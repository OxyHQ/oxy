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
 *
 * `POST /identity/key-history/claim` — add a root replaced BEFORE that history
 * existed (migration 0235; security review R6-5): Commons proves it holds the
 * key, and the server adds it only when its own records prove the key was this
 * account's (`services/personalKeyEvidence.ts`).
 */
import { Router, type Request, type Response } from 'express';
import { asc, eq } from 'drizzle-orm';
import { isValidSecp256k1PublicKey, normalizeSecp256k1PublicKey } from '@oxy.so/protocol/secp256k1';
import {
  IDENTITY_ERROR_CODES,
  IDENTITY_KEY_HISTORY_CLAIM_ACTION,
  identityKeyHistoryClaimRequestSchema,
  identityKeyHistorySchema,
  type IdentityKeyHistoryClaimRequest,
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
import { ApiError, BadRequestError, ConflictError, UnauthorizedError } from '../utils/error';
import { mintIdentityProofChallenge } from '../services/identityProof.service';
import { lockIdentityKeys } from '../services/organizationKeyHistory';
import { personalKeyEvidence } from '../services/personalKeyEvidence';
import SignatureService from '../services/signature.service';

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

/** The signed-in personal account, or the error the key-history routes answer. */
async function personalAccount(userId: string): Promise<{ publicKey: string | null }> {
  const [account] = await getDb()
    .select({ kind: users.kind, publicKey: users.publicKey })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (!account) throw new UnauthorizedError('Authentication required');
  if (account.kind !== 'personal') {
    throw new ApiError(403, 'Only a personal account has a root', IDENTITY_ERROR_CODES.notPersonal);
  }
  return { publicKey: account.publicKey };
}

/** The account's key history, as `GET /identity/key-history` answers it. */
async function keyHistoryOf(userId: string, currentRoot: string | null) {
  const retired = await getDb()
    .select({
      publicKey: personalIdentityKeyRetirements.publicKey,
      retiredAt: personalIdentityKeyRetirements.retiredAt,
    })
    .from(personalIdentityKeyRetirements)
    .where(eq(personalIdentityKeyRetirements.userId, userId))
    .orderBy(asc(personalIdentityKeyRetirements.retiredAt), asc(personalIdentityKeyRetirements.id));
  // The current root in the history's spelling (a sign-up may have stored a
  // compressed or upper-case encoding of it).
  const current = currentRoot?.trim() || null;
  return identityKeyHistorySchema.parse({
    publicKey:
      current && isValidSecp256k1PublicKey(current)
        ? normalizeSecp256k1PublicKey(current)
        : current,
    retired: retired.map((row) => ({
      publicKey: row.publicKey,
      retiredAt: row.retiredAt.toISOString(),
    })),
  });
}

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
    const account = await personalAccount(userId);
    res.status(200).json(await keyHistoryOf(userId, account.publicKey));
  }),
);

const keyHistoryClaimLimiter = rateLimit({
  prefix: 'rl:identity:key-history-claim:',
  windowMs: 60 * 60 * 1000,
  max: 30,
  message: 'Too many identity requests. Please try again later.',
  keyGenerator: (req: Request): string => {
    const userId = (req as AuthRequest).user?.id;
    return userId
      ? `identity:key-history-claim:${userId}`
      : `identity:key-history-claim:ip:${hashedIpKey(req)}`;
  },
});

/** How old (or how far ahead) a claim's signed timestamp may be. */
const CLAIM_SIGNATURE_MAX_AGE_MS = 5 * 60 * 1000;

function keyNotProven(): ApiError {
  return new ApiError(
    404,
    "Oxy's records do not show this key was this account's root",
    IDENTITY_ERROR_CODES.keyNotProven,
  );
}

/**
 * Add a root replaced before migration 0235 to the signed-in person's key history.
 *
 * The history (`personal_identity_key_retirements`) starts at migration 0235;
 * this adds an earlier one so Commons can bind the key it kept quarantined
 * (security review R6-5). Two proofs, both required:
 *
 * - **possession**: `signature` is the key's signature over
 *   `JSON.stringify({ action: 'claim_retired_identity_key', userId, publicKey,
 *   timestamp })`, the rotation proofs' signing format, with `timestamp` within
 *   five minutes;
 * - **provenance from Oxy's own records**: `personalKeyEvidence` (verified,
 *   self-issued signed records the account wrote with that key while it was
 *   one of its current verification methods). A client's word is never one.
 *
 * Answers the key history (200) once the key is in it, idempotently. The
 * account's live root: 409. Another account's retired root: 409. Anything the
 * records do not prove, or that may never be a retired root of this account
 * (another account's live key, an organization's): 404
 * `IDENTITY_KEY_NOT_PROVEN`.
 *
 * @response 200 identityKeyHistorySchema The key history, now naming the key.
 */
router.post(
  '/key-history/claim',
  authMiddleware,
  requireFirstPartyDeviceAccess,
  keyHistoryClaimLimiter,
  validate({ body: identityKeyHistoryClaimRequestSchema }),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const userId = req.user?._id;
    if (!userId) throw new UnauthorizedError('Authentication required');
    const { publicKey, signature, timestamp } = req.body as IdentityKeyHistoryClaimRequest;
    const account = await personalAccount(userId);

    if (!SignatureService.isTimestampFresh(timestamp, CLAIM_SIGNATURE_MAX_AGE_MS)) {
      throw new BadRequestError('Signature expired or invalid timestamp — please try again');
    }
    const message = JSON.stringify({
      action: IDENTITY_KEY_HISTORY_CLAIM_ACTION,
      userId,
      publicKey,
      timestamp,
    });
    if (!SignatureService.verifySignature(message, signature, publicKey)) {
      throw new BadRequestError('Invalid signature — cannot verify possession of the key');
    }

    // One transaction, the key locked before the evidence is read (R7, info):
    // a re-link of the key cannot commit between the read and the insert.
    await getDb().transaction(async (db) => {
      await lockIdentityKeys(db, publicKey);
      const evidence = await personalKeyEvidence(db, userId, publicKey);
      switch (evidence.kind) {
        case 'already-retired':
          break;
        case 'proven': {
          const [inserted] = await db
            .insert(personalIdentityKeyRetirements)
            .values({ userId, publicKey, retiredAt: evidence.lastSeenAt })
            .onConflictDoNothing({ target: personalIdentityKeyRetirements.publicKey })
            .returning({ id: personalIdentityKeyRetirements.id });
          if (!inserted) {
            // A concurrent writer took the key first: it is this account's only
            // when that writer was this account.
            const [row] = await db
              .select({ userId: personalIdentityKeyRetirements.userId })
              .from(personalIdentityKeyRetirements)
              .where(eq(personalIdentityKeyRetirements.publicKey, publicKey))
              .limit(1);
            if (row?.userId !== userId) {
              throw new ConflictError("This key is in another account's history");
            }
          }
          break;
        }
        case 'excluded':
          if (evidence.reason === 'current-root') {
            throw new ConflictError("This key is the account's current root, not a retired one");
          }
          if (evidence.reason === 'retired-elsewhere') {
            throw new ConflictError("This key is in another account's history");
          }
          throw keyNotProven();
        case 'unproven':
          throw keyNotProven();
      }
    });
    res.status(200).json(await keyHistoryOf(userId, account.publicKey));
  }),
);

export default router;
