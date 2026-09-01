# Backend image for {{APP_NAME}}. Two-stage build on oven/bun (linux/arm64 for
# AWS Graviton). Only the backend + shared-types workspaces are installed; the
# heavy Expo frontend tree is excluded via .dockerignore.

# Stage 1: build (tsc → dist)
FROM oven/bun:{{BUN_VERSION}}-alpine AS builder
WORKDIR /app

# Root files first. bunfig.toml pins the hoisted linker; the root tsconfig is
# the solution base each package extends.
COPY package.json bun.lock bunfig.toml tsconfig.json ./

# Every workspace member's package.json is required for a frozen-lockfile install
# to reconcile, even the ones we do not build here.
COPY packages/shared-types/package.json packages/shared-types/
COPY packages/backend/package.json packages/backend/
COPY packages/frontend/package.json packages/frontend/

# --ignore-scripts skips the root postinstall (it builds shared-types before the
# source is copied); shared-types + backend are built explicitly below.
RUN bun install --frozen-lockfile --ignore-scripts

COPY packages/shared-types/ packages/shared-types/
COPY packages/backend/ packages/backend/

RUN cd packages/shared-types && bun run build
RUN cd packages/backend && bun run build

# Stage 2: runtime
FROM oven/bun:{{BUN_VERSION}}-alpine AS runtime
WORKDIR /app

RUN addgroup -g 1001 -S appgroup && adduser -u 1001 -S appuser -G appgroup

COPY --from=builder /app/package.json /app/bun.lock /app/bunfig.toml ./
COPY --from=builder /app/packages/shared-types/package.json packages/shared-types/
COPY --from=builder /app/packages/backend/package.json packages/backend/
COPY --from=builder /app/packages/frontend/package.json packages/frontend/
COPY --from=builder /app/packages/shared-types/dist/ packages/shared-types/dist/
COPY --from=builder /app/packages/backend/dist/ packages/backend/dist/

# The SQL migrations, beside packages/backend/package.json — which is how
# src/db/migrationsFolder.ts resolves them. Needed by the one-shot migration
# task AND by every serving task, because readiness reads this journal to
# decide whether the database is current with the image (GET /ready).
COPY --from=builder /app/packages/backend/drizzle/ packages/backend/drizzle/

RUN bun install --frozen-lockfile --production --ignore-scripts

USER appuser
EXPOSE 3000

# Probe on 127.0.0.1 (musl resolves "localhost" to ::1 first, which would fail
# even though the server binds IPv4).
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://127.0.0.1:3000/ready || exit 1

CMD ["bun", "packages/backend/dist/server.js"]
