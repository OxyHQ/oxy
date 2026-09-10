/**
 * `NodeClient` — the HTTP client that drives an Oxy-protocol data node's
 * routes (head / log / records / blobs). It is the OUTBOUND half of the node
 * protocol: oxy-api uses it to PULL a user's chain back from their node; a
 * future Mention backend (B3) uses it to drive a node + push records/blobs.
 *
 * The client is transport-agnostic — it takes an injected {@link NodeFetch} so
 * the protocol package never depends on `@oxy.so/core`. Oxy supplies an adapter
 * over `@oxy.so/core/server`'s `safeFetch` (HTTPS-only, DNS-pinned, private-IP
 * denylist, bounded redirects); a test supplies an in-process stub. Every
 * response body is read with a hard byte ceiling, so a node cannot stream an
 * unbounded body into the caller.
 */

import type { SignedRecordEnvelope } from '@oxy.so/contracts';
import {
  type NodeFetch,
  type NodeFetchInit,
  readBoundedBytes,
  readBoundedJson,
} from './httpFetch';
import {
  DEFAULT_CLIENT_MAX_REDIRECTS,
  DEFAULT_CLIENT_TIMEOUT_MS,
  DEFAULT_HEAD_MAX_BYTES,
  DEFAULT_LOG_MAX_BYTES,
  DEFAULT_MAX_BLOB_BYTES,
  DEFAULT_WRITE_RESPONSE_MAX_BYTES,
  NODE_BLOBS_PATH,
  NODE_HEAD_PATH,
  NODE_LOG_PATH,
  NODE_RECORDS_PATH,
  NODE_SYNC_PUSH_PATH,
  OWNER_AUTH_HEADERS,
} from './constants';

/** The chain head a node reports at `GET /oxy/head`. */
export interface NodeHead {
  seq: number | null;
  headRecordId: string | null;
  recordCount: number;
}

/** One ordered page of a node's log (`GET /oxy/log`). */
export interface NodeLogPage {
  /**
   * The raw log items, returned VERBATIM (not re-parsed) — the caller validates
   * + verifies each against the envelope schema. Preserves the node's exact wire
   * shape so a puller's own verification is the trust boundary.
   */
  records: unknown[];
  count: number;
  head: { seq: number; headRecordId: string } | null;
}

/** Outcome of an owner write (`POST /records`). */
export interface NodeWriteResult {
  recordId: string;
  seq: number;
}

/** Outcome of an owner blob pin (`PUT /blobs/:hash`). */
export interface NodeBlobPutResult {
  hash: string;
  size: number;
}

/** Owner-signed authorization for a blob pin (caller signs; client sends headers). */
export interface NodeBlobPinAuth {
  publicKey: string;
  signature: string;
  timestamp: number;
}

/** A non-2xx node response (or a node that returned a malformed body). */
export class NodeClientError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
    public readonly reason?: string,
  ) {
    super(message);
    this.name = 'NodeClientError';
  }
}

/** Construction options for a {@link NodeClient}. */
export interface NodeClientOptions {
  /** The node's HTTPS base URL (no trailing slash). */
  baseUrl: string;
  /** The injected transport (an adapter over `safeFetch`, or a test stub). */
  fetch: NodeFetch;
  /** Time-to-first-byte deadline per request (ms). */
  headersTimeoutMs?: number;
  /** Redirect budget per request (each re-validated by the transport). */
  maxRedirects?: number;
  /** Bounded read ceiling for a `/oxy/head` response. */
  headMaxBytes?: number;
  /** Bounded read ceiling for a `/oxy/log` page response. */
  logMaxBytes?: number;
  /** Bounded read ceiling for a small write/JSON response. */
  writeResponseMaxBytes?: number;
  /** Bounded read ceiling for a fetched blob. */
  blobMaxBytes?: number;
}

function readError(body: unknown): string | undefined {
  if (typeof body === 'object' && body !== null && typeof (body as { error?: unknown }).error === 'string') {
    return (body as { error: string }).error;
  }
  return undefined;
}

/**
 * Trim every trailing slash from a base URL in LINEAR time.
 *
 * Replaces an anchored-quantifier regex (`/\/+$/`) whose backtracking is a
 * polynomial-ReDoS sink on a long all-slash input; a single-pass scan is O(n)
 * with no ReDoS surface.
 */
export function trimTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value.charCodeAt(end - 1) === 47 /* '/' */) {
    end -= 1;
  }
  return end === value.length ? value : value.slice(0, end);
}

export class NodeClient {
  private readonly baseUrl: string;
  private readonly fetch: NodeFetch;
  private readonly headersTimeoutMs: number;
  private readonly maxRedirects: number;
  private readonly headMaxBytes: number;
  private readonly logMaxBytes: number;
  private readonly writeResponseMaxBytes: number;
  private readonly blobMaxBytes: number;

  constructor(options: NodeClientOptions) {
    this.baseUrl = trimTrailingSlashes(options.baseUrl);
    this.fetch = options.fetch;
    this.headersTimeoutMs = options.headersTimeoutMs ?? DEFAULT_CLIENT_TIMEOUT_MS;
    this.maxRedirects = options.maxRedirects ?? DEFAULT_CLIENT_MAX_REDIRECTS;
    this.headMaxBytes = options.headMaxBytes ?? DEFAULT_HEAD_MAX_BYTES;
    this.logMaxBytes = options.logMaxBytes ?? DEFAULT_LOG_MAX_BYTES;
    this.writeResponseMaxBytes = options.writeResponseMaxBytes ?? DEFAULT_WRITE_RESPONSE_MAX_BYTES;
    this.blobMaxBytes = options.blobMaxBytes ?? DEFAULT_MAX_BLOB_BYTES;
  }

  /** Base request options shared by every call (timeout + redirect budget). */
  private init(extra: Partial<NodeFetchInit> & Pick<NodeFetchInit, 'method'>): NodeFetchInit {
    return {
      headersTimeoutMs: this.headersTimeoutMs,
      maxRedirects: this.maxRedirects,
      ...extra,
    };
  }

  /** The node's current chain head. Throws {@link NodeClientError} on a non-2xx. */
  async head(): Promise<NodeHead> {
    const res = await this.fetch(`${this.baseUrl}${NODE_HEAD_PATH}`, this.init({ method: 'GET' }));
    if (res.status < 200 || res.status >= 300) {
      res.destroy();
      throw new NodeClientError(`node ${NODE_HEAD_PATH} responded HTTP ${res.status}`, res.status);
    }
    const body = await readBoundedJson(res, this.headMaxBytes);
    const obj = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;
    return {
      seq: typeof obj.seq === 'number' ? obj.seq : null,
      headRecordId: typeof obj.headRecordId === 'string' ? obj.headRecordId : null,
      recordCount: typeof obj.recordCount === 'number' ? obj.recordCount : 0,
    };
  }

  /**
   * One ordered page of the node's log strictly after `sinceSeq` (pass `-1` from
   * genesis), capped at `limit`. Throws {@link NodeClientError} on a non-2xx or a
   * response missing the `records` array.
   */
  async log(sinceSeq: number, limit: number): Promise<NodeLogPage> {
    // A genesis cursor (`sinceSeq < 0`) is expressed by OMITTING `since` — the
    // node reads an absent cursor as "from genesis". A negative numeric `since`
    // is not a valid cursor on the wire (only an absent one, a non-negative seq,
    // or a recordId), so omitting it is the correct way to request the whole log.
    const sinceParam = sinceSeq >= 0 ? `since=${encodeURIComponent(String(sinceSeq))}&` : '';
    const url = `${this.baseUrl}${NODE_LOG_PATH}?${sinceParam}limit=${encodeURIComponent(String(limit))}`;
    const res = await this.fetch(url, this.init({ method: 'GET' }));
    if (res.status < 200 || res.status >= 300) {
      res.destroy();
      throw new NodeClientError(`node ${NODE_LOG_PATH} responded HTTP ${res.status}`, res.status);
    }
    const body = await readBoundedJson(res, this.logMaxBytes);
    const records = (body as { records?: unknown }).records;
    if (!Array.isArray(records)) {
      throw new NodeClientError(`node ${NODE_LOG_PATH} returned no records array`, res.status);
    }
    const headRaw = (body as { head?: unknown }).head;
    const head =
      typeof headRaw === 'object' &&
      headRaw !== null &&
      typeof (headRaw as { seq?: unknown }).seq === 'number' &&
      typeof (headRaw as { headRecordId?: unknown }).headRecordId === 'string'
        ? { seq: (headRaw as { seq: number }).seq, headRecordId: (headRaw as { headRecordId: string }).headRecordId }
        : null;
    return { records, count: records.length, head };
  }

  /**
   * Write a single owner-signed envelope (`POST /records`). Throws
   * {@link NodeClientError} (carrying the node's `reason`) on any non-2xx — a
   * chain rejection (`chain_gap`/`chain_fork`/`bad_seq`/`chain_conflict`) or an
   * authorization failure.
   */
  async writeRecord(envelope: SignedRecordEnvelope): Promise<NodeWriteResult> {
    const res = await this.fetch(
      `${this.baseUrl}${NODE_RECORDS_PATH}`,
      this.init({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: Buffer.from(JSON.stringify(envelope), 'utf8'),
      }),
    );
    const body = await readBoundedJson(res, this.writeResponseMaxBytes);
    if (res.status < 200 || res.status >= 300) {
      const reason = readError(body);
      throw new NodeClientError(
        `node ${NODE_RECORDS_PATH} responded HTTP ${res.status}${reason ? ` (${reason})` : ''}`,
        res.status,
        reason,
      );
    }
    const obj = body as { recordId?: unknown; seq?: unknown };
    if (typeof obj.recordId !== 'string' || typeof obj.seq !== 'number') {
      throw new NodeClientError(`node ${NODE_RECORDS_PATH} returned a malformed write result`, res.status);
    }
    return { recordId: obj.recordId, seq: obj.seq };
  }

  /**
   * Push a batch of owner-signed envelopes (`POST /sync/push`). Returns the
   * node's per-item results. Throws {@link NodeClientError} only on a non-2xx
   * batch-level failure (`invalid_batch` / `batch_too_large`).
   */
  async pushRecords(
    envelopes: SignedRecordEnvelope[],
  ): Promise<{ accepted: number; results: Array<{ ok: boolean; recordId?: string; seq?: number; reason?: string }> }> {
    const res = await this.fetch(
      `${this.baseUrl}${NODE_SYNC_PUSH_PATH}`,
      this.init({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: Buffer.from(JSON.stringify({ records: envelopes }), 'utf8'),
      }),
    );
    const body = await readBoundedJson(res, this.writeResponseMaxBytes);
    if (res.status < 200 || res.status >= 300) {
      const reason = readError(body);
      throw new NodeClientError(
        `node ${NODE_SYNC_PUSH_PATH} responded HTTP ${res.status}${reason ? ` (${reason})` : ''}`,
        res.status,
        reason,
      );
    }
    const obj = body as { accepted?: unknown; results?: unknown };
    return {
      accepted: typeof obj.accepted === 'number' ? obj.accepted : 0,
      results: Array.isArray(obj.results)
        ? (obj.results as Array<{ ok: boolean; recordId?: string; seq?: number; reason?: string }>)
        : [],
    };
  }

  /** Fetch a content-addressed blob. Returns `null` on a 404; throws on other non-2xx. */
  async getBlob(hash: string): Promise<Buffer | null> {
    const res = await this.fetch(`${this.baseUrl}${NODE_BLOBS_PATH}/${encodeURIComponent(hash)}`, this.init({ method: 'GET' }));
    if (res.status === 404) {
      res.destroy();
      return null;
    }
    if (res.status < 200 || res.status >= 300) {
      res.destroy();
      throw new NodeClientError(`node ${NODE_BLOBS_PATH}/:hash responded HTTP ${res.status}`, res.status);
    }
    return readBoundedBytes(res, this.blobMaxBytes);
  }

  /**
   * Pin a content-addressed blob with an owner-signed authorization
   * (`PUT /blobs/:hash`). The caller signs the pin (it holds the owner key) and
   * passes the resulting `{ publicKey, signature, timestamp }`; the client sets
   * the owner-auth headers. Throws {@link NodeClientError} on a non-2xx.
   */
  async putBlob(hash: string, bytes: Uint8Array, auth: NodeBlobPinAuth): Promise<NodeBlobPutResult> {
    const res = await this.fetch(
      `${this.baseUrl}${NODE_BLOBS_PATH}/${encodeURIComponent(hash)}`,
      this.init({
        method: 'PUT',
        headers: {
          'Content-Type': 'application/octet-stream',
          [OWNER_AUTH_HEADERS.publicKey]: auth.publicKey,
          [OWNER_AUTH_HEADERS.signature]: auth.signature,
          [OWNER_AUTH_HEADERS.timestamp]: String(auth.timestamp),
        },
        body: bytes,
      }),
    );
    const body = await readBoundedJson(res, this.writeResponseMaxBytes);
    if (res.status < 200 || res.status >= 300) {
      const reason = readError(body);
      throw new NodeClientError(
        `node ${NODE_BLOBS_PATH}/:hash responded HTTP ${res.status}${reason ? ` (${reason})` : ''}`,
        res.status,
        reason,
      );
    }
    const obj = body as { hash?: unknown; size?: unknown };
    if (typeof obj.hash !== 'string' || typeof obj.size !== 'number') {
      throw new NodeClientError(`node ${NODE_BLOBS_PATH}/:hash returned a malformed pin result`, res.status);
    }
    return { hash: obj.hash, size: obj.size };
  }
}
