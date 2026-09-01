# OxyHQServices — Platform Documentation

Comprehensive developer documentation for the Oxy platform: the identity
provider, the SDK, the "Oxy ID" self-sovereign identity + civic layer, and the
decentralization (user data nodes) layer.

---

## What Oxy is, on one screen

OxyHQServices (`@oxyhq/sdk`) is the platform layer for the whole Oxy ecosystem. It
is four things in one Bun-workspaces monorepo:

1. **An API + a device-first, zero-cookie session model.** `api.oxy.so` owns
   the server-side `DeviceSession` authority (which accounts are signed in on
   a device, which one is active), addressed by a `deviceId` + `deviceSecret`
   the client persists first-party (no cookies, no refresh-token family).
   Every web/native app restores its session through the shared SDK's
   device-first cold boot and stays in sync across apps via the
   `session_state` socket event. `auth.oxy.so` is the third-party OAuth
   authorize/consent IdP — it is not a relying party and not the session
   authority.

2. **A client SDK.** `@oxyhq/core` (platform-agnostic client, `SessionClient`,
   `/server` middleware), `@oxyhq/services` (the single UI SDK — `OxyProvider`
   on web and Expo/RN), `@oxyhq/contracts` (Zod API contracts), and
   `@oxyhq/protocol` (signed-record/crypto substrate). Every Oxy app
   (Mention, Allo, Homiio, Syra, accounts, console, inbox) consumes these for
   auth, profiles, payments, and media — zero per-app session code.

3. **Oxy ID — self-sovereign identity.** Account-anchored `did:web` documents,
   cryptographically signed records on a per-user hash chain, verifiable
   credentials, proof-of-personhood, and signed data export. Surfaced through the
   native-only **Commons by Oxy** vault app.

4. **Decentralization — user data nodes.** A user can run their own
   `@oxyhq/node` server that *owns* their signed records; Oxy keeps a fast,
   always-available read copy and re-verifies everything it ingests. Reads never
   touch a node.

The unifying thesis: **ownership comes from cryptography, not from Oxy granting
it.** A record signed in Commons verifies identically on Oxy, on a personal node,
and in any third-party verifier — using the exact same `@oxyhq/core` code.

---

## Table of contents (this doc set)

| Doc | What it covers |
|---|---|
| [architecture/overview.md](architecture/overview.md) | Monorepo packages, dependency graph, build order, package boundaries, end-to-end request flow |
| [auth/README.md](auth/README.md) | Auth & session entry point: device-first model, sign-in surfaces, the IdP's role |
| [auth/device-session.md](auth/device-session.md) | DeviceSession API (`/session/device/*`), `session_state` socket sync, multi-account switching, `SessionClient` |
| [auth/integration-guide.md](auth/integration-guide.md) | "Sign in with Oxy" for third-party apps: Console registration, OAuth 2.0 + PKCE (SPA / server / native), `OxySignInButton`, consent, grant revocation |
| [identity/README.md](identity/README.md) | `did:web` documents (custodial ↔ self-sovereign), signed records (envelope v2, hash chain, `verifyEnvelope`), signed export, domain verification, "Sign in with Oxy" |
| [reputation/README.md](reputation/README.md) | Oxy Trust ledger (tiers/influence), crypto-owned reputation, F2 real-life attestation + validator jury, F3 proof-of-personhood, F4 verifiable credentials |
| [nodes/README.md](nodes/README.md) | The data-node model, `@oxyhq/node` server, registration, Oxy→node export, node→Oxy ingest (verify/LWW/fork/counter-sign), managed vault |
| [inference/README.md](inference/README.md) | The inference platform: credentials, attribution, the model catalogue, exact billing, migrations — **and, in one place, what is not built yet and what tracks it** |
| [inference/request-routing.md](inference/request-routing.md) | The canonical Kaana/Alia/Oxy boundary, product request paths, provider-key custody and cutover gates |
| [runbooks/README.md](runbooks/README.md) | Rotation and break-glass procedures for every credential Oxy issues — trigger, commands, how to verify the write took, rollback, and what to do when the normal path is unavailable. The AWS half stays in `oxy-infra`. |
| [architecture/oxy-auth-platform.md](architecture/oxy-auth-platform.md) | The auth platform master plan (phases, decisions, target architecture) |
| [CHANGELOG.md](CHANGELOG.md) | Chronological "what changed and why" for the whole F0→F5 + Oxy ID rename + Commons/Reputation UI initiative, with commit SHAs |

### Reading paths

- **New to the platform?** Start with [architecture/overview.md](architecture/overview.md),
  then [auth/README.md](auth/README.md).
- **Integrating auth into an Oxy app?** [auth/README.md](auth/README.md) +
  [auth/device-session.md](auth/device-session.md) — RPs mount `OxyProvider`
  with a registered `clientId` and are otherwise zero-config.
- **Integrating "Sign in with Oxy" into a third-party app?**
  [auth/integration-guide.md](auth/integration-guide.md) is the copy-paste
  OAuth + PKCE walkthrough.
- **Building against Oxy inference?** Start at
  [inference/request-routing.md](inference/request-routing.md), then read
  [inference/README.md](inference/README.md) for the control-plane mechanisms
  and rollout gates. Production reachability is live state and must be checked,
  not inferred from either document.
- **Working on Oxy ID / Commons / civic features?** Read
  [identity/README.md](identity/README.md) → [reputation/README.md](reputation/README.md)
  → [nodes/README.md](nodes/README.md), in that order — each builds on the prior.
- **Want the history?** [CHANGELOG.md](CHANGELOG.md) maps every phase to its
  commits.

---

## Reference docs (existing, deployment/ops focused)

These pre-existing documents cover infrastructure, email, and platform-specific
topics and remain authoritative for their areas:

- [ARCHITECTURE.md](ARCHITECTURE.md) — system architecture: identity vs auth, device-first sessions, DB schema
- [AUTHENTICATION.md](AUTHENTICATION.md) — auth integration guide (Expo, Web, Node, WebSockets)
- [SESSION-ARCHITECTURE.md](SESSION-ARCHITECTURE.md) — session architecture in depth
- [SERVICE_TOKENS.md](SERVICE_TOKENS.md) — service-to-service auth (OAuth2 client credentials)
- [INFRASTRUCTURE.md](INFRASTRUCTURE.md) — AWS resources (ECS, ALB, ECR, ElastiCache, RDS PostgreSQL)
- [DEPLOYMENT.md](DEPLOYMENT.md) — GitHub OIDC, ECS Fargate, env vars, Cloudflare Pages
- [REDIS.md](REDIS.md) — ElastiCache Valkey: rate limiting, Socket.IO adapter, caching

---

## Engineering notes (moved out of `AGENTS.md`)

`AGENTS.md` carries only rules — the things that break silently if you get them
wrong — and is bounded at 12 KB by `scripts/check-agents-md-size.mjs`. The
mechanisms it used to restate live here:

- [engineering/package-rules.md](engineering/package-rules.md) — the evidence behind every package boundary, build and runtime rule: the ambient-shim incident, the Hermes verification, the optional-peer resolver asymmetry
- [engineering/build-and-deploy.md](engineering/build-and-deploy.md) — AWS, the inbound email path, containers and the Dockerfile gotcha, the workspace and dependency graph, contract-first schemas, key entry points, published version notes
- [engineering/auth-and-identity.md](engineering/auth-and-identity.md) — the session contract, the application model, service tokens, the SSI layer, Sign in with Oxy, the Auth app
- [engineering/platform-features.md](engineering/platform-features.md) — workspaces, Oxy Trust, rate limiting, federation, OTA updates, contact discovery, the accounts and commons apps, civic identity, the no-IP invariant
- [engineering/sdk-patterns.md](engineering/sdk-patterns.md) — `HttpService`, the offline queue, persistence, `useSessionSocket`, the bottom-sheet and media patterns, `KeyManager` safety
- [engineering/local-dev-cursor-cloud.md](engineering/local-dev-cursor-cloud.md) — local infra, building shared libs, the end-to-end auth smoke test
- [engineering/measurement-traps.md](engineering/measurement-traps.md) — checks that run clean while measuring the wrong thing: what `origin/main..HEAD` actually compares, why `--theirs` is inverted during a rebase, and why a transforming query schema must parse its own output

---

## Audits (dated snapshots — provenance, not mechanism)

An audit records what was true at ONE commit, with `path:line` evidence. It is
never the mechanism doc: when it and the code disagree, the code is right and the
audit has aged. Each file names its commit in its own header.

- [audits/2026-08-15-account-and-application-ownership.md](audits/2026-08-15-account-and-application-ownership.md)
  — inference/billing attribution, `Application.ownerAccountId`, account-graph
  permissions and Console account switching, at `215b12fe` (OxyHQ/oxy#972
  workstream 1)
- [EMAIL.md](EMAIL.md) — native email (`username@oxy.so`), DKIM/SPF/DMARC, inbound webhook

For the authoritative rules and version matrix, see the repo
[`AGENTS.md`](../AGENTS.md).

---

## License

MIT (c) OxyHQ
