/**
 * Transparency checkpoint service — publishes and serves the log that lets a
 * third party audit Oxy WITHOUT trusting Oxy.
 *
 * The Merkle math, the leaf/checkpoint signing bytes, and the proof verifier all
 * live in `@oxyhq/protocol` (`src/transparency/`), app-agnostic and
 * independently reimplementable. This service is the Oxy-specific glue: it reads
 * the heads from `RepoHead`, commits them, signs with the Oxy custodial key, and
 * serves proofs from the snapshot each checkpoint committed to.
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
 */

import {
  buildTransparencyTreeFromHeads,
  checkpointHash,
  inclusionProof,
  signCheckpoint,
  transparencyLeafHash,
  type TransparencyCheckpointFields,
  type TransparencyHeadEntry,
} from '@oxyhq/protocol';
import type {
  TransparencyCheckpoint as TransparencyCheckpointDto,
  TransparencyInclusionProof,
} from '@oxyhq/contracts';
import RepoHead from '../models/RepoHead';
import TransparencyCheckpoint, {
  type ICheckpointSnapshotEntry,
  type ITransparencyCheckpoint,
} from '../models/TransparencyCheckpoint';
import { logger } from '../utils/logger';

/**
 * Ceiling on subjects per checkpoint.
 *
 * The committed snapshot is stored on the checkpoint document so proofs can be
 * served against what was committed; at ~130 bytes per entry this stays an order
 * of magnitude under MongoDB's 16MB document limit. Crossing it is a hard
 * failure rather than a silent truncation: a checkpoint whose proofs cannot be
 * served is worse than no checkpoint. Beyond this scale the snapshot moves to
 * external storage (S3/GridFS) — a deliberate migration, not a config bump.
 */
export const MAX_CHECKPOINT_SUBJECTS = 50_000;

/** How many checkpoints' derived leaf hashes stay cached in-process. */
const LEAF_CACHE_LIMIT = 2;

/**
 * Derived leaf hashes per checkpoint index, so serving repeated proofs for one
 * checkpoint does not re-hash the whole snapshot each time. Bounded, and purely
 * derived from immutable committed data — never a source of truth.
 */
const leafCache = new Map<number, string[]>();

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

/** Strip a stored checkpoint down to the public contract — drops `snapshot`. */
function toDto(doc: ITransparencyCheckpoint): TransparencyCheckpointDto {
  return {
    index: doc.index,
    periodEnd: doc.periodEnd,
    treeSize: doc.treeSize,
    root: doc.root,
    prevCheckpointHash: doc.prevCheckpointHash ?? null,
    signatures: doc.signatures.map((s) => ({
      publicKey: s.publicKey,
      alg: s.alg,
      signature: s.signature,
    })),
    anchors: doc.anchors.map((a) => ({
      network: a.network,
      txid: a.txid,
      confirmations: a.confirmations,
      anchoredAt: a.anchoredAt,
    })),
  };
}

/** The newest stored checkpoint document, or `null` before the first one. */
async function loadNewestDoc(): Promise<ITransparencyCheckpoint | null> {
  return TransparencyCheckpoint.findOne().sort({ index: -1 }).lean() as unknown as Promise<
    ITransparencyCheckpoint | null
  >;
}

/** A stored checkpoint document by index, or `null`. */
async function loadDocByIndex(index: number): Promise<ITransparencyCheckpoint | null> {
  return TransparencyCheckpoint.findOne({ index }).lean() as unknown as Promise<
    ITransparencyCheckpoint | null
  >;
}

/** True for MongoDB's duplicate-key error — the concurrent-writer collision. */
function isDuplicateKeyError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: number }).code === 11000;
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

  const rows = (await RepoHead.find({}, 'subjectDid seq headRecordId').lean()) as unknown as
    ICheckpointSnapshotEntry[];

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

  const previous = await loadNewestDoc();
  const fields: TransparencyCheckpointFields = {
    index: previous ? previous.index + 1 : 0,
    periodEnd,
    treeSize: tree.treeSize,
    root: tree.root,
    prevCheckpointHash: previous ? await checkpointHash(checkpointSignedFields(previous)) : null,
  };

  const signature = await signCheckpoint(fields, privateKey);

  // The snapshot must be stored in the SAME order the tree committed to, so a
  // proof's leaf index matches the tree. `indexBySubject` owns that order.
  const snapshot = [...entries].sort(
    (a, b) => tree.indexBySubject[a.subjectDid] - tree.indexBySubject[b.subjectDid],
  );

  try {
    const created = (await TransparencyCheckpoint.create({
      ...fields,
      signatures: [signature],
      anchors: [],
      snapshot,
    })) as unknown as ITransparencyCheckpoint;
    return toDto(created);
  } catch (error) {
    if (!isDuplicateKeyError(error)) {
      throw error;
    }
    // Another task published this index first. Its root is the published one;
    // ours is discarded rather than retried — two signed roots for one index is
    // exactly the equivocation this log exists to detect.
    const winner = await loadDocByIndex(fields.index);
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
  const doc = await loadNewestDoc();
  return doc ? toDto(doc) : null;
}

/** One published checkpoint by index, or `null`. */
export async function getCheckpoint(index: number): Promise<TransparencyCheckpointDto | null> {
  const doc = await loadDocByIndex(index);
  return doc ? toDto(doc) : null;
}

/**
 * The checkpoint chain from `sinceIndex`, oldest first, so a verifier can walk
 * `prevCheckpointHash` links itself.
 */
export async function listCheckpoints(
  sinceIndex: number,
  limit: number,
): Promise<TransparencyCheckpointDto[]> {
  const docs = (await TransparencyCheckpoint.find({ index: { $gte: sinceIndex } })
    .sort({ index: 1 })
    .limit(limit)
    .lean()) as unknown as ITransparencyCheckpoint[];
  return docs.map(toDto);
}

/** Leaf hashes for a checkpoint's committed snapshot, memoized per index. */
async function leavesFor(doc: ITransparencyCheckpoint): Promise<string[]> {
  const cached = leafCache.get(doc.index);
  if (cached) {
    return cached;
  }
  const leaves = await Promise.all(
    doc.snapshot.map((entry) =>
      transparencyLeafHash({
        subjectDid: entry.subjectDid,
        seq: entry.seq,
        headRecordId: entry.headRecordId,
      }),
    ),
  );
  if (leafCache.size >= LEAF_CACHE_LIMIT) {
    const oldest = leafCache.keys().next();
    if (!oldest.done) {
      leafCache.delete(oldest.value);
    }
  }
  leafCache.set(doc.index, leaves);
  return leaves;
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
  const doc = index === undefined ? await loadNewestDoc() : await loadDocByIndex(index);
  if (!doc) {
    return null;
  }

  const leafIndex = doc.snapshot.findIndex((entry) => entry.subjectDid === subjectDid);
  if (leafIndex === -1) {
    return null;
  }

  const entry = doc.snapshot[leafIndex];
  const leaves = await leavesFor(doc);

  return {
    checkpoint: toDto(doc),
    subjectDid: entry.subjectDid,
    seq: entry.seq,
    headRecordId: entry.headRecordId,
    leaf: leaves[leafIndex],
    leafIndex,
    proof: await inclusionProof(leaves, leafIndex),
  };
}
