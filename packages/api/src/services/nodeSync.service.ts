/**
 * Node Sync Service (self-sovereign identity layer — F5b node → Oxy ingest)
 *
 * Pulls a user's authentic signed-record chain BACK from their personal data
 * node and mirrors it into Oxy's fast local copy (`signed_records` +
 * `repo_heads`). This is the inbound half of the two-way sync; F5a is the
 * outbound (Oxy → node) export.
 *
 * ## Absolute read-path invariant
 *
 * Every node fetch here goes through `@oxyhq/core/server`'s `safeFetch`
 * (HTTPS-only, private-IP denylist, DNS-pinned, bounded redirects) and runs ONLY
 * in the background (the BullMQ worker / the in-process fallback). NOTHING in a
 * request's read path ever calls this. A down/slow/malicious node leaves Oxy's
 * mirror STALE — never wrong and never slow. `ingestFromNode` NEVER throws into a
 * caller; it logs and records `lastError` on the `user_nodes` row.
 *
 * ## Trust model — verify everything, trust nothing the node says
 *
 * The node is untrusted transport. Every record it returns is independently
 * re-verified with the EXISTING `signedRecord.service.verifyAndStoreRecord`
 * (signature over the canonical input, recomputed `recordId`,
 * current-verification-method / subject ownership, freshness, and v2 chain
 * continuity). A record whose `publicKey` is not a current verification method of
 * THIS user's DID, or whose `subject` is not this user's DID, is rejected as
 * forged/foreign — a node cannot inject a record the user did not sign.
 *
 * ## Conflict resolution
 *
 *  - **Linear append** (the normal case): a record that extends Oxy's chain head
 *    by one is appended atomically via `verifyAndStoreRecord`, advancing the
 *    head and the `user_nodes` cursor.
 *  - **Last-writer-wins per `(userId, nsid, rkey)`**: a record whose `issuedAt`
 *    is not newer than Oxy's current value for that key (tiebreak: higher
 *    `recordId`) is the loser — Oxy keeps what it has and skips. This also makes
 *    re-pulling an already-ingested record idempotent.
 *  - **Genuine fork** (a record authentically signed by the owner that conflicts
 *    Oxy's chain at an existing point): append-only history is authentic, so the
 *    forked envelope is ALSO preserved (stored as a non-chained mirror row so the
 *    unique `(user_id, seq)` chain index is never violated) and the materialized
 *    "current" value for its key advances to it when it wins LWW. Both branches
 *    persist; nothing is ever deleted; the fork is logged.
 *
 * ## The fork mirror is what `seq is null` MEANS on a v2 row
 *
 * A fork carries a `seq` that is already taken, so it cannot join the linear
 * chain — the whole point of the unique `(user_id, seq)` index. It is stored with
 * its content address and record key but WITHOUT `seq`, which is exactly how the
 * ledger says "authentic, preserved, off the linear chain".
 * `signed_records_chain_completeness_check` admits that shape (a v2 row needs
 * `record_id`/`nsid`/`rkey` together; `seq` is the separate on-chain marker) —
 * before migration `0009` it did not, and this whole branch could only ever have
 * raised a CHECK violation. See `db/schema/signedRecords.ts`.
 *
 * ## Anti-rewrite counter-signature
 *
 * Every recordId Oxy ingests is COUNTER-SIGNED with the Oxy custodial key into an
 * append-only `node_ingest_witnesses` row. If the user's node key were stolen and
 * used to silently rewrite history, the witness proves the original record
 * existed and was observed by Oxy at a specific time. When the Oxy key is
 * unconfigured (dev/pre-prod) witnessing is skipped (logged once) but ingest
 * still proceeds.
 *
 * `ingested_at` is a `timestamptz` column but the SIGNED input keeps the
 * millisecond epoch number Mongo stored, so the signature over
 * `canonicalize({ recordId, userId, ingestedAt })` is reproducible from the
 * stored row via `.getTime()`.
 */

import { and, desc, eq, ne } from 'drizzle-orm';
import { canonicalize, computeRecordId } from '@oxyhq/protocol';
import { NodeClient, type NodeFetch } from '@oxyhq/protocol/node';
import { safeFetch } from '@oxyhq/core/server';
import {
  oxySignedRecordTypeSchema,
  signedRecordEnvelopeSchema,
  type SignedRecordEnvelope,
} from '@oxyhq/contracts';
import { getDb } from '../config/postgres';
import { nodeIngestWitnesses } from '../db/schema/nodeIngestWitnesses';
import { signedRecords } from '../db/schema/signedRecords';
import { userNodes } from '../db/schema/userNodes';
import SignatureService from './signature.service';
import { getHead } from './repoLog.service';
import { verifyAndStoreRecord } from './signedRecord.service';
import userCache from '../utils/userCache';
import { logger } from '../utils/logger';
import {
  NODE_INGEST_BATCH,
  NODE_INGEST_MAX_ITERATIONS,
  NODE_INGEST_FETCH_TIMEOUT_MS,
  NODE_INGEST_MAX_BYTES,
  NODE_LAST_ERROR_MAX_LEN,
} from '../utils/nodes.constants';

/** True only once the missing-Oxy-key warning has been logged (avoid log spam). */
let warnedMissingOxyKey = false;

/** Per-record ingest outcome, used to drive cursor advance + loop control. */
type IngestOutcome =
  | { kind: 'appended'; seq: number; recordId: string }
  | { kind: 'fork'; recordId: string }
  | { kind: 'skipped' }
  | { kind: 'stop'; reason: string };

/**
 * The injected transport for the protocol {@link NodeClient}: a thin adapter over
 * `@oxyhq/core/server`'s `safeFetch` (HTTPS-only, DNS-pinned, private-IP
 * denylist, bounded redirects). The client owns the bounded-body reads; this
 * adapter only hands it the SSRF-safe streamed response. The read-path invariant
 * still holds — this runs ONLY in the background ingest worker.
 */
const nodeFetch: NodeFetch = async (url, init) => {
  const result = await safeFetch(url, {
    method: init.method,
    ...(init.headers ? { headers: init.headers } : {}),
    headersTimeoutMs: init.headersTimeoutMs,
    maxRedirects: init.maxRedirects,
  });
  return {
    status: result.status,
    headers: result.headers,
    body: result.response,
    destroy: () => result.response.destroy(),
  };
};

/** Build a {@link NodeClient} for a node endpoint with the ingest tunables. */
function makeNodeClient(endpoint: string): NodeClient {
  return new NodeClient({
    baseUrl: endpoint,
    fetch: nodeFetch,
    headersTimeoutMs: NODE_INGEST_FETCH_TIMEOUT_MS,
    maxRedirects: 1,
    logMaxBytes: NODE_INGEST_MAX_BYTES,
  });
}

/** Every non-revoked node row for a user — the only rows ingest ever writes. */
function liveNodeFor(userId: string) {
  return and(eq(userNodes.userId, userId), ne(userNodes.status, 'revoked'));
}

/**
 * The `cursor` COLUMN value for an in-memory cursor.
 *
 * `-1` is this module's in-memory sentinel for "nothing mirrored yet"; the
 * column expresses that as NULL, and `user_nodes_cursor_check` refuses a
 * negative. Mongo stored the `-1` verbatim, so a literal translation writes a
 * row Postgres rejects — and because the write sits inside the background-safe
 * `try`, the rejection would be swallowed into `lastError` and every ingest that
 * had appended nothing yet (a chain gap, a rejected record, an unreachable
 * frontier) would silently fail to stamp its real reason.
 */
function storedCursor(cursor: number): number | null {
  return cursor < 0 ? null : cursor;
}

/**
 * Counter-sign an ingested recordId with the Oxy custodial key and append it to
 * the witness ledger (idempotent per recordId). Non-fatal and never throws: a
 * missing Oxy key skips witnessing (warned once); a re-pull of an already
 * witnessed record is a no-op via `on conflict do nothing`.
 *
 * `ingestedAt` stays a millisecond epoch NUMBER in the signed input — it is part
 * of the signature — and is stored as the equivalent `timestamptz` instant.
 */
async function witnessRecord(userId: string, recordId: string, ingestedAt: number): Promise<void> {
  const privateKey = process.env.OXY_PRIVATE_KEY;
  const publicKey = process.env.OXY_PUBLIC_KEY;
  if (!privateKey || !publicKey) {
    if (!warnedMissingOxyKey) {
      warnedMissingOxyKey = true;
      logger.warn('Node ingest counter-signing skipped: OXY_PRIVATE_KEY/OXY_PUBLIC_KEY not configured', {
        component: 'nodeSync',
      });
    }
    return;
  }
  try {
    const witnessSignature = SignatureService.signMessage(
      canonicalize({ recordId, userId, ingestedAt }),
      privateKey,
    );
    await getDb()
      .insert(nodeIngestWitnesses)
      .values({ userId, recordId, witnessSignature, ingestedAt: new Date(ingestedAt) })
      .onConflictDoNothing({ target: nodeIngestWitnesses.recordId });
  } catch (err) {
    // Background-safe: a witness is evidence, never a gate on ingest. The one
    // error that reaches here is a foreign-key violation from a content address
    // that names no stored row (an unchained v1 append), and it must be visible.
    logger.warn('Node ingest counter-signature failed (non-fatal)', {
      component: 'nodeSync',
      userId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * The current materialized record for an AtProto-style `(nsid, rkey)` key, as the
 * minimal `{ issuedAt, recordId }` LWW needs. Reads Oxy's own copy only.
 */
async function currentKeyValue(
  userId: string,
  nsid: string,
  rkey: string,
): Promise<{ issuedAt: number; recordId: string } | null> {
  const [row] = await getDb()
    .select({ recordId: signedRecords.recordId, envelope: signedRecords.envelope })
    .from(signedRecords)
    .where(
      and(
        eq(signedRecords.userId, userId),
        eq(signedRecords.nsid, nsid),
        eq(signedRecords.rkey, rkey),
        eq(signedRecords.verified, true),
      ),
    )
    .orderBy(desc(signedRecords.createdAt))
    .limit(1);
  // `record_id` is non-null for any row carrying an `nsid`
  // (`signed_records_chain_completeness_check`), so this guard is the type
  // system's, not a real case — but LWW must never compare against a missing
  // content address, so it is answered as "no current value" rather than cast.
  if (!row || row.recordId === null) {
    return null;
  }
  return { issuedAt: row.envelope.issuedAt, recordId: row.recordId };
}

/**
 * Last-writer-wins decision: does the incoming record supersede the existing
 * value for its key? Newer `issuedAt` wins; on an exact `issuedAt` tie the higher
 * `recordId` (string compare) wins. No existing value → incoming always wins.
 */
function incomingWinsLww(
  incoming: { issuedAt: number; recordId: string },
  existing: { issuedAt: number; recordId: string } | null,
): boolean {
  if (!existing) return true;
  if (incoming.issuedAt !== existing.issuedAt) return incoming.issuedAt > existing.issuedAt;
  return incoming.recordId > existing.recordId;
}

/**
 * Persist a forked / tie-breaking envelope as a NON-chained mirror row. It keeps
 * the AtProto `(nsid, rkey)` materialization fields and `recordId` (so it becomes
 * the current value for its key by `created_at`) but deliberately carries NO
 * `seq` — the authentic linear chain, and its unique `(user_id, seq)` index, is
 * left untouched, so both the existing chain row AND this fork branch persist.
 * The unique `record_id` index makes a re-ingested fork idempotent.
 *
 * Only a v2 envelope can fork (a v1 append runs no continuity check at all), so
 * the chain fields are required here rather than derived — a v1 envelope would
 * otherwise produce a half-chained row the CHECK constraint refuses.
 *
 * Returns `true` when this call is the one that stored the row.
 */
async function storeForkMirror(
  env: SignedRecordEnvelope,
  userId: string,
  recordId: string,
  nsid: string,
  rkey: string,
): Promise<boolean> {
  // The envelope `type` is an OPEN string on the shared protocol grammar; the
  // `signed_records.type` column is the closed Oxy set with a matching CHECK.
  // `verifyAndStoreRecord`'s store policy already rejected anything outside it
  // (as `invalid_envelope`, which never reaches a fork branch), so this is the
  // narrowing that carries the guarantee into the INSERT rather than a cast.
  const oxyType = oxySignedRecordTypeSchema.safeParse(env.type);
  if (!oxyType.success) {
    logger.warn('Node ingest refused to mirror a fork of a non-Oxy record type', {
      component: 'nodeSync',
      userId,
      recordId,
    });
    return false;
  }

  const inserted = await getDb()
    .insert(signedRecords)
    .values({
      subjectDid: env.subject,
      userId,
      type: oxyType.data,
      envelope: env,
      publicKey: env.publicKey,
      verified: true,
      // No `seq`/`prev` — intentionally off the linear chain (fork archive).
      recordId,
      nsid,
      rkey,
    })
    .onConflictDoNothing({ target: signedRecords.recordId })
    .returning({ id: signedRecords.id });
  return inserted.length > 0;
}

/**
 * Verify + ingest a single envelope from the node. Drives the cursor/loop via the
 * returned {@link IngestOutcome}. `verifyAndStoreRecord` does the heavy lifting
 * (re-verify + atomic append + head advance); its rejection reason routes the
 * record to LWW-skip, fork-preserve, or hard-reject.
 */
async function ingestEnvelope(
  env: SignedRecordEnvelope,
  userId: string,
): Promise<IngestOutcome> {
  const result = await verifyAndStoreRecord(env, userId);

  if (result.ok) {
    await witnessRecord(userId, result.record.recordId, Date.now());
    return { kind: 'appended', seq: result.record.seq, recordId: result.record.recordId };
  }

  switch (result.reason) {
    case 'stale_issued_at': {
      // LWW: incoming is not newer for its key — usually idempotent re-pull. Only
      // an exact-issuedAt tie with a higher recordId flips to incoming (fork
      // archive); otherwise Oxy keeps what it has. Either way the linear chain
      // cannot advance through a stale frontier record, so we stop.
      if (env.version === 2 && typeof env.collection === 'string' && typeof env.rkey === 'string') {
        const recordId = await computeRecordId(env);
        const existing = await currentKeyValue(userId, env.collection, env.rkey);
        if (incomingWinsLww({ issuedAt: env.issuedAt, recordId }, existing)) {
          const stored = await storeForkMirror(env, userId, recordId, env.collection, env.rkey);
          if (stored) {
            await witnessRecord(userId, recordId, Date.now());
            logger.info('Node ingest LWW tiebreak adopted incoming record', {
              component: 'nodeSync',
              userId,
              nsid: env.collection,
              rkey: env.rkey,
            });
            return { kind: 'stop', reason: 'lww_tiebreak' };
          }
        }
      }
      return { kind: 'skipped' };
    }

    case 'chain_fork':
    case 'bad_seq':
    case 'chain_conflict': {
      // A genuine fork: the record is authentically signed by the owner (signature
      // + ownership + freshness all passed before the chain check) but conflicts
      // Oxy's chain. Preserve it append-only and let it win materialization for
      // its key (it is strictly newer — `stale_issued_at` is handled above). The
      // authentic linear chain is left intact; we stop advancing past the fork.
      const recordId = await computeRecordId(env);
      if (env.version !== 2 || typeof env.collection !== 'string' || typeof env.rkey !== 'string') {
        // Unreachable: only a v2 envelope is chain-checked, so only a v2 envelope
        // can be rejected for a chain reason. Answered as a hard stop rather than
        // written, because a half-chained mirror row is not representable.
        logger.warn('Node ingest saw a chain rejection on an unchained envelope', {
          component: 'nodeSync',
          userId,
          reason: result.reason,
        });
        return { kind: 'stop', reason: `rejected:${result.reason}` };
      }
      const stored = await storeForkMirror(env, userId, recordId, env.collection, env.rkey);
      if (stored) {
        await witnessRecord(userId, recordId, Date.now());
      }
      logger.warn('Node ingest detected a chain fork; preserved both branches', {
        component: 'nodeSync',
        userId,
        reason: result.reason,
        recordId,
      });
      return { kind: 'fork', recordId };
    }

    case 'chain_gap':
      // Oxy is missing intermediate records this one builds on — cannot append out
      // of order. Stop and leave the mirror stale at the last good seq.
      return { kind: 'stop', reason: 'chain_gap' };

    default:
      // Forged / foreign / malformed: subject_mismatch,
      // public_key_not_a_current_verification_method, untrusted_issuer,
      // bad_signature, invalid_envelope, issued_in_future. Reject and stop so a
      // poisoned log entry can never advance the mirror.
      logger.warn('Node ingest rejected a record', {
        component: 'nodeSync',
        userId,
        reason: result.reason,
      });
      return { kind: 'stop', reason: `rejected:${result.reason}` };
  }
}

/**
 * Ingest a user's chain from their registered node into Oxy's local mirror.
 *
 * Background-safe: NEVER throws. A missing/revoked/unreachable node is a no-op
 * (or records `lastError`) — the mirror simply stays as-is. On success the
 * `user_nodes` cursor (= Oxy's local head seq) and `lastSyncedAt` advance, and
 * the user cache is invalidated when the materialized records/DID changed.
 */
export async function ingestFromNode(userId: string): Promise<void> {
  try {
    const [node] = await getDb()
      .select({ endpoint: userNodes.endpoint, cursor: userNodes.cursor })
      .from(userNodes)
      .where(liveNodeFor(userId))
      .limit(1);
    if (!node) {
      // No registered node — nothing to ingest. This ALSO covers a deleted
      // account: `user_nodes.user_id` is `NOT NULL REFERENCES users(id) ON
      // DELETE CASCADE`, so a node row cannot outlive its account. Mongo had no
      // such constraint and needed a separate existence check here; in Postgres
      // that check can never fail, so it is deleted rather than translated.
      return;
    }

    const client = makeNodeClient(node.endpoint);

    // Compare the node's head against Oxy's local head. When Oxy is already at or
    // ahead of the node, there is nothing to pull — just stamp the sync time.
    let remoteHeadSeq: number;
    try {
      const head = await client.head();
      remoteHeadSeq = typeof head.seq === 'number' && Number.isFinite(head.seq) ? head.seq : -1;
    } catch (err) {
      await recordIngestError(userId, err);
      return;
    }

    const localHead = await getHead(userId);
    const localHeadSeq = localHead ? localHead.seq : -1;
    // Never re-pull below our own head: start from the greater of the persisted
    // cursor and the live local head (idempotent — avoids re-ingesting).
    let cursor = Math.max(node.cursor ?? -1, localHeadSeq);

    if (remoteHeadSeq <= cursor) {
      await markSynced(userId, cursor, true);
      return;
    }

    let changed = false;
    let stopReason: string | null = null;

    for (let iteration = 0; iteration < NODE_INGEST_MAX_ITERATIONS && !stopReason; iteration += 1) {
      let page: unknown[];
      try {
        page = (await client.log(cursor, NODE_INGEST_BATCH)).records;
      } catch (err) {
        await recordIngestError(userId, err);
        return;
      }
      if (page.length === 0) {
        break; // caught up
      }

      for (const raw of page) {
        const parsed = signedRecordEnvelopeSchema.safeParse(raw);
        if (!parsed.success) {
          stopReason = 'rejected:invalid_envelope';
          logger.warn('Node ingest rejected a malformed envelope', { component: 'nodeSync', userId });
          break;
        }
        const env = parsed.data;

        // Already mirrored (below our advanced cursor)? Skip without re-work.
        if (env.version === 2 && typeof env.seq === 'number' && env.seq <= cursor) {
          continue;
        }

        const outcome = await ingestEnvelope(env, userId);
        if (outcome.kind === 'appended') {
          cursor = outcome.seq >= 0 ? outcome.seq : cursor;
          changed = true;
        } else if (outcome.kind === 'fork') {
          changed = true;
          stopReason = 'chain_fork';
          break;
        } else if (outcome.kind === 'stop') {
          if (outcome.reason === 'lww_tiebreak') {
            changed = true;
          }
          stopReason = outcome.reason;
          break;
        }
        // 'skipped' → continue to the next record (LWW loser / idempotent).
      }

      // A short page means the node has no more records right now.
      if (page.length < NODE_INGEST_BATCH) {
        break;
      }
    }

    if (stopReason && stopReason !== 'lww_tiebreak') {
      await getDb()
        .update(userNodes)
        .set({
          cursor: storedCursor(cursor),
          lastSyncedAt: new Date(),
          lastError: stopReason.slice(0, NODE_LAST_ERROR_MAX_LEN),
        })
        .where(liveNodeFor(userId));
    } else {
      await markSynced(userId, cursor, true);
    }

    if (changed) {
      userCache.invalidate(userId);
    }
  } catch (err) {
    // Background-safe: a programming/DB error must never escape the worker.
    logger.error(
      'Node ingest encountered an error',
      err instanceof Error ? err : new Error(String(err)),
      { component: 'nodeSync', userId },
    );
    await recordIngestError(userId, err).catch(() => undefined);
  }
}

/** Advance the cursor + stamp `lastSyncedAt`; clear `lastError` when requested. */
async function markSynced(userId: string, cursor: number, clearError: boolean): Promise<void> {
  await getDb()
    .update(userNodes)
    .set({
      cursor: storedCursor(cursor),
      lastSyncedAt: new Date(),
      ...(clearError ? { lastError: null } : {}),
    })
    .where(liveNodeFor(userId));
}

/** Record a non-throwing ingest failure as `lastError` on the node row. */
async function recordIngestError(userId: string, err: unknown): Promise<void> {
  const message = err instanceof Error ? err.message : String(err);
  logger.debug('Node ingest fetch failed', { component: 'nodeSync', userId, error: message });
  await getDb()
    .update(userNodes)
    .set({ lastError: message.slice(0, NODE_LAST_ERROR_MAX_LEN), lastSyncedAt: new Date() })
    .where(liveNodeFor(userId));
}
