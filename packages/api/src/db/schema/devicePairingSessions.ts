/**
 * `device_pairing_sessions` — the short-lived relay that clones an identity from
 * an existing device to a fresh one.
 *
 * Ported from `models/DevicePairingSession.ts`. End-to-end encrypted: the server
 * holds the two ephemeral secp256k1 PUBLIC keys plus an opaque AEAD
 * ciphertext/nonce and never a key that can decrypt the transferred private key.
 * A dump of this table yields ciphertext.
 *
 * ## Expiry — the sweep is NOT the mechanism that marks a pairing expired
 *
 * Mongo's TTL (`expireAfterSeconds: 0`) lags ~60s, and the read path relies on
 * that: `deviceTransfer.service.ts:98` and `:181` find a still-present `pending`
 * row past its deadline and write `status = 'expired'` LAZILY, which is what
 * lets the client be told "this pairing expired" instead of "unknown pairing".
 * The Postgres sweep has the same lag and the same relationship to that read —
 * it reclaims storage, it does not produce the verdict.
 *
 * **Port the lazy-expiry read verbatim.** Replacing it with "the sweep handles
 * it" would not leak anything (the atomic approve is separately conditioned on
 * `expiresAt > now`, `deviceTransfer.service.ts:193`) but it would turn every
 * expired pairing into an indistinguishable 404, and users would be told their
 * transfer never existed.
 */

import { sql } from 'drizzle-orm';
import { check, index, pgTable, text, unique } from 'drizzle-orm/pg-core';
import { createdAt, generatedId, timestamptz, updatedAt } from '@oxyhq/db';
import { users } from './users';

/** Lifecycle. `expired` is written lazily on read — see the header. */
export const DEVICE_PAIRING_STATUSES = ['pending', 'approved', 'denied', 'expired'] as const;

export const devicePairingSessions = pgTable(
  'device_pairing_sessions',
  {
    id: generatedId(),
    /** 128-bit single-use handle carried in the QR; also the HKDF salt. */
    pairingId: text().notNull(),
    /** The NEW device's ephemeral secp256k1 public key, hex. */
    newDeviceEphemeralPublicKey: text().notNull(),
    newDeviceLabel: text(),
    /** The OLD device's ephemeral public key, hex. Written on approve. */
    oldDeviceEphemeralPublicKey: text(),
    /** AEAD ciphertext of `{ privateKey, publicKey }`, hex. Written on approve. */
    ciphertext: text(),
    /** AEAD nonce, hex (24 bytes). Written on approve. */
    nonce: text(),
    status: text({ enum: DEVICE_PAIRING_STATUSES }).notNull().default('pending'),
    /**
     * The bearer-authenticated user who approved the transfer.
     *
     * `CASCADE`: the row is a three-minute credential-transfer relay, and one
     * whose approver no longer exists must not remain claimable. `SET NULL`
     * would leave an `approved` row carrying decryptable-by-someone ciphertext
     * with no record of who released it.
     */
    approvedByUserId: text().references(() => users.id, { onDelete: 'cascade' }),
    expiresAt: timestamptz().notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique('device_pairing_sessions_pairing_id_key').on(t.pairingId),
    // Mongo declared a standalone `{status: 1}` index. Kept only as part of the
    // deadline scan below: on its own it is four values across a table that is
    // never larger than the in-flight transfers, so it can never beat a scan.
    // Supports the expiry sweep in `db/expiry.ts`, and the lazy-expiry read.
    index('device_pairing_sessions_expires_at_idx').on(t.expiresAt),
    check(
      'device_pairing_sessions_status_check',
      sql`${t.status} in (${sql.raw(DEVICE_PAIRING_STATUSES.map((value) => `'${value}'`).join(', '))})`
    ),
    // The sealed payload arrives as a unit on the single atomic `pending →
    // approved` transition. A half-written approval could not be decrypted and
    // would leave the new device waiting forever on a pairing that reads as done.
    check(
      'device_pairing_sessions_sealed_payload_check',
      sql`(${t.oldDeviceEphemeralPublicKey} is null and ${t.ciphertext} is null and ${t.nonce} is null)
        or (${t.oldDeviceEphemeralPublicKey} is not null and ${t.ciphertext} is not null and ${t.nonce} is not null)`
    ),
  ]
);
