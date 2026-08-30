##
## Dockerfile for the Oxy API Server
##
## Runs the Express API. Inbound email is handled by Cloudflare Email
## Routing -> Worker -> /email/inbound in production. Do not expose public
## SMTP ports from this API container.
##
## Build:  docker build -t oxy-api .
## Run:    docker run --env-file .env -p 8080:8080 oxy-api
##

FROM oven/bun:1.3.14-alpine@sha256:5acc90a93e91ff07bf72aa90a7c9f0fa189765aec90b47bdbf2152d2196383c0 AS bun-bin

FROM node:20-alpine AS bun-node

# Copy one platform-specific, digest-pinned Bun binary. Installing the npm
# wrapper retained multiple @oven platform binaries and added 346 MiB to the
# runtime while only one 85 MiB executable can ever run in a given image.
COPY --from=bun-bin /usr/local/bin/bun /usr/local/bin/bun
RUN test "$(bun --version)" = "1.3.14"

FROM bun-node AS builder

WORKDIR /app

# Copy workspace root and override workspaces to only include api + core +
# protocol + contracts + federation + db. `@oxyhq/api` depends on
# `@oxyhq/contracts` + `@oxyhq/protocol` + `@oxyhq/federation` + `@oxyhq/db`
# (workspace:*); core is retained for the admin scripts that import
# packages/core/src/* at runtime (and core depends on protocol).
#
# A workspace:* dependency missing from this list is not a degraded build, it
# is no build at all: `bun install` below exits 1 with
# `@oxyhq/db@workspace:* failed to resolve`. Every entry in packages/api's
# `dependencies` that reads `workspace:*` must appear here.
#
# Remove bun.lock since the workspace change invalidates it — bun will
# resolve fresh dependencies (still deterministic from package.json versions).
COPY package.json ./
# The root dependencies belong to the Expo test app, not the API. Leaving them
# in this reduced server workspace pulled Expo, React Native and Bloom into both
# the build graph and the production image even though no server package imports
# them. Package-local dependencies below remain authoritative.
RUN node -e "const p=require('./package.json'); const catalog=p.workspaces?.catalog; const packages=['packages/contracts','packages/protocol','packages/federation','packages/core','packages/db','packages/api']; p.workspaces=catalog?{packages,catalog}:packages; p.dependencies={}; delete p.patchedDependencies; require('fs').writeFileSync('package.json', JSON.stringify(p, null, 2));"

# Copy package.json files for dependency resolution
COPY packages/api/package.json packages/api/
COPY packages/core/package.json packages/core/
COPY packages/protocol/package.json packages/protocol/
COPY packages/contracts/package.json packages/contracts/
COPY packages/federation/package.json packages/federation/
COPY packages/db/package.json packages/db/

# Install dependencies (no lockfile — workspace subset doesn't match the full monorepo lock)
RUN bun install

# The install above is UNLOCKED, so this asserts the one property the lockfile
# would otherwise have guaranteed: that the express types resolve to exactly one
# copy. `@types/express-slow-down` and `@types/express-rate-limit` both request
# `@types/express: "*"`, which resolves to `latest` (v5) here and lands BESIDE
# the v4 the runtime actually uses; tsc then sees two express type identities
# and fails 200 lines later in `routes/assets.ts`, `routes/email.ts` and
# `server.ts` — files nobody touched — which reads like an application bug and
# is not one. The root `overrides` entry is what holds it to v4; this fails the
# build AT the cause if that entry is ever dropped or defeated.
RUN set -eu; \
    found=$(ls -d node_modules/.bun/@types+express@* 2>/dev/null | wc -l); \
    if [ "$found" -ne 1 ]; then \
      echo "FATAL: expected exactly 1 @types/express resolution in the image, found ${found}:" >&2; \
      ls -d node_modules/.bun/@types+express@* 2>/dev/null >&2 || true; \
      echo "The root package.json 'overrides' entry pinning @types/express to ^4 is missing or defeated." >&2; \
      exit 1; \
    fi; \
    echo "express types: exactly one resolution ($(ls -d node_modules/.bun/@types+express@*))"

# Copy source code
COPY packages/core/ packages/core/
COPY packages/protocol/ packages/protocol/
COPY packages/contracts/ packages/contracts/
COPY packages/federation/ packages/federation/
COPY packages/db/ packages/db/
COPY packages/api/ packages/api/

# drizzle-orm's runtime migrator reads the SQL files and meta/_journal.json.
# The 46 historical drizzle-kit snapshots are generation inputs only and added
# roughly 25 MiB to every API task, so stage the exact runtime ledger here.
RUN mkdir -p packages/api/drizzle-runtime/meta \
    && cp packages/api/drizzle/*.sql packages/api/drizzle-runtime/ \
    && cp packages/api/drizzle/meta/_journal.json packages/api/drizzle-runtime/meta/

# Build contracts first (api depends on it at runtime via dist/cjs), then
# protocol (the signed-record crypto base core + api consume), then federation
# (HTTP signatures for outbound ActivityPub fetches), then core (api imports
# @oxyhq/core/server — safeFetch etc.), then db (every entry point in
# @oxyhq/db resolves into dist/, which is gitignored and produced by no install
# hook), then api.
RUN bun run --filter @oxyhq/contracts build
RUN bun run --filter @oxyhq/protocol build
RUN bun run --filter @oxyhq/core build
# Federation's public build script rebuilds contracts, protocol and core before
# compiling itself. Those exact artifacts were produced above, so invoke only
# Federation's three package-local compilation phases here.
RUN bun run --cwd packages/federation build:cjs \
    && bun run --cwd packages/federation build:esm \
    && bun run --cwd packages/federation build:types
RUN bun run --filter @oxyhq/db build
RUN bun run --cwd packages/api tsc -p tsconfig.json

# ── Production dependency tree ────────────────────────────────────
# Native dependencies may need a compiler while installing, but the resulting
# node_modules is portable to the identical Alpine runtime below. Keeping the
# toolchain in this throwaway stage removes roughly 300 MiB from the final image.
FROM bun-node AS production-deps

RUN apk add --no-cache python3 make g++

WORKDIR /app

# Reuse the already-normalised workspace manifests from the builder. The API
# image always installs Alpine's ffmpeg/ffprobe, so carrying ffprobe-static's
# every-OS binary bundle (336 MiB in a measured install) is pure duplication.
COPY --from=builder /app/package.json ./
COPY --from=builder /app/packages/api/package.json packages/api/
COPY --from=builder /app/packages/core/package.json packages/core/
COPY --from=builder /app/packages/protocol/package.json packages/protocol/
COPY --from=builder /app/packages/contracts/package.json packages/contracts/
COPY --from=builder /app/packages/federation/package.json packages/federation/
COPY --from=builder /app/packages/db/package.json packages/db/
RUN node -e "const fs=require('fs'); const apiFile='packages/api/package.json'; const api=require('./'+apiFile); delete api.optionalDependencies?.['ffmpeg-static']; delete api.optionalDependencies?.['ffprobe-static']; for (const name of Object.keys(api.dependencies ?? {})) if (name.startsWith('@types/')) delete api.dependencies[name]; fs.writeFileSync(apiFile, JSON.stringify(api, null, 2)); const mobilePeers=['@react-native-async-storage/async-storage','expo-crypto','expo-secure-store','expo-modules-core']; for (const name of ['core','protocol']) { const file='packages/'+name+'/package.json'; const p=require('./'+file); for (const peer of mobilePeers) { delete p.peerDependencies?.[peer]; delete p.peerDependenciesMeta?.[peer]; } fs.writeFileSync(file, JSON.stringify(p, null, 2)); }"

# Install production dependencies
RUN bun install --production \
    && rm -rf node_modules/.bun/@img+sharp-linux-*@* \
              node_modules/.bun/@img+sharp-libvips-linux-*@*

# ── Production image ──────────────────────────────────────────────
FROM node:20-alpine

COPY --from=bun-bin /usr/local/bin/bun /usr/local/bin/bun
RUN apk add --no-cache ffmpeg curl \
    && test "$(bun --version)" = "1.3.14"

WORKDIR /app

COPY --from=production-deps /app/package.json ./
COPY --from=production-deps /app/packages packages/
COPY --from=production-deps /app/node_modules node_modules/

# Copy built artifacts. @oxyhq/db's dist is needed HERE and not only in the
# builder: `bun install --production` above resolves the same `workspace:*`, and
# both `dist/server.js` and the `packages/api/src` copied below for the one-shot
# admin scripts import the package at runtime.
COPY --from=builder /app/packages/api/dist packages/api/dist
COPY --from=builder /app/packages/core/dist packages/core/dist
COPY --from=builder /app/packages/protocol/dist packages/protocol/dist
COPY --from=builder /app/packages/contracts/dist packages/contracts/dist
COPY --from=builder /app/packages/federation/dist packages/federation/dist
COPY --from=builder /app/packages/db/dist packages/db/dist

# Copy admin scripts + their src dependencies so one-shot ECS tasks can run them
# via `bun run packages/api/scripts/<name>.ts`. Scripts intentionally live outside
# tsconfig's rootDir; they are executed with bun (which interprets TS on the fly)
# and import from packages/api/src/* + packages/core/src/* at runtime.
COPY --from=builder /app/packages/api/scripts packages/api/scripts
COPY --from=builder /app/packages/api/src packages/api/src
COPY --from=builder /app/packages/core/src packages/core/src

# The SQL migrations + their journal. `dist/db/migrate.js` (built above) reads
# them from a path resolved relative to itself, so this directory has to sit at
# packages/api/drizzle exactly as it does in the repo. Applied by a one-shot ECS
# task — see .github/workflows/run-postgres-migrations.yml.
#
# The migrator is drizzle-orm's, NOT the drizzle-kit CLI: drizzle-kit is a
# devDependency that `bun install --production` above deliberately leaves out,
# because it depends on esbuild, whose arm64/alpine postinstall breaks this
# image (PR #261). drizzle-orm is already a runtime dependency and ships the
# migrator, so migrations run from the same image the service runs.
COPY --from=builder /app/packages/api/drizzle-runtime packages/api/drizzle

# Fail the build at the layer that owns runtime completeness. ffmpeg/ffprobe
# must come from Alpine, Sharp must retain its platform optional dependency,
# Bun must remain for the explicitly supported TypeScript one-shot tasks, and
# the two redundant static-binary packages must not leak back in.
RUN command -v ffmpeg >/dev/null \
    && command -v ffprobe >/dev/null \
    && command -v bun >/dev/null \
    && node -e "const p=require.resolve('sharp',{paths:['/app/packages/api']}); require(p)" \
    && test ! -d node_modules/ffmpeg-static \
    && test ! -d node_modules/ffprobe-static \
    && test ! -e packages/api/drizzle/meta/0000_snapshot.json \
    && test ! -e /usr/bin/python3 \
    && test ! -e /usr/bin/g++

# Main API entry point
CMD ["node", "packages/api/dist/server.js"]

# HTTP API port
EXPOSE 8080
