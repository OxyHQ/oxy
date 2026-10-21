/**
 * User-node constants (F5a — decentralization / personal data nodes).
 *
 * SINGLE SOURCE OF TRUTH for the tunables of node registration, the liveness
 * probe, and the background liveness sweep. Nothing in the node services may
 * hardcode these — import them here.
 */

/**
 * AtProto-style collection (NSID) carried by a signed `type:'node'` record. The
 * record's `rkey` is fixed to {@link NODE_RKEY} so a user has exactly ONE active
 * node registration (last-writer-wins on the chain's `(collection, rkey)` key).
 */
export const NODE_COLLECTION = 'app.oxy.node';

/** The single record key for a user's node registration (one node per user). */
export const NODE_RKEY = 'self';

/** The DID-document service `type` announced for a user's personal data node. */
export const OXY_NODE_SERVICE_TYPE = 'OxyPersonalDataNode';

/** The DID-document service-id fragment for a user's personal data node. */
export const OXY_NODE_SERVICE_FRAGMENT = '#oxy-node';

/**
 * The well-known liveness manifest a node serves. The probe fetches this over
 * HTTPS via `safeFetch`; a 2xx means the node is reachable.
 */
export const NODE_WELL_KNOWN_PATH = '/.well-known/oxy-node.json';

/** Time-to-first-byte deadline for a liveness probe (kept short — background). */
export const NODE_PROBE_TIMEOUT_MS = 5_000;

/** Max bytes read from a liveness probe response before the stream is destroyed. */
export const NODE_PROBE_MAX_BYTES = 64 * 1024;

/** Max length of a stored `lastError` string (keeps the row bounded). */
export const NODE_LAST_ERROR_MAX_LEN = 300;

/** How often the background sweep re-probes registered nodes. */
export const NODE_LIVENESS_SWEEP_INTERVAL_MS = 10 * 60 * 1000; // 10 minutes

/** Max nodes re-probed per sweep (bounds the background work). */
export const NODE_LIVENESS_SWEEP_BATCH = 100;

/* -------------------------------------------------------------------------- */
/*  F5b — bidirectional sync (node → Oxy ingest)                              */
/* -------------------------------------------------------------------------- */

/** Records pulled per `/oxy/log` page (bounds a single fetch's working set). */
export const NODE_INGEST_BATCH = 100;

/**
 * Hard cap on log pages processed in one `ingestFromNode` run. The batch × this
 * bounds how many records a single ingest can append (`100 × 50 = 5000`) so a
 * very long chain is caught up across several scheduled runs, never one
 * unbounded loop.
 */
export const NODE_INGEST_MAX_ITERATIONS = 50;

/** Time-to-first-byte deadline for a node head/log fetch (kept short). */
export const NODE_INGEST_FETCH_TIMEOUT_MS = 8_000;

/**
 * Deadline for reading a whole node head/log response body once its headers
 * arrived. A node that sends headers and stalls ends this attempt with a
 * transient `ResponseTimeoutError`; the next sweep retries from the local head.
 */
export const NODE_INGEST_BODY_TIMEOUT_MS = 15_000;

/** Max bytes read from a single `/oxy/log` response before the stream is cut. */
export const NODE_INGEST_MAX_BYTES = 2 * 1024 * 1024; // 2 MiB

/** How often the background sweep pulls `mode:'pull'` active nodes. */
export const NODE_INGEST_SWEEP_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

/** Max `mode:'pull'` nodes enqueued for ingest per sweep (bounds the work). */
export const NODE_INGEST_SWEEP_BATCH = 100;

/**
 * BullMQ queue name for node ingest. MUST NOT contain `:` (BullMQ throws on it)
 * — the `oxy-api-` prefix keeps the key distinct from cache keys on the shared
 * Valkey instance and uses `-`, never `:`.
 */
export const NODE_INGEST_QUEUE_NAME = 'oxy-api-node-ingest';

/**
 * Stable repeatable-scheduler id for the pull sweep. Constant across boots and
 * replicas so BullMQ's `upsertJobScheduler` converges on ONE fleet-wide schedule
 * (the "leader-gated" effect) rather than accumulating duplicates.
 */
export const NODE_INGEST_SWEEP_SCHEDULER_ID = 'node-ingest-pull-sweep';

/** Job name for the repeatable pull-sweep tick. */
export const NODE_INGEST_SWEEP_JOB = 'node-ingest-pull-sweep';

/** Job name for an on-demand per-user ingest (carries `{ userId }`). */
export const NODE_INGEST_USER_JOB = 'node-ingest-user';

/* -------------------------------------------------------------------------- */
/*  F5c — managed vault (Oxy operates a node on behalf of a user)             */
/* -------------------------------------------------------------------------- */

/**
 * Env var naming the HTTPS base URL of the Oxy-operated managed-node fleet. A
 * managed vault's endpoint is derived as
 * `${MANAGED_NODE_BASE_URL}${MANAGED_NODE_USER_PATH_PREFIX}${userId}` (e.g.
 * `https://nodes.oxy.so/u/<userId>`) — NEVER hardcoded. When unset (or not a
 * valid credential-free HTTPS base) managed-vault provisioning FAILS CLOSED: a
 * managed vault must have a real place to live, so Oxy never creates a broken one.
 */
export const MANAGED_NODE_BASE_URL_ENV = 'MANAGED_NODE_BASE_URL';

/** Per-user path segment appended under the managed-node base URL. */
export const MANAGED_NODE_USER_PATH_PREFIX = '/u/';

/**
 * Env var optionally overriding the managed node's signing public key (hex
 * secp256k1). Oxy operates a managed node with the CUSTODIAL key
 * (`controller:[OXY_DID]`), so this DEFAULTS to `OXY_PUBLIC_KEY` when unset —
 * records a managed node signs verify against the Oxy custodial key exactly like
 * any other custodial (`issuer = OXY_DID`) record. Set it only when the managed
 * fleet runs a dedicated keypair distinct from the org custodial key.
 */
export const MANAGED_NODE_PUBLIC_KEY_ENV = 'MANAGED_NODE_PUBLIC_KEY';

/**
 * Transport mode for a managed vault. Oxy operates both sides, but the node still
 * PULLS its own chain (the node paces sync) — identical to the self-hosted
 * default — so nothing in a read path ever waits on it.
 */
export const MANAGED_NODE_MODE = 'pull' as const;
