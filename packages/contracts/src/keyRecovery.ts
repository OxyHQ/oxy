import { integerCheck } from './numberChecks';
import { utf16MinLength } from './stringChecks';
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

/**
 * The highest envelope version any client writes (core's `BACKUP_ENVELOPE_VERSION`:
 * 2 carries the retired keys). An upload above it is refused (R7-1).
 */
export const IDENTITY_BACKUP_MAX_VERSION = 2;

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
const backupEnvelopeFields = z.object({
  version: z.number().check(integerCheck()).positive(),
  algorithm: z.literal('xchacha20poly1305'),
  kdfInfo: z.string().check(utf16MinLength(1)),
  nonce: z.string().trim().check(utf16MinLength(1)),
  ciphertext: z.string().trim().check(utf16MinLength(1)),
  publicKeyHint: z.string().trim().check(utf16MinLength(1)),
  createdAt: z.string().trim().check(utf16MinLength(1)),
});

/**
 * The envelope as `GET /identity/backup/:lookupId` serves it. `superseded:
 * true` (security review R6-8) marks a backup the account's key rotation
 * replaced while it carried retired keys (version >= 2): it is kept, so the
 * previous phrase still recovers the money it holds, but it backs up a key
 * that is no longer the account's root — restore its keys as RETIRED keys,
 * never as the current identity. Absent on a current backup. Never part of an
 * upload (the server decides it).
 */
export const encryptedBackupEnvelopeSchema = backupEnvelopeFields.extend({
  superseded: z.boolean().optional(),
});

export type EncryptedBackupEnvelope = z.infer<typeof encryptedBackupEnvelopeSchema>;

/**
 * Request body of `POST /identity/backup` — the envelope PLUS the raw
 * `lookupId`. The server sha256-hashes `lookupId` before storing it (it never
 * persists the raw value), and upserts by the authenticated user id so a
 * re-upload REPLACES the prior backup rather than accumulating duplicates.
 */
export const backupUploadRequestSchema = backupEnvelopeFields.extend({
  /**
   * At most {@link IDENTITY_BACKUP_MAX_VERSION} (security review R7-1): the
   * server keeps the HIGHER version of two uploads, so an envelope version no
   * client writes would refuse every later legitimate upload with 409, for
   * good. A new envelope version raises the maximum here first.
   */
  version: z.number().check(integerCheck()).positive().max(IDENTITY_BACKUP_MAX_VERSION),
  /**
   * The raw 256-bit backup locator (hex), derived client-side from the seed
   * with a domain-separated HKDF `info`. The server stores ONLY its sha256; a
   * DB dump therefore cannot recompute a locator to enumerate backups.
   */
  lookupId: backupLookupIdSchema,
  /**
   * The raw locator of a SUPERSEDED backup this upload replaces (security
   * review R7-2). A key rotation keeps the previous backup, marked superseded,
   * because it carries the person's retired keys under the previous phrase; an
   * upload replaces it only with this acknowledgement, which proves the client
   * opened it (or carried its keys at the rotation): its sha256 must be the
   * stored backup's. Without it, or with any other locator, an upload over a
   * superseded backup is refused (409 `IDENTITY_BACKUP_SUPERSEDED`). Ignored
   * when the stored backup is current or there is none.
   */
  replacesLookupId: backupLookupIdSchema.optional(),
  /**
   * The person's explicit choice to have a backup (owner's decision,
   * 2026-11-07). A person who deleted their backup (`status.optedOut`) gets a
   * new one only with it: an upload without it is refused (409
   * `IDENTITY_BACKUP_OPTED_OUT`), so a key rotation, a re-seal or another
   * device never re-uploads silently. An accepted upload with it clears the
   * deletion in the same transaction. Ignored when the person never deleted
   * one. Clients send it only from a control the person pressed ("Create
   * backup", or the rotation's "Create a backup" choice).
   */
  optIn: z.boolean().optional(),
});

export type BackupUploadRequest = z.infer<typeof backupUploadRequestSchema>;

/**
 * Response of `GET /identity/backup/status` (and the write/delete acks): whether
 * the authenticated user has a stored backup, plus the non-sensitive hint +
 * timestamp when one exists. Carries no ciphertext and no locator.
 */
export const backupStatusResponseSchema = z.object({
  exists: z.boolean(),
  /**
   * `true` when the stored backup is one a key rotation SUPERSEDED (R6-8,
   * R7-2): `exists` is `false` (the current key has no backup), and
   * `publicKeyHint` / `createdAt` describe the superseded one. A new backup
   * replaces it only with `replacesLookupId`. Absent otherwise.
   */
  superseded: z.boolean().optional(),
  /**
   * `true` when the PERSON deleted their backup (`DELETE /identity/backup`)
   * and has not chosen to create one since (owner's decision, 2026-11-07):
   * `exists` is `false`. Told apart from "never had one" (absent) and from a
   * rotation's `superseded`. Recorded on the account, so every device reads
   * it: no client re-uploads a backup without the person's explicit opt-in
   * (`optIn` on the upload). Without a backup, keys a rotation retired are
   * recoverable off this phone only with their own recovery phrases.
   */
  optedOut: z.boolean().optional(),
  publicKeyHint: z.string().optional(),
  createdAt: z.string().optional(),
});

export type BackupStatusResponse = z.infer<typeof backupStatusResponseSchema>;
