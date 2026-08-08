# Deployment

## Overview

| Environment | Platform | URL | Trigger |
|-------------|----------|-----|---------|
| **API** | AWS ECS Fargate (us-west-2) | `api.oxy.so` | Push to `main` -> `deploy-aws.yml` |
| **Static frontends** | Cloudflare Pages | `auth.oxy.so`, `accounts.oxy.so`, `inbox.oxy.so`, `console.oxy.so` | Push to `main` -> `deploy-cloudflare.yml` |
| **Other backends** | AWS ECS Fargate (us-west-2) | `api.mention.earth`, `api.homiio.com`, `api.alia.onl`, `api.syra.oxy.so`, `api.allo.oxy.so` | Push to their repos -> per-repo `deploy-aws.yml` |

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

There is no Caddy, no SMTP server, and no NAT gateway in this path. Outbound email goes through AWS SES; inbound email goes through Cloudflare Email Routing -> SES -> a webhook handler in `packages/api/src/routes/emailInbound.ts`.

### CI/CD pipeline

`.github/workflows/deploy-aws.yml` runs on every push to `main`:

1. Sync the relevant GitHub Actions secrets into SSM (`/oxy/oxy-api/*` and the shared parameter namespace). The deploy workflow is the source of truth that mirrors GitHub secrets to AWS — see lines 36-46 of the workflow.
2. Authenticate to AWS using **GitHub OIDC** (no static AWS keys in repo secrets) -> assume the IAM role `oxy-github-deploy`.
3. `docker buildx build --platform linux/arm64 ...` against the API Dockerfile.
4. Push the resulting image to ECR (`237343248947.dkr.ecr.us-west-2.amazonaws.com/oxy/oxy-api`).
5. `aws ecs update-service --cluster oxy-cluster --service oxy-api --force-new-deployment` -- ECS pulls the new image, drains old tasks behind the ALB and replaces them.

Task definitions are versioned (`oxy-oxy-api:N`). New revisions are registered with `aws ecs register-task-definition` when env / secret mappings change; image-only updates reuse the existing task definition.

### GitHub secrets

| Secret | Description |
|--------|-------------|
| `AWS_GITHUB_OIDC_ROLE_ARN` | ARN of `oxy-github-deploy`; assumed via OIDC |
| `ACCESS_TOKEN_SECRET` | JWT signing secret for access tokens |
| `REFRESH_TOKEN_SECRET` | JWT signing secret for refresh tokens |
| `DEVICE_ID_SALT` | 64-hex salt for `deriveStableDeviceId` |
| `DATABASE_URL` | Postgres connection string for the `oxy_api` database on `oxy-postgres` |
| `REDIS_URL` | ElastiCache Valkey URI |
| `CLOUDFLARE_API_TOKEN` | For Cloudflare Pages deploys + DNS-01 ACM validation |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare account |

Shared secrets (AWS access-key variables for SES / app-level S3 usage where IAM roles aren't applied, shared runtime variables) are mirrored under the shared parameter namespace and consumed across services.

### Dockerfile (multi-stage, linux/arm64)

```
Stage 1 (builder): oven/bun:1.3-alpine
  - bun install --frozen-lockfile
  - bun run core:build && bun run --cwd packages/api build

Stage 2 (production): oven/bun:1.3-alpine
  - bun install --production --frozen-lockfile
  - copy compiled dist/ from builder
  - CMD: bun run packages/api/dist/server.js
```

The image is built for **linux/arm64** (Graviton). x86 images won't run on the Fargate task family.

## Environment variables

### Required

| Variable | Description |
|----------|-------------|
| `DATABASE_URL` | Postgres connection string; the database name is part of the URI |
| `ACCESS_TOKEN_SECRET` | JWT signing secret for access tokens |
| `REFRESH_TOKEN_SECRET` | JWT signing secret for refresh tokens |
| `DEVICE_ID_SALT` | 64-hex salt scoping `deriveStableDeviceId` |
| `AWS_REGION` | S3/SES region (`us-west-2`) |
| `AWS_S3_BUCKET` | Asset storage bucket |
| `NODE_ENV` | `production` or `development` |
| `PORT` | `8080` |

### Optional

| Variable | Description | Default |
|----------|-------------|---------|
| `REDIS_URL` | ElastiCache Valkey URI | Falls back to in-memory |
| `AWS_ACCESS_KEY_ID` | Explicit creds for S3/SES | Uses task IAM role |
| `AWS_SECRET_ACCESS_KEY` | Explicit creds for S3/SES | Uses task IAM role |
| `REFRESH_COOKIE_DOMAIN` | Cookie scope (e.g. `oxy.so`) | Validated at startup |
| `ORIGIN_GUARD_MODE` | `enforce` or `log-only` | `enforce` |

### Generating secrets

```bash
openssl rand -hex 64
# or, equivalently:
node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"
```

`DEVICE_ID_SALT` should be 64 hex chars; the API validates at startup and refuses to boot without it.

## Static frontends (Cloudflare Pages)

`.github/workflows/deploy-cloudflare.yml` builds each affected frontend with `bun x turbo run build --filter=<app>` and deploys via `cloudflare/wrangler-action@v3`.

| Project | Source | Notes |
|---------|--------|-------|
| `oxy-auth` | `packages/auth/` | Builds the Vite SPA as **pure-static output** — the device-account chooser runs in the device-first SDK (`useSwitchableAccounts`), so the former `/api/device-accounts` Cloudflare Pages Function was deleted in the 2c cutover. The workflow deploys via a direct `bunx wrangler@4 pages deploy` `run:` step (NOT `cloudflare/wrangler-action`, whose default `npx` path trips npm's override-conflict check against the repo-root `@oxyhq/bloom` override). A post-deploy smoke gate (`scripts/smoke-idp.ts`) re-checks the live host. Live-verified working. |
| `oxy-accounts` | `packages/accounts/` | Expo Web export -> Cloudflare Pages |
| `oxy-inbox` | `packages/inbox/` | Expo Web export |
| `oxy-console` | `packages/console/` | Nuxt or Vite output |

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

- **Logs**: ECS task stdout/stderr is shipped to CloudWatch Logs (`/oxy/ecs`). Use `aws logs tail /oxy/ecs --follow --log-stream-name-prefix oxy-api` (profile `oxy`) to stream the live log.
- **Rollback**: re-run a previous successful deploy workflow, or `aws ecs update-service --task-definition oxy-oxy-api:<previous-rev>`.
- **Database access and backups**: `oxy-postgres` is an RDS instance owned by `oxy-infra` — automated snapshots, parameter groups and restore live there, not here. See `~/Oxy/oxy-infra/terraform-uswest2/postgres.tf`.
- **Excluded from AWS**: the LiveKit cluster still runs on its own external managed host and is migrated separately. Athina, faircoin, TNP, and the OpenSearch `genai-shark` instance also stay outside AWS.
