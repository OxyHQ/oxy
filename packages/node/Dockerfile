##
## Dockerfile for an Oxy data node (@oxyhq/node) — a reusable multi-app base.
##
## A small, self-hostable server that stores and serves a user's OWN signed
## records (their personal repo). The runnable engine is @oxyhq/protocol/node
## (createNodeApp + the record verifier); this image is the thin deployment
## (SQLite store + env config + bootstrap), so a record signed on the node
## verifies with the EXACT @oxyhq/protocol code Oxy uses.
##
## The SAME image serves many app-node deployments by ENV alone (the env-var
## prefix + app namespace are config): the default OXY_NODE_* / app.oxy build is
## the Oxy identity node; a future mention-node is the same base with
## MENTION_NODE_* / app.mention env (built in workstream B3) — no fork.
##
## Build context is the MONOREPO ROOT (it copies @oxyhq/protocol + @oxyhq/core +
## @oxyhq/contracts as workspace deps). Mirrors the api Dockerfile: node:20-alpine
## + bun, a lean workspace subset (contracts + protocol + core + node only),
## build-from-source.
##
## Build (arm64):
##   docker build --platform linux/arm64 -f packages/node/Dockerfile -t oxy-node .
## Run:
##   docker run --env-file .env -p 4000:4000 -v oxy-node-data:/data oxy-node
##

FROM node:24-alpine AS builder

# python3/make/g++: better-sqlite3 compiles a native addon at install time.
RUN apk add --no-cache python3 make g++
RUN npm install -g bun

# Pin node-gyp to a known-good version. better-sqlite3 has no prebuilt binary for
# this Node/musl target, so it compiles from source. Bun's default addon build
# fetches `bunx node-gyp@latest` — currently node-gyp@13, whose bundled undici
# calls `webidl.util.markAsUncloneable`, which throws on Node 20 and fails the
# install. Installing node-gyp globally puts a known-good `node-gyp` on PATH, and
# `npm_config_node_gyp` makes bun use it directly instead of the volatile @latest.
RUN npm install -g node-gyp@11.5.0
ENV npm_config_node_gyp=/usr/local/lib/node_modules/node-gyp/bin/node-gyp.js

WORKDIR /app

# Narrow the workspaces to the lean subset this image needs, then drop the
# monorepo lockfile (the subset does not match the full-repo lock — bun resolves
# deterministically from the package.json versions). Mirrors the api Dockerfile.
COPY package.json ./
RUN node -e "const p=require('./package.json'); const catalog=p.workspaces?.catalog; const packages=['packages/contracts','packages/protocol','packages/core','packages/node']; p.workspaces=catalog?{packages,catalog}:packages; delete p.patchedDependencies; require('fs').writeFileSync('package.json', JSON.stringify(p, null, 2));"

# package.json files first for dependency resolution caching
COPY packages/node/package.json packages/node/
COPY packages/core/package.json packages/core/
COPY packages/protocol/package.json packages/protocol/
COPY packages/contracts/package.json packages/contracts/

RUN bun install

# Source
COPY packages/core/ packages/core/
COPY packages/protocol/ packages/protocol/
COPY packages/contracts/ packages/contracts/
COPY packages/node/ packages/node/

# Build contracts, then protocol (the signed-record crypto base node verifies
# with), then core (node consumes their dist), then node.
RUN bun run --filter @oxyhq/contracts build
RUN bun run --filter @oxyhq/protocol build
RUN bun run --filter @oxyhq/core build
RUN cd packages/node && bunx tsc

# ── Production image ──────────────────────────────────────────────
FROM node:24-alpine

RUN apk add --no-cache python3 make g++ curl
RUN npm install -g bun

# better-sqlite3 (a runtime dependency) compiles from source in the production
# install too; pin node-gyp so bun does not fetch the broken `node-gyp@latest`.
# See the builder stage above for the full rationale.
RUN npm install -g node-gyp@11.5.0
ENV npm_config_node_gyp=/usr/local/lib/node_modules/node-gyp/bin/node-gyp.js

WORKDIR /app

COPY package.json ./
RUN node -e "const p=require('./package.json'); const catalog=p.workspaces?.catalog; const packages=['packages/contracts','packages/protocol','packages/core','packages/node']; p.workspaces=catalog?{packages,catalog}:packages; delete p.patchedDependencies; require('fs').writeFileSync('package.json', JSON.stringify(p, null, 2));"
COPY packages/node/package.json packages/node/
COPY packages/core/package.json packages/core/
COPY packages/protocol/package.json packages/protocol/
COPY packages/contracts/package.json packages/contracts/

RUN bun install --production

# Built artifacts
COPY --from=builder /app/packages/node/dist packages/node/dist
COPY --from=builder /app/packages/core/dist packages/core/dist
COPY --from=builder /app/packages/protocol/dist packages/protocol/dist
COPY --from=builder /app/packages/contracts/dist packages/contracts/dist

# Default data directory (mount a volume here to persist the SQLite DB + blobs).
ENV OXY_NODE_DATA_DIR=/data
VOLUME ["/data"]

# Container liveness — the node's own well-known liveness endpoint.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -fsS "http://127.0.0.1:${OXY_NODE_PORT:-4000}/health" || exit 1

CMD ["node", "packages/node/dist/index.js"]

EXPOSE 4000
