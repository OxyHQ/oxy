# Deployment

## Overview

| Environment | Platform | URL | Trigger |
|-------------|----------|-----|---------|
| **API** | AWS ECS Fargate (us-west-2) | `api.oxy.so` | Push to `main` -> `deploy-aws.yml` |
| **Static frontends** | Cloudflare Workers | `accounts.oxy.so`, `console.oxy.so` | Push to `main` -> `deploy-cloudflare.yml` |
| **IdP frontend** | Cloudflare Pages (Pages Functions) | `auth.oxy.so` | Push to `main` -> `deploy-cloudflare.yml` |
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

1. Authenticate to AWS using **GitHub OIDC** (no static AWS keys in repo secrets) -> assume the IAM role `oxy-github-deploy`.
2. `docker buildx build --platform linux/arm64 ...` against the API Dockerfile.
3. Push the resulting image to ECR (`237343248947.dkr.ecr.us-west-2.amazonaws.com/oxy/oxy-api`).
4. `aws ecs update-service --cluster oxy-cluster --service oxy-api --force-new-deployment` -- ECS pulls the new image, drains old tasks behind the ALB and replaces them.

Task definitions are versioned (`oxy-oxy-api:N`). New revisions are registered with `aws ecs register-task-definition` when env / secret mappings change; image-only updates reuse the existing task definition.

### Runtime secrets live only in SSM

The API's runtime secrets (`DATABASE_URL`, `ACCESS_TOKEN_SECRET`, `REFRESH_TOKEN_SECRET`, `DEVICE_ID_SALT`, the signing keys, …) live ONLY in SSM Parameter Store under `/oxy/oxy-api/*` (SecureString). Shared parameters (`REDIS_URL`, `QUEUE_REDIS_URL`, the `AWS_*` access-key variables) live under `/oxy/_shared/*` and are owned by oxy-infra. The ECS task definition reads them at task start; the deploy workflow writes none and reads no repo secret (`scripts/check-deploy-secrets-sync.mjs` fails CI otherwise).

Setting or rotating a value is `aws ssm put-parameter --type SecureString --overwrite --name /oxy/oxy-api/<NAME>` by its owner, then a rollout (oxy-infra `docs/runbooks/46-app-secrets-in-ssm.md`). A NEW secret: write the parameter FIRST, then bind it in the task definition — a task naming a parameter that does not exist cannot start. Until 2026-10-10 the deploy copied GitHub repo secrets into SSM on every run; that path is gone.

GitHub holds only what CI itself spends: `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID` (Cloudflare deploys and DNS), `NPM_TOKEN` (package releases), `ADD_TO_PROJECT_TOKEN` (roadmap automation) and `CREDENTIAL_OUTPUT_ENCRYPTION_KEY` (encrypts `provision-service-credential.yml`'s output).

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
| `oxy-auth` | `packages/auth/` | Builds the Vite SPA as **pure-static output** — the device-account chooser runs in the device-first SDK (`useDeviceSwitcher`), so the former `/api/device-accounts` Cloudflare Pages Function was deleted in the 2c cutover. The workflow deploys via a direct `bunx wrangler@4 pages deploy` `run:` step (NOT `cloudflare/wrangler-action`, whose default `npx` path trips npm's override-conflict check against the repo-root `@oxy.so/bloom` override). A post-deploy smoke gate (`scripts/smoke-idp.ts`) re-checks the live host. Live-verified working. |
| `oxy-accounts` | `packages/accounts/` | Expo Web export -> Cloudflare Pages |
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
