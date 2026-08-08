# Infrastructure

All Oxy production infrastructure runs on **AWS** in the **us-west-2 (Oregon)** region in the production AWS account. Terraform IaC lives in the `oxy-infra` repo (state in a private S3 backend).

## Resources Overview

| Resource | Type | Identifier | Region | Purpose |
|----------|------|------------|--------|---------|
| `oxy-cluster` | ECS Fargate cluster | — | us-west-2 | All 6 backend services as Fargate tasks (linux/arm64) |
| `oxy-alb` | Application Load Balancer | `<alb-dns-name>` | us-west-2 | HTTPS termination (ACM multi-SAN cert) + host-based routing |
| `oxy-valkey` | ElastiCache (Valkey) | — | us-west-2 | Rate limiting + Socket.IO adapter |
| `oxy-postgres` | RDS (PostgreSQL 17) | — | us-west-2 | The API serves from the `oxy_api` database. Shared instance — other Oxy apps sit in their own databases on it |
| `<terraform-state-bucket>` | S3 bucket | — | us-west-2 | Terraform remote state |
| ECR | `237343248947.dkr.ecr.us-west-2.amazonaws.com/oxy/<app>` | one per service | us-west-2 | linux/arm64 images |
| `oxy-github-deploy` | IAM role | — | — | GitHub OIDC trust; no static AWS keys in repo secrets |
| SES | — | — | us-west-2 | Outbound email + inbound via Cloudflare Email Routing |
| Cloudflare Pages | — | — | — | Static frontends (accounts, auth, console, inbox) |

### Backend services on `oxy-cluster`

| Service | Port | Hostnames |
|---------|------|-----------|
| `oxy-api` | 8080 | `api.oxy.so`, `api.website.oxy.so`, `website-api.oxy.so` |
| `mention` | 3000 | `api.mention.earth` |
| `alia` | 3001 | `api.alia.onl` |
| `homiio` | 4000 | `api.homiio.com` |
| `syra` | 3000 | `api.syra.oxy.so` |
| `allo` | 8080 | `api.allo.oxy.so` |

All tasks run with `assign_public_ip = true` (no NAT gateway).

### Non-AWS resources (intentional exclusions)

| Resource | Where | Why |
|----------|-------|-----|
| LiveKit | external managed host | Migration to AWS pending |
| Athina, FairCoin, TNP, OpenSearch (`genai-shark`) | DigitalOcean | Outside the Oxy ecosystem migration scope |

## Networking

- ALB listener on `:443` terminates TLS using an ACM multi-SAN certificate (DNS-validated via the Cloudflare API).
- HTTP `:80` redirects to `:443`.
- ALB target groups route by `Host:` header to the matching ECS service.
- Cloudflare DNS is **DNS-only** (grey cloud) for all API hostnames so the ALB sees real client IPs and ACM can complete DNS-01 validation.
- ECS tasks reach ElastiCache and the RDS instance over the default VPC.
- The RDS security group accepts `:5432` only from the ECS task ENIs (security-group-to-security-group rule). Ops access uses AWS SSM Session Manager — there are no SSH keys on disk.

## Database: PostgreSQL (RDS `oxy-postgres`)

The API serves from the `oxy_api` database on the shared `oxy-postgres` RDS instance, reached through a single `DATABASE_URL` that carries the database name.

Schema is owned by Drizzle: `packages/api/src/db/schema/` declares it, `drizzle/` holds the generated migrations, `bun run db:migrate` applies them, and `packages/api/src/db/MIGRATION-CONTRACT.md` records the invariants it must hold.

Sizing, storage headroom, parameter groups, snapshots and restore belong to `oxy-infra` (`terraform-uswest2/postgres.tf`, `docs/postgres-shared-instance-capacity.md`) and are deliberately not restated here — duplicating them is how this page went stale before.

## Cache: ElastiCache Valkey

See [[Redis & Valkey]] for client wiring. Connection URL lives in SSM as a shared parameter (the shared Redis URL parameter) and is injected into every ECS task definition.

## Secrets

GitHub Actions repo secrets are the **source of truth**. `.github/workflows/deploy-aws.yml` mirrors them to AWS SSM under the per-app parameter namespace and the shared parameter namespace on every run. ECS task definitions reference SSM parameters via `secrets` mappings, so the container only ever sees the resolved value at task launch.

The shared parameter namespace covers AWS access-key variables (for SES / app-level S3 usage where IAM roles aren't applied), shared runtime variables.

> Never commit secret values. Never put secret values in this wiki.

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
