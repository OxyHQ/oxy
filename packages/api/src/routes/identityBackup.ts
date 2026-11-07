/**
 * Encrypted off-device identity backup routes (b3 Feature 1).
 *
 * Mounted at `/identity/backup`:
 *  - `POST   /identity/backup`            (bearer) upsert the encrypted backup
 *  - `GET    /identity/backup/status`     (bearer) does the caller have a backup?
 *  - `DELETE /identity/backup`            (bearer) delete the caller's backup
 *  - `GET    /identity/backup/:lookupId`  (PUBLIC) fetch the envelope by locator
 *
 * Zero-knowledge: the server persists ONLY ciphertext + `sha256(lookupId)`. It
 * never sees the recovery phrase, the derived backup key, the plaintext private
 * key, or the raw `lookupId`.
 *
 * The `:lookupId` restore endpoint is PUBLIC because possession of the 256-bit
 * locator (which itself requires the full BIP-39 seed to compute) IS the
 * authorization — a signed-out device recovering from the phrase alone has no
 * bearer token. Its real protection is that entropy; the hash-and-lookup +
 * constant-shape 404 are defense-in-depth against enumeration. No bearer writes
 * carry ambient cookies, so this router is mounted without CSRF.
 *
 * Both WRITES are the account's own (security review R7-1): the backup is the
 * only off-device copy of the person's retired keys, so a third-party
 * application's session or an application token (ADR 0058) may neither replace
 * nor delete it (`requireFirstPartyDeviceAccess`, as `/identity/key-history`).
 */
import { Router, type Request, type Response } from 'express';
import crypto from 'node:crypto';
import { and, eq, gt, isNull, lte, or } from 'drizzle-orm';
import { isValidSecp256k1PublicKey, normalizeSecp256k1PublicKey } from '@oxy.so/protocol/secp256k1';
import { authMiddleware, type AuthRequest } from '../middleware/auth';
import { requireFirstPartyDeviceAccess } from '../middleware/firstPartyDeviceAccess';
import { asyncHandler } from '../utils/asyncHandler';
import {
  ApiError,
  ConflictError,
  NotFoundError,
  UnauthorizedError,
  BadRequestError,
} from '../utils/error';
import { validate } from '../middleware/validate';
import { rateLimit } from '../middleware/rateLimiter';
import { hashedIpKey } from '../utils/ipKey';
import {
  IDENTITY_BACKUP_MAX_VERSION,
  IDENTITY_ERROR_CODES,
  backupUploadRequestSchema,
  backupLookupIdSchema,
  type BackupUploadRequest,
  type BackupStatusResponse,
  type EncryptedBackupEnvelope,
} from '@oxy.so/contracts';
import { getDb } from '../config/postgres';
import { identityBackups } from '../db/schema/identityBackups';
import { users } from '../db/schema/users';
import { isUniqueViolation } from '@oxy.so/db';

const router = Router();

/**
 * `sha256(lookupId)` — the ONLY form of the locator that is ever stored or
 * compared. The raw `lookupId` (256-bit, derived from the full seed) is
 * discarded after hashing, so a DB dump cannot recompute a locator.
 */
function lookupIdHashOf(rawLookupId: string): string {
  return crypto.createHash('sha256').update(rawLookupId).digest('hex');
}

/**
 * The stored fields the public envelope is projected from.
 *
 * `clientCreatedAt` is `text`, not a `timestamptz`: it holds the CLIENT's
 * ISO-8601 snapshot time byte for byte, because the restore endpoint's contract
 * is to hand back the exact envelope that was uploaded. Parsing it into a
 * timestamp would re-render it in a different string form on read.
 */
interface StoredEnvelopeFields {
  version: number;
  kdfInfo: string;
  nonce: string;
  ciphertext: string;
  publicKeyHint: string;
  clientCreatedAt: string;
  supersededAt: Date | null;
}

/** The columns `toEnvelope` needs — named explicitly, never a whole-row read. */
const ENVELOPE_COLUMNS = {
  version: identityBackups.version,
  kdfInfo: identityBackups.kdfInfo,
  nonce: identityBackups.nonce,
  ciphertext: identityBackups.ciphertext,
  publicKeyHint: identityBackups.publicKeyHint,
  clientCreatedAt: identityBackups.clientCreatedAt,
  supersededAt: identityBackups.supersededAt,
} as const;

/** Project a stored backup row into the public `EncryptedBackupEnvelope`. */
function toEnvelope(doc: StoredEnvelopeFields): EncryptedBackupEnvelope {
  return {
    version: doc.version,
    algorithm: 'xchacha20poly1305',
    kdfInfo: doc.kdfInfo,
    nonce: doc.nonce,
    ciphertext: doc.ciphertext,
    publicKeyHint: doc.publicKeyHint,
    createdAt: doc.clientCreatedAt,
    // A key rotation replaced the root this backup holds (R6-8): restore its
    // keys as retired keys, never as the identity.
    ...(doc.supersededAt ? { superseded: true } : {}),
  };
}

/**
 * Public restore-lookup limiter (IP-keyed — the endpoint is unauthenticated).
 * Bounds brute-force scanning of the locator space (already 256-bit, so this is
 * defense-in-depth, not the primary control).
 */
const publicRestoreLimiter = rateLimit({
  prefix: 'rl:identity:backup:',
  windowMs: 60 * 1000,
  max: 30,
  message: 'Too many backup lookups. Please try again shortly.',
  keyGenerator: (req: Request): string => `identity:backup:ip:${hashedIpKey(req)}`,
});

/** Per-user write budget for backup upserts (ciphertext can be large). */
const backupWriteLimiter = rateLimit({
  prefix: 'rl:identity:backup:write:',
  windowMs: 60 * 60 * 1000,
  max: 20,
  message: 'Too many backup uploads. Please try again later.',
  keyGenerator: (req: Request): string => {
    const userId = (req as AuthRequest).user?.id;
    return userId
      ? `identity:backup:write:${userId}`
      : `identity:backup:write:ip:${hashedIpKey(req)}`;
  },
});

/** Per-user delete budget — idempotent but should not be hammered. */
const backupDeleteLimiter = rateLimit({
  prefix: 'rl:identity:backup:delete:',
  windowMs: 60 * 60 * 1000,
  max: 10,
  message: 'Too many backup delete requests. Please try again later.',
  keyGenerator: (req: Request): string => {
    const userId = (req as AuthRequest).user?.id;
    return userId
      ? `identity:backup:delete:${userId}`
      : `identity:backup:delete:ip:${hashedIpKey(req)}`;
  },
});

/** The shortest `publicKeyHint` the root check accepts (clients send 16 hex characters). */
const MIN_PUBLIC_KEY_HINT_LENGTH = 16;

/**
 * Throw 409 unless `publicKeyHint` names the account's CURRENT root (R6-9). The
 * root is compared in its canonical spelling (uncompressed, lowercase), the one
 * the client derives the hint from. An account with no root (a keyless account)
 * has nothing to compare and is not refused.
 */
async function assertSealedUnderCurrentRoot(userId: string, publicKeyHint: string): Promise<void> {
  const [account] = await getDb()
    .select({ publicKey: users.publicKey })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  const root = account?.publicKey?.trim();
  if (!root) return;
  const canonical = isValidSecp256k1PublicKey(root)
    ? normalizeSecp256k1PublicKey(root)
    : root.toLowerCase();
  const hint = publicKeyHint.trim().toLowerCase();
  if (hint.length < MIN_PUBLIC_KEY_HINT_LENGTH || !canonical.startsWith(hint)) {
    throw new ConflictError(
      "This backup is not of the account's current key: create it again with your current recovery phrase.",
    );
  }
}

/**
 * POST /identity/backup — create or REPLACE the caller's encrypted backup.
 * Upsert by `userId`, so a re-upload never accumulates duplicates. The raw
 * `lookupId` from the body is hashed before storage; only the hash is persisted.
 *
 * Never DOWNGRADED (round-5 review R5-9): an upload whose envelope `version`
 * is LOWER than the stored one is refused with 409 and the stored backup is
 * kept. A newer payload carries more (version 2 carries the person's retired
 * keys), and an older Commons would otherwise replace it with one that drops
 * them. The comparison is part of the same upsert statement, so two racing
 * writers cannot interleave a downgrade.
 *
 * Only under the CURRENT root (security review R6-9): an upload whose
 * `publicKeyHint` is not the prefix of the account's root is refused with 409.
 * A backup sealed with a stale phrase (a slot that still held the phrase of a
 * rotated-away key) backs up a retired key, and would replace the backup of
 * the key the account signs in with. An account without a root is not checked.
 *
 * First-party only, and the version is bounded (R7-1): a third party's bearer
 * is refused before anything is read, and the contract refuses a version above
 * `IDENTITY_BACKUP_MAX_VERSION`. A stored row ABOVE that maximum was never
 * written by a client (an upload made before the bound existed), so it never
 * blocks a legitimate upload: it is replaced like an older version.
 *
 * Never over a SUPERSEDED backup without its acknowledgement (R7-2): a backup
 * a key rotation kept carries the person's retired keys under the previous
 * phrase, and the new phrase cannot open it. An upload replaces it only with
 * `replacesLookupId`, the superseded backup's own locator (its sha256 must be
 * the stored hash), which only a client that opened it (or carried its keys at
 * the rotation) holds. Otherwise 409 `IDENTITY_BACKUP_SUPERSEDED`, with the
 * stored backup kept. Part of the same upsert statement.
 */
router.post(
  '/',
  authMiddleware,
  requireFirstPartyDeviceAccess,
  backupWriteLimiter,
  validate({ body: backupUploadRequestSchema }),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const userId = req.user?._id;
    if (!userId) {
      throw new UnauthorizedError('Authentication required');
    }

    const body = req.body as BackupUploadRequest;
    await assertSealedUnderCurrentRoot(userId, body.publicKeyHint);
    const stored = {
      lookupIdHash: lookupIdHashOf(body.lookupId),
      publicKeyHint: body.publicKeyHint,
      ciphertext: body.ciphertext,
      nonce: body.nonce,
      algorithm: body.algorithm,
      kdfInfo: body.kdfInfo,
      version: body.version,
      clientCreatedAt: body.createdAt,
      // A backup of the current root is never superseded (R6-8).
      supersededAt: null,
    };

    try {
      const [row] = await getDb()
        .insert(identityBackups)
        .values({ userId, ...stored })
        .onConflictDoUpdate({
          target: identityBackups.userId,
          set: stored,
          setWhere: and(
            or(
              lte(identityBackups.version, body.version),
              gt(identityBackups.version, IDENTITY_BACKUP_MAX_VERSION),
            ),
            body.replacesLookupId === undefined
              ? isNull(identityBackups.supersededAt)
              : or(
                  isNull(identityBackups.supersededAt),
                  eq(identityBackups.lookupIdHash, lookupIdHashOf(body.replacesLookupId)),
                ),
          ),
        })
        .returning({
          publicKeyHint: identityBackups.publicKeyHint,
          clientCreatedAt: identityBackups.clientCreatedAt,
        });
      if (!row) {
        // The caller's row exists and the guard kept it: superseded without
        // its acknowledgement, or a NEWER envelope version.
        const [kept] = await getDb()
          .select({ supersededAt: identityBackups.supersededAt })
          .from(identityBackups)
          .where(eq(identityBackups.userId, userId))
          .limit(1);
        if (kept?.supersededAt) {
          throw new ApiError(
            409,
            'Your previous backup holds keys from before your last key change: open it with your previous recovery phrase first.',
            IDENTITY_ERROR_CODES.backupSuperseded,
          );
        }
        throw new ConflictError(
          'A newer version of the app wrote this backup. Update the app to replace it.',
        );
      }

      const payload: BackupStatusResponse = {
        exists: true,
        publicKeyHint: row.publicKeyHint,
        createdAt: row.clientCreatedAt,
      };
      res.status(200).json(payload);
    } catch (err) {
      // The caller's OWN row is handled by `onConflictDoUpdate`, so the only
      // unique index left to fire is the locator one — a `lookupIdHash`
      // collision with a DIFFERENT user's backup. Astronomically unlikely at
      // 256-bit entropy; never silently overwrite another user's record —
      // surface a clean conflict. Named, so a future index on this table cannot
      // quietly start answering 409.
      if (isUniqueViolation(err, 'identity_backups_lookup_id_hash_key')) {
        throw new ConflictError('Backup locator already in use.');
      }
      throw err;
    }
  }),
);

/**
 * GET /identity/backup/status — whether the caller has a backup of its CURRENT
 * root, plus the non-sensitive hint + timestamp when one exists. No ciphertext,
 * no locator. A backup a key rotation superseded (R6-8) is not one of the
 * current root (`exists: false`), and is told apart from none (R7-2):
 * `superseded: true` with its hint and timestamp, so the client knows a new
 * backup must acknowledge it.
 */
router.get(
  '/status',
  authMiddleware,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const userId = req.user?._id;
    if (!userId) {
      throw new UnauthorizedError('Authentication required');
    }

    const [row] = await getDb()
      .select({
        publicKeyHint: identityBackups.publicKeyHint,
        clientCreatedAt: identityBackups.clientCreatedAt,
        supersededAt: identityBackups.supersededAt,
      })
      .from(identityBackups)
      .where(eq(identityBackups.userId, userId))
      .limit(1);

    // A superseded backup (R6-8) holds a retired root: the account's CURRENT
    // key has no backup, so the client is asked to create one, acknowledging
    // the superseded one (R7-2).
    const payload: BackupStatusResponse = !row
      ? { exists: false }
      : row.supersededAt
        ? {
            exists: false,
            superseded: true,
            publicKeyHint: row.publicKeyHint,
            createdAt: row.clientCreatedAt,
          }
        : { exists: true, publicKeyHint: row.publicKeyHint, createdAt: row.clientCreatedAt };
    res.status(200).json(payload);
  }),
);

/**
 * DELETE /identity/backup — remove the caller's backup. Idempotent (deleting a
 * non-existent backup still returns success). First-party only (R7-1).
 */
router.delete(
  '/',
  authMiddleware,
  requireFirstPartyDeviceAccess,
  backupDeleteLimiter,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const userId = req.user?._id;
    if (!userId) {
      throw new UnauthorizedError('Authentication required');
    }

    await getDb().delete(identityBackups).where(eq(identityBackups.userId, userId));
    res.status(200).json({ success: true });
  }),
);

/**
 * GET /identity/backup/:lookupId — PUBLIC restore fetch. Hash the supplied raw
 * locator and return the matching envelope, or a constant-shape 404. No user
 * enumeration is possible: the response reveals only found/not-found, gated by
 * the locator's 256-bit entropy. A superseded backup (R6-8) is still served —
 * its phrase is the only way to the retired keys it carries — with
 * `superseded: true`.
 */
router.get(
  '/:lookupId',
  publicRestoreLimiter,
  asyncHandler(async (req: Request, res: Response) => {
    const parsed = backupLookupIdSchema.safeParse(req.params.lookupId);
    if (!parsed.success) {
      throw new BadRequestError('Invalid backup locator');
    }
    const [row] = await getDb()
      .select(ENVELOPE_COLUMNS)
      .from(identityBackups)
      .where(eq(identityBackups.lookupIdHash, lookupIdHashOf(parsed.data)))
      .limit(1);
    if (!row) {
      throw new NotFoundError('Backup not found');
    }
    res.status(200).json(toEnvelope(row));
  }),
);

export default router;
