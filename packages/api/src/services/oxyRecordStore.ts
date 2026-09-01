/**
 * Oxy RecordStore — the @oxyhq/protocol {@link RecordStore} implementation over
 * Oxy's `signed_records` + `repo_heads` tables.
 *
 * This is the storage HALF of the chain adapter: the protocol engine
 * (`@oxyhq/protocol`'s `verifyAndAppend`) owns verification + continuity policy
 * and delegates every read/write here. Everything Oxy- and Postgres-specific
 * that does NOT belong in the app-agnostic engine lives in this file:
 *
 *  - the ATOMIC append + head advance (one real transaction — see below),
 *  - the unique `{user_id, seq}` index backstop translated to `chain_conflict`
 *    on a `unique_violation`,
 *  - the v1 `{type}` vs v2 `{nsid, rkey}` monotonicity split, and
 *  - the `nsid` denormalization of the envelope's `collection` field.
 *
 * ## The session-less fallback is DELETED, not translated
 *
 * The Mongo version string-matched "no replica set" on the transaction error and
 * silently RE-RAN the append and the head advance without a session. That made
 * the pair non-atomic on any deployment without a replica set, which is exactly
 * the failure the pair exists to prevent: a head pointing at a record that was
 * never stored makes every later `prev` check fail, and a head left behind lets
 * a second device re-use a `seq` that is already taken. Postgres has real
 * transactions everywhere, so there is nothing to fall back FROM — `repoHeads.ts`
 * records the same decision on the schema side.
 *
 * ## `{user_id, seq}` is the multi-device write-race backstop
 *
 * Two devices that sign at the same `seq` both try to insert; the loser gets a
 * `unique_violation`, which this store answers as `chain_conflict` so the caller
 * re-reads the head and re-signs. That shape is preserved verbatim — it is the
 * only thing standing between a concurrent write and a forked chain.
 *
 * The store is **subject-keyed by the subject DID** (the protocol's notion of a
 * subject). Oxy's primary key is the account `userId`, so each method parses the
 * DID back to its `userId` via {@link parseUserDid}. (Oxy has no per-record blob
 * storage — identity/civic/node records carry no blobs — so no `BlobStore` is
 * implemented here.)
 */

import { and, asc, desc, eq, gt, inArray, isNotNull, sql, type SQL } from 'drizzle-orm';
import { oxySignedRecordTypeSchema, type SignedRecordEnvelope } from '@oxyhq/contracts';
import type { AppendOutcome, ChainHead, RecordStore } from '@oxyhq/protocol';
import { getDb } from '../config/postgres';
import { isUniqueViolation } from '@oxyhq/db';
import { repoHeads } from '../db/schema/repoHeads';
import { signedRecords } from '../db/schema/signedRecords';
import { buildUserDid, parseUserDid } from './did.service';

/** Default page size for the log read helpers. */
export const DEFAULT_LOG_LIMIT = 100;
/** Hard ceiling so a single log call can never scan an unbounded slice. */
const MAX_LOG_LIMIT = 500;

function clampLogLimit(limit: number): number {
  return Math.max(1, Math.min(Math.trunc(limit) || DEFAULT_LOG_LIMIT, MAX_LOG_LIMIT));
}

/**
 * Most authors one multi-author page may name. A feed asks for the people a
 * viewer follows; beyond this the caller pages its own author set rather than
 * asking the database to merge an unbounded number of index scans.
 */
export const MAX_RECORD_AUTHORS = 300;

/** Most lexicon collections one multi-author page may name. */
export const MAX_RECORD_COLLECTIONS = 32;

/**
 * Keyset position in the multi-author stream. `createdAt` is the axis and `id`
 * the tiebreaker — see {@link OxyRecordStoreImpl.listRecordsByAuthors} for why
 * this cursor may repeat a record and must never be treated as exact.
 */
export interface AuthorRecordCursor {
  createdAt: Date;
  id: string;
}

/** One row of the multi-author stream: the full envelope plus its stored coordinates. */
export interface AuthorRecordRow {
  id: string;
  userId: string;
  recordId: string;
  /** The envelope's `collection` — the lexicon this record belongs to. */
  nsid: string;
  /** The STORE's insert time. Never the envelope's self-asserted timestamp. */
  createdAt: Date;
  envelope: SignedRecordEnvelope;
}

/** One page of the multi-author stream. */
export interface AuthorRecordPage {
  records: AuthorRecordRow[];
  /** Where to resume, or `null` when this page reached the end of the stream. */
  nextCursor: AuthorRecordCursor | null;
}

/**
 * The Oxy implementation of the protocol {@link RecordStore}, backed by the
 * `signed_records` ledger + `repo_heads` head pointer.
 */
class OxyRecordStoreImpl implements RecordStore {
  async getHead(subject: string): Promise<ChainHead | null> {
    const userId = parseUserDid(subject);
    if (!userId) {
      return null;
    }
    const [head] = await getDb()
      .select({
        headRecordId: repoHeads.headRecordId,
        seq: repoHeads.seq,
        recordCount: repoHeads.recordCount,
      })
      .from(repoHeads)
      .where(eq(repoHeads.userId, userId))
      .limit(1);
    if (!head) {
      return null;
    }
    return { headRecordId: head.headRecordId, seq: head.seq, recordCount: head.recordCount };
  }

  /**
   * Persist a verified envelope and (for v2) advance the per-subject hash chain.
   *
   * v1: a single append, NO chain fields and NO head advance — which is why a
   * v1 row's content address is NOT stored (`signed_records_chain_completeness_check`
   * forbids it) and why nothing may use one as a foreign key. `oxyStorePolicy`
   * in `signedRecord.service.ts` is what keeps every projected record type off
   * that path; see its `chain_required` branch.
   *
   * v2: the append AND the head advance happen in ONE transaction. A
   * `unique_violation` from `{user_id, seq}` or from `record_id` — a concurrent
   * write that already took this `seq` — is surfaced as `chain_conflict` so the
   * caller re-reads the head and retries.
   */
  async append(subject: string, env: SignedRecordEnvelope, recordId: string): Promise<AppendOutcome> {
    const userId = parseUserDid(subject);
    if (!userId) {
      // The subject DID does not belong to this issuer's domain — there is no
      // Oxy chain to write. Treated as a continuity conflict (no valid head).
      return { ok: false, reason: 'chain_gap' };
    }

    // The envelope `type` is an OPEN string on the shared protocol grammar; the
    // `signed_records.type` column is the closed Oxy set with a matching CHECK.
    // `oxyStorePolicy` already refused anything outside it, so this re-narrowing
    // is what carries that guarantee into the INSERT rather than a cast — and it
    // keeps the store correct if it is ever driven by another caller.
    const oxyType = oxySignedRecordTypeSchema.safeParse(env.type);
    if (!oxyType.success) {
      return { ok: false, reason: 'invalid_envelope' };
    }
    const type = oxyType.data;

    if (env.version === 2) {
      // Narrowed here rather than asserted: the engine rejects a v2 envelope
      // missing any chain field as `invalid_envelope` upstream, and the CHECK
      // constraint refuses a half-chained row, so a missing one at this point is
      // a continuity failure rather than a row to write.
      const seq = env.seq;
      const nsid = env.collection;
      const rkey = env.rkey;
      if (typeof seq !== 'number' || typeof nsid !== 'string' || typeof rkey !== 'string') {
        return { ok: false, reason: 'chain_gap' };
      }

      try {
        await getDb().transaction(async (tx) => {
          await tx.insert(signedRecords).values({
            subjectDid: env.subject,
            userId,
            type,
            envelope: env,
            publicKey: env.publicKey,
            verified: true,
            seq,
            prev: env.prev ?? null,
            recordId,
            // Denormalize the envelope's `collection` to the `nsid` column.
            nsid,
            rkey,
          });

          await tx
            .insert(repoHeads)
            .values({
              userId,
              subjectDid: env.subject,
              seq,
              headRecordId: recordId,
              recordCount: 1,
            })
            .onConflictDoUpdate({
              target: repoHeads.userId,
              set: {
                subjectDid: env.subject,
                seq,
                headRecordId: recordId,
                recordCount: sql`${repoHeads.recordCount} + 1`,
                updatedAt: new Date(),
              },
            });
        });
      } catch (error) {
        if (isUniqueViolation(error)) {
          return { ok: false, reason: 'chain_conflict' };
        }
        throw error;
      }

      return { ok: true, recordId, seq };
    }

    // v1: an unchained singleton append. No chain fields, no head advance — so
    // no `record_id` either, and the returned address names no stored row.
    await getDb().insert(signedRecords).values({
      subjectDid: env.subject,
      userId,
      type,
      envelope: env,
      publicKey: env.publicKey,
      verified: true,
    });
    return { ok: true, recordId, seq: -1 };
  }

  async getLogSince(subject: string, sinceSeq: number, limit: number = DEFAULT_LOG_LIMIT): Promise<SignedRecordEnvelope[]> {
    const userId = parseUserDid(subject);
    if (!userId) {
      return [];
    }
    const rows = await getDb()
      .select({ envelope: signedRecords.envelope })
      .from(signedRecords)
      .where(and(eq(signedRecords.userId, userId), gt(signedRecords.seq, sinceSeq)))
      .orderBy(asc(signedRecords.seq))
      .limit(clampLogLimit(limit));
    return rows.map((row) => row.envelope);
  }

  async resolveCursorSeq(subject: string, recordId: string): Promise<number | null> {
    const userId = parseUserDid(subject);
    if (!userId) {
      return null;
    }
    const [row] = await getDb()
      .select({ seq: signedRecords.seq })
      .from(signedRecords)
      .where(and(eq(signedRecords.userId, userId), eq(signedRecords.recordId, recordId)))
      .limit(1);
    return row?.seq ?? null;
  }

  async materializeCurrent(subject: string, collection: string, rkey: string): Promise<SignedRecordEnvelope | null> {
    const userId = parseUserDid(subject);
    if (!userId) {
      return null;
    }
    const [row] = await getDb()
      .select({ envelope: signedRecords.envelope })
      .from(signedRecords)
      .where(
        and(
          eq(signedRecords.userId, userId),
          eq(signedRecords.nsid, collection),
          eq(signedRecords.rkey, rkey),
          eq(signedRecords.verified, true),
        ),
      )
      .orderBy(desc(signedRecords.createdAt))
      .limit(1);
    return row?.envelope ?? null;
  }

  /**
   * Monotonicity frontier scoped to the LOGICAL record key:
   *  - v1 (identity/profile singletons): per `type` — a newer record supersedes
   *    the latest of the same type.
   *  - v2: per record KEY (`nsid`, `rkey`) — last-writer-wins for THAT key;
   *    distinct keys are independent appends.
   */
  async latestIssuedAtForKey(subject: string, env: SignedRecordEnvelope): Promise<number | null> {
    const userId = parseUserDid(subject);
    if (!userId) {
      return null;
    }
    // A v2 envelope missing its required `collection`/`rkey` would collapse the
    // filter below to a global-latest comparison across ALL keys — a false
    // replay/rollback rejection of valid appends on OTHER keys. Mirror the
    // NodeStore guard and treat it as "no prior record for this key". (The
    // engine rejects such an envelope as `invalid_envelope` upstream anyway.)
    let filter: SQL | undefined;
    if (env.version === 2) {
      const { collection, rkey } = env;
      if (typeof collection !== 'string' || typeof rkey !== 'string') {
        return null;
      }
      filter = and(
        eq(signedRecords.userId, userId),
        eq(signedRecords.nsid, collection),
        eq(signedRecords.rkey, rkey),
      );
    } else {
      // The same open-`type` narrowing `append` applies: a type outside the Oxy
      // set can hold no stored record, so there is no prior issuedAt for it.
      const oxyType = oxySignedRecordTypeSchema.safeParse(env.type);
      if (!oxyType.success) {
        return null;
      }
      filter = and(eq(signedRecords.userId, userId), eq(signedRecords.type, oxyType.data));
    }
    const [latest] = await getDb()
      .select({ envelope: signedRecords.envelope })
      .from(signedRecords)
      .where(filter)
      .orderBy(desc(signedRecords.createdAt))
      .limit(1);
    const latestIssuedAt = latest?.envelope?.issuedAt;
    return typeof latestIssuedAt === 'number' ? latestIssuedAt : null;
  }

  /* ---------------------------------------------------------------------- */
  /*  Oxy-specific reads (not part of the protocol RecordStore interface)   */
  /* ---------------------------------------------------------------------- */

  /**
   * Public node-bootstrap log export: only verified records whose `nsid` is in
   * the supplied allowlist (an Oxy POLICY passed by the caller — the protocol
   * has no notion of "public collections"). `userId`-keyed because the public
   * chain endpoints address subjects by their Oxy account id.
   */
  async getPublicLogSince(
    userId: string,
    sinceSeq: number,
    limit: number,
    collections: readonly string[],
  ): Promise<SignedRecordEnvelope[]> {
    if (collections.length === 0) {
      return [];
    }
    const rows = await getDb()
      .select({ envelope: signedRecords.envelope })
      .from(signedRecords)
      .where(
        and(
          eq(signedRecords.userId, userId),
          gt(signedRecords.seq, sinceSeq),
          eq(signedRecords.verified, true),
          inArray(signedRecords.nsid, [...collections]),
        ),
      )
      .orderBy(asc(signedRecords.seq))
      .limit(clampLogLimit(limit));
    return rows.map((row) => row.envelope);
  }

  /**
   * Records published by ANY of `userIds` in any of `collections`, as one
   * ordered page — the multi-author read a consuming app projects a
   * cross-app feed from ("give me records of these 300 people, of these lexicon
   * types, since this cursor").
   *
   * Every other read on this store is single-subject, because the protocol
   * engine is: `RecordStore` exists for verify-then-append and a feed is not
   * that. This one is deliberately NOT part of that interface.
   *
   * ## The cursor is (created_at, id), and it can REPEAT a record — never skip
   *
   * `created_at` is `defaultNow()`, and `now()` in Postgres is the TRANSACTION
   * START time, not the commit time. A transaction that starts earlier can
   * commit later, so a reader holding a strictly-increasing cursor can pass a
   * timestamp that a not-yet-committed row will later occupy — and that row is
   * then invisible forever. A monotonic sequence would not fix it: a sequence
   * value is also assigned at insert, not at commit.
   *
   * So this page is complete only up to that race, and callers MUST re-poll from
   * slightly BEFORE their last cursor rather than exactly at it. That is safe
   * here specifically because a record is content-addressed (`record_id` is
   * unique) and projection is idempotent, so re-delivering one costs bytes while
   * skipping one costs a post that never appears. `id` breaks ties within a
   * timestamp: it is a total order, though not a chronological one (pre-cutover
   * ids are ObjectId hex, post-cutover ones uuid v7, and the two do not sort
   * against each other) — which is exactly why it is the TIEBREAKER and
   * `created_at` is the axis.
   *
   * Only `verified` rows with an `nsid` are returned: an unverified row has no
   * business in anyone's feed, and a v1 row has no lexicon to filter on.
   *
   * ## `collections` is a POLICY, and here it is a privacy boundary
   *
   * The store has no notion of a public collection — `getPublicLogSince` takes
   * its allowlist for the same reason, and `repoLog.service`'s
   * `PUBLIC_LOG_COLLECTIONS` is where that policy is written down. It matters
   * more on THIS read: that one serves one subject's bootstrap log under a
   * constant, while this one spans subjects and serves app records, and a
   * person's chain interleaves an app's PUBLIC and PRIVATE collections in one
   * log. Mention's `app.mention.feed.bookmark` is declared in
   * `@mention/shared-types` as "a private bookmark (excluded from any public
   * log)" — a fact Oxy cannot derive, because which of an app's collections are
   * publishable is the APP's knowledge and no registry carries it yet.
   *
   * So a read surface built on this MUST pass an allowlist it owns, in the shape
   * `PUBLIC_LOG_COLLECTIONS` already has. Passing a request-supplied list
   * straight through hands every caller everyone's saved posts, and nothing
   * below this line would notice.
   *
   * THROWS rather than truncating when a cap is exceeded. A silently shortened
   * author list reads as "these people published nothing".
   */
  async listRecordsByAuthors(params: {
    userIds: readonly string[];
    collections: readonly string[];
    after?: AuthorRecordCursor | null;
    limit?: number;
  }): Promise<AuthorRecordPage> {
    const userIds = [...new Set(params.userIds)];
    const collections = [...new Set(params.collections)];

    if (userIds.length > MAX_RECORD_AUTHORS) {
      throw new Error(`listRecordsByAuthors: ${userIds.length} authors exceeds the ${MAX_RECORD_AUTHORS} cap`);
    }
    if (collections.length > MAX_RECORD_COLLECTIONS) {
      throw new Error(
        `listRecordsByAuthors: ${collections.length} collections exceeds the ${MAX_RECORD_COLLECTIONS} cap`,
      );
    }
    // An empty filter is an empty result, never "everything" — the same guard
    // `getPublicLogSince` makes for its collection allowlist.
    if (userIds.length === 0 || collections.length === 0) {
      return { records: [], nextCursor: null };
    }

    const limit = clampLogLimit(params.limit ?? DEFAULT_LOG_LIMIT);
    const after = params.after ?? null;

    const conditions: SQL[] = [
      inArray(signedRecords.userId, userIds),
      inArray(signedRecords.nsid, collections),
      eq(signedRecords.verified, true),
    ];
    if (after) {
      // Row-value comparison so the keyset rides the (user_id, created_at, id)
      // index instead of becoming a filter over an OR expansion.
      //
      // The timestamp is bound as an ISO string with an explicit cast, not as a
      // `Date`. A raw `sql` fragment carries no column type, so the driver has
      // nothing to infer from and rejects the value outright
      // (`The "string" argument must be of type string … Received an instance of
      // Date`) — drizzle only maps `Date` → `timestamptz` when the parameter sits
      // against a typed column, which is exactly what a row-value comparison is
      // not.
      conditions.push(
        sql`(${signedRecords.createdAt}, ${signedRecords.id}) > (${after.createdAt.toISOString()}::timestamptz, ${after.id})`,
      );
    }

    const rows = await getDb()
      .select({
        id: signedRecords.id,
        userId: signedRecords.userId,
        recordId: signedRecords.recordId,
        nsid: signedRecords.nsid,
        createdAt: signedRecords.createdAt,
        envelope: signedRecords.envelope,
      })
      .from(signedRecords)
      .where(and(...conditions))
      .orderBy(asc(signedRecords.createdAt), asc(signedRecords.id))
      .limit(limit);

    const records = rows.map((row) => ({
      id: row.id,
      userId: row.userId,
      // The `signed_records_chain_completeness_check` CHECK makes `record_id`
      // and `nsid` non-null on exactly the rows this query selects (`nsid is
      // not null`), so the narrowing is guaranteed by the schema, not assumed.
      recordId: row.recordId as string,
      nsid: row.nsid as string,
      createdAt: row.createdAt,
      envelope: row.envelope,
    }));

    const last = records.at(-1);
    return {
      records,
      // A full page means there may be more; a short one is the end of the
      // stream as of this snapshot. Either way the caller re-polls with overlap.
      nextCursor: last && records.length === limit ? { createdAt: last.createdAt, id: last.id } : null,
    };
  }

  /** Latest stored record of `type` for a user (v1 singleton read), or null. */
  async latestRecordOfType(
    userId: string,
    type: 'identity' | 'profile',
  ): Promise<{ envelope: SignedRecordEnvelope } | null> {
    const [row] = await getDb()
      .select({ envelope: signedRecords.envelope })
      .from(signedRecords)
      .where(and(eq(signedRecords.userId, userId), eq(signedRecords.type, type)))
      .orderBy(desc(signedRecords.createdAt))
      .limit(1);
    return row ?? null;
  }

  /**
   * The stored envelope for a content address, or `null`.
   *
   * Used by credential verification, which ALWAYS recomputes the canonical
   * signing input from the stored envelope rather than trusting a projection.
   * `record_id` is unique, so this is a single-row lookup.
   */
  async envelopeByRecordId(recordId: string): Promise<SignedRecordEnvelope | null> {
    const [row] = await getDb()
      .select({ envelope: signedRecords.envelope })
      .from(signedRecords)
      .where(eq(signedRecords.recordId, recordId))
      .limit(1);
    return row?.envelope ?? null;
  }

  /**
   * Whether a content address names a STORED record.
   *
   * The one read that distinguishes "the engine computed this address" from
   * "the ledger holds a row under it" — a v1 append returns an address it never
   * persists. Every projection that carries `record_id` as a foreign key relies
   * on the distinction; see `signedRecord.service.ts`'s `chain_required` policy.
   */
  async hasRecordId(recordId: string): Promise<boolean> {
    const [row] = await getDb()
      .select({ recordId: signedRecords.recordId })
      .from(signedRecords)
      .where(and(eq(signedRecords.recordId, recordId), isNotNull(signedRecords.recordId)))
      .limit(1);
    return row !== undefined;
  }
}

/** The singleton Oxy record store the chain adapter + repo-log glue drive. */
export const oxyRecordStore = new OxyRecordStoreImpl();

/** Build the subject DID for an Oxy `userId` (the store's subject key). */
export function subjectKeyForUser(userId: string): string {
  return buildUserDid(userId);
}
