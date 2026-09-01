/**
 * `transparency_checkpoints` (+ three child tables) — the operator's signed
 * commitment to every subject's chain head at a point in time.
 *
 * Ported from `models/TransparencyCheckpoint.ts`. A per-subject hash chain
 * proves nobody EDITED a record; it does not prove Oxy did not serve two
 * different histories or quietly drop one. A checkpoint closes that gap: it
 * commits to all heads under one Merkle root, is signed, is hash-linked to its
 * predecessor, and is later anchored on a public chain.
 *
 * ## `index` UNIQUE is the checkpoint job's real mutex
 *
 * Two tasks computing the same period produce slightly different roots (heads
 * move between reads) and only one insert may survive; the loser ADOPTS the
 * persisted checkpoint. Two signed roots for one index is precisely the
 * equivocation this log exists to detect — a correctness constraint, not a
 * race-condition nicety. `buildCheckpoint` already depends on the unique
 * violation to decide which task won.
 *
 * ## Three arrays, three different answers
 *
 * - **`snapshot[]` is a CHILD TABLE, mandatorily.** One entry per subject on the
 *   platform, per checkpoint — the largest embedded array in the codebase, and
 *   the reason `MAX_CHECKPOINT_SUBJECTS` exists at all (50 000, a hedge against
 *   Mongo's 16 MB document ceiling that Postgres simply does not have). Its
 *   ORDER is load-bearing: `getInclusionProof` uses the array position as the
 *   Merkle leaf index, so the ordinal is a real column and the primary key.
 * - **`signatures[]` and `anchors[]` are child tables** because they GROW after
 *   insert — witnesses co-sign asynchronously, anchors are broadcast later and
 *   then reconciled for confirmations. Appending to a Mongo array is a rewrite
 *   of the whole document; here it is an insert, and reconciliation becomes an
 *   `update ... where (checkpoint, network, txid)` instead of a positional
 *   array surgery with no key to aim at.
 *
 * ## The signed body is immutable, and a TRIGGER enforces it
 *
 * `index`, `period_end`, `tree_size`, `root` and `prev_checkpoint_hash` are the
 * five fields every co-signer signs (`checkpointSignedFields`). Mutating any of
 * them invalidates every signature over the checkpoint AND breaks the next
 * checkpoint's `prev_checkpoint_hash` link — silently, since nothing re-verifies
 * a stored checkpoint on read. A CHECK constraint cannot express this: it sees
 * only the new row, never the old one. {@link TRANSPARENCY_IMMUTABILITY_DDL} is
 * the mechanism, applied by the migration, and
 * `__tests__/transparencyCheckpoints.test.ts` proves the triggers exist AND
 * fire — so a regenerated migration that dropped them goes red.
 *
 * ## `period_end` and `anchored_at` become real timestamps
 *
 * Both were `Number` (ms epoch) in Mongo. `period_end` is part of the SIGNED
 * body, so the change is only safe because a whole-millisecond value round-trips
 * through `timestamptz` (microsecond resolution) exactly: the call site rebuilds
 * the identical signing input with `.getTime()`. The round-trip is pinned by a
 * real sign-store-read-verify test, not by argument.
 */

import { sql } from 'drizzle-orm';
import { check, integer, pgTable, primaryKey, text, uniqueIndex } from 'drizzle-orm/pg-core';
import { createdAt, generatedId, inList, timestamptz, updatedAt } from '@oxyhq/db';

/** The one signature algorithm the protocol emits. */
export const CHECKPOINT_SIGNATURE_ALGORITHMS = ['ES256K-DER-SHA256'] as const;

export const transparencyCheckpoints = pgTable(
  'transparency_checkpoints',
  {
    id: generatedId(),
    /**
     * Monotonic, gapless checkpoint number. The UNIQUE constraint is the mutex —
     * see the header. Kept as `index` rather than renamed: drizzle quotes every
     * identifier it emits, and renaming would put a gratuitous divergence
     * between this schema and the published `TransparencyCheckpoint` contract.
     */
    index: integer().notNull().unique(),
    /** End of the committed period. Part of the signed body. */
    periodEnd: timestamptz().notNull(),
    /** Number of committed leaves. Part of the signed body. */
    treeSize: integer().notNull(),
    /** Merkle root over the committed heads. Part of the signed body. */
    root: text().notNull(),
    /** Hash of the previous checkpoint's signing input; NULL at genesis. Part of the signed body. */
    prevCheckpointHash: text(),

    createdAt: createdAt(),
    /** Meaningful here: signatures and anchors are appended after insert. */
    updatedAt: updatedAt(),
  },
  (t) => [
    // Mongo's second `{index: -1}` index does NOT travel: Postgres scans a btree
    // backwards as cheaply as forwards, so the unique constraint already serves
    // "the latest checkpoint" and a descending duplicate would only cost writes.
    check('transparency_checkpoints_index_check', sql`${t.index} >= 0`),
    check('transparency_checkpoints_tree_size_check', sql`${t.treeSize} >= 0`),
  ]
);

/**
 * `transparency_checkpoint_signatures` — one signer's endorsement of the
 * checkpoint's signed body. Oxy signs at insert; witnesses co-sign later.
 */
export const transparencyCheckpointSignatures = pgTable(
  'transparency_checkpoint_signatures',
  {
    id: generatedId(),
    /** `CASCADE` — a signature over a checkpoint that does not exist endorses nothing. */
    checkpointId: text()
      .notNull()
      .references(() => transparencyCheckpoints.id, { onDelete: 'cascade' }),
    /**
     * Insertion order, preserved from the Mongo array because "Oxy's signature
     * first" is how `buildCheckpoint` writes it and how the DTO reads it.
     */
    position: integer().notNull(),
    /** The signer's secp256k1 public key. */
    publicKey: text().notNull(),
    alg: text({ enum: CHECKPOINT_SIGNATURE_ALGORITHMS }).notNull(),
    /** DER-encoded signature over `checkpointSigningInput`. */
    signature: text().notNull(),

    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('transparency_checkpoint_signatures_position_key').on(t.checkpointId, t.position),
    // One endorsement per signer. A Mongo array could hold the same witness
    // twice and inflate the apparent co-signature count, which is the only
    // number a reader uses to judge how well-witnessed a root is.
    uniqueIndex('transparency_checkpoint_signatures_signer_key').on(t.checkpointId, t.publicKey),
    check(
      'transparency_checkpoint_signatures_alg_check',
      sql`${t.alg} in (${sql.raw(inList(CHECKPOINT_SIGNATURE_ALGORITHMS))})`
    ),
    check('transparency_checkpoint_signatures_position_check', sql`${t.position} >= 0`),
  ]
);

/**
 * `transparency_checkpoint_anchors` — where a root was published on a public
 * chain. Appended after broadcast, then UPDATED as confirmations accrue.
 */
export const transparencyCheckpointAnchors = pgTable(
  'transparency_checkpoint_anchors',
  {
    id: generatedId(),
    /** `CASCADE` — an anchor for a checkpoint that does not exist anchors nothing. */
    checkpointId: text()
      .notNull()
      .references(() => transparencyCheckpoints.id, { onDelete: 'cascade' }),
    /** Public chain the root was published on. */
    network: text().notNull(),
    /** Transaction id carrying the root. */
    txid: text().notNull(),
    confirmations: integer().notNull().default(0),
    /** When the anchoring transaction was broadcast. */
    anchoredAt: timestamptz().notNull(),

    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    // The key reconciliation aims at: one row per (network, txid), UPDATED as
    // confirmations accrue. Mongo had no key here, so a re-broadcast reconcile
    // could append a second row for the same transaction and double-count it.
    uniqueIndex('transparency_checkpoint_anchors_txid_key').on(t.checkpointId, t.network, t.txid),
    check('transparency_checkpoint_anchors_confirmations_check', sql`${t.confirmations} >= 0`),
  ]
);

/**
 * `transparency_checkpoint_snapshot_entries` — the ordered heads one checkpoint
 * committed to.
 *
 * Server-side only: serving it would hand an unauthenticated caller an
 * enumeration of every subject on the platform. `toDto` drops it, and nothing in
 * this schema encourages a whole-row read of the parent to include it.
 *
 * `leaf_index` IS the Merkle leaf position, so it is the natural key together
 * with the checkpoint — a surrogate id would invent an identity for a row
 * nothing references and leave the ordinal unconstrained.
 */
export const transparencyCheckpointSnapshotEntries = pgTable(
  'transparency_checkpoint_snapshot_entries',
  {
    /** `CASCADE` — the snapshot has no meaning apart from its checkpoint. */
    checkpointId: text()
      .notNull()
      .references(() => transparencyCheckpoints.id, { onDelete: 'cascade' }),
    /** Zero-based Merkle leaf position. `inclusionProof` indexes the tree by it. */
    leafIndex: integer().notNull(),
    /** The committed subject DID. */
    subjectDid: text().notNull(),
    /** The subject's `seq` at commit time. */
    seq: integer().notNull(),
    /**
     * The subject's head content address at commit time.
     *
     * Deliberately NOT a foreign key — see `ID_COLUMNS_WITHOUT_FOREIGN_KEY`. A
     * committed value is frozen evidence, not a live pointer: an `ON DELETE`
     * action of ANY kind would let an unrelated erasure alter what a signed
     * checkpoint committed to, which is the exact tampering this log exists to
     * make detectable.
     */
    headRecordId: text().notNull(),
  },
  (t) => [
    primaryKey({
      columns: [t.checkpointId, t.leafIndex],
      name: 'transparency_checkpoint_snapshot_entries_pkey',
    }),
    // `getInclusionProof` finds a subject's leaf by DID, and a subject has
    // exactly one head per checkpoint — so the lookup index and the constraint
    // are the same object.
    uniqueIndex('transparency_checkpoint_snapshot_entries_subject_key').on(
      t.checkpointId,
      t.subjectDid
    ),
    check('transparency_checkpoint_snapshot_entries_leaf_index_check', sql`${t.leafIndex} >= 0`),
    check('transparency_checkpoint_snapshot_entries_seq_check', sql`${t.seq} >= 0`),
  ]
);

/**
 * The immutability triggers, as data.
 *
 * Drizzle-kit emits tables, constraints and indexes from a schema file; it
 * cannot emit a trigger. So these statements live in the migration — and
 * because a hand-written statement inside a GENERATED file is exactly the kind
 * of thing a central regeneration silently drops, the schema keeps the
 * authoritative text here and the test asserts the triggers are actually
 * installed AND that they fire. A regeneration that loses them goes red naming
 * the missing trigger, rather than leaving a signed body quietly writable.
 *
 * Two objects, not one: a checkpoint's five signed fields, and the snapshot the
 * inclusion proofs are served from. Both are `BEFORE UPDATE` only — an
 * `ON DELETE` guard would block the child `CASCADE` and turn "delete a
 * checkpoint" (which nothing does) into a confusing constraint failure rather
 * than the loud, deliberate error it should be.
 */
export const TRANSPARENCY_IMMUTABILITY_DDL: readonly string[] = [
  `create or replace function transparency_checkpoint_body_immutable() returns trigger
language plpgsql as $$
declare
  changed text;
begin
  changed := case
    when new."index" is distinct from old."index" then 'index'
    when new.period_end is distinct from old.period_end then 'period_end'
    when new.tree_size is distinct from old.tree_size then 'tree_size'
    when new.root is distinct from old.root then 'root'
    when new.prev_checkpoint_hash is distinct from old.prev_checkpoint_hash then 'prev_checkpoint_hash'
    else null
  end;
  if changed is not null then
    raise exception 'transparency_checkpoints.% is immutable: the checkpoint body is signed and hash-linked', changed
      using errcode = '23514';
  end if;
  return new;
end;
$$`,
  `create trigger transparency_checkpoints_body_immutable
before update on transparency_checkpoints
for each row execute function transparency_checkpoint_body_immutable()`,
  `create or replace function transparency_checkpoint_snapshot_immutable() returns trigger
language plpgsql as $$
begin
  raise exception 'transparency_checkpoint_snapshot_entries is append-only: leaf % of checkpoint % was committed under a signed Merkle root', old.leaf_index, old.checkpoint_id
    using errcode = '23514';
end;
$$`,
  `create trigger transparency_checkpoint_snapshot_entries_immutable
before update on transparency_checkpoint_snapshot_entries
for each row execute function transparency_checkpoint_snapshot_immutable()`,
];

/** The trigger names {@link TRANSPARENCY_IMMUTABILITY_DDL} installs. */
export const TRANSPARENCY_IMMUTABILITY_TRIGGERS = [
  'transparency_checkpoints_body_immutable',
  'transparency_checkpoint_snapshot_entries_immutable',
] as const;
