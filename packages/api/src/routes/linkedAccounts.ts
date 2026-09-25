/**
 * `/linked-accounts` — a local Oxy user proves they own a Mastodon-API or
 * Bluesky account by OAuth, and Oxy records the link. Oxy keeps NO third-party
 * token: the flow exists to learn which account authorized it, then the token
 * is revoked and dropped. See `docs/identity/linked-accounts.md`.
 *
 * - `POST /:network/start` (user session) → `{ authorizeUrl, expiresAt }`.
 * - `GET /:network/callback` (no session — the spent challenge row is the
 *   authentication) → redirect to the registered `returnTo` with
 *   `?linked=<id>` / `?error=<code>`, or a minimal page when none was given.
 * - `GET /` and `DELETE /:id` (user session) — list and revoke.
 * - `GET /by-user/:userId` (service token with the privileged
 *   `linked-accounts:read`) — for the first-party migration service.
 * - `GET /atproto/client-metadata.json` (public) — the atproto OAuth client_id.
 */

import { Router, type Request, type Response } from 'express';
import {
  linkedAccountListResponseSchema,
  serviceLinkedAccountListResponseSchema,
  startLinkedAccountRequestSchema,
  startLinkedAccountResponseSchema,
  type LinkedAccountCallbackError,
  type LinkedAccountNetwork,
  type StartLinkedAccountRequest,
} from '@oxy.so/contracts';
import { authMiddleware, serviceAuthMiddleware, type AuthRequest, type ServiceAuthRequest } from '../middleware/auth';
import { rateLimit } from '../middleware/rateLimiter';
import { validate } from '../middleware/validate';
import { asyncHandler, sendSuccess } from '../utils/asyncHandler';
import { BadRequestError, ForbiddenError, NotFoundError, UnauthorizedError } from '../utils/error';
import { hashedIpKey } from '../utils/ipKey';
import { logger } from '../utils/logger';
import type { ApplicationScope } from '../utils/applicationScopes';
import { spendChallenge, readChallengeReturn } from '../services/linkedAccounts/challenges';
import { LinkedAccountCallbackFailure, LinkedAccountStartRefusal } from '../services/linkedAccounts/common';
import { completeMastodonLink, startMastodonLink } from '../services/linkedAccounts/mastodon.provider';
import { atprotoClientMetadata, completeAtprotoLink, startAtprotoLink } from '../services/linkedAccounts/atproto.provider';
import {
  LinkedAccountAlreadyClaimed,
  listLinkedAccounts,
  listLinkedAccountsForService,
  recordLinkedAccount,
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
export const LINKED_ACCOUNTS_READ_SCOPE: ApplicationScope = 'linked-accounts:read';

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
      if (error instanceof LinkedAccountStartRefusal) throw new BadRequestError(error.message);
      throw error;
    }
  }),
);

function requiredField(name: string): never {
  throw new BadRequestError(`${name} is required for this network`);
}

// ── Callback (no session: the spent challenge authenticates it) ──

const PAGE_MESSAGES: Record<'linked' | LinkedAccountCallbackError | 'invalid_state', { status: number; text: string }> = {
  linked: { status: 200, text: 'Account linked. You can close this window.' },
  access_denied: { status: 400, text: 'Linking was cancelled. You can close this window.' },
  already_linked: { status: 409, text: 'That account is already linked to another Oxy account.' },
  verification_failed: { status: 400, text: 'We could not verify that account. Please try again.' },
  provider_unavailable: { status: 502, text: 'That server could not be reached. Please try again later.' },
  invalid_state: { status: 400, text: 'This link has expired or was already used. Please start again.' },
};

/** A fixed, script-free page. Nothing request-derived is interpolated. */
function renderPage(res: Response, outcome: keyof typeof PAGE_MESSAGES): void {
  const { status, text } = PAGE_MESSAGES[outcome];
  res
    .status(status)
    .set('Content-Type', 'text/html; charset=utf-8')
    .set('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'")
    .set('Cache-Control', 'no-store')
    .set('Referrer-Policy', 'no-referrer')
    .send(
      '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
        '<meta name="viewport" content="width=device-width, initial-scale=1"><title>Oxy</title></head>' +
        '<body style="font-family:system-ui,sans-serif;display:flex;min-height:100vh;align-items:center;' +
        `justify-content:center;margin:0;padding:16px;text-align:center"><p>${text}</p></body></html>`,
    );
}

function finish(
  res: Response,
  returnTo: string | null,
  outcome: { linked: string } | { error: LinkedAccountCallbackError },
): void {
  res.set('Cache-Control', 'no-store').set('Referrer-Policy', 'no-referrer');
  if (returnTo) {
    const target =
      'linked' in outcome ? withQueryParam(returnTo, 'linked', outcome.linked) : withQueryParam(returnTo, 'error', outcome.error);
    res.redirect(303, target);
    return;
  }
  renderPage(res, 'linked' in outcome ? 'linked' : outcome.error);
}

async function recordOrFail(
  userId: string,
  account: Parameters<typeof recordLinkedAccount>[1],
): Promise<{ linked: string } | { error: LinkedAccountCallbackError }> {
  try {
    return { linked: await recordLinkedAccount(userId, account) };
  } catch (error) {
    if (error instanceof LinkedAccountAlreadyClaimed) return { error: 'already_linked' };
    throw error;
  }
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
        if (!origin) return renderPage(res, 'invalid_state');
        return finish(res, origin.returnTo, { error: result.failure.code });
      }
      return finish(res, result.returnTo, await recordOrFail(result.userId, result.account));
    }

    const state = queryString(req.query.state);
    const challenge = state ? await spendChallenge('activitypub', state) : null;
    if (!challenge) return renderPage(res, 'invalid_state');

    if (queryString(req.query.error)) {
      return finish(res, challenge.returnTo, { error: 'access_denied' });
    }
    const code = queryString(req.query.code);
    if (!code) return finish(res, challenge.returnTo, { error: 'verification_failed' });

    try {
      const account = await completeMastodonLink(challenge, code);
      return finish(res, challenge.returnTo, await recordOrFail(challenge.userId, account));
    } catch (error) {
      if (error instanceof LinkedAccountCallbackFailure) {
        logger.info('[LinkedAccounts] Mastodon callback refused', { host: challenge.host, code: error.code, reason: error.message });
        return finish(res, challenge.returnTo, { error: error.code });
      }
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
