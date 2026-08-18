# Decentralization — User Data Nodes (F5)

> A user can run their **own** data node that owns their signed records; Oxy keeps
> a fast, always-available read copy. The node (`@oxyhq/node`) reuses
> `@oxyhq/core` crypto verbatim — a record signed in the Commons vault verifies on
> the node and on Oxy with the **same code**. This is Fase 5 of the Oxy ID
> initiative.
>
> Related: [Identity / Oxy ID](../identity/README.md) · [Reputation](../reputation/README.md) ·
> [Architecture](../architecture/overview.md) · [Changelog](../CHANGELOG.md)

---

## 1. The core invariant — reads NEVER touch a node

**Every node fetch happens in the background, via `safeFetch`. Nothing in a
request read path ever awaits a node.** A node being down means Oxy serves
stale-but-instant data; it is never slow and never wrong. This is the single
non-negotiable rule across F5a/F5b/F5c — liveness probes and the ingest worker
are fire-and-forget and never blocking.

The DID document's `#oxy-node` service entry is derived from the `UserNode` row
in Oxy's own DB (`did.service.ts`), never by reaching the node.

---

## 2. What lives on a node (the data boundary)

**On the node** — facts the user can sign as their own:

- Identity & profile records, verifiable credentials they hold
- Their social graph expressed as DIDs
- Their own content, namespaced (`app.<x>.<y>` collections)
- A **media manifest** (hash + CDN URL) and, on demand, pinned media blobs
  (heavy media is *not* copied — the node pins on demand)

**NOT on the node** — derived/aggregated data that is recomputed, not owned:
feeds, indexes, search, reputation scores, notifications.

---

## 3. The node server (`packages/node` → `@oxyhq/node`)

A small Express server (`better-sqlite3` log + on-disk blobs, pino logging,
Docker + Caddy) that stores a user's per-subject hash chain and serves it for
ingest. Protocol version `oxy-node/1`.

### HTTP API (`packages/node/src/app.ts`)

| Method & path | Auth | Purpose |
|---|---|---|
| `GET /.well-known/oxy-node.json` | none | identity + liveness `{ nodePublicKey, mode, version, head }` (Oxy's probe) |
| `GET /oxy/head` | none | chain head `{ seq, headRecordId, recordCount }` |
| `GET /oxy/log?since=<seq\|recordId>&limit=` | none | ordered envelopes from a cursor (Oxy ingest); `limit` 1..500, default 100 |
| `POST /records` | owner (signed envelope) | write a single v2 record (≤5 MB JSON) |
| `POST /sync/push` | owner (signed envelopes) | push a batch (≤200 records) |
| `GET /blobs/:hash` | none | serve a content-addressed blob (immutable, `max-age=31536000`) |
| `PUT /blobs/:hash` | owner (signed header) | pin a blob (bytes must hash to `:hash`, ≤25 MiB default) |
| `GET /health` | none | container liveness |

### Owner write authority

The node has exactly one write authority: the configured
`OXY_NODE_OWNER_PUBLIC_KEY` (a secp256k1 hex key; the process refuses to start
without a well-formed one).

- For `POST /records` / `/sync/push`: the envelope's `publicKey` must equal the
  owner key (constant-time `isOwnerKey`), and the signature verifies via
  `@oxyhq/core` (`verifyRecordEnvelope`) — **no new crypto**.
- For `PUT /blobs/:hash`: a fresh **owner-signed header** scheme (no shared bearer
  secret). Headers `X-Oxy-Node-Public-Key`, `X-Oxy-Node-Signature` (secp256k1 DER
  hex), `X-Oxy-Node-Timestamp`; the signed message is
  `oxy-node:blob-pin:<hash>:<ts>`; freshness window `OWNER_AUTH_MAX_AGE_MS` = 5
  min.

### Chain continuity (`store/nodeStore.ts`)

The node enforces the same hash-chain rules Oxy does. `appendRecord` (atomic txn):

- the envelope must be v2 (`seq`, `collection`, `rkey` present);
- **genesis** (`seq===0 && prev===null`) is allowed only when the head is empty;
- **extension** requires `prev === head.headRecordId && seq === head.seq + 1`;
- failures return a typed reason (`not_v2`, `chain_gap`, `chain_fork`, `bad_seq`,
  `chain_conflict`); unique indexes on `seq` and `record_id` are a concurrency
  backstop.

SQLite schema: `records(seq, collection, rkey, record_id, prev, issued_at,
envelope)` (PK `(collection, rkey, seq)`, unique `seq` + `record_id`),
`head(id=1, seq, head_record_id, record_count)`, `blobs(hash, bytes, size,
created_at)`. `putBlob` recomputes the SHA-256 and rejects a mismatch
(`BlobHashMismatchError`).

### Configuration

Key env vars (`packages/node/src/config.ts`):
`OXY_NODE_OWNER_PUBLIC_KEY` (**required**), `OXY_NODE_PUBLIC_KEY` (default = owner),
`OXY_NODE_PRIVATE_KEY`, `OXY_NODE_MODE` (`self-hosted`|`managed`),
`OXY_NODE_PORT` (4000), `OXY_NODE_DATA_DIR`, `OXY_NODE_DB_PATH`,
`OXY_NODE_MAX_BLOB_BYTES` (25 MiB), `OXY_NODE_LOG_LEVEL`. See
[`packages/node/README.md`](../../packages/node/README.md) for Docker/Caddy run
instructions.

---

## 4. F5a — node registration (one-way, Oxy → node)

A node is registered as a **signed `type:'node'` record** — there is no special
registration endpoint. `OxyServices.nodes.ts` `registerNode({ endpoint,
nodePublicKey, mode })` (native-only): fetch the chain head (uncached, for fresh
`seq`/`prev`) → sign a v2 envelope (collection `app.oxy.node`, rkey `self`,
last-writer-wins) via `SignatureService.signRecordV2` → `POST /identity/records`.
`nodeRegistry.service.ts` `materializeNodeFromRecord` then projects the verified
record into a `UserNode` operational cache row and fires a fire-and-forget
liveness probe.

`UserNode` (`models/UserNode.ts`, unique on `userId`) is a denormalized,
stale-but-instant projection: `endpoint`, `nodePublicKey`, `mode` (`pull`|`push`),
`managed`, `controller` (`self`|`oxy`), `status` (`active`|`unreachable`|`revoked`),
`lastSeenAt`/`lastProbeAt`/`lastError`, `cursor` (last-synced `seq`),
`lastSyncedAt`. The DID document's `#oxy-node` service entry is derived from it.

Liveness: `probeLiveness(userId)` `safeFetch`es `GET ${endpoint}/.well-known/oxy-node.json`
(max 1 redirect, `NODE_PROBE_TIMEOUT_MS`); 2xx → `active` + `lastSeenAt`, else
`unreachable` + `lastError`. `sweepNodeLiveness()` re-probes least-recently-probed
`active`/`unreachable` rows in the background (never `revoked`).

SDK methods: `registerNode`, `getMyNode` (`GET /nodes/me`), `removeMyNode`
(`DELETE /nodes/me`), `provisionManagedVault` (`POST /nodes/managed`),
`notifyNodeIngest(userId)` (`POST /nodes/ingest/notify/:userId`).

---

## 5. F5b — node → Oxy ingest (bidirectional)

The node exposes `/oxy/log` + `/oxy/head`; Oxy pulls and re-verifies everything.

```mermaid
sequenceDiagram
    participant Anyone
    participant API as api.oxy.so (/nodes/ingest/notify)
    participant Worker as nodeSync worker (BullMQ / interval)
    participant Node as user's node (/oxy/head, /oxy/log)
    participant DB as Oxy DB (SignedRecord, RepoHead, NodeIngestWitness)

    Anyone->>API: POST /nodes/ingest/notify/:userId (hint, no authority)
    API-->>Anyone: 202 accepted
    API->>Worker: enqueue nodeIngest(userId)
    Worker->>Node: safeFetch GET /oxy/head
    Note over Worker: remote.seq ≤ local.seq? mark synced, return
    Worker->>Node: safeFetch GET /oxy/log?since=&lt;cursor&gt;&limit=&lt;batch&gt;
    loop each record (bounded pages)
        Worker->>Worker: verifyEnvelope (sig + recordId + current VM + subject + freshness + chain)
        alt linear append
            Worker->>DB: verifyAndStoreRecord → append, advance head, advance cursor
            Worker->>DB: witnessRecord (OXY counter-sign recordId)
        else LWW per (nsid,rkey) — incoming newer
            Worker->>DB: store as fork mirror (non-chained) + witness; stop advance
        else genuine fork (chain_fork/bad_seq) but owner-signed
            Worker->>DB: store as fork mirror (both branches kept) + witness; stop
        else hard reject (invalid/forged/gap)
            Worker->>Worker: log + stop ingest
        end
    end
```

`nodeSync.service.ts` `ingestFromNode(userId)` (background-safe, never throws):

1. **Verify everything, trust nothing.** Each record is re-verified with
   `verifyEnvelope` — signature, recomputed `recordId`, current verification
   method, subject ownership (owner-DID check), freshness, and v2 chain
   continuity. Forged/foreign records are hard-rejected.
2. **Linear append**: `verifyAndStoreRecord` appends and advances the chain head +
   cursor, then `witnessRecord` counter-signs the `recordId`.
3. **LWW per `(nsid, rkey)`**: if `verifyAndStoreRecord` returns `stale_issued_at`,
   decide by last-writer-wins — higher `issuedAt` wins; exact tie → higher
   `recordId` (string compare). A winning incoming record is stored as a **fork
   mirror** (a non-chained row, no `seq`/`prev`) and witnessed; the cursor is not
   advanced past the frontier.
4. **Genuine fork** (`chain_fork`/`bad_seq`/`chain_conflict`, but the record is
   authentically owner-signed and fresh): preserve **both** branches as append-only
   fork mirrors (the unique `(userId, seq)` index is never violated) and witness.
5. **Hard rejects** (`invalid_envelope`, `chain_gap`, anything else): log and stop.

`POST /nodes/ingest/notify/:userId` is an unauthenticated **hint** with no
authority (the worker re-verifies the node fully regardless); it always returns
202 and enqueues `nodeIngest(userId)` only if the user has an active node. The
worker runs on BullMQ when `REDIS_URL` is present, otherwise a fallback interval —
either way unref'd/background.

### The counter-sign witness

`witnessRecord(userId, recordId, ingestedAt)` signs
`canonicalize({ recordId, userId, ingestedAt })` with `OXY_PRIVATE_KEY` and
appends a `NodeIngestWitness` row (idempotent per `recordId`). This is an
**immutable witness**: if a user's node key is later stolen and used to rewrite
history, Oxy can prove the original record existed and was observed at a specific
time. Missing OXY key is non-fatal (warned once; ingest still proceeds).

---

## 6. F5c — managed vault (custodial node)

For non-technical users, Oxy can operate the same node image with a custodial key
("Create your vault"). `POST /nodes/managed` (`provisionManagedVault`, auth,
`rl:` 10/min) → `nodeRegistry.service.ts`: Oxy custodial-signs the `type:'node'`
record (`issuer = OXY_DID`, signed with `OXY_PRIVATE_KEY`) via
`verifyAndStoreRecord`, materializes the `UserNode` as `managed: true,
controller: 'oxy'`, probes, and invalidates the user cache. Idempotent — an
existing managed vault at the same endpoint is a refresh; retries up to 4 on a
chain race; returns 503 if the OXY key / `MANAGED_NODE_BASE_URL` is unconfigured.
The managed endpoint is `${MANAGED_NODE_BASE_URL}/u/${userId}`.

> **Deferred (infra, not code):** the actual container/storage orchestration that
> spins up per-user node instances behind `MANAGED_NODE_BASE_URL` lives in
> `oxy-infra`. F5c only does the registration + custodial sign.

---

## 7. `/nodes/*` route table

| Path | Method | Auth | Rate limit | Purpose |
|---|---|---|---|---|
| `/nodes/me` | GET | bearer | 120/min per user | caller's node + live status (`{ node \| null }`) |
| `/nodes/me` | DELETE | bearer | 20/min per user | revoke registration (`status: revoked`) |
| `/nodes/managed` | POST | bearer | 10/min per user | provision the OXY-custodial managed vault |
| `/nodes/ingest/notify/:userId` | POST | none (hint) | 30/min per IP | fire-and-forget ingest hint; always 202 |

The three per-user budgets are keyed on the account and each limiter is mounted
AFTER `authMiddleware` — the ordering is the mechanism, not a detail. All three
used to sit BEFORE it, so `req.user` was never set when the key was computed and
every caller fell to the limiter's hashed-IP fallback: one shared bucket per NAT
egress, and the per-user ceiling in this column was unreachable. There is no IP
arm left; a request with no resolved account is skipped and bounded instead by the
global `rl:general:` limiter. `routes/__tests__/nodeLimiterOrdering.test.ts` fails
if the ordering is restored.

Node **registration** itself goes through `POST /identity/records` (a signed
record), not a `/nodes` endpoint. Owner ids are always resolved server-side from
the session, never from the body.

Public log/head used by ingest: `GET /identity/log/:userId` (`rl:nodes:log:`
60/min) and `GET /identity/head/:userId` (`rl:nodes:head:` 240/min) — see
[identity/README.md → public log](../identity/README.md#public-log).

---

## 8. Status & deferred items

Shipped to `main` (see [Changelog](../CHANGELOG.md)): F5a API foundation
(`89ce0422`), the `@oxyhq/node` server (`d9c74692`), F5b ingest (`c6fb8a86`), F5c
managed vault registration (`964b265e`), and the `@oxyhq/core` nodes SDK mixin.

Deferred:

- **Managed-vault container/storage orchestration** — infra (`oxy-infra`).
- **Commons node UI** — a "Connect your node" / "Create your vault" surface in
  Commons Settings calling the SDK node methods.
- **SSRF constraint (v1):** self-hosted nodes must expose a *public* HTTPS
  endpoint (or use the managed vault) — `safeFetch` denies private/link-local
  addresses by design.
