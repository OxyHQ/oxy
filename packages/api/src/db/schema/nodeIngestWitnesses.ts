/**
 * `node_ingest_witnesses` — Oxy's counter-signature over each record it mirrors
 * from a user's personal data node.
 *
 * Ported from `models/NodeIngestWitness.ts`. The node holds the user's own
 * signing key, so a stolen key could re-sign a DIFFERENT history and present it
 * as authentic. This row binds the FIRST content address Oxy ever saw to a
 * timestamp under Oxy's independent key, so a later silent rewrite cannot claim
 * the old content never existed.
 *
 * Append-only, one witness per record (`record_id` unique) — witnessing is
 * idempotent, so a record re-pulled on a later sweep is never double-witnessed.
 *
 * ## `ingested_at` becomes a real timestamp
 *
 * Mongo stored it as a `Number` (ms epoch) because it is part of the signed
 * input `canonicalize({ recordId, userId, ingestedAt })`. It is a `timestamptz`
 * here: a whole-millisecond value round-trips through `timestamptz`
 * (microsecond resolution) exactly, so the call site re-derives the identical
 * signing input with `.getTime()` and the signature still verifies. Keeping a
 * bare `bigint` would carry a Mongo representation into a column whose meaning
 * is a point in time — and would silently lose the time-zone semantics every
 * other date column in this schema has.
 */

import { index, pgTable, text } from 'drizzle-orm/pg-core';
import { createdAt, generatedId, timestamptz } from '@oxyhq/db';
import { signedRecords } from './signedRecords';
import { users } from './users';

export const nodeIngestWitnesses = pgTable(
  'node_ingest_witnesses',
  {
    id: generatedId(),
    /** The account whose chain the witnessed record belongs to. `CASCADE` with the chain. */
    userId: text()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /**
     * The content address Oxy witnessed.
     *
     * `CASCADE`: the witness attests to a specific record; with the record gone
     * there is nothing left to attest to, and the only deleter is the account
     * erasure that takes both.
     */
    recordId: text()
      .notNull()
      .unique()
      .references(() => signedRecords.recordId, { onDelete: 'cascade' }),
    /** DER-encoded secp256k1 signature by the Oxy custodial key. */
    witnessSignature: text().notNull(),
    /** When Oxy first ingested and witnessed the record. Part of the signed input. */
    ingestedAt: timestamptz().notNull(),

    /** Append-only: the ABSENCE of `updated_at` is the contract. */
    createdAt: createdAt(),
  },
  (t) => [
    // Per-user audit reads, newest first. `record_id`'s unique constraint
    // already serves the idempotency lookup, so it gets no second index.
    index('node_ingest_witnesses_user_id_created_at_idx').on(t.userId, t.createdAt.desc()),
  ]
);
