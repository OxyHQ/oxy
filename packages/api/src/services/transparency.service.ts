/**
 * Transparency checkpoint service — publishes and serves the log that lets a
 * third party audit Oxy WITHOUT trusting Oxy.
 *
 * The Merkle math, the leaf/checkpoint signing bytes, and the proof verifier all
 * live in `@oxyhq/protocol` (`src/transparency/`), app-agnostic and
 * independently reimplementable. This service is the Oxy-specific glue: it reads
 * the heads from `repo_heads`, commits them, signs with the Oxy custodial key,
 * and serves proofs from the snapshot each checkpoint committed to.
 *
 * Design rules that are load-bearing (see
 * `docs/superpowers/specs/2026-07-26-oxy-id-verifiability-faircoin-anchor-design.md`):
 *  - **One root per index, ever.** On a concurrent-write collision the loser
 *    ADOPTS the persisted checkpoint. Publishing a second signed root for the
 *    same index is the exact equivocation the log exists to detect.
 *  - **Never publish an unsigned checkpoint.** An unsigned root commits nobody,
 *    so a missing signing key is a hard failure, not a degraded mode.
 *  - **Proofs come from the committed snapshot**, never from the current heads —
 *    heads move, and a proof against a moved head would fail verification while
 *    the server looked correct.
 *  - **The snapshot never crosses the wire**: it would hand an unauthenticated
 *    caller an enumeration of every subject on the platform.
 *
 * ## What the Postgres port changed, and why each change is not cosmetic
 *
 * **The snapshot is a CHILD TABLE, so it is no longer dragged along by every
 * read.** In Mongo it was an embedded array, so `findOne` materialized up to
 * `MAX_CHECKPOINT_SUBJECTS` entries even when the caller only wanted the DTO —
 * and `toDto` then threw them away. `GET /transparency/checkpoints` did that
 * once per page entry. Here the checkpoint body plus its signatures and anchors
 * is one read, and the snapshot is loaded ONLY by the two paths that commit to
 * or prove against it. Nothing about the served bytes changes.
 *
 * **`period_end` and `anchored_at` are `timestamptz`, not epoch milliseconds.**
 * `period_end` is part of the SIGNED body, so the conversion is confined to this
 * file's boundary: `new Date(ms)` on the way in, `.getTime()` on the way out,
 * and the wire contract (`@oxyhq/contracts`, ms epoch) is unchanged. A
 * whole-millisecond value round-trips through microsecond-resolution
 * `timestamptz` exactly — asserted by a sign-store-read-verify test, not argued.
 *
 * **The concurrent-writer collision is a named unique violation.** Mongo's
 * `code === 11000` said only "some unique index fired"; `isUniqueViolation(err,
 * 'transparency_checkpoints_index_unique')` says WHICH, so a future index on
 * this table cannot silently start being read as "another task won this index".
 */

import {
  buildTransparencyTree,
  buildTransparencyTreeFromHeads,
  checkpointHash,
  inclusionProof,
  signCheckpoint,
  transparencyLeafHash,
  type TransparencyCheckpointFields,
  type TransparencyCheckpointSignature,
  type TransparencyHeadEntry,
  type TransparencyTree,
} from '@oxyhq/protocol';
import type {
  TransparencyCheckpoint as TransparencyCheckpointDto,
  TransparencyInclusionProof,
} from '@oxyhq/contracts';
import { asc, desc, eq, gte, inArray } from 'drizzle-orm';
import { getDb } from '../config/postgres';
import { isUniqueViolation } from '@oxyhq/db';
import { repoHeads } from '../db/schema/repoHeads';
import {
  transparencyCheckpointAnchors,
  transparencyCheckpointSignatures,
  transparencyCheckpointSnapshotEntries,
  transparencyCheckpoints,
} from '../db/schema/transparencyCheckpoints';
import { logger } from '../utils/logger';

/**
 * Ceiling on subjects per checkpoint.
 *
 * Inherited from Mongo, where the committed snapshot lived inside the checkpoint
 * document and had to stay an order of magnitude under the 16MB document limit.
 * Postgres has no such ceiling — the snapshot is its own table — but the bound
 * is KEPT deliberately: it also bounds how much work one `getInclusionProof`
 * cache miss does (the whole snapshot is re-hashed to rebuild the tree), and
 * that cost is real regardless of storage engine. Crossing it is a hard failure
 * rather than a silent truncation: a checkpoint whose proofs cannot be served is
 * worse than no checkpoint.
 */
export const MAX_CHECKPOINT_SUBJECTS = 50_000;

/** How many checkpoints' derived trees stay cached in-process. */
const TREE_CACHE_LIMIT = 2;

/**
 * The derived Merkle tree per committed ROOT, so serving repeated proofs for one
 * checkpoint neither re-hashes the snapshot nor rebuilds the tree. Bounded, and
 * purely derived from immutable committed data — never a source of truth.
 *
 * Caching the whole tree rather than just its leaves is what keeps a proof
 * O(log n): the interior levels are already there to read siblings from.
 *
 * Keyed by the root rather than by the checkpoint index, because the root IS the
 * content address of the tree: a cache hit can only ever be a tree over the
 * exact leaves, in the exact order, that the checkpoint being proved against
 * committed to. An index-keyed cache is only correct while no index is ever
 * reused, which is true of the published log but is an invariant held somewhere
 * else — and its failure mode is silent, serving proofs that verify against a
 * root nobody published.
 */
const treeCache = new Map<string, TransparencyTree>();

/**
 * A stored checkpoint WITHOUT its snapshot: the signed body plus the two arrays
 * that grow after insert. This is everything the public DTO needs.
 *
 * `id` is carried because the child tables key off it — the snapshot load and
 * every future append aim at the row, not at `index`.
 */
interface StoredCheckpoint {
  id: string;
  index: number;
  periodEnd: Date;
  treeSize: number;
  root: string;
  prevCheckpointHash: string | null;
  signatures: TransparencyCheckpointSignature[];
  anchors: TransparencyCheckpointDto['anchors'];
}

/** One subject's committed head, in the checkpoint's canonical leaf order. */
interface SnapshotEntry {
  subjectDid: string;
  seq: number;
  headRecordId: string;
}

/** The five fields every co-signer signs — the checkpoint's immutable body. */
export function checkpointSignedFields(
  checkpoint: Pick<
    TransparencyCheckpointDto,
    'index' | 'periodEnd' | 'treeSize' | 'root' | 'prevCheckpointHash'
  >,
): TransparencyCheckpointFields {
  return {
    index: checkpoint.index,
    periodEnd: checkpoint.periodEnd,
    treeSize: checkpoint.treeSize,
    root: checkpoint.root,
    prevCheckpointHash: checkpoint.prevCheckpointHash,
  };
}

/** Strip a stored checkpoint down to the public contract — no `snapshot`, by construction. */
function toDto(stored: StoredCheckpoint): TransparencyCheckpointDto {
  return {
    index: stored.index,
    periodEnd: stored.periodEnd.getTime(),
    treeSize: stored.treeSize,
    root: stored.root,
    prevCheckpointHash: stored.prevCheckpointHash,
    signatures: stored.signatures,
    anchors: stored.anchors,
  };
}

/** The checkpoint-body columns every read selects. Never a whole-row read. */
const CHECKPOINT_COLUMNS = {
  id: transparencyCheckpoints.id,
  index: transparencyCheckpoints.index,
  periodEnd: transparencyCheckpoints.periodEnd,
  treeSize: transparencyCheckpoints.treeSize,
  root: transparencyCheckpoints.root,
  prevCheckpointHash: transparencyCheckpoints.prevCheckpointHash,
} as const;

/** The checkpoint body of a set of rows, without the appended children. */
type CheckpointBody = Omit<StoredCheckpoint, 'signatures' | 'anchors'>;

/**
 * Attach each checkpoint's signatures and anchors.
 *
 * Two queries for the whole page rather than two per checkpoint: `listCheckpoints`
 * serves up to 200 at a time, and a per-row load would turn one page into 401
 * round trips.
 */
async function withChildren(bodies: CheckpointBody[]): Promise<StoredCheckpoint[]> {
  if (bodies.length === 0) {
    return [];
  }

  const ids = bodies.map((body) => body.id);
  const db = getDb();
  const [signatureRows, anchorRows] = await Promise.all([
    db
      .select({
        checkpointId: transparencyCheckpointSignatures.checkpointId,
        publicKey: transparencyCheckpointSignatures.publicKey,
        alg: transparencyCheckpointSignatures.alg,
        signature: transparencyCheckpointSignatures.signature,
      })
      .from(transparencyCheckpointSignatures)
      .where(inArray(transparencyCheckpointSignatures.checkpointId, ids))
      // Oxy's signature first, then witnesses — the order `buildCheckpoint`
      // wrote and the order the DTO has always carried.
      .orderBy(asc(transparencyCheckpointSignatures.position)),
    db
      .select({
        checkpointId: transparencyCheckpointAnchors.checkpointId,
        network: transparencyCheckpointAnchors.network,
        txid: transparencyCheckpointAnchors.txid,
        confirmations: transparencyCheckpointAnchors.confirmations,
        anchoredAt: transparencyCheckpointAnchors.anchoredAt,
      })
      .from(transparencyCheckpointAnchors)
      .where(inArray(transparencyCheckpointAnchors.checkpointId, ids))
      .orderBy(asc(transparencyCheckpointAnchors.anchoredAt)),
  ]);

  return bodies.map((body) => ({
    ...body,
    signatures: signatureRows
      .filter((row) => row.checkpointId === body.id)
      .map((row) => ({ publicKey: row.publicKey, alg: row.alg, signature: row.signature })),
    anchors: anchorRows
      .filter((row) => row.checkpointId === body.id)
      .map((row) => ({
        network: row.network,
        txid: row.txid,
        confirmations: row.confirmations,
        anchoredAt: row.anchoredAt.getTime(),
      })),
  }));
}

/** The newest stored checkpoint, or `null` before the first one. */
async function loadNewest(): Promise<StoredCheckpoint | null> {
  const bodies = await getDb()
    .select(CHECKPOINT_COLUMNS)
    .from(transparencyCheckpoints)
    .orderBy(desc(transparencyCheckpoints.index))
    .limit(1);
  const [stored] = await withChildren(bodies);
  return stored ?? null;
}

/** A stored checkpoint by index, or `null`. */
async function loadByIndex(index: number): Promise<StoredCheckpoint | null> {
  const bodies = await getDb()
    .select(CHECKPOINT_COLUMNS)
    .from(transparencyCheckpoints)
    .where(eq(transparencyCheckpoints.index, index))
    .limit(1);
  const [stored] = await withChildren(bodies);
  return stored ?? null;
}

/**
 * A checkpoint's committed heads, in the exact order the Merkle tree committed
 * to them — `leaf_index` IS the leaf position, so the ordering is the contract,
 * not a convenience.
 */
async function loadSnapshot(checkpointId: string): Promise<SnapshotEntry[]> {
  return getDb()
    .select({
      subjectDid: transparencyCheckpointSnapshotEntries.subjectDid,
      seq: transparencyCheckpointSnapshotEntries.seq,
      headRecordId: transparencyCheckpointSnapshotEntries.headRecordId,
    })
    .from(transparencyCheckpointSnapshotEntries)
    .where(eq(transparencyCheckpointSnapshotEntries.checkpointId, checkpointId))
    .orderBy(asc(transparencyCheckpointSnapshotEntries.leafIndex));
}

/**
 * Compute, sign, and publish the checkpoint for a period.
 *
 * Reads every chain head, commits them under one Merkle root, links the root to
 * the previous checkpoint, signs it with the Oxy custodial key, and stores it
 * with the committed snapshot. Returns the PERSISTED checkpoint — which, on a
 * concurrent-write collision, is the winner's, not this call's.
 */
export async function buildCheckpoint(periodEnd: number): Promise<TransparencyCheckpointDto> {
  const privateKey = process.env.OXY_PRIVATE_KEY;
  if (!privateKey) {
    // An unsigned root commits nobody — refuse rather than publish one.
    throw new Error('Cannot publish a transparency checkpoint: OXY_PRIVATE_KEY is not configured');
  }

  const db = getDb();
  const rows = await db
    .select({
      subjectDid: repoHeads.subjectDid,
      seq: repoHeads.seq,
      headRecordId: repoHeads.headRecordId,
    })
    .from(repoHeads);

  if (rows.length > MAX_CHECKPOINT_SUBJECTS) {
    throw new Error(
      `Cannot publish a transparency checkpoint: ${rows.length} subjects exceeds the ${MAX_CHECKPOINT_SUBJECTS} ceiling for an inline snapshot`,
    );
  }

  const entries: TransparencyHeadEntry[] = rows.map((row) => ({
    subjectDid: row.subjectDid,
    seq: row.seq,
    headRecordId: row.headRecordId,
  }));
  const tree = await buildTransparencyTreeFromHeads(entries);

  const previous = await loadNewest();
  const fields: TransparencyCheckpointFields = {
    index: previous ? previous.index + 1 : 0,
    periodEnd,
    treeSize: tree.treeSize,
    root: tree.root,
    prevCheckpointHash: previous
      ? await checkpointHash(checkpointSignedFields(toDto(previous)))
      : null,
  };

  const signature = await signCheckpoint(fields, privateKey);

  // The snapshot must be stored in the SAME order the tree committed to, so a
  // proof's leaf index matches the tree. `indexBySubject` owns that order.
  const snapshot = [...entries].sort(
    (a, b) => tree.indexBySubject[a.subjectDid] - tree.indexBySubject[b.subjectDid],
  );

  try {
    // One transaction: a checkpoint whose snapshot half failed would serve
    // proofs against a root it cannot reproduce. Mongo could not express this at
    // all — the embedded array made it a single document write by accident
    // rather than by design.
    await db.transaction(async (tx) => {
      const [created] = await tx
        .insert(transparencyCheckpoints)
        .values({
          index: fields.index,
          periodEnd: new Date(fields.periodEnd),
          treeSize: fields.treeSize,
          root: fields.root,
          prevCheckpointHash: fields.prevCheckpointHash,
        })
        .returning({ id: transparencyCheckpoints.id });

      await tx.insert(transparencyCheckpointSignatures).values({
        checkpointId: created.id,
        position: 0,
        publicKey: signature.publicKey,
        alg: signature.alg,
        signature: signature.signature,
      });

      if (snapshot.length > 0) {
        await tx.insert(transparencyCheckpointSnapshotEntries).values(
          snapshot.map((entry, leafIndex) => ({
            checkpointId: created.id,
            leafIndex,
            subjectDid: entry.subjectDid,
            seq: entry.seq,
            headRecordId: entry.headRecordId,
          })),
        );
      }
    });

    return {
      index: fields.index,
      periodEnd: fields.periodEnd,
      treeSize: fields.treeSize,
      root: fields.root,
      prevCheckpointHash: fields.prevCheckpointHash,
      signatures: [signature],
      // A freshly published checkpoint is never anchored yet — anchors are
      // broadcast asynchronously and appended later.
      anchors: [],
    };
  } catch (error) {
    if (!isUniqueViolation(error, 'transparency_checkpoints_index_unique')) {
      throw error;
    }
    // Another task published this index first. Its root is the published one;
    // ours is discarded rather than retried — two signed roots for one index is
    // exactly the equivocation this log exists to detect.
    const winner = await loadByIndex(fields.index);
    if (!winner) {
      throw error;
    }
    logger.warn('Transparency checkpoint index already published; adopting the persisted root', {
      index: fields.index,
    });
    return toDto(winner);
  }
}

/** The newest published checkpoint, or `null` before the first one. */
export async function getLatestCheckpoint(): Promise<TransparencyCheckpointDto | null> {
  const stored = await loadNewest();
  return stored ? toDto(stored) : null;
}

/** One published checkpoint by index, or `null`. */
export async function getCheckpoint(index: number): Promise<TransparencyCheckpointDto | null> {
  const stored = await loadByIndex(index);
  return stored ? toDto(stored) : null;
}

/**
 * The checkpoint chain from `sinceIndex`, oldest first, so a verifier can walk
 * `prevCheckpointHash` links itself.
 */
export async function listCheckpoints(
  sinceIndex: number,
  limit: number,
): Promise<TransparencyCheckpointDto[]> {
  const bodies = await getDb()
    .select(CHECKPOINT_COLUMNS)
    .from(transparencyCheckpoints)
    .where(gte(transparencyCheckpoints.index, sinceIndex))
    .orderBy(asc(transparencyCheckpoints.index))
    .limit(limit);
  const stored = await withChildren(bodies);
  return stored.map(toDto);
}

/** The Merkle tree over a checkpoint's committed snapshot, memoized per root. */
async function treeFor(root: string, snapshot: SnapshotEntry[]): Promise<TransparencyTree> {
  const cached = treeCache.get(root);
  if (cached) {
    return cached;
  }
  const leaves = await Promise.all(
    snapshot.map((entry) =>
      transparencyLeafHash({
        subjectDid: entry.subjectDid,
        seq: entry.seq,
        headRecordId: entry.headRecordId,
      }),
    ),
  );
  const tree = await buildTransparencyTree(leaves);
  if (treeCache.size >= TREE_CACHE_LIMIT) {
    const oldest = treeCache.keys().next();
    if (!oldest.done) {
      treeCache.delete(oldest.value);
    }
  }
  treeCache.set(root, tree);
  return tree;
}

/**
 * An inclusion proof for one subject against a checkpoint (the latest by
 * default), or `null` when there is no such checkpoint or the subject was not in
 * it.
 *
 * The proof carries the committed leaf PREIMAGE so the verifier re-derives the
 * leaf itself instead of trusting this server's hash.
 */
export async function getInclusionProof(
  subjectDid: string,
  index?: number,
): Promise<TransparencyInclusionProof | null> {
  const stored = index === undefined ? await loadNewest() : await loadByIndex(index);
  if (!stored) {
    return null;
  }

  const snapshot = await loadSnapshot(stored.id);
  const leafIndex = snapshot.findIndex((entry) => entry.subjectDid === subjectDid);
  if (leafIndex === -1) {
    return null;
  }

  const entry = snapshot[leafIndex];
  const tree = await treeFor(stored.root, snapshot);

  return {
    checkpoint: toDto(stored),
    subjectDid: entry.subjectDid,
    seq: entry.seq,
    headRecordId: entry.headRecordId,
    leaf: tree.levels[0][leafIndex],
    leafIndex,
    proof: inclusionProof(tree, leafIndex),
  };
}
