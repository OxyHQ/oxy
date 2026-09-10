/**
 * `@oxy.so/protocol/node` — the runnable node substrate.
 *
 * The Node-only half of the protocol: the Express app factory that backs any
 * Oxy-protocol data node ({@link createNodeApp}), the HTTP {@link NodeClient}
 * that drives a node's routes, the `did:web` verification-method resolver, the
 * record verifier, and the node-protocol shape constants. A SEPARATE subpath
 * from the package root so this Express/Node-only code never enters React
 * Native / web bundles that import `@oxy.so/protocol`.
 *
 * Reused by `@oxy.so/node` (the runnable node), a future `mention-node` (an
 * env-only deployment of the same base), and oxy-api's node sync (which drives
 * a node via `NodeClient`).
 */

// ── Express app factory ───────────────────────────────────────────────────────
export { createNodeApp, BlobHashMismatchError } from './nodeApp';
export type {
  NodeApp,
  NodeAppDependencies,
  NodeAppConfig,
  NodeStoreLike,
  OwnerAuth,
  NodeLogger,
} from './nodeApp';

// ── Per-IP write rate limiter ──────────────────────────────────────────────────
export {
  createRateLimiter,
  DEFAULT_WRITE_RATE_LIMIT,
  DEFAULT_MAX_RATE_LIMIT_ENTRIES,
} from './rateLimit';
export type { RateLimitConfig, RateLimiter } from './rateLimit';

// ── Record verification (signature + v2 + content address) ─────────────────────
export { verifyNodeRecordEnvelope } from './verifyRecord';
export type { NodeVerifyResult, NodeVerifyRejectionReason } from './verifyRecord';

// ── HTTP client ────────────────────────────────────────────────────────────────
export { NodeClient, NodeClientError, trimTrailingSlashes } from './nodeClient';
export type {
  NodeClientOptions,
  NodeHead,
  NodeLogPage,
  NodeWriteResult,
  NodeBlobPutResult,
  NodeBlobPinAuth,
} from './nodeClient';

// ── Injected transport contract + bounded readers ──────────────────────────────
export { readBoundedBytes, readBoundedJson, ResponseTooLargeError } from './httpFetch';
export type { NodeFetch, NodeFetchInit, NodeFetchResponse } from './httpFetch';

// ── did:web verification-method resolver ───────────────────────────────────────
export { createDidWebResolver, didWebToUrl } from './didWebResolver';
export type { DidWebResolverOptions } from './didWebResolver';

// ── Node-protocol shape constants ──────────────────────────────────────────────
export {
  PROTOCOL_VERSION,
  DEFAULT_WELL_KNOWN_PATH,
  DEFAULT_SERVICE_TYPE,
  DEFAULT_APP_NAMESPACE,
  DEFAULT_PORT,
  DEFAULT_LOG_LIMIT,
  MAX_LOG_LIMIT,
  DEFAULT_MAX_BLOB_BYTES,
  MAX_SYNC_BATCH,
  JSON_BODY_LIMIT,
  OWNER_AUTH_HEADERS,
  OWNER_AUTH_MAX_AGE_MS,
  NODE_MODES,
  OWNER_ACTION_BLOB_PIN,
  SHA256_HEX,
  NODE_HEAD_PATH,
  NODE_LOG_PATH,
  NODE_RECORDS_PATH,
  NODE_SYNC_PUSH_PATH,
  NODE_BLOBS_PATH,
  DEFAULT_CLIENT_TIMEOUT_MS,
  DEFAULT_CLIENT_MAX_REDIRECTS,
  DEFAULT_HEAD_MAX_BYTES,
  DEFAULT_LOG_MAX_BYTES,
  DEFAULT_WRITE_RESPONSE_MAX_BYTES,
  DEFAULT_DID_DOC_MAX_BYTES,
} from './constants';
export type { NodeMode } from './constants';
