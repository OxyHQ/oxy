/**
 * `createNodeApp` — the app-agnostic Express factory for an Oxy-protocol data
 * node. A node stores and serves ONE owner's append-only signed-record log
 * (their "personal repo") plus the content-addressed blobs the records point at.
 *
 * This is the engine extracted from `@oxy.so/node` so the SAME code can back many
 * app-node deployments (the Oxy identity node, a future Mention node) that
 * differ only by ENV: the namespace they serve, their well-known manifest path,
 * their advertised protocol id + service-type, and their owner key. Everything
 * app-specific is INJECTED:
 *
 *  - `store`     — a {@link RecordStore} + {@link BlobStore} (the node's SQLite
 *                  store, or a test stub). The node holds exactly one subject's
 *                  repo, so the store keys a single global chain and ignores the
 *                  subject argument; `createNodeApp` passes the node's own key as
 *                  a stable sentinel.
 *  - `ownerAuth` — the single write authority. Records and blob pins are
 *                  authorized against the node's configured owner key. This is
 *                  injected (rather than importing `@oxy.so/core/server`) so the
 *                  protocol package never depends on core.
 *  - `config`    — the wire-shape knobs (well-known path, protocol id,
 *                  service-type, mode, blob ceiling, collection allowlist).
 *  - `logger`    — structured logging for the terminal error handler.
 *
 * Endpoints:
 *  - `GET  <wellKnownPath>` — node identity + liveness (a probe target).
 *  - `GET  /oxy/head`       — chain head `{ seq, headRecordId, recordCount }`.
 *  - `GET  /oxy/log`        — ordered envelopes from a cursor (ingest).
 *  - `POST /records`        — owner writes a single signed envelope.
 *  - `POST /sync/push`      — owner pushes a batch of signed envelopes.
 *  - `GET  /blobs/:hash`    — serve a content-addressed blob.
 *  - `PUT  /blobs/:hash`    — owner pins a blob (signed-header auth).
 *  - `GET  /health`         — container liveness.
 */

import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import type { SignedRecordEnvelope } from '@oxy.so/contracts';
import { computeRecordId } from '../envelope/recordId';
import type { RecordStore, BlobStore } from '../chain/recordStore';
import { createRateLimiter, DEFAULT_WRITE_RATE_LIMIT, type RateLimitConfig } from './rateLimit';
import { verifyNodeRecordEnvelope } from './verifyRecord';
import {
  DEFAULT_LOG_LIMIT,
  JSON_BODY_LIMIT,
  MAX_LOG_LIMIT,
  MAX_SYNC_BATCH,
  NODE_BLOBS_PATH,
  NODE_HEAD_PATH,
  NODE_LOG_PATH,
  NODE_RECORDS_PATH,
  NODE_SYNC_PUSH_PATH,
  OWNER_AUTH_HEADERS,
  SHA256_HEX,
} from './constants';

/**
 * The Express app returned by {@link createNodeApp}, augmented with a {@link stop}
 * hook that releases the app's background resources (currently the rate-limiter's
 * sweep timer). The node bootstrap calls it from the graceful-shutdown path.
 */
export interface NodeApp extends Express {
  /**
   * Release the app's background resources (the rate-limiter sweep timer).
   * Idempotent and safe to call on shutdown; not required for process exit (the
   * timer is `unref()`'d) but keeps long-lived test harnesses leak-free.
   */
  stop(): void;
}

/**
 * Thrown by a {@link BlobStore.putBlob} implementation when bytes do not hash to
 * the supplied address. Defined here (rather than in `@oxy.so/node`) so the node
 * app can map it to `hash_mismatch` without importing the store implementation.
 */
export class BlobHashMismatchError extends Error {
  constructor(
    public readonly expected: string,
    public readonly actual: string,
  ) {
    super(`blob hash mismatch: expected ${expected}, computed ${actual}`);
    this.name = 'BlobHashMismatchError';
  }
}

/** The store a node app drives — the chain log plus the blob store. */
export type NodeStoreLike = RecordStore & BlobStore;

/**
 * The owner authority for node writes (the single write principal). Injected so
 * the protocol package stays free of `@oxy.so/core` — `@oxy.so/node` provides an
 * implementation bound to its configured owner key.
 */
export interface OwnerAuth {
  /** True iff `publicKey` is the node's configured owner key (constant-time). */
  isOwnerKey(publicKey: string): boolean;
  /**
   * Verify an owner-signed authorization for a blob pin over `hash` (a fresh
   * signed header proving control, since the body is raw bytes not an envelope).
   */
  verifyBlobPin(
    hash: string,
    auth: { publicKey: string; signature: string; timestamp: number },
  ): Promise<boolean>;
}

/** The wire-shape configuration a node app advertises + enforces. */
export interface NodeAppConfig {
  /** Path the liveness manifest is served at (e.g. `/.well-known/oxy-node.json`). */
  readonly wellKnownPath: string;
  /** Node-protocol id advertised as `version` in the manifest (e.g. `oxy-node/1`). */
  readonly protocolId: string;
  /** Service-type label advertised in the manifest (e.g. `OxyPersonalDataNode`). */
  readonly serviceType: string;
  /** Operating mode advertised in the manifest (`self-hosted` / `managed`). */
  readonly mode: string;
  /** The node's advertised public key (its single-chain subject sentinel). */
  readonly nodePublicKey: string;
  /** Upper bound on a single pinned blob, in bytes. */
  readonly maxBlobBytes: number;
  /**
   * Collection allowlist. EMPTY = accept any collection (the existing Oxy node
   * behaviour). NON-EMPTY = only these collections may be written (else
   * `foreign_collection`) and the public log is filtered to them.
   */
  readonly collections: readonly string[];
  /**
   * Per-IP rate budget for the owner-authorized WRITE routes (`POST /records`,
   * `POST /sync/push`, `PUT /blobs/:hash`). Defence-in-depth on the
   * unauthenticated edge, capping request rate BEFORE signature verification.
   * Defaults to {@link DEFAULT_WRITE_RATE_LIMIT} (60/min) — generous for the
   * single-writer model.
   */
  readonly writeRateLimit?: RateLimitConfig;
}

/** Minimal structured logger (a pino `Logger` satisfies this structurally). */
export interface NodeLogger {
  error(obj: object, msg?: string): void;
}

export interface NodeAppDependencies {
  store: NodeStoreLike;
  config: NodeAppConfig;
  ownerAuth: OwnerAuth;
  logger: NodeLogger;
}

/**
 * Coerce a raw Express query value (`string | string[] | ParsedQs | undefined`)
 * to a single string. A repeated/array param (`?since[]=a&since[]=b`) yields a
 * non-string under qs; take its first string element so a tampered array can
 * never reach a `typeof === 'string'` check as a non-string and cause type
 * confusion. Returns `undefined` for anything that is not a string or a
 * string-first array.
 */
function firstQueryValue(raw: unknown): string | undefined {
  if (typeof raw === 'string') {
    return raw;
  }
  if (Array.isArray(raw) && raw.length > 0 && typeof raw[0] === 'string') {
    return raw[0];
  }
  return undefined;
}

/** Clamp the `limit` query param into `[1, MAX_LOG_LIMIT]`, defaulting when absent/invalid. */
function parseLimit(raw: unknown): number {
  const value = firstQueryValue(raw);
  if (value === undefined || value.trim() === '') {
    return DEFAULT_LOG_LIMIT;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return DEFAULT_LOG_LIMIT;
  }
  return Math.min(parsed, MAX_LOG_LIMIT);
}

/** HTTP status for a chain-append rejection. */
function appendStatus(reason: string): number {
  return reason === 'chain_conflict' ? 409 : 422;
}

/** True when `collection` is writable under the node's allowlist (empty = all). */
function isCollectionAllowed(config: NodeAppConfig, collection: string): boolean {
  return config.collections.length === 0 || config.collections.includes(collection);
}

/**
 * Resolve the `/oxy/log` `since` query param to an exclusive lower-bound `seq`.
 * Returns `null` when the page should be EMPTY (an unknown `recordId` cursor or
 * an unrecognized cursor shape). Mirrors the legacy in-store cursor resolver,
 * now split across the protocol `RecordStore` (numeric `getLogSince` +
 * `resolveCursorSeq`).
 */
async function resolveSinceSeq(
  store: RecordStore,
  subject: string,
  since: string | undefined,
): Promise<number | null> {
  if (since === undefined || since === '') {
    return -1;
  }
  const lower = since.toLowerCase();
  if (SHA256_HEX.test(lower)) {
    return store.resolveCursorSeq(subject, lower);
  }
  if (/^\d+$/.test(since)) {
    const parsed = Number(since);
    return Number.isSafeInteger(parsed) ? parsed : -1;
  }
  return null;
}

/** Map a stored envelope to the `/oxy/log` wire record. */
async function toLogWireRecord(env: SignedRecordEnvelope): Promise<{
  seq: number;
  recordId: string;
  prev: string | null;
  issuedAt: number;
  envelope: SignedRecordEnvelope;
}> {
  return {
    seq: env.seq ?? 0,
    recordId: await computeRecordId(env),
    prev: env.prev ?? null,
    issuedAt: env.issuedAt,
    envelope: env,
  };
}

export function createNodeApp(deps: NodeAppDependencies): NodeApp {
  const { store, config, ownerAuth, logger } = deps;
  // The node holds one subject's repo; the store keys a single global chain and
  // ignores the subject argument. Pass the node's own key as a stable sentinel.
  const subject = config.nodePublicKey;

  const app = express() as NodeApp;
  app.disable('x-powered-by');

  // JSON parser applies only to JSON bodies (it checks Content-Type), so the raw
  // blob upload below is untouched by it.
  const jsonParser = express.json({ limit: JSON_BODY_LIMIT });

  // Per-IP rate limiter on the owner-authorized write routes. Caps request rate
  // BEFORE signature verification so a flood of bogus envelopes can't pin CPU.
  // It owns a background sweep timer; expose its teardown as `app.stop()`.
  const writeRateLimit = createRateLimiter(config.writeRateLimit ?? DEFAULT_WRITE_RATE_LIMIT);
  app.stop = (): void => writeRateLimit.stop();

  app.get('/health', (_req: Request, res: Response) => {
    res.json({ status: 'ok' });
  });

  // ── Node identity / liveness ────────────────────────────────────────────────
  app.get(config.wellKnownPath, async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const head = await store.getHead(subject);
      res.json({
        nodePublicKey: config.nodePublicKey,
        mode: config.mode,
        version: config.protocolId,
        serviceType: config.serviceType,
        head: head && head.headRecordId !== null ? { seq: head.seq, headRecordId: head.headRecordId } : null,
      });
    } catch (error) {
      next(error);
    }
  });

  // ── Chain head ──────────────────────────────────────────────────────────────
  app.get(NODE_HEAD_PATH, async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const head = await store.getHead(subject);
      if (!head || head.headRecordId === null) {
        res.json({ seq: null, headRecordId: null, recordCount: 0 });
        return;
      }
      res.json({ seq: head.seq, headRecordId: head.headRecordId, recordCount: head.recordCount });
    } catch (error) {
      next(error);
    }
  });

  // ── Ordered log (ingest) ──────────────────────────────────────────────────────
  app.get(NODE_LOG_PATH, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const since = firstQueryValue(req.query.since);
      const limit = parseLimit(req.query.limit);
      const head = await store.getHead(subject);
      const headWire = head && head.headRecordId !== null ? { seq: head.seq, headRecordId: head.headRecordId } : null;

      const sinceSeq = await resolveSinceSeq(store, subject, since);
      if (sinceSeq === null) {
        res.json({ records: [], count: 0, head: headWire });
        return;
      }

      const envelopes = await store.getLogSince(subject, sinceSeq, limit);
      const records = await Promise.all(envelopes.map(toLogWireRecord));
      res.json({ records, count: records.length, head: headWire });
    } catch (error) {
      next(error);
    }
  });

  // ── Owner write: a single signed envelope ────────────────────────────────────
  app.post(NODE_RECORDS_PATH, writeRateLimit, jsonParser, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const verification = await verifyNodeRecordEnvelope(req.body);
      if (!verification.ok) {
        res.status(400).json({ error: verification.reason });
        return;
      }
      if (!ownerAuth.isOwnerKey(verification.envelope.publicKey)) {
        res.status(403).json({ error: 'not_owner' });
        return;
      }
      if (!isCollectionAllowed(config, verification.envelope.collection ?? '')) {
        res.status(403).json({ error: 'foreign_collection' });
        return;
      }
      const outcome = await store.append(subject, verification.envelope, verification.recordId);
      if (!outcome.ok) {
        res.status(appendStatus(outcome.reason)).json({ error: outcome.reason });
        return;
      }
      res.status(201).json({ recordId: outcome.recordId, seq: outcome.seq });
    } catch (error) {
      next(error);
    }
  });

  // ── Owner write: a batch push (verified + appended in order) ──────────────────
  app.post(NODE_SYNC_PUSH_PATH, writeRateLimit, jsonParser, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const body: unknown = req.body;
      const items =
        typeof body === 'object' && body !== null && Array.isArray((body as { records?: unknown }).records)
          ? (body as { records: unknown[] }).records
          : null;
      if (!items) {
        res.status(400).json({ error: 'invalid_batch' });
        return;
      }
      if (items.length > MAX_SYNC_BATCH) {
        res.status(400).json({ error: 'batch_too_large' });
        return;
      }

      const results: Array<
        { ok: true; recordId: string; seq: number } | { ok: false; reason: string }
      > = [];
      for (const item of items) {
        const verification = await verifyNodeRecordEnvelope(item);
        if (!verification.ok) {
          results.push({ ok: false, reason: verification.reason });
          continue;
        }
        if (!ownerAuth.isOwnerKey(verification.envelope.publicKey)) {
          results.push({ ok: false, reason: 'not_owner' });
          continue;
        }
        if (!isCollectionAllowed(config, verification.envelope.collection ?? '')) {
          results.push({ ok: false, reason: 'foreign_collection' });
          continue;
        }
        const outcome = await store.append(subject, verification.envelope, verification.recordId);
        results.push(
          outcome.ok
            ? { ok: true, recordId: outcome.recordId, seq: outcome.seq }
            : { ok: false, reason: outcome.reason },
        );
      }

      const accepted = results.filter((result) => result.ok).length;
      res.json({ accepted, results });
    } catch (error) {
      next(error);
    }
  });

  // ── Serve a content-addressed blob ───────────────────────────────────────────
  app.get(`${NODE_BLOBS_PATH}/:hash`, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const hash = req.params.hash.toLowerCase();
      if (!SHA256_HEX.test(hash)) {
        res.status(400).json({ error: 'invalid_hash' });
        return;
      }
      const bytes = await store.getBlob(hash);
      if (!bytes) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      res.setHeader('Content-Type', 'application/octet-stream');
      // Content-addressed → immutable, safe to cache aggressively.
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      res.send(Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes));
    } catch (error) {
      next(error);
    }
  });

  // ── Owner pins a blob (signed-header authorization) ──────────────────────────
  app.put(
    `${NODE_BLOBS_PATH}/:hash`,
    writeRateLimit,
    express.raw({ type: () => true, limit: config.maxBlobBytes }),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const rawHash: unknown = req.params.hash;
        if (typeof rawHash !== 'string') {
          res.status(400).json({ error: 'invalid_hash' });
          return;
        }
        const hash = rawHash.toLowerCase();
        if (!SHA256_HEX.test(hash)) {
          res.status(400).json({ error: 'invalid_hash' });
          return;
        }

        const publicKey = req.header(OWNER_AUTH_HEADERS.publicKey);
        const signature = req.header(OWNER_AUTH_HEADERS.signature);
        const timestampRaw = req.header(OWNER_AUTH_HEADERS.timestamp);
        if (!publicKey || !signature || !timestampRaw) {
          res.status(401).json({ error: 'missing_owner_auth' });
          return;
        }

        const authorized = await ownerAuth.verifyBlobPin(hash, {
          publicKey,
          signature,
          timestamp: Number(timestampRaw),
        });
        if (!authorized) {
          res.status(403).json({ error: 'unauthorized' });
          return;
        }

        const bytes = req.body;
        if (!Buffer.isBuffer(bytes) || bytes.length === 0) {
          res.status(400).json({ error: 'empty_blob' });
          return;
        }

        try {
          await store.putBlob(hash, bytes);
        } catch (error) {
          if (error instanceof BlobHashMismatchError) {
            res.status(400).json({ error: 'hash_mismatch' });
            return;
          }
          throw error;
        }

        res.status(201).json({ hash, size: bytes.length });
      } catch (error) {
        next(error);
      }
    },
  );

  // ── Terminal error handler ───────────────────────────────────────────────────
  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    logger.error({ err: error }, 'unhandled request error');
    res.status(500).json({ error: 'internal_error' });
  });

  return app;
}
