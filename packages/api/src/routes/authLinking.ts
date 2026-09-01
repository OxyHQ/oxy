/**
 * Auth Linking Routes
 *
 * Endpoints for linking multiple authentication methods to a single user account.
 * Allows users to:
 * - Link an identity (publicKey) to an existing account
 * - View and manage linked auth methods
 * - Unlink an identity or an individual passkey (webauthn)
 *
 * ## Storage (Postgres)
 *
 * The `authMethods[]` subdocument array is now the CHILD TABLE
 * `user_auth_methods`, so "push an entry" is an INSERT, "filter the array" is a
 * DELETE, and "replace the identity entry in place" is an UPDATE of exactly one
 * row. Three consequences worth stating, because each is a behaviour the Mongo
 * version could not have:
 *
 * - **The last-auth-method guard runs under a row lock.** The count and the
 *   delete happen in ONE transaction that takes `select … for update` on the
 *   account row first, so two concurrent unlinks can no longer both observe
 *   "two methods remain" and leave the account with zero.
 * - **The rotation swap is one transaction** covering the `users.public_key`
 *   write, the in-place identity-row replacement, AND the stale
 *   `identity_backups` delete — a committed swap can no longer leave a backup
 *   that still holds the OLD key behind.
 * - **A key already linked elsewhere is caught by a unique index**
 *   (`users_lower_public_key_key`, `user_auth_methods_lower_method_public_key_key`)
 *   as well as by the read-then-check, so the read/write race answers 409 rather
 *   than 500.
 */

import { Router, type Request, type Response } from 'express';
import { and, count, eq, gt, ne, sql } from 'drizzle-orm';
import { authMiddleware, type AuthRequest } from '../middleware/auth.js';
import { getDb, type Database } from '../config/postgres.js';
import { authChallenges } from '../db/schema/authChallenges.js';
import { identityBackups } from '../db/schema/identityBackups.js';
import { sessions } from '../db/schema/sessions.js';
import { userAuthMethods } from '../db/schema/userAuthMethods.js';
import { users } from '../db/schema/users.js';
import { webauthnCredentials } from '../db/schema/webauthnCredentials.js';
import SignatureService from '../services/signature.service.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { BadRequestError, ConflictError, UnauthorizedError } from '../utils/error.js';
import { validate } from '../middleware/validate.js';
import { linkAuthMethodSchema, unlinkTypeParams, unlinkWebauthnParams } from '../schemas/authLinking.schemas.js';
import sessionService from '../services/session.service.js';
import { rateLimit } from '../middleware/rateLimiter.js';
import { hashedIpKey } from '../utils/ipKey.js';
import { isUniqueViolation } from '../utils/postgresErrors.js';
import { extractTokenFromRequest, decodeToken } from '../middleware/authUtils.js';
import userCache from '../utils/userCache.js';
import { buildUserDid } from '../services/did.service.js';
import { buildAuthMethodEntries } from '../utils/authMethodEntries.js';
import {
  authMethodsResponseSchema,
  rotateKeyChallengeResponseSchema,
  rotateKeyCompleteRequestSchema,
  rotateKeyCompleteResponseSchema,
  type RotateKeyCompleteRequest,
} from '@oxyhq/contracts';

const router = Router();

/**
 * Anything that can run a query — the pool handle or an open transaction. Every
 * helper below takes one so the SAME read serves an ordinary request and a read
 * INSIDE a transaction; without it a guard would have to re-read through the
 * pool and could observe pre-transaction state, which is exactly the lost update
 * the transaction exists to prevent.
 */
type Queryable = Database | Parameters<Parameters<Database['transaction']>[0]>[0];

/** The account's authentication posture, as the unlink guards read it. */
interface AuthPosture {
  /** The linked identity key, or null when the account is custodial. */
  publicKey: string | null;
  /** How many passkeys the account holds. */
  webauthnCount: number;
  /**
   * The account's distinct authentication methods: the identity key AND each
   * registered passkey. The unlink guards keep this at ≥1 after a removal —
   * taking the last one would lock the user out.
   */
  total: number;
}

/**
 * Read the account's auth-method posture, LOCKING the account row.
 *
 * `for('update')` is the whole point: the guard is a check-then-act, so without
 * the lock two concurrent unlinks each read "2 methods" and each delete one,
 * ending at zero. The lock serializes them, and the loser re-reads "1 method"
 * and is refused. Returns null when the account does not exist.
 */
async function readAuthPosture(db: Queryable, userId: string): Promise<AuthPosture | null> {
  const [account] = await db
    .select({ publicKey: users.publicKey })
    .from(users)
    .where(eq(users.id, userId))
    .for('update')
    .limit(1);
  if (!account) return null;

  const [passkeys] = await db
    .select({ value: count() })
    .from(userAuthMethods)
    .where(and(eq(userAuthMethods.userId, userId), eq(userAuthMethods.type, 'webauthn')));

  const webauthnCount = passkeys?.value ?? 0;
  return {
    publicKey: account.publicKey,
    webauthnCount,
    total: (account.publicKey ? 1 : 0) + webauthnCount,
  };
}

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
 * GET /api/auth/methods
 * Get the account DID and all linked authentication methods for the current
 * user, shaped to the `authMethodsResponseSchema` contract. Identity methods
 * carry their DID verification-method id (`#key-1`); passkeys carry none.
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
      methodCredentialId: userAuthMethods.methodCredentialId,
      methodName: userAuthMethods.methodName,
    })
    .from(userAuthMethods)
    .where(eq(userAuthMethods.userId, userId))
    .orderBy(userAuthMethods.linkedAt, userAuthMethods.id);

  const response = authMethodsResponseSchema.parse({
    did: buildUserDid(userId),
    // `buildAuthMethodEntries` is shared with the signed data export and still
    // reads the `metadata.*` shape the subdocument had; the child-table columns
    // are adapted to it HERE rather than by changing a helper two routes depend
    // on.
    methods: buildAuthMethodEntries({
      publicKey: account.publicKey,
      authMethods: methods.map((method) => ({
        type: method.type,
        linkedAt: method.linkedAt,
        metadata: { credentialID: method.methodCredentialId, name: method.methodName },
      })),
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
 * Link an identity (publicKey) to the current user account.
 */
router.post('/link', validate({ body: linkAuthMethodSchema }), asyncHandler(async (req: AuthRequest, res: Response) => {
  const userId = req.user?._id?.toString();
  if (!userId) {
    throw new BadRequestError('User not authenticated');
  }

  const { type, publicKey, signature, timestamp } = req.body;

  // Validate type is a non-empty string before it decides a branch.
  if (typeof type !== 'string' || !type.trim()) {
    throw new BadRequestError('Auth method type is required and must be a string');
  }
  const safeType = type.trim();

  const db = getDb();
  const [account] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (!account) {
    throw new BadRequestError('User not found');
  }

  if (safeType !== 'identity') {
    throw new BadRequestError(`Unknown auth method type: ${safeType}`);
  }

  // Link identity (publicKey) to account
  if (!publicKey || !signature || !timestamp) {
    throw new BadRequestError('publicKey, signature, and timestamp are required for identity linking');
  }

  // Validate publicKey is a non-empty string before it reaches a query.
  if (typeof publicKey !== 'string' || !publicKey.trim()) {
    throw new BadRequestError('publicKey must be a non-empty string');
  }
  // Mongoose's `lowercase: true` setter on `publicKey` has no Postgres
  // counterpart, so the normalization it performed is re-applied here — without
  // it a mixed-case key would be stored in a form the identifier index and every
  // later lookup canonicalize differently.
  const safePublicKey = publicKey.trim().toLowerCase();

  // Check if publicKey is already used by another user
  const [existingUser] = await db
    .select({ id: users.id })
    .from(users)
    .where(publicKeyMatches(safePublicKey))
    .limit(1);
  if (existingUser && existingUser.id !== userId) {
    throw new ConflictError('This identity is already linked to another account');
  }

  // Verify signature proves ownership of the private key
  const message = JSON.stringify({
    action: 'link_identity',
    userId,
    timestamp,
  });

  const isValid = SignatureService.verifySignature(message, signature, safePublicKey);
  if (!isValid) {
    throw new BadRequestError('Invalid signature - cannot verify identity ownership');
  }

  // Check timestamp is recent (within 5 minutes), allowing modest client clock skew
  if (!SignatureService.isTimestampFresh(timestamp)) {
    throw new BadRequestError('Signature expired or invalid timestamp - please try again');
  }

  // The key on the account and its `user_auth_methods` row are ONE fact, so they
  // are written together — a committed `users.public_key` with no method row
  // would be invisible to `GET /auth/methods` and to the unlink guard.
  try {
    await db.transaction(async (tx) => {
      await tx.update(users).set({ publicKey: safePublicKey }).where(eq(users.id, userId));

      const [existingMethod] = await tx
        .select({ id: userAuthMethods.id })
        .from(userAuthMethods)
        .where(and(eq(userAuthMethods.userId, userId), eq(userAuthMethods.type, 'identity')))
        .limit(1);
      if (!existingMethod) {
        await tx.insert(userAuthMethods).values({
          userId,
          type: 'identity',
          methodPublicKey: safePublicKey,
        });
      }
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new ConflictError('This identity is already linked to another account');
    }
    throw error;
  }

  userCache.invalidate(userId);
  res.json({ success: true, message: 'Identity linked successfully' });
}));

/**
 * DELETE /api/auth/link/webauthn/:credentialID
 * Unlink ONE passkey (by its public credential id) from the current account.
 * Passkeys are per-credential, so this needs the specific id rather than the
 * generic per-type unlink. Removes the `user_auth_methods` row AND the
 * `webauthn_credentials` row, keeping at least one usable auth method overall.
 *
 * Registered BEFORE `DELETE /link/:type` so the two-segment webauthn path is not
 * shadowed by the single-segment `:type` route.
 */
router.delete('/link/webauthn/:credentialID', validate({ params: unlinkWebauthnParams }), asyncHandler(async (req: AuthRequest, res: Response) => {
  const userId = req.user?._id?.toString();
  if (!userId) {
    throw new BadRequestError('User not authenticated');
  }

  const { credentialID } = req.params;

  // Guard and removal share ONE transaction, and the posture read takes a row
  // lock, so the "keep ≥1 auth method" check cannot be raced by a concurrent
  // unlink of the account's other method.
  await getDb().transaction(async (tx) => {
    const posture = await readAuthPosture(tx, userId);
    if (!posture) {
      throw new BadRequestError('User not found');
    }

    // The passkey must belong to the caller (its public id alone is not proof of
    // ownership — scope the lookup by userId).
    const [credential] = await tx
      .select({ id: webauthnCredentials.id })
      .from(webauthnCredentials)
      .where(
        and(
          eq(webauthnCredentials.credentialID, credentialID),
          eq(webauthnCredentials.userId, userId),
        ),
      )
      .limit(1);
    if (!credential) {
      throw new BadRequestError('No such passkey is linked to this account');
    }

    // Removing the last remaining auth method would lock the account out.
    if (posture.total <= 1) {
      throw new BadRequestError('Cannot unlink last authentication method - account would become inaccessible');
    }

    await tx
      .delete(userAuthMethods)
      .where(
        and(
          eq(userAuthMethods.userId, userId),
          eq(userAuthMethods.type, 'webauthn'),
          eq(userAuthMethods.methodCredentialId, credentialID),
        ),
      );
    await tx.delete(webauthnCredentials).where(eq(webauthnCredentials.id, credential.id));
  });

  userCache.invalidate(userId);

  res.json({ success: true, message: 'Passkey unlinked successfully' });
}));

/**
 * DELETE /api/auth/link/:type
 * Unlink an authentication method from the current user account.
 * Must keep at least one auth method. Only `identity` is unlinkable by type —
 * passkeys are per-credential (see the webauthn route above).
 */
router.delete('/link/:type', validate({ params: unlinkTypeParams }), asyncHandler(async (req: AuthRequest, res: Response) => {
  const userId = req.user?._id?.toString();
  if (!userId) {
    throw new BadRequestError('User not authenticated');
  }

  const { type } = req.params;
  if (type !== 'identity') {
    throw new BadRequestError(`Invalid auth method type: ${type}`);
  }

  // Same shape as the passkey unlink: the guard and the removal are one
  // transaction over a locked account row.
  await getDb().transaction(async (tx) => {
    const posture = await readAuthPosture(tx, userId);
    if (!posture) {
      throw new BadRequestError('User not found');
    }

    if (posture.total <= 1) {
      throw new BadRequestError('Cannot unlink last authentication method - account would become inaccessible');
    }

    if (!posture.publicKey) {
      throw new BadRequestError('No identity is linked to this account');
    }

    await tx.update(users).set({ publicKey: null }).where(eq(users.id, userId));
    await tx
      .delete(userAuthMethods)
      .where(and(eq(userAuthMethods.userId, userId), eq(userAuthMethods.type, 'identity')));
  });

  userCache.invalidate(userId);
  res.json({ success: true, message: `${type} auth unlinked successfully` });
}));

export default router;
