# Infrastructure

All Oxy production infrastructure runs on **AWS** in the **us-west-2 (Oregon)** region in the production AWS account. Infrastructure-as-code lives in the `oxy-infra` repo (Terraform; state in a private S3 backend).

## Resources Overview

| Resource | Type | Identifier | Region | Purpose |
|----------|------|------------|--------|---------|
| `oxy-cluster` | ECS Fargate cluster | — | us-west-2 | Runs all 6 backend services as Fargate tasks (linux/arm64) |
| `oxy-alb` | Application Load Balancer | `<alb-dns-name>` | us-west-2 | HTTPS termination (ACM multi-SAN cert) + path/host routing to ECS services |
| `oxy-valkey` | ElastiCache (Valkey) | — | us-west-2 | Rate limiting + Socket.IO adapter |
| `oxy-postgres` | RDS (PostgreSQL 17) | — | us-west-2 | The API serves from the `oxy_api` database. Shared instance — other Oxy apps sit in their own databases on it |
| `<terraform-state-bucket>` | S3 bucket | — | us-west-2 | Terraform remote state |
| ECR repos | `237343248947.dkr.ecr.us-west-2.amazonaws.com/oxy/<app>` | one per service | us-west-2 | linux/arm64 images for each backend |
| `oxy-github-deploy` | IAM role | — | — | Trust policy for GitHub OIDC; no static AWS keys in GitHub |
| SES | — | — | us-west-2 | Outbound email |
| Cloudflare Pages | — | — | — | Static frontends (accounts, auth, console, inbox, os, syra, allo) |

### Services running on `oxy-cluster`

| Service | Container port | Hostnames (via ALB) |
|---------|----------------|---------------------|
| `oxy-api` | 8080 | `api.oxy.so`, `api.website.oxy.so`, `website-api.oxy.so` |
| `mention` | 3000 | `api.mention.earth` |
| `alia` | 3001 | `api.alia.onl` |
| `homiio` | 4000 | `api.homiio.com` |
| `syra` | 3000 | `api.syra.oxy.so` |
| `allo` | 8080 | `api.allo.oxy.so` |

All tasks run `assign_public_ip=true` so there is no NAT gateway in the path.

### Static frontends (Cloudflare Pages)

| Project | Hostnames |
|---------|-----------|
| `oxy-accounts` | accounts.oxy.so |
| `oxy-auth` | auth.oxy.so (third-party OAuth authorize/consent IdP — pure-static Vite SPA; the device-account chooser runs in the device-first SDK, so there is no Pages Function) |
| `oxy-inbox` | inbox.oxy.so — deployed from [OxyHQ/Inbox](https://github.com/OxyHQ/Inbox) |
| `oxy-console` | console.oxy.so |

## Networking

- ALB listener on `:443` terminates TLS with the ACM multi-SAN cert (DNS-validated through the Cloudflare API). HTTP `:80` redirects to `:443`.
- ALB target groups route by `Host:` header to the matching ECS service.
- Cloudflare DNS is **DNS-only** (grey cloud) for the API hostnames so the ALB sees real client IPs and ACM can complete DNS-01 validation.
- ECS tasks talk to ElastiCache and the RDS instance over the default VPC inside `us-west-2`.
- Security group on the RDS instance allows `:5432` only from the ECS task ENIs and from the ops bastion path (SSM Session Manager — no SSH key on disk).

## Database: PostgreSQL (RDS `oxy-postgres`)

The API's data lives in the `oxy_api` database on the shared `oxy-postgres` RDS instance. It is reached through one `DATABASE_URL` — a single connection string carrying the database name, so there is no per-app database selection at connect time.

Schema is owned by Drizzle: `packages/api/src/db/schema/` declares it, `drizzle/` holds the generated migrations, and `bun run db:migrate` applies them. `packages/api/src/db/MIGRATION-CONTRACT.md` records the invariants the schema must hold.

Instance sizing, storage headroom, parameter groups, backup/restore and the tenancy question (which apps share the instance) are owned by `oxy-infra` — see `~/Oxy/oxy-infra/terraform-uswest2/postgres.tf` and `~/Oxy/oxy-infra/docs/postgres-shared-instance-capacity.md`. Deliberately not restated here: this document went stale once by duplicating infrastructure detail it does not own.

## Cache: ElastiCache Valkey (`oxy-valkey`)

See [Redis & Valkey](REDIS.md) for the rate-limiter and Socket.IO adapter wiring. Connection string is published via SSM as a shared parameter (the shared Redis URL parameter) and injected into every ECS task.

## Secrets

GitHub Actions repo secrets are the **source of truth**. The deploy workflow (`.github/workflows/deploy-aws.yml`) syncs them into SSM Parameter Store under the per-app parameter namespace and the shared parameter namespace on every run. ECS task definitions inject the SSM parameters at task launch.

Shared parameters (the shared parameter namespace) include AWS access-key variables (for app-level S3/SES access where IAM roles aren't used), shared runtime variables.

> Never commit secret values to git. Never put secret values in this document.

## Architecture Diagram

```
                          Internet
                              |
                              v
                +-------------+--------------+
                |  Cloudflare DNS (DNS only) |
                +-------------+--------------+
                              |
        +---------------------+---------------------+
        |                                           |
        v                                           v
+-------+--------+                       +----------+----------+
| Cloudflare    |                        |  ALB (oxy-alb)      |
| Pages         |                        |  ACM HTTPS          |
| (frontends:   |                        +----------+----------+
|  accounts,    |                                   |
|  auth, inbox, |                  Host-based routing per service
|  console)     |                                   |
+---------------+                                   v
                                       +------------+------------+
                                       |  ECS Fargate cluster    |
                                       |  oxy-cluster (arm64)    |
                                       |                         |
                                       |  oxy-api  mention  alia |
                                       |  homiio   syra    allo  |
                                       +-----+-------+-----+-----+
                                             |       |     |
                                             v       v     v
                                   +---------+----+ +-+---+----------+
                                   | ElastiCache  | |  RDS           |
                                   |  Valkey      | |  PostgreSQL 17 |
                                   |  oxy-valkey  | |  oxy-postgres  |
                                   +--------------+ +----------------+
```
