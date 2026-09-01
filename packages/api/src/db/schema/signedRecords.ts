/**
 * `signed_records` — the append-only, per-subject hash chain.
 *
 * Ported from `models/SignedRecord.ts`. Every row is one cryptographically
 * signed envelope a subject published about themselves. Rows are never mutated;
 * a newer record supersedes an older one. This table is the cryptographic root
 * of the civic layer: five other tables reference a record by its content
 * address, `RepoHead` points at the current head, and a
 * `TransparencyCheckpoint` commits to every head under one Merkle root.
 *
 * ## `envelope` is `jsonb`, and that is a measured decision
 *
 * Verification NEVER reads the stored bytes back: `canonicalize()`
 * (`@oxyhq/protocol`, `envelope/canonicalJson.ts`) sorts keys at every level and
 * re-serializes from the PARSED value, so `jsonb`'s key reordering, duplicate-key
 * collapse, number re-formatting and unicode unescaping are representation-only
 * and produce a byte-identical signing input. `__tests__/signedRecords.test.ts`
 * proves it end to end: sign an envelope, store it, read it back, recompute the
 * signing input, and re-verify the signature.
 *
 * The one hazard is a `\0` inside a string, which `jsonb` refuses outright
 * (`unsupported Unicode escape sequence`). That is a LOUD insert failure, not
 * silent corruption, and it is the correct failure mode — `text`/`json` would
 * accept it and trade a queryable typed column for an opaque blob.
 *
 * ## The three Mongo indexes, and why two of them stop being partial
 *
 * Mongo's `recordId` and `{userId, seq}` unique indexes carry
 * `partialFilterExpression: { …: { $type: … } }` for ONE reason: Mongo treats a
 * MISSING field as `null` and would collide across every v1 row, which has
 * neither field. Postgres unique indexes treat NULLs as DISTINCT by default, so
 * a plain `UNIQUE` already has exactly that semantic — `CONVENTIONS.md` names
 * this workaround explicitly and forbids carrying it over.
 *
 * That is not cosmetic here. A PARTIAL unique index cannot be the target of a
 * foreign key (`there is no unique constraint matching given keys`), and five
 * tables plus this one's own `prev` must reference `record_id`. Dropping the
 * partial-ness is what makes the whole chain declarable as real constraints.
 *
 * The third index (`{userId, nsid, rkey, createdAt: -1}`) is NOT unique, and its
 * partial filter is a genuine size optimisation — v1 rows have no `nsid` and can
 * never match the materialization query — so it stays partial.
 *
 * **`{user_id, seq}` is the multi-device write-race backstop.** Two devices that
 * sign at the same `seq` both try to insert; the loser gets a unique violation,
 * re-reads the head, and re-signs. `oxyRecordStore.append` already translates
 * that into `chain_conflict`.
 *
 * ## `nsid`, not `collection`
 *
 * The wire/envelope field is `collection`; the denormalized column is `nsid`
 * (the AtProto term), because `collection` is a reserved Mongoose `Document`
 * member. The name is kept on port: queries read `nsid` today and the stored
 * envelope is untouched either way.
 */

import { sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { oxySignedRecordTypeSchema } from '@oxyhq/contracts';
import type { OxySignedRecordType, SignedRecordEnvelope } from '@oxyhq/contracts';
import { createdAt, generatedId, inList } from '@oxyhq/db';
import { users } from './users';

/**
 * The closed set of record categories the Oxy store accepts, derived from the
 * contract so the CHECK cannot drift from `verifyEnvelope`'s runtime gate.
 * `satisfies` proves every value is a contract type; `OxySignedRecordTypeGap`
 * proves the reverse, so widening the contract fails THIS file's typecheck
 * rather than silently producing a value the CHECK rejects.
 */
export const OXY_SIGNED_RECORD_TYPES = [
  ...oxySignedRecordTypeSchema.options,
] as const satisfies readonly OxySignedRecordType[];

/** `never` while `OXY_SIGNED_RECORD_TYPES` covers the contract union. */
export type OxySignedRecordTypeGap = Exclude<
  OxySignedRecordType,
  (typeof OXY_SIGNED_RECORD_TYPES)[number]
>;

export const signedRecords = pgTable(
  'signed_records',
  {
    id: generatedId(),

    /** The subject DID the record is about (`did:web:<domain>:u:<userId>`). */
    subjectDid: text().notNull(),
    /**
     * The account that owns the subject DID.
     *
     * `CASCADE` — the chain is the account's own signed history about itself, so
     * an erasure takes it with the account. Nothing else's chain is touched:
     * chains are strictly per-subject, and a checkpoint commits to head HASHES
     * rather than to rows, so a published root stays intact (that subject simply
     * has no inclusion proof to serve any more).
     */
    userId: text()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    type: text({ enum: OXY_SIGNED_RECORD_TYPES }).notNull(),
    /** The complete signed envelope, verbatim. See the header on `jsonb`. */
    envelope: jsonb().$type<SignedRecordEnvelope>().notNull(),
    /** The secp256k1 key that signed it — a current VM of the subject at write time. */
    publicKey: text().notNull(),
    /** True only when the envelope passed FULL verification at write time. */
    verified: boolean().notNull().default(false),

    // ---- v2 hash chain (all four absent together on a v1 row) --------------
    /** Strictly-increasing per subject. */
    seq: integer(),
    /**
     * Content address of the PREVIOUS record, `null` at genesis.
     *
     * A real self-reference, because continuity is already verified against
     * Oxy's own head (`checkContinuity`), so the target always exists locally.
     * `CASCADE`: a record whose predecessor is gone is an unverifiable chain
     * fragment, and the only deleter is the account erasure that removes the
     * whole chain anyway.
     */
    prev: text().references((): AnyPgColumn => signedRecords.recordId, {
      onDelete: 'cascade',
    }),
    /** Content address: sha256 of the canonical signing input. */
    recordId: text().unique(),
    /** Denormalized envelope `collection` (e.g. `app.oxy.credential`). */
    nsid: text(),
    /** AtProto-style record key within the collection (e.g. `self`). */
    rkey: text(),

    /** Append-only: the ABSENCE of `updated_at` is the contract. */
    createdAt: createdAt(),
  },
  (t) => [
    index('signed_records_subject_did_idx').on(t.subjectDid),
    // Latest-record-per-(user, type) lookups, v1 and v2 alike.
    index('signed_records_user_id_type_created_at_idx').on(t.userId, t.type, t.createdAt.desc()),
    // The multi-device write-race backstop, and the ordered `getLogSince` scan.
    // Plain, not partial: NULLS DISTINCT already exempts every v1 row.
    uniqueIndex('signed_records_user_id_seq_key').on(t.userId, t.seq),
    // v2 materialization: newest record for an (nsid, rkey) key. Partial for
    // real — v1 rows can never match this query and only bloat the index.
    index('signed_records_user_id_nsid_rkey_created_at_idx')
      .on(t.userId, t.nsid, t.rkey, t.createdAt.desc())
      .where(sql`${t.nsid} is not null`),
    // The multi-author projection scan (`oxyRecordStore.listRecordsByAuthors`):
    // "records by ANY of these authors, in these collections, after this
    // cursor".
    //
    // MEASURED, not assumed (60k rows, 2000 authors, 300 asked for, PG17): the
    // planner takes a Bitmap Index Scan on this index for the author set and
    // then top-N heapsorts the matches — it does NOT merge one ordered scan per
    // author, and no `IN`-list plan in this version does. So the index buys the
    // author RESTRICTION; the ordering is still a sort, bounded by how many rows
    // the cursor leaves in range.
    //
    // That is the right trade for an INCREMENTAL puller, which is the only
    // caller: past the first poll the surviving set is small. The shape that
    // would bound the first poll too is a LATERAL top-N per author
    // (`unnest(authors) … LATERAL (… ORDER BY created_at, id LIMIT n)`), which
    // does use the ordering — worth reaching for when a far-behind cursor
    // actually hurts, and not before.
    //
    // `nsid` is deliberately NOT a leading column: it stays an IN-list filter so
    // the index serves any lexicon mix rather than one, and `created_at` keeps
    // its place directly after `user_id` for the LATERAL shape above.
    //
    // Partial on the same rows the query selects: a v1 row has no lexicon to
    // filter on, and an unverified row never reaches a feed.
    index('signed_records_authors_created_at_id_idx')
      .on(t.userId, t.createdAt, t.id)
      .where(sql`${t.nsid} is not null and ${t.verified}`),

    check('signed_records_type_check', sql`${t.type} in (${sql.raw(inList(OXY_SIGNED_RECORD_TYPES))})`),
    // `signedRecordEnvelopeSchema` requires `seq` to be a non-negative integer
    // on v2 and forbids it entirely on v1.
    check('signed_records_seq_check', sql`${t.seq} is null or ${t.seq} >= 0`),
    // A row is either v1 — no chain fields at all — or v2, in which case its
    // content address AND its record key are all present, because
    // `collection`/`rkey` are part of the signed bytes and `record_id` is what
    // five other tables reference. Mongo could represent a half-chained row that
    // no reader knows how to treat; here it is unrepresentable.
    //
    // `seq` is deliberately NOT required by the v2 branch: it is the separate
    // marker for "this row is ON the linear chain". A genuine FORK carries a
    // `seq` that is already taken — the unique `(user_id, seq)` index above
    // exists to reject exactly that — so `nodeSync.service.storeForkMirror`
    // preserves the authentic forked envelope with its address and key but with
    // NO `seq`, off the chain, both branches intact. Requiring `seq` here made
    // that shape unrepresentable and turned the whole fork-preservation branch
    // into a guaranteed CHECK violation; migration `0009` relaxes it.
    check(
      'signed_records_chain_completeness_check',
      sql`(${t.seq} is null and ${t.recordId} is null and ${t.nsid} is null and ${t.rkey} is null) or (${t.recordId} is not null and ${t.nsid} is not null and ${t.rkey} is not null)`
    ),
    // A record cannot chain from itself.
    check('signed_records_prev_not_self_check', sql`${t.prev} is null or ${t.prev} <> ${t.recordId}`),
  ]
);
