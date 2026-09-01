import mongoose, { type Document, Schema } from 'mongoose';

/**
 * TransparencyCheckpoint — the operator's signed commitment to every subject's
 * chain head at a point in time.
 *
 * A per-subject hash chain (`SignedRecord` + `RepoHead`) proves nobody edited a
 * record. It does NOT prove that Oxy didn't serve two different histories to two
 * parties, or quietly drop a record. A checkpoint closes that gap: it commits to
 * ALL heads at once under one Merkle root, is signed, is hash-linked to its
 * predecessor, and (later) is anchored on a public chain. Anyone can then ask
 * for an inclusion proof of their own head and check it against the published
 * root without trusting this server.
 *
 * ## Append-only, with two additive exceptions
 *
 * The SIGNED body (`index`, `periodEnd`, `treeSize`, `root`,
 * `prevCheckpointHash`) is immutable once written — mutating it would invalidate
 * every signature over it and break the next checkpoint's `prevCheckpointHash`.
 * Only two fields grow after insert: `signatures` (witnesses co-sign the same
 * bytes asynchronously) and `anchors` (a checkpoint is published immediately and
 * anchored on-chain later, then reconciled for confirmations).
 *
 * ## Why `index` is uniquely indexed
 *
 * The unique index is the real mutex for the checkpoint job. If two tasks
 * compute the same period concurrently they will produce slightly different
 * roots (heads move between reads) and only one insert survives; the loser must
 * ADOPT the persisted checkpoint rather than publish its own. Two signed roots
 * for one index is precisely the equivocation this whole system exists to
 * detect, so this is a correctness constraint, not a race-condition nicety.
 *
 * ## `snapshot` is server-side only
 *
 * Inclusion proofs must be served against what the checkpoint COMMITTED to, not
 * against whatever the heads are now — so the ordered head snapshot is stored
 * with the checkpoint. It is never exposed on the wire: serving it would hand an
 * unauthenticated caller an enumeration of every subject on the platform.
 */

/** One subject's committed head, in the checkpoint's canonical leaf order. */
export interface ICheckpointSnapshotEntry {
  subjectDid: string;
  seq: number;
  headRecordId: string;
}

/** One signer's endorsement of the checkpoint's signed fields. */
export interface ICheckpointSignature {
  publicKey: string;
  alg: 'ES256K-DER-SHA256';
  signature: string;
}

/** Where this checkpoint's root was published on a public chain. */
export interface ICheckpointAnchor {
  network: string;
  txid: string;
  confirmations: number;
  anchoredAt: number;
}

export interface ITransparencyCheckpoint extends Document {
  /** Monotonic, gapless checkpoint number. Unique. */
  index: number;
  /** End of the committed period (ms epoch). */
  periodEnd: number;
  /** Number of committed subjects (leaves). */
  treeSize: number;
  /** Merkle root over the committed heads. */
  root: string;
  /** Hash of the previous checkpoint's signing input; `null` at genesis. */
  prevCheckpointHash: string | null;
  /** Oxy's signature first; witness co-signatures appended later. */
  signatures: ICheckpointSignature[];
  /** Public-chain anchors, appended after broadcast and reconciled for confirmations. */
  anchors: ICheckpointAnchor[];
  /** Server-side only: the ordered heads this checkpoint committed to. */
  snapshot: ICheckpointSnapshotEntry[];
  createdAt: Date;
  updatedAt: Date;
}

const SignatureSchema = new Schema<ICheckpointSignature>(
  {
    publicKey: { type: String, required: true },
    alg: { type: String, required: true, enum: ['ES256K-DER-SHA256'] },
    signature: { type: String, required: true },
  },
  { _id: false },
);

const AnchorSchema = new Schema<ICheckpointAnchor>(
  {
    network: { type: String, required: true },
    txid: { type: String, required: true },
    confirmations: { type: Number, required: true, default: 0 },
    anchoredAt: { type: Number, required: true },
  },
  { _id: false },
);

const SnapshotEntrySchema = new Schema<ICheckpointSnapshotEntry>(
  {
    subjectDid: { type: String, required: true },
    seq: { type: Number, required: true },
    headRecordId: { type: String, required: true },
  },
  { _id: false },
);

const TransparencyCheckpointSchema = new Schema<ITransparencyCheckpoint>(
  {
    index: { type: Number, required: true, unique: true },
    periodEnd: { type: Number, required: true },
    treeSize: { type: Number, required: true },
    root: { type: String, required: true },
    prevCheckpointHash: { type: String, default: null },
    signatures: { type: [SignatureSchema], required: true },
    anchors: { type: [AnchorSchema], default: [] },
    snapshot: { type: [SnapshotEntrySchema], default: [] },
  },
  {
    // `updatedAt` is meaningful here: signatures and anchors are appended after
    // insert. The signed body itself is never mutated.
    timestamps: { createdAt: true, updatedAt: true },
    strict: true,
    minimize: false,
  },
);

// Newest-first lookups for "the latest checkpoint".
TransparencyCheckpointSchema.index({ index: -1 });

export const TransparencyCheckpoint = mongoose.model<ITransparencyCheckpoint>(
  'TransparencyCheckpoint',
  TransparencyCheckpointSchema,
);
export default TransparencyCheckpoint;
