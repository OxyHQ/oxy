/**
 * Auth Linking Routes
 *
 * Endpoints for linking multiple authentication methods to a single user account.
 * Allows users to:
 * - Link an identity (publicKey) to an existing account
 * - View linked auth methods
 * - Rotate the root. A root is never unlinked; it is replaced by rotation
 *   (ADR 0024 D8).
 *
 * ## Storage (Postgres)
 *
 * The `authMethods[]` subdocument array is now the CHILD TABLE
 * `user_auth_methods`, so "push an entry" is an INSERT, "filter the array" is a
 * DELETE, and "replace the identity entry in place" is an UPDATE of exactly one
 * row. Two consequences worth stating, because each is a behaviour the Mongo
 * version could not have:
 *
 * - **The rotation swap is one transaction** covering the `users.public_key`
 *   write, the in-place identity-row replacement, AND the stale
 *   `identity_backups` delete — a committed swap can no longer leave a backup
 *   that still holds the OLD key behind.
 * - **A key already linked elsewhere is caught by a unique index**
 *   (`users_lower_public_key_key`, `user_auth_methods_lower_method_public_key_key`)
 *   as well as by the read-then-check, so the read/write race answers 409 rather
 *   than 500.
 */

import { Router, type NextFunction, type Request, type Response } from 'express';
import { and, eq, gt, ne, sql } from 'drizzle-orm';
import { authMiddleware, type AuthRequest } from '../middleware/auth.js';
import { requireFirstPartyDeviceAccess } from '../middleware/firstPartyDeviceAccess.js';
import { getDb } from '../config/postgres.js';
import { authChallenges } from '../db/schema/authChallenges.js';
import { identityBackups } from '../db/schema/identityBackups.js';
import { sessions } from '../db/schema/sessions.js';
import { userAuthMethods } from '../db/schema/userAuthMethods.js';
import { users } from '../db/schema/users.js';
import SignatureService from '../services/signature.service.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { BadRequestError, ConflictError, UnauthorizedError } from '../utils/error.js';
import { validate } from '../middleware/validate.js';
import { linkAuthMethodSchema, type LinkAuthMethodBody } from '../schemas/authLinking.schemas.js';
import sessionService from '../services/session.service.js';
import { rateLimit } from '../middleware/rateLimiter.js';
import { hashedIpKey } from '../utils/ipKey.js';
import { isUniqueViolation } from '../utils/postgresErrors.js';
import { extractTokenFromRequest, decodeToken } from '../middleware/authUtils.js';
import userCache from '../utils/userCache.js';
import { buildUserDid } from '../services/did.service.js';
import { buildAuthMethodEntries } from '../utils/authMethodEntries.js';
import { linkRootToAccount } from '../services/identityLink.service.js';
import { ApiError } from '../utils/error.js';
import {
  IDENTITY_ERROR_CODES,
  authMethodsResponseSchema,
  rotateKeyChallengeResponseSchema,
  rotateKeyCompleteRequestSchema,
  rotateKeyCompleteResponseSchema,
  type RotateKeyCompleteRequest,
} from '@oxy.so/contracts';

const router = Router();

/**
 * `where lower(btrim(public_key)) = lower(btrim($1))` — the spelling that both
 * matches case-insensitively and uses `users_lower_public_key_key`. A plain
 * `public_key = $1` is correct-looking, case-sensitive, and would not use the
 * index (Mongoose's `lowercase: true` setter is what used to make the naive
 * comparison work, and it has no Postgres counterpart).
 */
function publicKeyMatches(candidate: string) {
  return sql`lower(btrim(${users.publicKey})) = lower(btrim(${candidate}))`;
}

/** Rotation-challenge time-to-live (5 minutes), matching the signin challenge. */
const ROTATE_CHALLENGE_TTL_MS = 5 * 60 * 1000;

/** Max age accepted for the client rotation signature (5 minutes). */
const ROTATE_SIGNATURE_MAX_AGE_MS = 5 * 60 * 1000;

/** Per-authenticated-user rate-limit key (falls back to a hashed IP pre-auth). */
function rotateKey(scope: string) {
  return (req: Request): string => {
    const userId = (req as AuthRequest).user?._id?.toString();
    return userId ? `${scope}:${userId}` : `${scope}:ip:${hashedIpKey(req)}`;
  };
}

const rotateChallengeLimiter = rateLimit({
  prefix: 'rl:identity:rotate:challenge:',
  windowMs: 60 * 60 * 1000,
  max: 20,
  message: 'Too many key-rotation requests. Please try again later.',
  keyGenerator: rotateKey('identity:rotate:challenge'),
});

const rotateCompleteLimiter = rateLimit({
  prefix: 'rl:identity:rotate:complete:',
  windowMs: 60 * 60 * 1000,
  max: 20,
  message: 'Too many key-rotation attempts. Please try again later.',
  keyGenerator: rotateKey('identity:rotate:complete'),
});

/**
 * Revoke every OTHER active session for the account, keeping the session that
 * made this request signed in (mirrors the "logout all sessions" controller).
 * Pushes a `sessions_removed` event so connected clients drop immediately.
 *
 * `emitSessionUpdate` is loaded DYNAMICALLY to avoid a load-time import cycle
 * with `server.ts` (which imports this router).
 */
async function revokeOtherSessions(req: Request, userId: string): Promise<void> {
  const token = extractTokenFromRequest(req);
  const currentSessionId = token ? decodeToken(token)?.sessionId : undefined;

  // Only `session_id` is selected: `sessions` carries live bearer credentials
  // (`access_token`, `refresh_token`, `previous_refresh_token`) that a whole-row
  // read would pull into memory for no reason — see `protectedColumns.ts`.
  const others = await getDb()
    .select({ sessionId: sessions.sessionId })
    .from(sessions)
    .where(
      and(
        eq(sessions.userId, userId),
        eq(sessions.isActive, true),
        gt(sessions.expiresAt, new Date()),
        currentSessionId ? ne(sessions.sessionId, currentSessionId) : undefined,
      ),
    );
  const sessionIds = others.map((s) => s.sessionId);

  await sessionService.deactivateAllUserSessions(userId, currentSessionId);

  if (sessionIds.length > 0) {
    const { emitSessionUpdate } = await import('../server.js');
    emitSessionUpdate(userId, { type: 'sessions_removed', sessionIds });
  }
}

// All routes require authentication
router.use(authMiddleware);

/**
 * Every CHANGE to how the account signs in — linking or rotating a root,
 * removing a sign-in method — is the account's own: a third-party
 * application's token is refused (security review of #1421). Reads stay open.
 */
function requireFirstPartyForChanges(req: AuthRequest, res: Response, next: NextFunction): void {
  if (req.method === 'GET' || req.method === 'HEAD') {
    next();
    return;
  }
  requireFirstPartyDeviceAccess(req, res, next);
}
router.use(requireFirstPartyForChanges);

/**
 * GET /api/auth/methods
 * Get the account DID and all linked authentication methods for the current
 * user, shaped to the `authMethodsResponseSchema` contract. The identity
 * method carries its DID verification-method id (`#key-1`).
 */
router.get('/methods', asyncHandler(async (req: AuthRequest, res: Response) => {
  const userId = req.user?._id?.toString();
  if (!userId) {
    throw new BadRequestError('User not authenticated');
  }

  const db = getDb();
  const [account] = await db
    .select({ publicKey: users.publicKey, createdAt: users.createdAt })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (!account) {
    throw new BadRequestError('User not found');
  }

  // Ordered by `linked_at`: the Mongo array was read in insertion order, and
  // `linked_at` is the meaningful form of that. `id` (uuid v7, time-ordered)
  // breaks a same-instant tie so the response order is total rather than
  // whatever the heap returns.
  const methods = await db
    .select({
      type: userAuthMethods.type,
      linkedAt: userAuthMethods.linkedAt,
    })
    .from(userAuthMethods)
    .where(eq(userAuthMethods.userId, userId))
    .orderBy(userAuthMethods.linkedAt, userAuthMethods.id);

  const response = authMethodsResponseSchema.parse({
    did: buildUserDid(userId),
    methods: buildAuthMethodEntries({
      publicKey: account.publicKey,
      authMethods: methods,
      createdAt: account.createdAt,
    }),
  });

  res.json(response);
}));

/**
 * POST /api/auth/rotate/challenge
 * Mint a single-use `rotate_key` challenge for the current account. The client
 * signs it with its CURRENT key to prove control before the swap.
 *
 * The challenge is bound to the account's current `publicKey` and carries
 * `purpose: 'rotate_key'`, so a signin challenge (default purpose) can never be
 * spent here and vice-versa.
 */
router.post('/rotate/challenge', rotateChallengeLimiter, asyncHandler(async (req: AuthRequest, res: Response) => {
  const userId = req.user?._id?.toString();
  if (!userId) {
    throw new BadRequestError('User not authenticated');
  }

  // Bind the challenge to the authoritative user row (not the JWT/cache
  // snapshot) so mint + complete always agree on the account's current key.
  const [account] = await getDb()
    .select({ publicKey: users.publicKey })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  const oldPublicKey = account?.publicKey;
  if (!oldPublicKey) {
    throw new BadRequestError('No identity key is linked to this account — nothing to rotate.');
  }

  const challenge = SignatureService.generateChallenge();
  const expiresAt = new Date(Date.now() + ROTATE_CHALLENGE_TTL_MS);

  await getDb().insert(authChallenges).values({
    publicKey: oldPublicKey,
    challenge,
    purpose: 'rotate_key',
    expiresAt,
    used: false,
  });

  const response = rotateKeyChallengeResponseSchema.parse({
    challenge,
    expiresAt: expiresAt.toISOString(),
  });
  res.json(response);
}));

/**
 * POST /api/auth/rotate/complete
 * Atomically REPLACE the account's identity key with `newPublicKey`.
 *
 * Rotation is a single atomic swap — never a remove-then-add — so it never
 * passes through a zero-auth-method state and is independent of the unlink
 * guards. Because control of the CURRENT key is proven (from SecureStore OR a
 * recovery-phrase re-derivation), even the LAST remaining credential can be
 * replaced.
 *
 * Security invariants:
 *  - `oldPublicKey` is ALWAYS derived from the authenticated user row, NEVER
 *    from the request (prevents proving control of key X but rotating key Y).
 *  - control of the CURRENT key is proven (`signature`) AND possession of the
 *    NEW key is proven (`newKeyProof`) — the latter stops an attacker rotating
 *    their account to a re-encoding of a key they do not control.
 *  - the incoming key is canonicalized (uncompressed, lowercased) before the
 *    uniqueness check and the write, so two encodings of the same point cannot
 *    coexist across accounts.
 *  - the `rotate_key` challenge is burned ATOMICALLY (single-use) by one
 *    conditional UPDATE; the timestamp is checked BEFORE the burn so a stale
 *    request cannot self-burn a challenge.
 *  - the identity `user_auth_methods` row is UPDATED IN PLACE (never deleted and
 *    re-inserted), so the account never passes through `total === 0`.
 */
router.post('/rotate/complete', rotateCompleteLimiter, validate({ body: rotateKeyCompleteRequestSchema }), asyncHandler(async (req: AuthRequest, res: Response) => {
  const userId = req.user?._id?.toString();
  if (!userId) {
    throw new BadRequestError('User not authenticated');
  }

  const { newPublicKey, challenge, signature, newKeyProof, timestamp, signOutEverywhere } = req.body as RotateKeyCompleteRequest;
  const safeNewPublicKey = newPublicKey.trim();

  // Defense-in-depth: pin the query-bound `challenge` to a primitive string,
  // independent of the upstream Zod validation. Mirrors the explicit string
  // guards in POST /auth/link.
  if (typeof challenge !== 'string') {
    throw new BadRequestError('challenge must be a string');
  }

  const db = getDb();

  // Load the authoritative account row (for the server-derived old key).
  const [account] = await db
    .select({ publicKey: users.publicKey })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (!account) {
    throw new BadRequestError('User not found');
  }

  // 1. oldPublicKey is derived from the USER ROW — never client-supplied.
  const oldPublicKey = account.publicKey;
  if (!oldPublicKey) {
    throw new BadRequestError('No identity key is linked to this account — nothing to rotate.');
  }

  // Structural guards on the incoming new key.
  if (!SignatureService.isValidPublicKey(safeNewPublicKey)) {
    throw new BadRequestError('newPublicKey is not a valid public key');
  }

  // Canonicalize BOTH keys (uncompressed, lowercased). The differ-check, the
  // uniqueness query, and the write all operate on the canonical form so a
  // re-encoded (compressed / re-cased) duplicate can never slip past them.
  const canonicalNewPublicKey = SignatureService.canonicalizePublicKey(safeNewPublicKey);
  const canonicalOldPublicKey = SignatureService.canonicalizePublicKey(oldPublicKey);
  if (canonicalNewPublicKey === canonicalOldPublicKey) {
    throw new BadRequestError('newPublicKey must differ from the current identity key');
  }

  // 2. Timestamp freshness (recent, modest client clock skew) — BEFORE the burn, so a
  //    stale-but-otherwise-valid request cannot consume its own challenge.
  if (!SignatureService.isTimestampFresh(timestamp, ROTATE_SIGNATURE_MAX_AGE_MS)) {
    throw new BadRequestError('Signature expired or invalid timestamp — please try again');
  }

  // 3. Verify the client signature proves control of the CURRENT key BEFORE
  //    burning the challenge (mirrors signin verifyChallenge). The signed bytes
  //    use the canonical old key so compressed/legacy encodings still match.
  const message = JSON.stringify({
    action: 'rotate_key',
    userId,
    oldPublicKey: canonicalOldPublicKey,
    newPublicKey: safeNewPublicKey,
    challenge,
    timestamp,
  });
  if (!SignatureService.verifySignature(message, signature, oldPublicKey)) {
    throw new BadRequestError('Invalid signature — cannot verify control of the current key');
  }

  // 4. Verify proof-of-possession of the NEW key. Without this, an attacker
  //    could rotate their OWN account to a re-encoding of a victim's key (read
  //    from the public DID) — passing the uniqueness check but never controlling
  //    the private key. Requiring the new key to sign closes that.
  const newKeyMessage = JSON.stringify({
    action: 'rotate_key_new',
    userId,
    newPublicKey: safeNewPublicKey,
    challenge,
    timestamp,
  });
  if (!SignatureService.verifySignature(newKeyMessage, newKeyProof, safeNewPublicKey)) {
    throw new BadRequestError('Invalid new-key proof — cannot verify possession of the new key');
  }

  // 5. Reject if the (canonical) new key already belongs to another account.
  const [conflict] = await db
    .select({ id: users.id })
    .from(users)
    .where(publicKeyMatches(canonicalNewPublicKey))
    .limit(1);
  if (conflict && conflict.id !== userId) {
    throw new ConflictError('This identity is already linked to another account');
  }

  // 6. Atomically burn the rotate_key challenge (single-use, purpose-scoped,
  //    bound to the account's CURRENT key). One conditional UPDATE: if it
  //    changes no row the challenge was never minted for rotation, was for a
  //    different key, is EXPIRED, or was already consumed — reject in every
  //    case. The `expires_at` predicate is not delegated to the expiry sweep;
  //    the sweep lags, and a challenge outliving its deadline is spendable for
  //    that whole window.
  const burned = await db
    .update(authChallenges)
    .set({ used: true })
    .where(
      and(
        eq(authChallenges.challenge, challenge),
        eq(authChallenges.publicKey, oldPublicKey),
        eq(authChallenges.used, false),
        eq(authChallenges.purpose, 'rotate_key'),
        gt(authChallenges.expiresAt, new Date()),
      ),
    )
    .returning({ id: authChallenges.id });
  if (burned.length === 0) {
    throw new UnauthorizedError('Invalid or expired rotation challenge');
  }

  // 7. ATOMIC REPLACE, in one transaction: swap `users.public_key`, replace the
  //    single identity `user_auth_methods` row IN PLACE, and drop the stale
  //    encrypted backup. The identity row is UPDATEd rather than deleted and
  //    re-inserted, so the account never passes through zero auth methods; and
  //    because the backup delete rides the same transaction, a committed swap
  //    can no longer leave behind a backup that still holds the OLD key under
  //    the OLD phrase's locator (from which restore would silently import a
  //    stale identity).
  try {
    await db.transaction(async (tx) => {
      const replaced = await tx
        .update(userAuthMethods)
        .set({ methodPublicKey: canonicalNewPublicKey, linkedAt: new Date() })
        .where(and(eq(userAuthMethods.userId, userId), eq(userAuthMethods.type, 'identity')))
        .returning({ id: userAuthMethods.id });
      if (replaced.length === 0) {
        // The account holds a `users.public_key` with no matching method row
        // (possible for a pre-`authMethods` account). Adding the row is still a
        // net INCREASE in methods, so the zero-method window does not open.
        await tx.insert(userAuthMethods).values({
          userId,
          type: 'identity',
          methodPublicKey: canonicalNewPublicKey,
        });
      }

      await tx.update(users).set({ publicKey: canonicalNewPublicKey }).where(eq(users.id, userId));

      await tx.delete(identityBackups).where(eq(identityBackups.userId, userId));
    });
  } catch (error) {
    // The read-then-check in step 5 is not atomic with this write; the unique
    // indexes on both key columns are, so a key that was claimed elsewhere in
    // between answers the SAME 409 rather than a 500.
    if (isUniqueViolation(error)) {
      throw new ConflictError('This identity is already linked to another account');
    }
    throw error;
  }
  userCache.invalidate(userId);

  // 8. Optional: revoke every OTHER session (the rotating device stays signed
  //    in) when the caller suspects the old key is compromised.
  if (signOutEverywhere) {
    await revokeOtherSessions(req, userId);
  }

  const response = rotateKeyCompleteResponseSchema.parse({
    success: true,
    publicKey: canonicalNewPublicKey,
    message: 'Identity key rotated successfully',
  });
  res.json(response);
}));

/**
 * POST /api/auth/link
 * Link a root (`publicKey`) to a personal account that has NONE — first link only
 * (ADR 0024 D8). Both factors in one request; linking Commons from another device
 * relays them through `routes/identityLink.ts`. Either way `linkRootToAccount`.
 *
 * - An account whose root is this key: idempotent with a root proof, and heals a
 *   missing `identity` method row.
 * - An account with a DIFFERENT root: 409. Replacing a root is
 *   `POST /auth/rotate/*`, which needs the old root's proof too.
 * - A keyless account: refused here. Its first link goes through
 *   `routes/identityLink.ts`, confirmed by a code sent to its email (plus its
 *   authenticator); a bearer plus a key generated a moment ago is not
 *   authority.
 */
router.post('/link', validate({ body: linkAuthMethodSchema }), asyncHandler(async (req: AuthRequest, res: Response) => {
  const userId = req.user?._id?.toString();
  if (!userId) {
    throw new BadRequestError('User not authenticated');
  }

  const body = req.body as LinkAuthMethodBody;
  // Mongoose's `lowercase: true` setter on `publicKey` has no Postgres
  // counterpart, so the normalization it performed is re-applied here.
  const safePublicKey = body.publicKey.trim().toLowerCase();
  if (!SignatureService.isValidPublicKey(safePublicKey)) {
    throw new BadRequestError('publicKey is not a valid public key');
  }

  try {
    await getDb().transaction((tx) =>
      linkRootToAccount(tx, { userId, publicKey: safePublicKey, proof: body.proof }),
    );
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new ApiError(409, 'This identity is already linked to another account', IDENTITY_ERROR_CODES.rootLinkedElsewhere);
    }
    throw error;
  }

  userCache.invalidate(userId);
  res.json({ success: true, message: 'Identity linked successfully' });
}));

export default router;
