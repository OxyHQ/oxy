/**
 * Storage interfaces — the injected persistence the chain engine drives.
 *
 * The engine ({@link ./verify}, {@link ./engine}) is storage-agnostic: it owns
 * the verification state machine and continuity logic, and delegates EVERY read
 * and write to an injected {@link RecordStore}. An app supplies a store over its
 * own backend (oxy-api over Mongo `SignedRecord`/`RepoHead`, a node over SQLite,
 * Mention over its own Mongo) without the engine knowing anything Oxy- or
 * app-specific.
 *
 * All methods are **subject-keyed**: `subject` is the chain's subject DID
 * (`env.subject`). A store maps that DID to its own primary key (e.g. an Oxy
 * userId) internally; the engine never sees that mapping.
 *
 * ## Concurrency contract
 *
 * `append` MUST be atomic (record insert + head advance in one unit) and MUST
 * translate a duplicate-key collision on the unique `(subject, seq)` /
 * `recordId` index — i.e. a concurrent writer that already took this `seq` — into
 * `{ ok: false, reason: 'chain_conflict' }` (Mongo E11000 / SQLite
 * `SQLITE_CONSTRAINT`). That is the real multi-writer race guard; the engine's
 * pre-append continuity check is only the fast-path rejection.
 */

import type { SignedRecordEnvelope } from '@oxy.so/contracts';
import type { AppendOutcome, ChainHead } from './types';

export interface RecordStore {
  /** The subject's chain head, or `null` when the subject has no chain yet. */
  getHead(subject: string): Promise<ChainHead | null>;

  /**
   * Atomically persist a verified envelope and advance the subject's chain.
   *
   * `recordId` is the engine-computed content address (`computeRecordId(env)`).
   * Implementations MUST surface a duplicate-key collision as `chain_conflict`
   * (see the concurrency contract above). v1 envelopes (no chain coordinates)
   * are stored without advancing a chain and SHOULD report `seq: -1`.
   */
  append(subject: string, env: SignedRecordEnvelope, recordId: string): Promise<AppendOutcome>;

  /**
   * The ordered slice of the subject's chain with `seq > sinceSeq`, ascending by
   * `seq`, capped at `limit`. Only chained (v2) records have a `seq`, so v1 rows
   * are naturally excluded. Pass `sinceSeq = -1` to start from genesis.
   */
  getLogSince(subject: string, sinceSeq: number, limit: number): Promise<SignedRecordEnvelope[]>;

  /**
   * Resolve a `recordId` cursor to its chain `seq` (so a puller resumes from the
   * last record it ingested), or `null` when no such record exists.
   */
  resolveCursorSeq(subject: string, recordId: string): Promise<number | null>;

  /**
   * The latest verified envelope for an AtProto-style `(collection, rkey)` key —
   * the materialized "current" value (last-writer-wins by chain order), or
   * `null` when no record exists for that key.
   */
  materializeCurrent(
    subject: string,
    collection: string,
    rkey: string,
  ): Promise<SignedRecordEnvelope | null>;

  /**
   * The `issuedAt` of the latest stored record for the envelope's LOGICAL key —
   * the monotonicity frontier the engine compares against (replay/rollback
   * defence). Scoping is the store's policy:
   *  - v2: per record key (`collection`, `rkey`) — last-writer-wins for THAT key.
   *  - v1: per `type` (the legacy identity/profile singletons).
   *
   * Returns `null` when there is no prior record (the record is the first of its
   * key, so any `issuedAt` is acceptable).
   */
  latestIssuedAtForKey(subject: string, env: SignedRecordEnvelope): Promise<number | null>;
}

/**
 * Content-addressed blob storage — the bytes a record's blob refs point at,
 * keyed by their SHA-256 (`sha256`) content address.
 *
 * Separate from {@link RecordStore} because not every app stores blobs in the
 * same place a record lives (oxy-api identity records carry no blobs; a node
 * pins them; Mention rehosts to the Oxy CDN). `Uint8Array` rather than Node's
 * `Buffer` so the interface stays platform-agnostic.
 */
export interface BlobStore {
  /**
   * Pin `bytes` under their content address `hash`. Implementations MUST validate
   * that `bytes` actually hash to `hash`, and SHOULD be idempotent (re-pinning
   * the same hash is a no-op).
   */
  putBlob(hash: string, bytes: Uint8Array): Promise<void>;

  /** The bytes of a pinned blob, or `null` when absent. */
  getBlob(hash: string): Promise<Uint8Array | null>;
}
