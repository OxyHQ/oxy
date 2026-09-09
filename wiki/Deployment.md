# Deployment

## Overview

The Oxy API runs on **AWS ECS Fargate** in `us-west-2`. Static frontends ship to **Cloudflare Workers** (static assets), except `auth.oxy.so`, which is still a **Cloudflare Pages** project because it carries a Pages Functions directory.

| Environment | Platform | URL | Trigger |
|-------------|----------|-----|---------|
| **API (production)** | ECS Fargate (us-west-2) | `api.oxy.so` | Push to `main` -> `deploy-aws.yml` |
| **Static frontends** | Cloudflare Workers | `accounts.oxy.so`, `console.oxy.so` | Push to `main` -> `deploy-cloudflare.yml` |
| **IdP frontend** | Cloudflare Pages | `auth.oxy.so` | Push to `main` -> `deploy-cloudflare.yml` |
| **Other backends** | ECS Fargate (us-west-2) | `api.mention.earth`, `api.homiio.com`, `api.alia.onl`, `api.syra.oxy.so`, `api.allo.oxy.so` | Per-repo `deploy-aws.yml` |

## AWS deployment (`api.oxy.so`)

### Stack

```
Cloudflare DNS (DNS-only, grey cloud)
   |
   v
ALB (<alb-dns-name>)
   |  ACM multi-SAN cert, host-based target groups
   v
ECS Fargate task (oxy-cluster / oxy-api)
   |  linux/arm64, port 8080, assign_public_ip=true
   v
+------------------+   +----------------------+
| ElastiCache      |   | RDS PostgreSQL 17    |
| Valkey           |   | (oxy-postgres)       |
+------------------+   +----------------------+
```

No Caddy, no on-box SMTP, no NAT gateway. Outbound email goes through AWS SES; inbound email goes through Cloudflare Email Routing -> SES -> a webhook in `packages/api/src/routes/emailInbound.ts`.

### CI/CD pipeline

`.github/workflows/deploy-aws.yml` runs on every push to `main`:

1. Sync the relevant GitHub Actions secrets to SSM (`/oxy/oxy-api/*` and the shared parameter namespace). See lines 36-46 of the workflow.
2. Authenticate to AWS via **GitHub OIDC** (no long-lived AWS keys in repo secrets) -> assume `oxy-github-deploy`.
3. `docker buildx build --platform linux/arm64 ...`.
4. Push to ECR (`237343248947.dkr.ecr.us-west-2.amazonaws.com/oxy/oxy-api`).
5. `aws ecs update-service --cluster oxy-cluster --service oxy-api --force-new-deployment`.

Task definitions are versioned (`oxy-oxy-api:N`). New revisions are registered with `aws ecs register-task-definition` whenever env / secret mappings change. Image-only updates reuse the existing task definition.

### GitHub Secrets Required

| Secret | Description |
|--------|-------------|
| `AWS_GITHUB_OIDC_ROLE_ARN` | ARN of `oxy-github-deploy`; assumed via OIDC |
| `ACCESS_TOKEN_SECRET` | JWT signing secret for access tokens |
| `REFRESH_TOKEN_SECRET` | JWT signing secret for refresh tokens |
| `DEVICE_ID_SALT` | 64-hex salt for `deriveStableDeviceId` |
| `DATABASE_URL` | Postgres connection string for the `oxy_api` database on `oxy-postgres` |
| `REDIS_URL` | ElastiCache Valkey URI |
| `CLOUDFLARE_API_TOKEN` | Cloudflare Workers and Pages deploys + DNS-01 ACM validation |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare account |

Shared secrets (AWS access-key variables for SES / app-level S3 usage, shared runtime variables) are mirrored under the shared parameter namespace for cross-service use.

### Docker files

| File | Purpose |
|------|---------|
| `Dockerfile` | Multi-stage `oven/bun:1.3-alpine` build: builder (TypeScript compile) -> production (`bun install --production`). Targets **linux/arm64** (Graviton). |
| `.dockerignore` | Use `**/node_modules` and `**/dist`; BuildKit does not match nested directories with bare patterns |
| `bunfig.toml` | `linker = "hoisted"` — Bun 1.3 `isolated` linker breaks Dockerfiles that copy root-only `node_modules` |

### Dockerfile build process

```dockerfile
# Stage 1: builder
FROM oven/bun:1.3-alpine AS builder
COPY bunfig.toml ./
COPY packages/core/ packages/api/ ...
RUN bun install --frozen-lockfile
RUN bun run core:build && bun run --cwd packages/api build

# Stage 2: production
FROM oven/bun:1.3-alpine
RUN bun install --production --frozen-lockfile
COPY --from=builder /app/packages/api/dist ./packages/api/dist
COPY --from=builder /app/packages/core/dist ./packages/core/dist
CMD ["bun", "run", "packages/api/dist/server.js"]
```

## Environment variables

### Required (API)

| Variable | Description | Example |
|----------|-------------|---------|
| `DATABASE_URL` | Postgres connection string; the database name is part of the URI | `postgres://<user>:<pass>@<private-rds-host>:5432/oxy_api` |
| `ACCESS_TOKEN_SECRET` | JWT signing secret for access tokens | 64+ hex |
| `REFRESH_TOKEN_SECRET` | JWT signing secret for refresh tokens | 64+ hex |
| `DEVICE_ID_SALT` | 64-hex salt scoping `deriveStableDeviceId` | 64 hex |
| `AWS_REGION` | S3/SES region | `us-west-2` |
| `AWS_S3_BUCKET` | Asset storage bucket | |
| `NODE_ENV` | Environment | `production` |
| `PORT` | API port | `8080` |

### Optional

| Variable | Description | Default |
|----------|-------------|---------|
| `REDIS_URL` | ElastiCache Valkey URI | Falls back to in-memory |
| `AWS_ACCESS_KEY_ID` | Explicit creds for S3/SES | Task IAM role |
| `AWS_SECRET_ACCESS_KEY` | Explicit creds for S3/SES | Task IAM role |
| `REFRESH_COOKIE_DOMAIN` | Cookie scope, e.g. `oxy.so` | Validated at startup |
| `ORIGIN_GUARD_MODE` | `enforce` or `log-only` | `enforce` |

### Generating secrets

```bash
openssl rand -hex 64
```

`DEVICE_ID_SALT` must be 64 hex chars — the API refuses to boot without it.

## Static frontends

`.github/workflows/deploy-cloudflare.yml` builds each affected frontend with `bun x turbo run build --filter=<app>` and deploys with `bunx wrangler@4` — never `cloudflare/wrangler-action`, which selects its package manager from a lockfile in its working directory, finds none in a package here, falls back to npm, and dies on the root `overrides` pinning `@oxyhq/bloom` to the bun-only `catalog:` protocol.

A Pages project always serves `<project>.pages.dev`, with no way to switch it off — a second copy of the app on a hostname that is in no CORS allowlist. `accounts` and `console` are therefore Workers, declining that hostname with `workers_dev = false`; `auth` cannot be, because its Pages Functions directory has no config-only Worker equivalent.

| Project | Kind | Source | Notes |
|---------|------|--------|-------|
| `oxy-auth` | Pages | `packages/auth/` | Vite SPA plus ONE Pages Functions directory, `functions/hub/*` (the browser DeviceSession hub) — the OAuth authorize/consent IdP. Post-deploy smoke gate (`bun run smoke:idp`) asserts the SPA renders and that the FedCM manifest stays deleted. |
| `oxy-accounts` | Worker | `packages/accounts/` | Expo Web export with `web.output: 'static'` — real per-route HTML, plus an index.html fallback for dynamic routes. `packages/accounts/wrangler.toml`. |
| `oxy-console` | Worker | `packages/console/` | Vite SPA, one `index.html`. `packages/console/wrangler.toml`. |

## Health check

```bash
curl https://api.oxy.so/health
```

```json
{
  "status": "operational",
  "timestamp": "2026-06-12T18:00:00.000Z",
  "database": "connected",
  "redis": "connected"
}
```

`redis` is one of `"connected"`, `"disconnected"`, `"not configured"`.

## Operational notes

- **Logs**: ECS task stdout/stderr -> CloudWatch Logs (`/oxy/ecs`). `aws logs tail /oxy/ecs --follow --log-stream-name-prefix oxy-api` (profile `oxy`) streams live output.
- **Rollback**: re-run a prior successful deploy workflow, or `aws ecs update-service --task-definition oxy-oxy-api:<previous-rev>`.
- **Database access and backups**: `oxy-postgres` is an RDS instance owned by `oxy-infra` — snapshots, parameter groups and restore live there (`terraform-uswest2/postgres.tf`).
