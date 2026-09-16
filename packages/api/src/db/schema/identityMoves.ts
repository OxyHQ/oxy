/**
 * `identity_moves` — the relay for taking a web identity into Commons.
 *
 * One short-lived row per move (`@oxy.so/contracts` `identityMove`). The server
 * holds two ephemeral public keys, an AEAD ciphertext it cannot open, and — once
 * Commons has the identity — the identity key's receipt signature. The
 * ciphertext is cleared the moment the move completes.
 *
 * Expiry is read-side first: every read and transition filters on `expires_at`
 * itself and marks a stale row `expired`; the sweep in `db/expiry.ts` only
 * reclaims storage (same contract as `device_pairing_sessions`).
 */

import { sql } from 'drizzle-orm';
import { bigint, check, index, integer, pgTable, text, unique } from 'drizzle-orm/pg-core';
import { IDENTITY_MOVE_STATUSES } from '@oxy.so/contracts';
import { createdAt, generatedId, timestamptz, updatedAt } from '@oxy.so/db';
import { users } from './users';

export const identityMoves = pgTable(
  'identity_moves',
  {
    id: generatedId(),
    /** 128-bit handle carried in the QR; also the HKDF salt. */
    moveId: text().notNull(),
    /** `CASCADE` — a move for a deleted account must not stay claimable. */
    userId: text()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** The identity being moved, snapshotted at creation (lowercase uncompressed hex). */
    publicKey: text().notNull(),
    /**
     * Transfer protocol (`IDENTITY_MOVE_PROTOCOL_VERSIONS`). Version 2 commits to
     * the initiator key first and reveals it only after the responder joined.
     */
    protocolVersion: integer().notNull().default(1),
    /** Version 2: `H(initiator key, nonce)`, published at creation. `null` in version 1. */
    initiatorCommitment: text(),
    /** Version 2: the commitment's nonce, published with the key at reveal so the responder can check it. */
    initiatorCommitmentNonce: text(),
    /** Version 1: set at creation. Version 2: `null` until revealed after the join. */
    initiatorEphemeralPublicKey: text(),
    responderEphemeralPublicKey: text(),
    /** Sealed entropy, written on seal, cleared on completion. */
    nonce: text(),
    ciphertext: text(),
    receiptSignature: text(),
    receiptTimestamp: bigint({ mode: 'number' }),
    status: text({ enum: IDENTITY_MOVE_STATUSES }).notNull().default('pending'),
    expiresAt: timestamptz().notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique('identity_moves_move_id_key').on(t.moveId),
    index('identity_moves_expires_at_idx').on(t.expiresAt),
    check(
      'identity_moves_status_check',
      sql`${t.status} in (${sql.raw(IDENTITY_MOVE_STATUSES.map((value) => `'${value}'`).join(', '))})`,
    ),
    // The sealed payload arrives and leaves as a unit.
    check('identity_moves_sealed_payload_check', sql`(${t.nonce} is null) = (${t.ciphertext} is null)`),
    check('identity_moves_receipt_check', sql`(${t.receiptSignature} is null) = (${t.receiptTimestamp} is null)`),
    check('identity_moves_protocol_version_check', sql`${t.protocolVersion} in (1, 2)`),
    // Version 1 always has its key and never a commitment; version 2 always has a commitment.
    check(
      'identity_moves_protocol_shape_check',
      sql`(${t.protocolVersion} = 1 and ${t.initiatorCommitment} is null and ${t.initiatorEphemeralPublicKey} is not null) or (${t.protocolVersion} = 2 and ${t.initiatorCommitment} is not null)`,
    ),
    // A version-2 key is revealed only after a responder joined, so it never precedes one.
    check(
      'identity_moves_reveal_after_join_check',
      sql`${t.protocolVersion} = 1 or ${t.initiatorEphemeralPublicKey} is null or ${t.responderEphemeralPublicKey} is not null`,
    ),
    check('identity_moves_reveal_nonce_check', sql`(${t.initiatorCommitmentNonce} is null) = (${t.protocolVersion} = 1 or ${t.initiatorEphemeralPublicKey} is null)`),
  ],
);
