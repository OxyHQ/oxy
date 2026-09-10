/**
 * NodeStore — the node's durable, append-only signed-record log and blob store,
 * backed by `better-sqlite3` (synchronous, single-file, on-disk).
 *
 * It IMPLEMENTS the app-agnostic `@oxy.so/protocol` {@link RecordStore} +
 * {@link BlobStore} interfaces, so the generic `createNodeApp` engine drives it
 * with no node-specific knowledge:
 *  - Append v2 signed-record envelopes, enforcing per-subject hash-chain
 *    continuity via the shared `checkContinuity` (no hand-rolled copy). Gaps/
 *    forks are rejected; the unique `seq`/`record_id` indexes are the
 *    concurrency backstop, surfaced as `chain_conflict` on `SQLITE_CONSTRAINT`.
 *  - Serve the ordered log from a numeric cursor (`getLogSince`), resolve a
 *    `recordId` cursor to its `seq` (`resolveCursorSeq`), and the chain head
 *    (`getHead`).
 *  - Materialize the latest version of a record key (`materializeCurrent`) and
 *    its freshness frontier (`latestIssuedAtForKey`).
 *  - Pin and serve content-addressed blobs (`putBlob` / `getBlob`).
 *
 * A node holds exactly ONE subject's repo (a single per-subject chain mirroring
 * Oxy's `RepoHead`), so the `subject` argument required by the interface is
 * accepted but not used to partition storage — `seq` is globally monotonic.
 *
 * Signature verification and `recordId` computation happen OUTSIDE this class
 * (in `createNodeApp` via `@oxy.so/protocol`); the store is the integrity and
 * persistence layer and trusts the `recordId` passed to {@link append}. All SQL
 * goes through prepared statements with bound parameters.
 */

import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';
import type { SignedRecordEnvelope } from '@oxy.so/contracts';
import {
  type AppendOutcome,
  type ChainHead,
  type BlobStore,
  type RecordStore,
  checkContinuity,
} from '@oxy.so/protocol';
import { BlobHashMismatchError, SHA256_HEX } from '@oxy.so/protocol/node';
import { SCHEMA_SQL } from './schema.js';

type DatabaseInstance = Database.Database;
type PreparedStatement = Database.Statement;

interface RecordRow {
  seq: number;
  collection: string;
  rkey: string;
  record_id: string;
  prev: string | null;
  issued_at: number;
  envelope: string;
}

interface HeadRow {
  seq: number;
  head_record_id: string;
  record_count: number;
}

interface SeqRow {
  seq: number;
}

interface IssuedAtRow {
  issued_at: number;
}

interface BlobRow {
  bytes: Buffer;
}

/** Pre-narrowed arguments to the atomic append transaction. */
interface AppendArgs {
  env: SignedRecordEnvelope;
  seq: number;
  collection: string;
  rkey: string;
  prev: string | null;
  issuedAt: number;
  envelopeJson: string;
  recordId: string;
}

function isSqliteConstraintError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    typeof (error as { code?: unknown }).code === 'string' &&
    (error as { code: string }).code.startsWith('SQLITE_CONSTRAINT')
  );
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export class NodeStore implements RecordStore, BlobStore {
  private readonly db: DatabaseInstance;

  private readonly insertRecordStmt: PreparedStatement;
  private readonly upsertHeadStmt: PreparedStatement;
  private readonly getHeadStmt: PreparedStatement;
  private readonly getRecordStmt: PreparedStatement;
  private readonly latestIssuedAtStmt: PreparedStatement;
  private readonly logSinceStmt: PreparedStatement;
  private readonly seqByRecordIdStmt: PreparedStatement;
  private readonly putBlobStmt: PreparedStatement;
  private readonly getBlobStmt: PreparedStatement;

  /** The atomic append: shared continuity check + record insert + head advance. */
  private readonly appendTxn: (args: AppendArgs) => AppendOutcome;

  /**
   * @param databasePath - SQLite file path, or `':memory:'` for an ephemeral
   *   in-process database (used by tests).
   */
  constructor(databasePath: string) {
    this.db = new Database(databasePath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.db.exec(SCHEMA_SQL);

    this.insertRecordStmt = this.db.prepare(
      `INSERT INTO records (seq, collection, rkey, record_id, prev, issued_at, envelope)
       VALUES (@seq, @collection, @rkey, @record_id, @prev, @issued_at, @envelope)`,
    );
    this.upsertHeadStmt = this.db.prepare(
      `INSERT INTO head (id, seq, head_record_id, record_count)
       VALUES (1, @seq, @head_record_id, 1)
       ON CONFLICT(id) DO UPDATE SET
         seq = @seq,
         head_record_id = @head_record_id,
         record_count = record_count + 1`,
    );
    this.getHeadStmt = this.db.prepare(`SELECT seq, head_record_id, record_count FROM head WHERE id = 1`);
    this.getRecordStmt = this.db.prepare(
      `SELECT seq, collection, rkey, record_id, prev, issued_at, envelope
       FROM records WHERE collection = @collection AND rkey = @rkey
       ORDER BY seq DESC LIMIT 1`,
    );
    this.latestIssuedAtStmt = this.db.prepare(
      `SELECT issued_at FROM records WHERE collection = @collection AND rkey = @rkey
       ORDER BY seq DESC LIMIT 1`,
    );
    this.logSinceStmt = this.db.prepare(
      `SELECT seq, collection, rkey, record_id, prev, issued_at, envelope
       FROM records WHERE seq > @since ORDER BY seq ASC LIMIT @limit`,
    );
    this.seqByRecordIdStmt = this.db.prepare(`SELECT seq FROM records WHERE record_id = @record_id`);
    this.putBlobStmt = this.db.prepare(
      `INSERT INTO blobs (hash, bytes, size, created_at)
       VALUES (@hash, @bytes, @size, @created_at)
       ON CONFLICT(hash) DO NOTHING`,
    );
    this.getBlobStmt = this.db.prepare(`SELECT bytes FROM blobs WHERE hash = @hash`);

    this.appendTxn = this.db.transaction((args: AppendArgs): AppendOutcome => {
      const headRow = this.getHeadStmt.get() as HeadRow | undefined;
      const head: ChainHead | null = headRow
        ? { headRecordId: headRow.head_record_id, seq: headRow.seq, recordCount: headRow.record_count }
        : null;

      // Single source of continuity truth — the shared protocol check (no copy).
      const continuity = checkContinuity(head, args.env);
      if (!continuity.ok) {
        return { ok: false, reason: continuity.reason };
      }

      this.insertRecordStmt.run({
        seq: args.seq,
        collection: args.collection,
        rkey: args.rkey,
        record_id: args.recordId,
        prev: args.prev,
        issued_at: args.issuedAt,
        envelope: args.envelopeJson,
      });
      this.upsertHeadStmt.run({ seq: args.seq, head_record_id: args.recordId });

      return { ok: true, recordId: args.recordId, seq: args.seq };
    });
  }

  /** The current chain head, or `null` for an empty log. The `subject` is ignored (single-subject node). */
  async getHead(_subject: string): Promise<ChainHead | null> {
    const row = this.getHeadStmt.get() as HeadRow | undefined;
    if (!row) {
      return null;
    }
    return { headRecordId: row.head_record_id, seq: row.seq, recordCount: row.record_count };
  }

  /**
   * Append a verified v2 envelope, enforcing chain continuity via the shared
   * protocol check. The envelope's signature and `recordId` MUST already have
   * been verified (in `createNodeApp`). Returns a typed outcome rather than
   * throwing on a chain violation so the route maps it to a 4xx; a unique-index
   * collision (concurrent writer) surfaces as `chain_conflict`.
   *
   * A node holds a v2 hash chain — a non-v2 envelope can never reach this store
   * (the node app rejects it as `not_v2` before append), so this requires v2.
   */
  async append(_subject: string, env: SignedRecordEnvelope, recordId: string): Promise<AppendOutcome> {
    if (
      env.version !== 2 ||
      typeof env.seq !== 'number' ||
      typeof env.collection !== 'string' ||
      typeof env.rkey !== 'string'
    ) {
      throw new TypeError('NodeStore.append requires a v2 envelope with seq/collection/rkey');
    }

    const args: AppendArgs = {
      env,
      seq: env.seq,
      collection: env.collection,
      rkey: env.rkey,
      prev: env.prev ?? null,
      issuedAt: env.issuedAt,
      envelopeJson: JSON.stringify(env),
      recordId,
    };

    try {
      return this.appendTxn(args);
    } catch (error) {
      if (isSqliteConstraintError(error)) {
        return { ok: false, reason: 'chain_conflict' };
      }
      throw error;
    }
  }

  /** Ordered log entries strictly AFTER the numeric `sinceSeq` cursor (`-1` = from genesis). */
  async getLogSince(_subject: string, sinceSeq: number, limit: number): Promise<SignedRecordEnvelope[]> {
    const rows = this.logSinceStmt.all({ since: sinceSeq, limit }) as RecordRow[];
    return rows.map((row) => JSON.parse(row.envelope) as SignedRecordEnvelope);
  }

  /** Resolve a `recordId` cursor to its chain `seq`, or `null` when unknown. */
  async resolveCursorSeq(_subject: string, recordId: string): Promise<number | null> {
    const row = this.seqByRecordIdStmt.get({ record_id: recordId.toLowerCase() }) as SeqRow | undefined;
    return row ? row.seq : null;
  }

  /** The latest (highest-`seq`) envelope for a record key, or `null`. */
  async materializeCurrent(
    _subject: string,
    collection: string,
    rkey: string,
  ): Promise<SignedRecordEnvelope | null> {
    const row = this.getRecordStmt.get({ collection, rkey }) as RecordRow | undefined;
    return row ? (JSON.parse(row.envelope) as SignedRecordEnvelope) : null;
  }

  /** The `issuedAt` of the latest record for the envelope's `(collection, rkey)` key, or `null`. */
  async latestIssuedAtForKey(_subject: string, env: SignedRecordEnvelope): Promise<number | null> {
    if (env.version !== 2 || typeof env.collection !== 'string' || typeof env.rkey !== 'string') {
      return null;
    }
    const row = this.latestIssuedAtStmt.get({ collection: env.collection, rkey: env.rkey }) as IssuedAtRow | undefined;
    return row ? row.issued_at : null;
  }

  /**
   * Pin a content-addressed blob, validating that `bytes` hash to `hash`.
   * Idempotent: re-pinning the same hash is a no-op.
   *
   * @throws {BlobHashMismatchError} when the bytes do not hash to `hash`.
   */
  async putBlob(hash: string, bytes: Uint8Array): Promise<void> {
    // Guard the blob address explicitly: it originates from a request route param
    // (`req.params.hash`), which a client can tamper into a non-string. Bind a
    // proven string before it reaches the SQL parameter sink.
    if (typeof hash !== 'string' || !SHA256_HEX.test(hash.toLowerCase())) {
      throw new TypeError('invalid_blob_hash');
    }
    if (!Buffer.isBuffer(bytes) && !(bytes instanceof Uint8Array)) {
      throw new TypeError('invalid_blob_bytes');
    }
    const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
    const address = hash.toLowerCase();
    const actual = sha256Hex(buf);
    if (actual !== address) {
      throw new BlobHashMismatchError(address, actual);
    }
    this.putBlobStmt.run({ hash: address, bytes: buf, size: buf.length, created_at: Date.now() });
  }

  /** The bytes of a pinned blob, or `null` if absent. */
  async getBlob(hash: string): Promise<Uint8Array | null> {
    // The address comes from a request route param; a tampered non-string or a
    // value that is not a well-formed 64-char SHA-256 hex digest can never
    // address a stored blob (all addresses are validated at pin time). Reject it
    // as absent BEFORE the DB query so garbage input cannot drive needless reads
    // or reach the `.toLowerCase()` + SQL parameter sink.
    if (typeof hash !== 'string' || !SHA256_HEX.test(hash.toLowerCase())) {
      return null;
    }
    const row = this.getBlobStmt.get({ hash: hash.toLowerCase() }) as BlobRow | undefined;
    return row ? row.bytes : null;
  }

  /** Close the underlying database (graceful shutdown / test teardown). */
  close(): void {
    this.db.close();
  }
}
