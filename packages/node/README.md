# @oxy.so/node — Oxy data node (reusable multi-app base)

A small, self-hostable server that stores **your own signed records** (your
personal "repo") and serves them so an app can ingest/mirror them. The node is
the **source of truth** for the data you author; the app keeps a fast read copy.

This is Fase 5 (decentralization) of the Oxy ID / Commons platform. The runnable
engine lives in [`@oxy.so/protocol/node`](../protocol) (`createNodeApp`, the
SQLite store interface, the record verifier, the `NodeClient`); this package is
the thin **deployment** of that engine — its SQLite store, env config, owner-key
authority, and bootstrap. Because the engine is app-agnostic, **the same image
serves many app-node deployments by ENV alone**: the default `OXY_NODE_*`
(`app.oxy`) deployment is the Oxy identity node, and a future `mention-node`
(built in workstream B3) is the **same base** with `MENTION_NODE_*` /
`app.mention` env — no fork.

All cryptography is reused from `@oxy.so/protocol` — a record signed by your key
(via the Commons vault's `SignatureService` / envelope **v2**) verifies on the
node with the **exact same code** Oxy uses. No crypto is re-implemented.

## What lives on a node

**On the node** — facts you can sign as your own:
- Identity & profile records
- Verifiable credentials you hold
- Your social graph expressed as DIDs
- Your own content, namespaced (`app.<x>.<y>` collections)
- A **media manifest** (hash + CDN URL) and, on demand, pinned media blobs

**NOT on the node** — derived/aggregated data that is recomputed, not owned:
- Feeds, indexes, search
- Reputation scores
- Notifications

## How it works

Records are an append-only **per-subject hash chain** (envelope v2:
`{version, type, subject, issuer, record, issuedAt, seq, prev, collection, rkey, publicKey, alg, signature}`).
Each record's `recordId = sha256(signedRecordSigningInput(envelope))`; the next
record's `prev` points at it. The node enforces chain continuity
(`prev === head`, `seq === head.seq + 1`) and refuses gaps/forks.

The **owner** is identified by a configured secp256k1 public key. Only records
signed by that key can be written; blob pins are authorized by a fresh
owner-signed header (no shared bearer secret).

## HTTP API

| Method & path | Auth | Purpose |
|---|---|---|
| `GET /.well-known/oxy-node.json` | none | Node identity + liveness `{ nodePublicKey, mode, version, serviceType, head }` (Oxy's probe) |
| `GET /oxy/head` | none | Chain head `{ seq, headRecordId, recordCount }` |
| `GET /oxy/log?since=<seq\|recordId>&limit=` | none | Ordered envelopes from a cursor (Oxy ingest) |
| `POST /records` | owner (signed envelope) | Write a single signed record |
| `POST /sync/push` | owner (signed envelopes) | Push a batch of signed records |
| `GET /blobs/:hash` | none | Serve a content-addressed blob |
| `PUT /blobs/:hash` | owner (signed header) | Pin a blob (bytes must hash to `:hash`) |
| `GET /health` | none | Container liveness |

`POST /records` / `POST /sync/push` take a v2 envelope (or `{ records: [...] }`)
signed by the owner key. The blob pin headers are `X-Oxy-Node-Public-Key`,
`X-Oxy-Node-Signature` (secp256k1 DER hex over `oxy-node:blob-pin:<hash>:<ts>`),
and `X-Oxy-Node-Timestamp`.

## Configuration (environment)

| Variable | Required | Default | Meaning |
|---|---|---|---|
| `OXY_NODE_OWNER_PUBLIC_KEY` | **yes** | — | Owner secp256k1 public key (hex); the sole write authority |
| `OXY_NODE_PUBLIC_KEY` | no | owner key | Node's advertised public key |
| `OXY_NODE_PRIVATE_KEY` | no | — | Node's own private key (if it signs its own material) |
| `OXY_NODE_MODE` | no | `self-hosted` | `self-hosted` or `managed` |
| `OXY_NODE_PORT` | no | `4000` | HTTP port |
| `OXY_NODE_DATA_DIR` | no | `<cwd>/data` | Directory for the SQLite database |
| `OXY_NODE_DB_PATH` | no | `<dataDir>/node.sqlite` | Explicit DB file path |
| `OXY_NODE_MAX_BLOB_BYTES` | no | `26214400` (25 MiB) | Max pinned blob size |
| `OXY_NODE_APP_NAMESPACE` | no | `app.oxy` | Application namespace this node serves; bounds the collection allowlist |
| `OXY_NODE_COLLECTIONS` | no | _(any)_ | Comma-separated collection allowlist. Empty = accept any collection; when set, every entry must be within `APP_NAMESPACE` and only these collections may be written / appear in the public log |
| `OXY_NODE_WELL_KNOWN_PATH` | no | `/.well-known/oxy-node.json` | Liveness manifest path |
| `OXY_NODE_PROTOCOL_ID` | no | `oxy-node/1` | Advertised node-protocol id (the manifest `version`) |
| `OXY_NODE_SERVICE_TYPE` | no | `OxyPersonalDataNode` | Advertised DID-document service-type label |
| `OXY_NODE_LOG_LEVEL` | no | `info` | pino log level |

The env-var **prefix is configurable** (`loadConfig(env, prefix)`): the Oxy
identity node uses `OXY_NODE_`; a Mention node deployment uses `MENTION_NODE_`
with `MENTION_NODE_APP_NAMESPACE=app.mention`. One codebase + one image, many app
nodes — config only.

No secrets are hardcoded; the process refuses to start without a well-formed
owner key.

## Run it

### Docker (one-liner)

Build from the **monorepo root** (the image pulls `@oxy.so/core` +
`@oxy.so/contracts` as workspace deps):

```bash
docker build --platform linux/arm64 -f packages/node/Dockerfile -t oxy-node .

docker run -d --name oxy-node -p 4000:4000 \
  -e OXY_NODE_OWNER_PUBLIC_KEY=<your-secp256k1-public-key-hex> \
  -v oxy-node-data:/data \
  oxy-node
```

### TLS with Caddy

Put the node behind Caddy for automatic HTTPS — see [`Caddyfile`](./Caddyfile).
Point `oxy-node.example.com` at your host, then:

```bash
caddy run --config ./Caddyfile
```

### Local dev

```bash
OXY_NODE_OWNER_PUBLIC_KEY=<pubkey> bun run --filter @oxy.so/node dev
```

## Scripts

- `bun run --filter @oxy.so/node dev` — watch-mode dev server
- `bun run --filter @oxy.so/node build` — build deps + `tsc` → `dist/`
- `bun run --filter @oxy.so/node start` — `node dist/index.js`
- `bun run --filter @oxy.so/node test` — Jest (ts-jest)
