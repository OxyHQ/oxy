/**
 * `/linked-accounts` — a local Oxy user proves they own a Mastodon-API or
 * Bluesky account by OAuth, and Oxy records the link. Oxy keeps NO third-party
 * token: the flow exists to learn which account authorized it, then the token
 * is revoked and dropped. See `docs/identity/linked-accounts.md`.
 *
 * - `POST /:network/start` (user session) → `{ authorizeUrl, expiresAt }`;
 *   `returnTo` must be a redirect URI of a trusted (first-party) application.
 *   A refusal the user can act on is a 400 with `details.reason`
 *   (`LINKED_ACCOUNT_START_ERROR_REASONS`).
 * - `GET /:network/callback` (no session — the spent challenge row is the
 *   authentication) verifies the account and redirects to `returnTo` with a
 *   one-time `?link_code=` or `?link_error=<code>`. It never links.
 * - `POST /complete` (user session) turns the code into the link — only for the
 *   user who started the flow; anyone else burns it.
 * - `GET /` and `DELETE /:id` (user session) — list and revoke.
 * - `GET /by-user/:userId` (service token with the privileged
 *   `linked-accounts:read`) — for the first-party migration service.
 * - `GET /atproto/client-metadata.json` (public) — the atproto OAuth client_id.
 */

import { Router, type Request, type Response } from 'express';
import {
  completeLinkedAccountRequestSchema,
  completeLinkedAccountResponseSchema,
  linkedAccountListResponseSchema,
  serviceLinkedAccountListResponseSchema,
  startLinkedAccountRequestSchema,
  startLinkedAccountResponseSchema,
  type CompleteLinkedAccountRequest,
  type LinkedAccountCallbackError,
  type LinkedAccountNetwork,
  type StartLinkedAccountRequest,
} from '@oxy.so/contracts';
import { authMiddleware, serviceAuthMiddleware, type AuthRequest, type ServiceAuthRequest } from '../middleware/auth';
import { rateLimit } from '../middleware/rateLimiter';
import { validate } from '../middleware/validate';
import { asyncHandler, sendSuccess } from '../utils/asyncHandler';
import { BadRequestError, ConflictError, ForbiddenError, NotFoundError, UnauthorizedError } from '../utils/error';
import { hashedIpKey } from '../utils/ipKey';
import { logger } from '../utils/logger';
import type { ApplicationScope } from '../utils/applicationScopes';
import { markChallengeVerified, readChallengeReturn, spendChallenge } from '../services/linkedAccounts/challenges';
import { LinkedAccountCallbackFailure, LinkedAccountStartRefusal, type VerifiedExternalAccount } from '../services/linkedAccounts/common';
import { completeMastodonLink, startMastodonLink } from '../services/linkedAccounts/mastodon.provider';
import { atprotoClientMetadata, completeAtprotoLink, startAtprotoLink } from '../services/linkedAccounts/atproto.provider';
import {
  LinkCodeInvalid,
  LinkCodeNotYours,
  LinkedAccountAlreadyClaimed,
  completeLinkedAccount,
  listLinkedAccounts,
  listLinkedAccountsForService,
  revokeLinkedAccount,
} from '../services/linkedAccounts/linkedAccounts.service';
import { resolveReturnTo, withQueryParam } from '../services/linkedAccounts/returnTo';
import {
  linkedAccountIdParams,
  linkedAccountNetworkParams,
  linkedAccountUserIdParams,
} from '../schemas/linkedAccounts.schemas';

const router = Router();

/**
 * The scope `GET /by-user/:userId` requires. Typed `ApplicationScope` so a
 * rename of the vocabulary entry breaks this line instead of leaving the route
 * checking for a string no token can carry.
 */
const LINKED_ACCOUNTS_READ_SCOPE: ApplicationScope = 'linked-accounts:read';

const startLimiter = rateLimit({
  prefix: 'rl:linked-accounts:start:',
  windowMs: 60 * 1000,
  max: process.env.NODE_ENV === 'development' ? 100 : 10,
  keyGenerator: (req) => (req as AuthRequest).user?.id ?? hashedIpKey(req),
});

const callbackLimiter = rateLimit({
  prefix: 'rl:linked-accounts:callback:',
  windowMs: 60 * 1000,
  max: process.env.NODE_ENV === 'development' ? 200 : 30,
});

const serviceReadLimiter = rateLimit({
  prefix: 'rl:linked-accounts:service:',
  windowMs: 60 * 1000,
  max: 600,
  keyGenerator: (req) => (req as ServiceAuthRequest).serviceApp?.appId ?? hashedIpKey(req),
});

// ── Public: the atproto OAuth client metadata document (the client_id URL) ──
router.get('/atproto/client-metadata.json', (_req: Request, res: Response) => {
  res.set('Cache-Control', 'public, max-age=300');
  res.json(atprotoClientMetadata());
});

// ── Service: a user's live links, for first-party services ──
router.get(
  '/by-user/:userId',
  serviceAuthMiddleware,
  serviceReadLimiter,
  validate({ params: linkedAccountUserIdParams }),
  asyncHandler(async (req: ServiceAuthRequest, res: Response) => {
    if (!req.serviceApp?.scopes.includes(LINKED_ACCOUNTS_READ_SCOPE)) {
      throw new ForbiddenError(`Missing required scope: ${LINKED_ACCOUNTS_READ_SCOPE}`);
    }
    const { userId } = req.params as { userId: string };
    const linkedAccounts = await listLinkedAccountsForService(userId);
    sendSuccess(res, serviceLinkedAccountListResponseSchema.parse({ userId, linkedAccounts }));
  }),
);

// ── User: start ──
router.post(
  '/:network/start',
  authMiddleware,
  startLimiter,
  validate({ params: linkedAccountNetworkParams, body: startLinkedAccountRequestSchema }),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const userId = req.user?.id;
    if (!userId) throw new UnauthorizedError();
    const { network } = req.params as { network: LinkedAccountNetwork };
    const body = req.body as StartLinkedAccountRequest;

    const destination = await resolveReturnTo(body.clientId, body.returnTo);
    if (!destination.ok) throw new BadRequestError(destination.reason);

    try {
      const started =
        network === 'activitypub'
          ? await startMastodonLink({
              userId,
              instance: body.instance ?? requiredField('instance'),
              clientApplicationId: destination.clientApplicationId,
              returnTo: destination.returnTo,
            })
          : await startAtprotoLink({
              userId,
              handle: body.handle ?? requiredField('handle'),
              clientApplicationId: destination.clientApplicationId,
              returnTo: destination.returnTo,
            });
      sendSuccess(
        res,
        startLinkedAccountResponseSchema.parse({
          authorizeUrl: started.authorizeUrl,
          expiresAt: started.expiresAt.toISOString(),
        }),
      );
    } catch (error) {
      if (error instanceof LinkedAccountStartRefusal) {
        throw new BadRequestError(error.message, { reason: error.reason });
      }
      throw error;
    }
  }),
);

function requiredField(name: string): never {
  throw new BadRequestError(`${name} is required for this network`);
}

// ── Callback (no session: the spent challenge authenticates it) ──
//
// The callback VERIFIES but never LINKS. It has no Oxy session, so a link made
// here would bind the external account to whoever started the flow, not to
// whoever approved it at the other network. It hands `returnTo` a one-time
// `link_code` instead, which only the starting user's session can complete.

/** The one outcome with no trusted place to return to. Fixed, script-free text. */
function renderInvalidState(res: Response): void {
  res
    .status(400)
    .set('Content-Type', 'text/html; charset=utf-8')
    .set('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'")
    .set('Cache-Control', 'no-store')
    .set('Referrer-Policy', 'no-referrer')
    .send(
      '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
        '<meta name="viewport" content="width=device-width, initial-scale=1"><title>Oxy</title></head>' +
        '<body style="font-family:system-ui,sans-serif;display:flex;min-height:100vh;align-items:center;' +
        'justify-content:center;margin:0;padding:16px;text-align:center">' +
        '<p>This link has expired or was already used. Please start again.</p></body></html>',
    );
}

async function finish(
  res: Response,
  returnTo: string,
  outcome: { challengeId: string; account: VerifiedExternalAccount } | { error: LinkedAccountCallbackError },
): Promise<void> {
  const target =
    'error' in outcome
      ? withQueryParam(returnTo, 'link_error', outcome.error)
      : withQueryParam(returnTo, 'link_code', await markChallengeVerified(outcome.challengeId, outcome.account));
  res.set('Cache-Control', 'no-store').set('Referrer-Policy', 'no-referrer').redirect(303, target);
}

function queryString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= 4096 ? value : null;
}

router.get(
  '/:network/callback',
  callbackLimiter,
  validate({ params: linkedAccountNetworkParams }),
  asyncHandler(async (req: Request, res: Response) => {
    const { network } = req.params as { network: LinkedAccountNetwork };

    if (network === 'atproto') {
      const params = new URLSearchParams();
      for (const [key, value] of Object.entries(req.query)) {
        const text = queryString(value);
        if (text !== null) params.set(key, text);
      }
      const result = await completeAtprotoLink(params);
      if ('failure' in result) {
        logger.info('[LinkedAccounts] atproto callback refused', { code: result.failure.code, reason: result.failure.message });
        const origin = result.challengeId ? await readChallengeReturn(result.challengeId) : null;
        if (!origin) return renderInvalidState(res);
        return finish(res, origin.returnTo, { error: result.failure.code });
      }
      return finish(res, result.returnTo, result);
    }

    const state = queryString(req.query.state);
    const challenge = state ? await spendChallenge('activitypub', state) : null;
    if (!challenge) return renderInvalidState(res);

    if (queryString(req.query.error)) {
      return finish(res, challenge.returnTo, { error: 'access_denied' });
    }
    const code = queryString(req.query.code);
    if (!code) return finish(res, challenge.returnTo, { error: 'verification_failed' });

    try {
      const account = await completeMastodonLink(challenge, code);
      return finish(res, challenge.returnTo, { challengeId: challenge.id, account });
    } catch (error) {
      if (error instanceof LinkedAccountCallbackFailure) {
        logger.info('[LinkedAccounts] Mastodon callback refused', { host: challenge.host, code: error.code, reason: error.message });
        return finish(res, challenge.returnTo, { error: error.code });
      }
      throw error;
    }
  }),
);

// ── User: complete (the starting user's session turns the code into a link) ──
router.post(
  '/complete',
  authMiddleware,
  startLimiter,
  validate({ body: completeLinkedAccountRequestSchema }),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const userId = req.user?.id;
    if (!userId) throw new UnauthorizedError();
    const { code } = req.body as CompleteLinkedAccountRequest;
    try {
      const linkedAccount = await completeLinkedAccount(userId, code);
      sendSuccess(res, completeLinkedAccountResponseSchema.parse({ linkedAccount }));
    } catch (error) {
      if (error instanceof LinkCodeInvalid) throw new NotFoundError(error.message);
      if (error instanceof LinkCodeNotYours) throw new ForbiddenError(error.message);
      if (error instanceof LinkedAccountAlreadyClaimed) throw new ConflictError(error.message);
      throw error;
    }
  }),
);

// ── User: list and revoke ──
router.get(
  '/',
  authMiddleware,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const userId = req.user?.id;
    if (!userId) throw new UnauthorizedError();
    sendSuccess(res, linkedAccountListResponseSchema.parse({ linkedAccounts: await listLinkedAccounts(userId) }));
  }),
);

router.delete(
  '/:id',
  authMiddleware,
  validate({ params: linkedAccountIdParams }),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const userId = req.user?.id;
    if (!userId) throw new UnauthorizedError();
    const { id } = req.params as { id: string };
    if (!(await revokeLinkedAccount(userId, id))) throw new NotFoundError('Linked account not found');
    res.status(204).end();
  }),
);

export default router;
