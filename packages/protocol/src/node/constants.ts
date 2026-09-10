/**
 * Node-protocol shape constants — the wire-level contract of an Oxy-protocol
 * data node, shared by the generic node app factory ({@link ./nodeApp}), the
 * HTTP {@link ./nodeClient.NodeClient}, and any app's node deployment
 * (`@oxy.so/node`, a future `mention-node`).
 *
 * These were previously hardcoded inside `@oxy.so/node`; they live here so the
 * SAME values drive a server and a client without either side re-declaring (and
 * drifting) the contract. Deployment-specific knobs (owner key, port, data dir)
 * are still resolved per-deployment from the environment — only the protocol's
 * own shape constants live here.
 */

/**
 * The node-protocol version advertised at the well-known manifest. Bumped only
 * on a breaking change to the wire shape of the log / head / record APIs. This
 * is the DEFAULT `protocolId` a deployment advertises (overridable per app).
 */
export const PROTOCOL_VERSION = 'oxy-node/1' as const;

/** Default well-known manifest path (the existing `@oxy.so/node` value). */
export const DEFAULT_WELL_KNOWN_PATH = '/.well-known/oxy-node.json';

/** Default DID-document service-type label advertised by a node deployment. */
export const DEFAULT_SERVICE_TYPE = 'OxyPersonalDataNode';

/**
 * Default application namespace a node deployment serves. The records a node
 * stores all live under this namespace (e.g. `app.oxy.*`); a `collections`
 * allowlist (when set) MUST be within it.
 */
export const DEFAULT_APP_NAMESPACE = 'app.oxy';

/** Default HTTP port when the port env var is unset (always overridable). */
export const DEFAULT_PORT = 4000;

/** Default and maximum number of log entries returned by `GET /oxy/log`. */
export const DEFAULT_LOG_LIMIT = 100;
export const MAX_LOG_LIMIT = 500;

/** Default upper bound on a single pinned blob's size when unset (25 MiB). */
export const DEFAULT_MAX_BLOB_BYTES = 25 * 1024 * 1024;

/** Maximum number of envelopes accepted in one `POST /sync/push` batch. */
export const MAX_SYNC_BATCH = 200;

/** Body-size ceiling for JSON request bodies (`/records`, `/sync/push`). */
export const JSON_BODY_LIMIT = '5mb';

/** HTTP headers carrying an owner-signed action authorization (blob pins). */
export const OWNER_AUTH_HEADERS = {
  publicKey: 'x-oxy-node-public-key',
  signature: 'x-oxy-node-signature',
  timestamp: 'x-oxy-node-timestamp',
} as const;

/**
 * Freshness window for an owner-signed action (e.g. a blob pin). A signed
 * authorization header older/newer than this (accounting for clock skew) is
 * rejected, bounding replay of a captured pin authorization.
 */
export const OWNER_AUTH_MAX_AGE_MS = 5 * 60 * 1000; // 5 minutes

/** Operating modes a node can advertise. */
export const NODE_MODES = ['self-hosted', 'managed'] as const;
export type NodeMode = (typeof NODE_MODES)[number];

/** The node operation an owner can authorize with a signed header. */
export const OWNER_ACTION_BLOB_PIN = 'blob-pin' as const;

/** A 32-byte (64 hex char) lowercase SHA-256 digest, used as the blob address. */
export const SHA256_HEX = /^[0-9a-f]{64}$/;

/* -------------------------------------------------------------------------- */
/*  HTTP NodeClient — the node-facing routes a client drives                  */
/* -------------------------------------------------------------------------- */

/** Chain head endpoint (`GET`). */
export const NODE_HEAD_PATH = '/oxy/head';
/** Ordered log endpoint (`GET ?since=&limit=`). */
export const NODE_LOG_PATH = '/oxy/log';
/** Single-record write endpoint (`POST`, owner-signed envelope). */
export const NODE_RECORDS_PATH = '/records';
/** Batch push endpoint (`POST`, owner-signed envelopes). */
export const NODE_SYNC_PUSH_PATH = '/sync/push';
/** Content-addressed blob endpoint prefix (`GET|PUT /blobs/:hash`). */
export const NODE_BLOBS_PATH = '/blobs';

/** Default time-to-first-byte deadline for a NodeClient request (ms). */
export const DEFAULT_CLIENT_TIMEOUT_MS = 8_000;

/** Default redirect budget for a NodeClient request (each re-validated upstream). */
export const DEFAULT_CLIENT_MAX_REDIRECTS = 1;

/** Default bounded read for a `/oxy/head` response (tiny JSON). */
export const DEFAULT_HEAD_MAX_BYTES = 64 * 1024;

/** Default bounded read for a `/oxy/log` page response. */
export const DEFAULT_LOG_MAX_BYTES = 2 * 1024 * 1024;

/** Default bounded read for a small JSON write response (`/records`, blob pin). */
export const DEFAULT_WRITE_RESPONSE_MAX_BYTES = 64 * 1024;

/** Default bounded read for a fetched `<did>.json` document. */
export const DEFAULT_DID_DOC_MAX_BYTES = 256 * 1024;
