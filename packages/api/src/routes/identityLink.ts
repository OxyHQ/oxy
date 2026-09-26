/**
 * Linking Commons to an account without a key, from two devices (ADR 0029
 * D3), mounted at `/identity/link`:
 *
 *  - `POST   /`                  official app, bearer → `{ linkId, challenge, expiresAt, qrPayload }`
 *  - `GET    /:linkId`           either device → status, account, the key once signed
 *  - `POST   /:linkId/proof`     Commons, no bearer → the root proof and its key
 *  - `POST   /:linkId/options`   auth.oxy.so, bearer → WebAuthn options over the challenge
 *  - `POST   /:linkId/complete`  official app, bearer → `{ reauth }` (a code just
 *    sent to the account's email, + its authenticator code) or, from
 *    auth.oxy.so, `{ assertion }` (a passkey); links, deletes the email, tells
 *    it so, and signs every other session of the account out
 *  - `DELETE /:linkId`           official app, bearer → withdraw
 *
 * The authority is a root proof over one challenge plus the account's own
 * fresh confirmation; `services/identityLink.service.ts` owns it. The routes
 * that name the account answer only official Oxy apps (`requireOfficialOrigin`)
 * and first-party bearers; the two Commons calls carry no bearer (Commons has
 * no session for the account yet) and are rate-limited by hashed IP.
 */
import { Router, type NextFunction, type Request, type Response } from 'express';
import { requireFirstPartyDeviceAccess } from '../middleware/firstPartyDeviceAccess';
import { requireOfficialOrigin } from '../middleware/officialOrigin';
import {
  identityLinkCompleteRequestSchema,
  identityLinkOptionsRequestSchema,
  identityLinkProofRequestSchema,
  type IdentityLinkCompleteRequest,
  type IdentityLinkOptionsRequest,
  type IdentityLinkProofRequest,
} from '@oxy.so/contracts';
import { authMiddleware, type AuthRequest } from '../middleware/auth';
import { rateLimit } from '../middleware/rateLimiter';
import { validate } from '../middleware/validate';
import { identityLinkParams } from '../schemas/identityLink.schemas';
import {
  cancelLinkRequest,
  completeLinkRequest,
  createLinkRequest,
  linkAssertionOptions,
  readLinkRequest,
  submitLinkProof,
} from '../services/identityLink.service';
import { asyncHandler } from '../utils/asyncHandler';
import { ForbiddenError, UnauthorizedError } from '../utils/error';
import { hashedIpKey } from '../utils/ipKey';
import { isAuthWebOrigin } from '../utils/origin';
import userCache from '../utils/userCache';
import { logger } from '../utils/logger';
import { sendSecurityNotice } from '../services/accountEmail.mail';
import sessionService from '../services/session.service';

const router = Router();

function ipLimiter(name: string, max: number) {
  return rateLimit({
    prefix: `rl:identity:link:${name}:`,
    windowMs: 60 * 60 * 1000,
    max,
    message: 'Too many link requests. Please try again later.',
    keyGenerator: (req: Request): string => `identity:link:${name}:ip:${hashedIpKey(req)}`,
  });
}

function userLimiter(name: string, max: number) {
  return rateLimit({
    prefix: `rl:identity:link:${name}:`,
    windowMs: 60 * 60 * 1000,
    max,
    message: 'Too many link requests. Please try again later.',
    keyGenerator: (req: Request): string => {
      const userId = (req as AuthRequest).user?.id;
      return userId ? `identity:link:${name}:${userId}` : `identity:link:${name}:ip:${hashedIpKey(req)}`;
    },
  });
}

/** Two devices poll every 2 s for up to 5 minutes. */
const readLimiter = ipLimiter('read', 1200);
const proofLimiter = ipLimiter('proof', 30);
const openLimiter = userLimiter('open', 20);
const ownerLimiter = userLimiter('owner', 60);

function requireAuthWebOrigin(req: Request, _res: Response, next: NextFunction): void {
  const origin = req.headers.origin;
  if (typeof origin !== 'string' || !isAuthWebOrigin(origin)) {
    next(new ForbiddenError('This endpoint is only available to auth.oxy.so'));
    return;
  }
  next();
}

function requireUserId(req: AuthRequest): string {
  const userId = req.user?.id;
  if (!userId) throw new UnauthorizedError('Authentication required');
  return userId;
}

router.post(
  '/',
  requireOfficialOrigin,
  authMiddleware,
  requireFirstPartyDeviceAccess,
  openLimiter,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    res.status(200).json(await createLinkRequest(requireUserId(req)));
  }),
);

router.get(
  '/:linkId',
  readLimiter,
  validate({ params: identityLinkParams }),
  asyncHandler(async (req: Request, res: Response) => {
    res.status(200).json(await readLinkRequest(req.params.linkId as string));
  }),
);

router.post(
  '/:linkId/proof',
  proofLimiter,
  validate({ params: identityLinkParams, body: identityLinkProofRequestSchema }),
  asyncHandler(async (req: Request, res: Response) => {
    await submitLinkProof(req.params.linkId as string, req.body as IdentityLinkProofRequest);
    res.status(200).json({ status: 'signed' });
  }),
);

router.post(
  '/:linkId/options',
  requireAuthWebOrigin,
  authMiddleware,
  ownerLimiter,
  validate({ params: identityLinkParams, body: identityLinkOptionsRequestSchema }),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const { challenge } = req.body as IdentityLinkOptionsRequest;
    res.status(200).json(await linkAssertionOptions(req.params.linkId as string, requireUserId(req), challenge));
  }),
);

router.post(
  '/:linkId/complete',
  requireOfficialOrigin,
  authMiddleware,
  requireFirstPartyDeviceAccess,
  ownerLimiter,
  validate({ params: identityLinkParams, body: identityLinkCompleteRequestSchema }),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const userId = requireUserId(req);
    const body = req.body as IdentityLinkCompleteRequest;
    // A passkey is asserted only on auth.oxy.so (ADR 0029 D1).
    if ('assertion' in body) {
      const origin = req.headers.origin;
      if (typeof origin !== 'string' || !isAuthWebOrigin(origin)) {
        throw new ForbiddenError('A passkey is confirmed only on auth.oxy.so');
      }
    }
    const { formerEmail, username } = await completeLinkRequest(req.params.linkId as string, userId, body);
    userCache.invalidate(userId);
    // The account is the person's own now: every other session goes.
    await sessionService.deactivateAllUserSessions(userId, req.sessionId);
    if (formerEmail) {
      sendSecurityNotice(formerEmail, 'commons_linked', username).catch((error: unknown) => {
        logger.error('Commons link notice could not be sent', error instanceof Error ? error : new Error(String(error)), {
          component: 'identityLink',
        });
      });
    }
    res.status(200).json({ success: true });
  }),
);

router.delete(
  '/:linkId',
  requireOfficialOrigin,
  authMiddleware,
  requireFirstPartyDeviceAccess,
  ownerLimiter,
  validate({ params: identityLinkParams }),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    await cancelLinkRequest(req.params.linkId as string, requireUserId(req));
    res.status(200).json({ success: true });
  }),
);

export default router;
