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
 *
 * `GET /identity/key-history` — a personal account's current root and every
 * root a rotation replaced (`personal_identity_key_retirements`), oldest first.
 * Commons reads it to accept a previous recovery phrase only when it derives a
 * key that WAS this account's root.
 */
import { Router, type Request, type Response } from 'express';
import { asc, eq } from 'drizzle-orm';
import { isValidSecp256k1PublicKey, normalizeSecp256k1PublicKey } from '@oxy.so/protocol/secp256k1';
import {
  IDENTITY_ERROR_CODES,
  identityKeyHistorySchema,
  identityProofChallengeRequestSchema,
  type IdentityProofChallengeRequest,
  type IdentityRootStatus,
} from '@oxy.so/contracts';
import { getDb } from '../config/postgres';
import { personalIdentityKeyRetirements } from '../db/schema/personalIdentityKeyRetirements';
import { users } from '../db/schema/users';
import { authMiddleware, type AuthRequest } from '../middleware/auth';
import { requireFirstPartyDeviceAccess } from '../middleware/firstPartyDeviceAccess';
import { rateLimit } from '../middleware/rateLimiter';
import { validate } from '../middleware/validate';
import { asyncHandler } from '../utils/asyncHandler';
import { hashedIpKey } from '../utils/ipKey';
import { ApiError, UnauthorizedError } from '../utils/error';
import { mintIdentityProofChallenge } from '../services/identityProof.service';

const router = Router();

const challengeLimiter = rateLimit({
  prefix: 'rl:identity:proof-challenge:',
  windowMs: 60 * 60 * 1000,
  max: 60,
  message: 'Too many identity requests. Please try again later.',
  keyGenerator: (req: Request): string => {
    const userId = (req as AuthRequest).user?.id;
    return userId
      ? `identity:proof-challenge:${userId}`
      : `identity:proof-challenge:ip:${hashedIpKey(req)}`;
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

const keyHistoryLimiter = rateLimit({
  prefix: 'rl:identity:key-history:',
  windowMs: 60_000,
  max: 30,
  keyGenerator: (req) => hashedIpKey(req),
  message: 'Too many identity requests. Please try again later.',
});

/**
 * A personal account's current root and every root a rotation replaced.
 * Oldest first, keys canonical; a non-personal account is refused
 * (`IDENTITY_NOT_PERSONAL_ACCOUNT`).
 *
 * Gated like `GET /accounts/:id/identity-key` (the organization's key history),
 * not like `root-status`: the answer names keys the DID no longer publishes,
 * which tie the account to every address tree it ever received into. Only
 * Commons needs it, so a third-party application's bearer is refused
 * (`requireFirstPartyDeviceAccess`), while `root-status` carries no key and is
 * read from any origin.
 *
 * @response 200 identityKeyHistorySchema The current root (`null` without one) and the retired roots.
 */
router.get(
  '/key-history',
  authMiddleware,
  requireFirstPartyDeviceAccess,
  keyHistoryLimiter,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const userId = req.user?._id;
    if (!userId) throw new UnauthorizedError('Authentication required');
    const db = getDb();
    const [account] = await db
      .select({ kind: users.kind, publicKey: users.publicKey })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    if (!account) throw new UnauthorizedError('Authentication required');
    if (account.kind !== 'personal') {
      throw new ApiError(
        403,
        'Only a personal account has a root',
        IDENTITY_ERROR_CODES.notPersonal,
      );
    }
    const retired = await db
      .select({
        publicKey: personalIdentityKeyRetirements.publicKey,
        retiredAt: personalIdentityKeyRetirements.retiredAt,
      })
      .from(personalIdentityKeyRetirements)
      .where(eq(personalIdentityKeyRetirements.userId, userId))
      .orderBy(
        asc(personalIdentityKeyRetirements.retiredAt),
        asc(personalIdentityKeyRetirements.id),
      );
    // The current root in the history's spelling (a sign-up may have stored a
    // compressed or upper-case encoding of it).
    const current = account.publicKey?.trim() || null;
    res.status(200).json(
      identityKeyHistorySchema.parse({
        publicKey:
          current && isValidSecp256k1PublicKey(current)
            ? normalizeSecp256k1PublicKey(current)
            : current,
        retired: retired.map((row) => ({
          publicKey: row.publicKey,
          retiredAt: row.retiredAt.toISOString(),
        })),
      }),
    );
  }),
);

export default router;
