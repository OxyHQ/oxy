# OxyHQ Services

Monorepo for the Oxy platform — authentication, user management, real-time features, and client SDKs.

## Quick Links

| Page | Description |
|------|-------------|
| [[Architecture]] | Monorepo structure, packages, dependency graph |
| [[Infrastructure]] | AWS resources (ECS, ALB, ECR, ElastiCache, RDS PostgreSQL) |
| [[Deployment]] | GitHub OIDC, ECS Fargate, env vars, Cloudflare Pages |
| [[Authentication]] | JWT flow, device sessions, session validation, CSRF protection |
| [[Service Tokens]] | Internal service-to-service auth (OAuth2 Client Credentials) |
| [[Redis & Valkey]] | ElastiCache Valkey: rate limiting, Socket.IO adapter, caching strategy |

## Packages

| Package | npm | Description |
|---------|-----|-------------|
| `packages/contracts/` | `@oxyhq/contracts` | Contract-first API schemas (Zod, zero React/RN) |
| `packages/protocol/` | `@oxyhq/protocol` | Signed-record envelope, canonical JSON, platform crypto |
| `packages/core/` | `@oxyhq/core` | Platform-agnostic foundation (zero React/RN deps) |
| `packages/services/` | `@oxyhq/services` | The single UI SDK — Expo, React Native, and web (RN Web) |
| `packages/api/` | `@oxyhq/api` | Express.js backend API |
| `packages/node/` | `@oxyhq/node` | Self-hostable personal data node |
| `packages/auth/` | — | auth.oxy.so — OAuth authorize/consent IdP (Vite + RN Web) |
| `packages/accounts/` | — | Accounts by Oxy (management-only Expo app) |
| `packages/commons/` | — | Commons by Oxy (native-only identity vault) |
| `packages/console/` | — | Developer console (Application registry) |
| `packages/test-app-expo/` | — | Expo test/playground app |

## Build commands

```bash
bun run core:build       # Build @oxyhq/core
bun run services:build   # Build @oxyhq/services
bun run build:all        # Build all (turbo; order: contracts -> protocol -> core -> services -> rest)
bun run test             # Run all workspace tests (each package's own runner)
bun install              # Install all workspace deps
```

Build order matters and is derived by turbo from the dependency graph: `contracts` -> `protocol` -> `core` -> `services` -> everything else.

## Live URLs

| Service | URL | Hosted on |
|---------|-----|-----------|
| API | `https://api.oxy.so` | AWS ECS Fargate (us-west-2) |
| Auth (OAuth IdP) | `https://auth.oxy.so` | Cloudflare Pages |
| Accounts | `https://accounts.oxy.so` | Cloudflare Pages |
| Inbox | `https://inbox.oxy.so` | Cloudflare Pages, from [OxyHQ/Inbox](https://github.com/OxyHQ/Inbox) |
| Console | `https://console.oxy.so` | Cloudflare Pages |
| Mention API | `https://api.mention.earth` | AWS ECS Fargate (us-west-2) |
| Homiio API | `https://api.homiio.com` | AWS ECS Fargate (us-west-2) |
| Alia API | `https://api.alia.onl` | AWS ECS Fargate (us-west-2) |
| Syra API | `https://api.syra.oxy.so` | AWS ECS Fargate (us-west-2) |
| Allo API | `https://api.allo.oxy.so` | AWS ECS Fargate (us-west-2) |
