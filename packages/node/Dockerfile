##
## Dockerfile for an Oxy data node (@oxy.so/node) — a reusable multi-app base.
##
## A small, self-hostable server that stores and serves a user's OWN signed
## records (their personal repo). The runnable engine is @oxy.so/protocol/node
## (createNodeApp + the record verifier); this image is the thin deployment
## (SQLite store + env config + bootstrap), so a record signed on the node
## verifies with the EXACT @oxy.so/protocol code Oxy uses.
##
## The SAME image serves many app-node deployments by ENV alone (the env-var
## prefix + app namespace are config): the default OXY_NODE_* / app.oxy build is
## the Oxy identity node; a future mention-node is the same base with
## MENTION_NODE_* / app.mention env (built in workstream B3) — no fork.
##
## Build context is the MONOREPO ROOT (it copies @oxy.so/protocol + @oxy.so/core +
## @oxy.so/telemetry + @oxy.so/contracts as workspace deps): a lean workspace
## subset (contracts + protocol + telemetry + core + node only), built from
## source on node:24-alpine + bun.
##
## The node RUNS on Bun: the production stage is oven/bun:1.4.3-alpine and the
## store is Bun's built-in `bun:sqlite`, so no stage compiles a native addon
## (better-sqlite3 needed python3/make/g++ in both). Rolling back to Node is
## reverting the change that made this switch: it moved the store, this image
## and the package's test runner together.
##
## Build (arm64):
##   docker build --platform linux/arm64 -f packages/node/Dockerfile -t oxy-node .
## Run:
##   docker run --env-file .env -p 4000:4000 -v oxy-node-data:/data oxy-node
##

# One platform-specific, digest-pinned Bun binary, as in the api Dockerfile.
# `npm install -g bun` was unpinned and pulled the npm wrapper with every
# @oven platform binary.
FROM oven/bun:1.4.3-alpine@sha256:629e17411f1f129dbec3af78d5af9c9f2a937435c80349437206c6b0b7422373 AS bun-bin

FROM node:24-alpine AS builder

COPY --from=bun-bin /usr/local/bin/bun /usr/local/bin/bun
RUN ln -s /usr/local/bin/bun /usr/local/bin/bunx

WORKDIR /app

# Narrow the workspaces to the lean subset this image needs, then drop the
# monorepo lockfile (the subset does not match the full-repo lock — bun resolves
# deterministically from the package.json versions). Mirrors the api Dockerfile.
COPY package.json ./
COPY vendor/display/ ./vendor/display/
COPY vendor/expo-native/oxy.so-expo-cli-native-57.0.23+oxy.native.3.tgz vendor/expo-native/oxy.so-expo-code-signing-native-0.1.2.tgz ./vendor/expo-native/
RUN node -e "const p=require('./package.json'); const catalog=p.workspaces?.catalog; const packages=['packages/contracts','packages/protocol','packages/telemetry','packages/core','packages/node']; p.workspaces=catalog?{packages,catalog}:packages; delete p.patchedDependencies; require('fs').writeFileSync('package.json', JSON.stringify(p, null, 2));"

# package.json files first for dependency resolution caching
COPY packages/node/package.json packages/node/
COPY packages/core/package.json packages/core/
COPY packages/telemetry/package.json packages/telemetry/
COPY packages/protocol/package.json packages/protocol/
COPY packages/contracts/package.json packages/contracts/

RUN bun install

# Source
COPY packages/core/ packages/core/
COPY packages/telemetry/ packages/telemetry/
COPY packages/protocol/ packages/protocol/
COPY packages/contracts/ packages/contracts/
COPY packages/node/ packages/node/

# Build contracts, then protocol (the signed-record crypto base node verifies
# with), then telemetry and core (core depends on @oxy.so/telemetry; node
# consumes their dist), then node.
RUN bun run --filter @oxy.so/contracts build
RUN bun run --filter @oxy.so/protocol build
RUN bun run --filter @oxy.so/telemetry build
RUN bun run --filter @oxy.so/core build
RUN cd packages/node && bunx tsc

# ── Production image: Bun ─────────────────────────────────────────
# The same digest-pinned Bun as the builder's binary. Alpine (musl), like the
# builder; nothing installed here is native. curl serves the HEALTHCHECK.
FROM oven/bun:1.4.3-alpine@sha256:629e17411f1f129dbec3af78d5af9c9f2a937435c80349437206c6b0b7422373

RUN apk add --no-cache curl

WORKDIR /app

COPY package.json ./
COPY vendor/display/ ./vendor/display/
COPY vendor/expo-native/oxy.so-expo-cli-native-57.0.23+oxy.native.3.tgz vendor/expo-native/oxy.so-expo-code-signing-native-0.1.2.tgz ./vendor/expo-native/
RUN bun -e "const p=require('./package.json'); const catalog=p.workspaces?.catalog; const packages=['packages/contracts','packages/protocol','packages/telemetry','packages/core','packages/node']; p.workspaces=catalog?{packages,catalog}:packages; delete p.patchedDependencies; require('fs').writeFileSync('package.json', JSON.stringify(p, null, 2));"
COPY packages/node/package.json packages/node/
COPY packages/core/package.json packages/core/
COPY packages/telemetry/package.json packages/telemetry/
COPY packages/protocol/package.json packages/protocol/
COPY packages/contracts/package.json packages/contracts/

RUN bun install --production

# Built artifacts
COPY --from=builder /app/packages/node/dist packages/node/dist
COPY --from=builder /app/packages/core/dist packages/core/dist
COPY --from=builder /app/packages/telemetry/dist packages/telemetry/dist
COPY --from=builder /app/packages/protocol/dist packages/protocol/dist
COPY --from=builder /app/packages/contracts/dist packages/contracts/dist

# Default data directory (mount a volume here to persist the SQLite DB + blobs).
ENV OXY_NODE_DATA_DIR=/data
VOLUME ["/data"]

# Container liveness — the node's own well-known liveness endpoint.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -fsS "http://127.0.0.1:${OXY_NODE_PORT:-4000}/health" || exit 1

# Exec form, so Bun is PID 1 and receives SIGTERM itself (src/index.ts drains
# HTTP, closes the database and exits 0). The base image's `node` on PATH is a
# symlink to bun, so name the runtime explicitly.
CMD ["bun", "packages/node/dist/index.js"]

EXPOSE 4000
