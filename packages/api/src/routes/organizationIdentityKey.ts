/**
 * An organization's identity key (ADR 0061): its DID `#key-1`, created in
 * Commons by an owner or admin. Every route rechecks the live session, the
 * organization and the caller's role; a change also needs fresh signatures by
 * the caller's own root and by the new key (`services/organizationIdentityKey.service.ts`).
 */
import { Router } from 'express';
import {
  organizationIdentityKeyStateSchema,
  organizationKeyApplyRequestSchema,
  organizationKeyChallengeRequestSchema,
  organizationKeyChallengeSchema,
} from '@oxy.so/contracts';
import { authMiddleware, type AuthRequest } from '../middleware/auth';
import { requireFirstPartyDeviceAccess } from '../middleware/firstPartyDeviceAccess';
import { validate } from '../middleware/validate';
import { rateLimit } from '../middleware/rateLimiter';
import { accountIdRouteParams } from '../schemas/account.schemas';
import { hashedIpKey } from '../utils/ipKey';
import { asyncHandler } from '../utils/asyncHandler';
import { ApiError } from '../utils/error';
import userCache from '../utils/userCache';
import {
  applyOrganizationKey,
  readOrganizationIdentityKey,
  requestOrganizationKeyChallenge,
} from '../services/organizationIdentityKey.service';

const router = Router();
const limiter = rateLimit({
  prefix: 'rl:organization-key:',
  windowMs: 60_000,
  max: 30,
  keyGenerator: (req) => hashedIpKey(req),
  message: 'Too many attempts',
});

function sessionIdOf(req: AuthRequest): string {
  if (!req.sessionId) throw new ApiError(401, 'Session required', 'INVALID_SESSION');
  return req.sessionId;
}

/** GET /accounts/:id/identity-key
 * The organization's key (`null` without one) and every key it has had. Owners and admins.
 */
router.get(
  '/:id/identity-key',
  authMiddleware,
  requireFirstPartyDeviceAccess,
  limiter,
  validate({ params: accountIdRouteParams }),
  asyncHandler(async (req: AuthRequest, res) => {
    res.json(
      organizationIdentityKeyStateSchema.parse(
        await readOrganizationIdentityKey(sessionIdOf(req), req.params.id),
      ),
    );
  }),
);

/** POST /accounts/:id/identity-key/challenge
 * A one-use challenge for creating or replacing the key, with the claims to sign.
 */
router.post(
  '/:id/identity-key/challenge',
  authMiddleware,
  requireFirstPartyDeviceAccess,
  limiter,
  validate({ params: accountIdRouteParams, body: organizationKeyChallengeRequestSchema }),
  asyncHandler(async (req: AuthRequest, res) => {
    res.json(
      organizationKeyChallengeSchema.parse(
        await requestOrganizationKeyChallenge(sessionIdOf(req), req.params.id, req.body),
      ),
    );
  }),
);

/** POST /accounts/:id/identity-key
 * Create or replace the key: the caller's root, the new key and (optionally) the current key sign.
 */
router.post(
  '/:id/identity-key',
  authMiddleware,
  requireFirstPartyDeviceAccess,
  limiter,
  validate({ params: accountIdRouteParams, body: organizationKeyApplyRequestSchema }),
  asyncHandler(async (req: AuthRequest, res) => {
    const state = await applyOrganizationKey(sessionIdOf(req), req.params.id, req.body);
    userCache.invalidate(req.params.id);
    res.json(organizationIdentityKeyStateSchema.parse(state));
  }),
);

export default router;
