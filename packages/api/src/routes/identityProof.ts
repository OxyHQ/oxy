/**
 * Bearer-only identity routes that are not bound to the holder origin.
 *
 * `POST /identity/proof-challenge` — mint a one-use challenge for a root proof.
 *
 * ADR 0024 D7. Bearer-authenticated and bound to the caller's account, the one
 * action it names, and the root linked right now. A challenge alone authorizes
 * nothing: it is spent only by a signature of that root over the canonical
 * claims (`identityProof.service.ts`).
 *
 * Not restricted to the holder origin: Commons (no browser origin) links and
 * rotates roots too. The routes that SPEND a challenge keep their own guards.
 *
 * `GET /identity/root-status` — how the account is kept (ADR 0029 D3): whether
 * Commons' root is linked (self-custody), or which email the account signs in
 * with. Accounts and the account menu read it from any origin
 * to recommend linking Commons.
 */
import { Router, type Request, type Response } from 'express';
import { eq } from 'drizzle-orm';
import { identityProofChallengeRequestSchema, type IdentityProofChallengeRequest, type IdentityRootStatus } from '@oxy.so/contracts';
import { getDb } from '../config/postgres';
import { users } from '../db/schema/users';
import { authMiddleware, type AuthRequest } from '../middleware/auth';
import { rateLimit } from '../middleware/rateLimiter';
import { validate } from '../middleware/validate';
import { asyncHandler } from '../utils/asyncHandler';
import { hashedIpKey } from '../utils/ipKey';
import { UnauthorizedError } from '../utils/error';
import { mintIdentityProofChallenge } from '../services/identityProof.service';

const router = Router();

const challengeLimiter = rateLimit({
  prefix: 'rl:identity:proof-challenge:',
  windowMs: 60 * 60 * 1000,
  max: 60,
  message: 'Too many identity requests. Please try again later.',
  keyGenerator: (req: Request): string => {
    const userId = (req as AuthRequest).user?.id;
    return userId ? `identity:proof-challenge:${userId}` : `identity:proof-challenge:ip:${hashedIpKey(req)}`;
  },
});

router.post(
  '/proof-challenge',
  authMiddleware,
  challengeLimiter,
  validate({ body: identityProofChallengeRequestSchema }),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const userId = req.user?._id;
    if (!userId) throw new UnauthorizedError('Authentication required');
    const { action } = req.body as IdentityProofChallengeRequest;
    res.status(200).json(await mintIdentityProofChallenge(userId, action));
  }),
);

router.get(
  '/root-status',
  authMiddleware,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const userId = req.user?._id;
    if (!userId) throw new UnauthorizedError('Authentication required');
    const [account] = await getDb()
      .select({ publicKey: users.publicKey, email: users.email })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    const rootLinked = Boolean(account?.publicKey?.trim());
    const status: IdentityRootStatus = {
      rootLinked,
      recoveryEmail: rootLinked ? null : account?.email?.trim() || null,
    };
    res.status(200).json(status);
  }),
);

export default router;
