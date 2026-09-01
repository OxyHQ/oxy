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

FROM node:20-alpine AS builder

RUN npm install -g bun

WORKDIR /app

# Copy workspace root and override workspaces to only include api + core + MCP +
# protocol + contracts + federation. `@oxyhq/api` depends on these workspace
# packages; core is also retained for admin scripts that import
# packages/core/src/* at runtime (and core depends on protocol).
# Remove bun.lock since the workspace change invalidates it — bun will
# resolve fresh dependencies (still deterministic from package.json versions).
COPY package.json ./
RUN node -e "const p=require('./package.json'); p.workspaces=['packages/contracts','packages/protocol','packages/federation','packages/core','packages/mcp','packages/api']; delete p.patchedDependencies; require('fs').writeFileSync('package.json', JSON.stringify(p, null, 2));"

# Copy package.json files for dependency resolution
COPY packages/api/package.json packages/api/
COPY packages/core/package.json packages/core/
COPY packages/protocol/package.json packages/protocol/
COPY packages/contracts/package.json packages/contracts/
COPY packages/federation/package.json packages/federation/
COPY packages/mcp/package.json packages/mcp/

# Install dependencies (no lockfile — workspace subset doesn't match the full monorepo lock)
RUN bun install

# Copy source code
COPY packages/core/ packages/core/
COPY packages/protocol/ packages/protocol/
COPY packages/contracts/ packages/contracts/
COPY packages/federation/ packages/federation/
COPY packages/mcp/ packages/mcp/
COPY packages/api/ packages/api/

# Build contracts first (api depends on it at runtime via dist/cjs), then
# protocol (the signed-record crypto base core + api consume), then federation
# (HTTP signatures for outbound ActivityPub fetches), core (api imports
# @oxyhq/core/server — safeFetch etc.), MCP, then api.
RUN bun run --filter @oxyhq/contracts build
RUN bun run --filter @oxyhq/protocol build
RUN bun run --filter @oxyhq/core build
RUN bun run --filter @oxyhq/federation build
RUN bun run --filter @oxyhq/mcp build
RUN bun run --filter @oxyhq/api build

# ── Production image ──────────────────────────────────────────────
FROM node:20-alpine

RUN apk add --no-cache python3 make g++ ffmpeg curl
RUN npm install -g bun

WORKDIR /app

# Copy workspace root and override workspaces
COPY package.json ./
RUN node -e "const p=require('./package.json'); p.workspaces=['packages/contracts','packages/protocol','packages/federation','packages/core','packages/mcp','packages/api']; delete p.patchedDependencies; require('fs').writeFileSync('package.json', JSON.stringify(p, null, 2));"
COPY packages/api/package.json packages/api/
COPY packages/core/package.json packages/core/
COPY packages/protocol/package.json packages/protocol/
COPY packages/contracts/package.json packages/contracts/
COPY packages/federation/package.json packages/federation/
COPY packages/mcp/package.json packages/mcp/

# Install production dependencies
RUN bun install --production

# Copy built artifacts
COPY --from=builder /app/packages/api/dist packages/api/dist
COPY --from=builder /app/packages/core/dist packages/core/dist
COPY --from=builder /app/packages/protocol/dist packages/protocol/dist
COPY --from=builder /app/packages/contracts/dist packages/contracts/dist
COPY --from=builder /app/packages/federation/dist packages/federation/dist
COPY --from=builder /app/packages/mcp/dist packages/mcp/dist

# Copy admin scripts + their src dependencies so one-shot ECS tasks can run them
# via `bun run packages/api/scripts/<name>.ts`. Scripts intentionally live outside
# tsconfig's rootDir; they are executed with bun (which interprets TS on the fly)
# and import from packages/api/src/* + packages/core/src/* at runtime.
COPY --from=builder /app/packages/api/scripts packages/api/scripts
COPY --from=builder /app/packages/api/src packages/api/src
COPY --from=builder /app/packages/core/src packages/core/src

# Main API entry point
CMD ["node", "packages/api/dist/server.js"]

# HTTP API port
EXPOSE 8080
