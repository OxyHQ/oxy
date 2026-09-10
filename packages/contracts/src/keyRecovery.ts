/**
 * Encrypted off-device identity backup contract (b3 Feature 1).
 *
 * SINGLE SOURCE OF TRUTH for the "encrypted identity backup" flow, where a
 * client stores an encrypted copy of its self-custody identity key off-device so
 * a lost/wiped device can be recovered from the recovery phrase ALONE — without
 * the platform ever seeing the phrase, the derived encryption key, or the
 * plaintext private key.
 *
 * Zero-knowledge design (mirrors the zero-cookie `DeviceSession.secretHash`
 * pattern): the client derives, from the FULL 64-byte BIP-39 seed, both an
 * encryption key (`backupKey`) and a locator (`lookupId`) via HKDF with
 * domain-separated `info` labels. It uploads ONLY the XChaCha20-Poly1305
 * ciphertext plus the raw `lookupId`; the server stores the ciphertext and
 * `sha256(lookupId)` (never the raw `lookupId`). Restoration re-derives both
 * from the phrase, fetches the envelope by `lookupId`, and decrypts locally.
 *
 * The server can neither locate a backup (it lacks the seed to compute the
 * lookup id) nor decrypt one (it lacks the seed to compute the backup key) — a
 * DB dump yields only opaque ciphertext keyed by an un-invertible hash.
 *
 * The producer (`@oxy.so/api`) validates its request/response against these
 * schemas; the consumer (`@oxy.so/core` identity-backup mixin) validates its
 * input against the same definitions, so the wire shape cannot drift.
 *
 * All shapes here are FLAT (no nested objects), so `z.infer<>` is safe under a
 * consumer's node10 `moduleResolution`. Platform-agnostic — zod only, ESM-safe
 * (no `require()`).
 */
import { z } from 'zod';

/** 256-bit backup locator (32 bytes), lowercase/uppercase hex. */
export const backupLookupIdSchema = z
    .string()
    .trim()
    .regex(/^[0-9a-fA-F]{64}$/, 'lookupId must be 64 hex characters');

/**
 * The stored, self-describing encrypted backup as it lives at rest and travels
 * on the public restore endpoint. Contains NO secret and NO locator: the
 * `lookupId` is uploaded separately (see {@link backupUploadRequestSchema}) and
 * only its hash is ever persisted.
 *
 * - `version`       — envelope/KDF version, so a future scheme migration is
 *   distinguishable at rest.
 * - `algorithm`     — the AEAD used. Pinned literal so a mismatched decryptor
 *   fails loudly rather than silently.
 * - `kdfInfo`       — the HKDF `info` label used to derive the encryption key
 *   (domain-separation tag; documents exactly which context produced the key).
 * - `nonce`         — the 24-byte XChaCha20-Poly1305 nonce, hex.
 * - `ciphertext`    — the encrypted `{privateKey, publicKey, createdAt}` payload
 *   with the appended Poly1305 tag, hex.
 * - `publicKeyHint` — a short, non-sensitive prefix of the backed-up identity's
 *   public key, so the owner can recognise WHICH identity a backup belongs to
 *   without exposing the full key. Bound into the AEAD associated data.
 * - `createdAt`     — ISO-8601 creation timestamp.
 */
export const encryptedBackupEnvelopeSchema = z.object({
    version: z.number().int().positive(),
    algorithm: z.literal('xchacha20poly1305'),
    kdfInfo: z.string().min(1),
    nonce: z.string().trim().min(1),
    ciphertext: z.string().trim().min(1),
    publicKeyHint: z.string().trim().min(1),
    createdAt: z.string().trim().min(1),
});

export type EncryptedBackupEnvelope = z.infer<typeof encryptedBackupEnvelopeSchema>;

/**
 * Request body of `POST /identity/backup` — the envelope PLUS the raw
 * `lookupId`. The server sha256-hashes `lookupId` before storing it (it never
 * persists the raw value), and upserts by the authenticated user id so a
 * re-upload REPLACES the prior backup rather than accumulating duplicates.
 */
export const backupUploadRequestSchema = encryptedBackupEnvelopeSchema.extend({
    /**
     * The raw 256-bit backup locator (hex), derived client-side from the seed
     * with a domain-separated HKDF `info`. The server stores ONLY its sha256; a
     * DB dump therefore cannot recompute a locator to enumerate backups.
     */
    lookupId: backupLookupIdSchema,
});

export type BackupUploadRequest = z.infer<typeof backupUploadRequestSchema>;

/**
 * Response of `GET /identity/backup/status` (and the write/delete acks): whether
 * the authenticated user has a stored backup, plus the non-sensitive hint +
 * timestamp when one exists. Carries no ciphertext and no locator.
 */
export const backupStatusResponseSchema = z.object({
    exists: z.boolean(),
    publicKeyHint: z.string().optional(),
    createdAt: z.string().optional(),
});

export type BackupStatusResponse = z.infer<typeof backupStatusResponseSchema>;
