# AGENTS.md

## AWS Deployment

The backend (`oxy-api`) runs on **AWS ECS Fargate** (region `us-west-2`, cluster `oxy-cluster`), behind an ALB with ACM HTTPS.

- **Port**: `8080` | **Domain**: `api.oxy.so` (also serves `api.website.oxy.so` / `website-api.oxy.so` for the oxy.so/fairco.in website API; outbound email via SES, inbound via Cloudflare Email Routing → Worker `email-inbound` → `POST /email/inbound`)
- **Deploy**: `git push origin main` → `.github/workflows/deploy-aws.yml` builds a `linux/arm64` Docker image → pushes to ECR (`237343248947.dkr.ecr.us-west-2.amazonaws.com/oxy/oxy-api`) → `aws ecs update-service --force-new-deployment`
- **Auth**: GitHub OIDC → role `oxy-github-deploy`. No AWS keys stored in GitHub.
- **Secrets**: GitHub Actions secrets are the source of truth. The deploy workflow syncs them to AWS SSM (`/oxy/oxy-api/*`; shared secrets to `/oxy/_shared/*`); ECS injects them into the container. To change a secret: edit it in GitHub — the next deploy applies it.
- **Empty/placeholder secret guard**: `.github/workflows/deploy-aws.yml` SKIPS syncing any secret whose value is empty or literally `-`. This is defense-in-depth after an incident (commit `641cea67`) where a `REDIS_URL=-` placeholder was synced and crash-looped `oxy-api` with `getaddrinfo ENOTFOUND -` from `ioredis`. **NEVER register a GitHub secret with a placeholder value (`-`, empty, `TODO`, etc.). If you don't have the real value yet, don't create the secret yet.**
- **SSM path convention**: per-app secrets → `/oxy/<app>/<KEY>`; shared infra (`REDIS_URL`, `AWS_*`, `LIVEKIT_*`) → `/oxy/_shared/<KEY>`. ECS task definitions reference these paths directly.
- **Dockerfile**: must build for `linux/arm64` (Graviton).
- **WARNING**: Never put secret values in this file.

## Inbound Email Path (Cloudflare → Worker → API)

Inbound mail for `*@oxy.so` is delivered as follows:

1. **MX** records for `oxy.so` point at Cloudflare Email Routing (`route1/2/3.mx.cloudflare.net`).
2. Cloudflare Email Routing has a **catch-all rule → Worker `email-inbound`** (source: `workers/email-inbound/`, zone `oxy.so` = `7f70358609578c4a1f24dbf6cb9c4498`).
3. The Worker POSTs the raw RFC 5322 message to `${API_URL}/email/inbound` with `Authorization: Bearer ${EMAIL_INBOUND_WEBHOOK_SECRET}` and `X-Envelope-From` / `X-Envelope-To` headers.
4. The API route `packages/api/src/routes/emailInbound.ts` (mounted at `/email/inbound` BEFORE `/email`, with a raw body parser registered in `server.ts:95`) parses MIME, validates recipients, spam-checks, and stores into Postgres via `emailService.storeIncomingMessage`.
5. Inbox UI at `inbox.oxy.so` reads `GET /email/mailboxes` + `GET /email/messages`.

**Critical config invariants** — if any drifts, inbound mail silently disappears:
- Worker var `API_URL` MUST equal `https://api.oxy.so` (NOT `mail.oxy.so` — that hostname still resolves to the retired DigitalOcean droplet `159.223.227.58` and returns 502).
- Worker secret `EMAIL_INBOUND_WEBHOOK_SECRET` MUST equal SSM `/oxy/oxy-api/EMAIL_INBOUND_WEBHOOK_SECRET` (mismatch → API returns 401 → Cloudflare bounces).
- The raw body parser at `server.ts:95` MUST be registered BEFORE the global `express.json()` middleware (otherwise the JSON parser eats the RFC822 stream and `simpleParser` gets an empty Buffer).
- `app.use('/email/inbound', emailInboundRoutes)` MUST be registered BEFORE `app.use('/email', ...)` in `server.ts` (otherwise the protected `/email` mount catches the unauthenticated webhook first).

**Worker deploy (when bindings drift):**
```bash
cd workers/email-inbound
export CLOUDFLARE_API_TOKEN=$(cat ~/.config/oxy/cloudflare.token)
export CLOUDFLARE_ACCOUNT_ID=$(aws --profile oxy --region us-west-2 ssm get-parameter --name /oxy/oxy-api/CLOUDFLARE_ACCOUNT_ID --with-decryption --query 'Parameter.Value' --output text)
./node_modules/.bin/wrangler deploy
aws --profile oxy --region us-west-2 ssm get-parameter --name /oxy/oxy-api/EMAIL_INBOUND_WEBHOOK_SECRET --with-decryption --query 'Parameter.Value' --output text \
  | ./node_modules/.bin/wrangler secret put EMAIL_INBOUND_WEBHOOK_SECRET
```

**Verify health:**
```bash
# 1. Confirm Worker bindings
curl -s -H "Authorization: Bearer $(cat ~/.config/oxy/cloudflare.token)" \
  "https://api.cloudflare.com/client/v4/accounts/<ACCOUNT_ID>/workers/scripts/email-inbound/settings" \
  | jq '.result.bindings'   # API_URL must be https://api.oxy.so

# 2. Confirm endpoint mounted (expect 401 = good, 404 = route gone, 500 = secret missing)
curl -s -o /dev/null -w "%{http_code}\n" -X POST https://api.oxy.so/email/inbound

# 3. CloudWatch (log group is /oxy/ecs, NOT /ecs/oxy-api)
aws --profile oxy --region us-west-2 logs tail /oxy/ecs --log-stream-name-prefix oxy-api --since 1h \
  | grep -iE 'inbound|envelope|delivered'
```

**Migration cleanup (2026-06-12):** ✅ DigitalOcean fully removed from the inbox path.
- SPF for `oxy.so` now reads `v=spf1 include:amazonses.com include:_spf.mx.cloudflare.net ~all`.
- DNS A record `mail.oxy.so` (→ `159.223.227.58`) deleted.
- Worker `email-inbound` redeployed with `API_URL=https://api.oxy.so` (ECS).
- Outbound: SES via `SMTP_RELAY_HOST` only. nodemailer v8 removed the legacy `{ direct: true }` MX path — `smtp.outbound.ts` now fails fast if `SMTP_RELAY_HOST` is unset.

## Containers (oxy-api Docker / ECS one-shot tasks)

The `oxy-api` Dockerfile uses Bun 1.3's **isolated linker** (default). Dependencies do NOT live at `/app/node_modules/<pkg>` — they live at:

```
/app/node_modules/.bun/<pkg>@<version>+<hash>/node_modules/<pkg>
```

This breaks naive `require('<pkg>')` from a `node -e` one-liner inside the container. To resolve, either:

- Run via a script file that lives inside the package's own resolution graph (where Node's normal resolution works), OR
- Use an **absolute path** to the isolated location.

**Cleaning Redis from a dev laptop**: the Valkey/Redis security group only accepts traffic from ECS task security groups, so you cannot connect from a laptop. Instead, run a one-shot Fargate task that overrides the container `command` to execute an inline cleanup. Example:

```bash
aws --profile oxy --region us-west-2 ecs run-task \
  --cluster oxy-cluster --task-definition oxy-oxy-api --launch-type FARGATE \
  --network-configuration 'awsvpcConfiguration={subnets=[subnet-08f5cc132b3cab15c,subnet-0bfb367f29d1fd375],securityGroups=[sg-0f0ca416eacab578c],assignPublicIp=ENABLED}' \
  --overrides '{"containerOverrides":[{"name":"oxy-api","command":["sh","-c","node -e \"const Redis=require('"'"'/app/node_modules/.bun/ioredis@5.11.1+f89edaf472774726/node_modules/ioredis'"'"');/* ... */\""]}]}'
```

Look up the exact `.bun/<pkg>@<ver>+<hash>/` directory in the running image (it changes on every install) before invoking. The full path is required because the inline `-e` script is not inside any package's resolution graph.

**GOTCHA — oxy-api Dockerfile: do NOT switch to a full-workspace frozen-lockfile install (PR #261):** The Dockerfile intentionally installs only the lean `core+contracts+api` workspace subset (workspaces-narrowing `node -e` + `bun install`). A full-workspace `bun install --frozen-lockfile` pulls `esbuild` (a frontend-only dep) whose arm64/alpine postinstall hard-fails with `Expected "0.27.2" but got "0.25.12"`, breaking the prod Docker build. A proper fix requires a SCOPED frozen install (`--filter` the api/core/contracts closure so `esbuild` is never materialized) or a single-esbuild-version root override, validated on a real arm64 build. Do NOT apply a naive full-workspace frozen install to the API Dockerfile.

## Commands

```bash
bun run core:build               # Build @oxyhq/core
bun run services:build           # Build @oxyhq/services
bun run build:all                # Build all (order: contracts -> core -> services -> rest)
bun run test                     # Run all workspace tests (Jest via turbo — see note below)
bun run dev                      # Dev mode across workspaces
bun install                      # Install all workspace deps
```

**Shared dependency versions live in `workspaces.catalog` (root `package.json`), not in the manifests.** A package shared by two or more workspaces is declared there once and referenced as `"catalog:"` everywhere it is used, root `overrides` included — an override reading `"catalog:"` still rewrites transitive resolutions. Bumping one is a single edit plus `bun install`. A package with a range that legitimately differs per workspace (`packages/core` and `packages/protocol` target Expo SDK 56 while the apps are on 57) stays literal, because a catalog entry would be asserting an agreement that does not exist.

This is safe for PUBLISHED packages only because of `scripts/assert-bun-publish.mjs`: `bun pm pack` substitutes a `catalog:` reference to the catalog's own range, while `npm pack` ships the literal string `catalog:`, which no consumer can resolve — the exact failure that broke `@oxyhq/core@12.10.1` with `workspace:`, one protocol later. Verified on the real `@oxyhq/core` and `@oxyhq/services` tarballs.

**`bun install` refuses to RESOLVE a dependency published in the last week** (`minimumReleaseAge` in `bunfig.toml`), where a compromised release is most likely to still be live. Resolution only — a frozen install is never affected, cold cache included. Anything that re-resolves must opt out, which is why `scripts/check-lockfile-sync.mjs` passes `--minimum-release-age=0`; without it a dependency published this week fails that check for a week with nothing actually wrong. Excludes match EXACT names (a `"@oxyhq/*"` glob parses and silently matches nothing), and only registry-sourced first-party packages need listing — the `@oxyhq/*` packages built here are workspaces.

**Test runners — per-package split (CRITICAL):**
- `@oxyhq/api`, `@oxyhq/core`, `@oxyhq/services`, `@oxyhq/contracts`, and the `commons` app use **Jest** (ts-jest / jest-expo). Their `test` script invokes `jest`.
- `packages/auth` (the standalone Vite IdP app) uses **Bun's native `bun test`** — configured via `packages/auth/bunfig.toml` (`[test] preload`), NOT jest. Its `test` script is `bun test lib/__tests__ components/__tests__` (the earlier `server/__tests__` suite no longer exists — do not reference it).
- THE RULE: always run each package's OWN `bun run test` script, which dispatches to the correct runner. At the monorepo root, `bun run test` delegates through turbo and is safe. NEVER blanket-invoke `bun test` across the monorepo — it runs Bun's native runner over the Jest packages, producing dozens of false failures in core and api (`jest.resetModules`, `jest.advanceTimersByTimeAsync`, and other Jest APIs are unavailable under Bun's runner). Do NOT assume all packages are Jest — the auth app (`packages/auth`) is bun-test.
- Per-package baselines, as last verified 2026-07-19 (when run under the correct runner): contracts **147**, core **1052**, api **1808**, services **305**, auth IdP **59**, commons **411**. These drift as suites grow — re-verify with each package's own `bun run test` rather than trusting a number here that's gone stale.

## Architecture

Monorepo (`@oxyhq/sdk`) using Bun workspaces + Turbo. Build order matters: `contracts` -> `core` -> `services` -> rest (turbo derives this from the dependency graph). **`@oxyhq/services` is the single UI SDK for web AND native** (RN Web on web) — the former standalone web SDK package was deleted from the monorepo; do not recreate it.

```
packages/
  contracts/      @oxyhq/contracts  Contract-first API schemas (Zod) — zero React/RN/Expo
  protocol/       @oxyhq/protocol   Shared protocol layer
  core/           @oxyhq/core       Platform-agnostic foundation (zero React/RN)
  services/       @oxyhq/services   Expo/React Native SDK — the ONLY UI SDK (web via RN Web + native)
  api/            @oxyhq/api        Express.js backend API
  node/           @oxyhq/node       User-operated data node (signed-records replica)
  federation/     @oxyhq/federation App-agnostic ActivityPub identity + follow engine substrate (connector contract, HTTP signatures, bridge relabelling — see "Federation" below)
  accounts/                         Expo accounts app ("Accounts by Oxy" — keyless, management-only)
  commons/                          Expo identity vault app ("Commons by Oxy" — NATIVE-ONLY, no web build)
  auth/                             Vite IdP app (auth.oxy.so — OAuth authorize/consent on @oxyhq/services, device-first like every app)
  console/                          Developer portal (Vite + @oxyhq/services)
  test-app-expo/                    Expo test/playground app
  expo-splash/    @oxyhq/expo-splash
  app-preset/     @oxyhq/app-preset Shared Expo config plugin + Metro/Babel/CSS/ESLint/tsconfig bases for every Oxy app
  create-oxy-app/ create-oxy-app    `bun create oxy-app` scaffolder — generates the canonical packages/frontend+backend+shared-types monorepo
  ship/           @oxyhq/ship       oxy-ship CLI — publishes Expo OTA updates to the Oxy Updates service
```

**Dependency graph:**
```
@oxyhq/contracts      no internal deps (only zod)
@oxyhq/core           dep: @oxyhq/contracts
@oxyhq/services       dep: @oxyhq/core + @oxyhq/contracts
@oxyhq/api            dep: @oxyhq/contracts + @oxyhq/core/server for auth middleware
@oxyhq/federation     dep: @oxyhq/core (isomorphic entry has zero Express/Mongo deps; `./node` subpath adds them)
accounts              dep: @oxyhq/core + @oxyhq/services
commons               dep: @oxyhq/core + @oxyhq/services  (NATIVE-ONLY — no web build/CF Pages)
console               dep: @oxyhq/core + @oxyhq/services  (RN Web via Vite)
auth (IdP)            dep: @oxyhq/core + @oxyhq/services  (RN Web via Vite, device-first cold boot)
test-app-expo         dep: @oxyhq/services
```

**Expo native-module version alignment (accounts, commons, test-app-expo):** when `@oxyhq/services`' pinned version of a native module (e.g. `react-native-svg`, `react-native-safe-area-context`, `react-native-keyboard-controller`) diverges from the version the current Expo SDK bundles, align the whole monorepo UP to the higher version and add that package to `expo.install.exclude` in the app's `package.json` — this stops `expo install --fix` / expo-doctor from downgrading it back to the SDK-bundled version. Never let two versions of the same native module coexist across the workspace. `react-native-svg` + `react-native-safe-area-context` are excluded in all three apps; `react-native-keyboard-controller` is additionally excluded in accounts and commons (test-app-expo doesn't depend on it).

## Package Boundaries (strict)

- **@oxyhq/contracts** must never import `react`, `react-native`, or `expo-*`. Only `zod` allowed. Platform-agnostic — both server and client import from it directly.
- **@oxyhq/core** must never import `react`, `react-native`, or `expo-*`. Dynamic imports (`await import(...)`) for optional RN modules are allowed.
- **@oxyhq/services** does NOT re-export from `@oxyhq/core` or `@oxyhq/contracts`. Consumers import core types directly from `@oxyhq/core` and API contract types directly from `@oxyhq/contracts`.
- **A module that names an OPTIONAL peer must never be reachable from the root barrel — give it its own export subpath.** `tsc` resolves the specifier of an `import()` even when the call is lazy and wrapped in try/catch, so a barrel re-export drags the specifier into EVERY consumer's type graph and turns an optional peer into a hard install requirement (`TS2307`, plus `TS7006` cascades where parameters lose contextual typing). This is resolver-asymmetric and therefore easy to ship unnoticed: web/Vite consumers resolve the package through `lib/**/*.d.ts` and `skipLibCheck: true` hides it, while Metro/RN consumers resolve the `react-native` condition (published `src/`) and fail. Metro itself is fine — an unresolvable DYNAMIC `import()` bundles cleanly and the `catch` handles it at runtime; only a STATIC import fails the Metro build. The push adapter is the worked example: `@oxyhq/services/notifications` (`packages/services/src/notifications/deviceNotifications.ts`), kept out of the barrel by `packages/services/__tests__/notifications/barrelIsolation.test.ts`, which walks the real module graph. Do NOT "fix" this class with an ambient `declare module 'expo-x'` in `src/types/` reached via `/// <reference path>`: an ambient declaration SHADOWS the real package for the whole consumer program, so an app that DID install the module silently loses its real types. (The existing `src/types/expo-*.d.ts` stubs are safe only because nothing `/// <reference>`s them into a consumer's program — they serve this package's own build.)
- **@oxyhq/api** imports schemas directly from `@oxyhq/contracts`. Server auth helpers come from `@oxyhq/core/server` only; do NOT route contracts through `@oxyhq/core` re-exports.

## ESM/CJS Compatibility (critical)

Both `@oxyhq/core` and `@oxyhq/contracts` ship dual CJS + ESM builds. The ESM build **must not contain `require()` calls** — Vite and other ESM-only bundlers will crash.

- **Never** use `require()` in `packages/core/` or `packages/contracts/` source code
- Use `import ... from` for static imports (JSON files, modules)
- Use `await import(moduleName)` for optional/platform-specific modules (e.g. expo-crypto)
- Guard any unavoidable `require()` with `typeof require !== 'undefined'`
- For platform-specific crypto: use `isReactNative()` → expo-crypto, `isNodeJS()` → node crypto, else → Web Crypto API

## Ambient `declare module` shims (core — critical)

**Never hand-write a `declare module '<pkg>'` for a package that ships types or has an `@types/<pkg>`.** An ambient module declaration SHADOWS the resolved types for every program that includes the declaring file — and `packages/core/tsconfig.json` includes it (`include: ["src"]`) while no consumer's tsconfig does. The result is a package that typechecks against a private view of its dependencies: core's own `tsc` passes, and any consumer compiling core SOURCE gets a different, sometimes broken, program.

This is not hypothetical — it took main's whole `packages/api` jest run down (`TS2305: Module '"elliptic"' has no exported member 'ECKeyPair'`, `Tests: 0 total`). api's jest maps `@oxyhq/core` to source, so it compiled `keyManager.ts` under api's tsconfig, where core's `src/types/elliptic.d.ts` was absent and the real `@types/elliptic` (which has no `ECKeyPair`) applied. The symptom looks environmental — one package builds, another cannot compile the same file — so it reads as a version skew or a stale tree and gets chased there first.

Same trap applies to Metro consumers: the `"react-native"` export condition points at published `src/`, so RN apps compile core/services SOURCE too. Babel does not typecheck, which is the only reason those apps do not also break.

- Shims are legitimate ONLY for a dependency with no types at all AND no `@types/` package (`buffer`, `expo-crypto`, `expo-secure-store` — the three left in core). Check both before writing one.
- If a type from a dependency appears in a package's PUBLISHED `.d.ts` (e.g. `KeyManager.getKeyPairObject(): EC.KeyPair`), its `@types/` package belongs in `dependencies`, not `devDependencies` — otherwise it resolves to nothing in the consumer and `skipLibCheck` silently degrades it to `any`.
- Verify a shim is load-bearing by deleting it and running the package's own `tsc`: core's 70-line `elliptic` shim had exactly one line anything used, and its `color` shim was for a package core does not import at all.

## Hermes Unicode Property Escapes (mobile — critical)

Mobile Hermes (RN 0.86, `hermes-v0.17.0`) is built with `HERMES_ENABLE_UNICODE_REGEXP_PROPERTY_ESCAPES` OFF, so it throws `SyntaxError: Invalid RegExp: Invalid property name` at runtime on EVERY `\p{…}`/`\P{…}` atom in a `u`-flag regex — `\p{L}`, `\p{M}`, `\p{Zs}`, `\p{scx=…}`, all of them, not just obscure subcategories. V8 (web) supports them fully, so this NEVER reproduces on web — only on a real native Hermes build. The `u` flag itself and lookbehind `(?<…)` are unaffected; only the `\p{…}` atoms are unsupported.

Why this is especially dangerous for `@oxyhq/core`: core builds with `tsc` (no Babel), so any `\p{…}` in source ships verbatim into `dist/`. A property escape in a MODULE-LOAD-time regex (a top-level literal, or a module-level `new RegExp(…, 'u')`) crashes every consuming RN app at BOOT the instant it imports the core barrel — one bad escape is a whole-ecosystem crash.

**Rule:** never ship a `\p{…}`/`\P{…}` atom in any package that runs on Hermes (core, services, bloom, and every app). Sanctioned fix (since `@oxyhq/core@12.5.4`): transpile property escapes to explicit code-point ranges at BUILD time with **`regexpu-core`** (the same transform Babel's `@babel/plugin-transform-unicode-property-regex` uses) — see `packages/core/scripts/generateDisplayNamePolicyRanges.mjs` → `displayNamePolicyRanges.generated.ts`, regenerated via `bun run generate:display-name-policy`. Call `rewritePattern(pattern, 'u', { unicodePropertyEscapes: 'transform' })` (no `unicodeFlag` option — keeps the `u` flag, rewrites only the `\p{…}` atoms). Keep the readable `\p{scx=…}` as the semantic source; never hand-edit the generated ranges. Shipped `dist/` must contain zero `\p{`. `validationUtils.test.ts` has a Jest regression guard that fails if any shipped policy source contains a property escape — extend it for new policy regexes.

**Verification:** `hermesc` (the desktop compiler) has the FULL Unicode property table and happily accepts `\p{Zl}` at compile time — that proves nothing about the mobile VM, whose on-device `.so` has zero property-name strings compiled in. Confirm on a real foregrounded Hermes build/device, never the compiler alone.

## React Compiler bundling of `@oxyhq/services` (Expo apps)

`@oxyhq/services` SOURCE is React-Compiler-compiled when bundled inside the `commons` and `accounts` Expo apps, even though `@oxyhq/services` itself declares no compiler flag. Those apps set `experiments.reactCompiler: true`, and because `services` is a workspace symlink whose `package.json` exposes `"react-native": "src/index.ts"`, Metro resolves it to the realpath TS source (no `node_modules` path segment) — so Expo's `isNodeModule` compiler gate treats services source as APP source and compiles it. Consequence: `packages/services/src/` must be held to React-Compiler-safe standards (no render-phase side effects/mutations inside `useMemo` or other compiler-memoizable positions; no reading external mutable state out-of-band in render — see the global React Compiler rule in `~/AGENTS.md`). In Allo, `services` resolves as a real `node_modules` directory, so it is excluded from compilation there — but the monorepo's own apps (commons, accounts) are the binding case.

## Import Conventions

```typescript
// Web (Vite + RN Web) AND Expo / React Native — ONE provider for both
import { OxyProvider, useOxy, OxySignInButton, OxyConsentScreen } from '@oxyhq/services';
import { OxyServices, KeyManager } from '@oxyhq/core';
import { generatePkcePair, generateOAuthState, buildOAuthAuthorizeUrl } from '@oxyhq/core';
import type { User, ApiError } from '@oxyhq/core';
```

When splitting imports: use `import type` for type-only imports, regular `import` for values.

## User Identity Contract

- Oxy API owns `name.displayName` for user/profile DTOs. `composeDisplayName` (`packages/api/src/utils/displayName.ts`) returns a real name (explicit displayName or composed first/last) or `undefined` — it does NOT fall back to username, publicKey, or `'Anonymous'`. `formatUserNameResponse` omits `displayName` when there is no real name.
- `@oxyhq/contracts` owns both the formatted user response contract and `UserProfileUpdate`. `@oxyhq/core`, `@oxyhq/services`, and `@oxyhq/api` import those types directly from `@oxyhq/contracts`; do not re-export them through another package.
- `@oxyhq/core` public `User.name.displayName` is **optional** (`string | undefined`). Consumers render `name.displayName` when present; **when absent, fall back to the handle** via `getNormalizedUserHandle` from `@oxyhq/core`. The pattern is `displayName ?? handle` — a single handle fallback. Do NOT rebuild multi-field chains (`displayName || first || username...`). The account-switcher helper `getAccountDisplayName` (local account surfaces only) keeps its own chain.
- **Display name character policy** (`cleanDisplayName`): allows letters (`\p{L}`) + marks (`\p{M}`) + spaces + apostrophe only; strips emoji, symbols, `:shortcode:`, digits, hyphens, dots, AND orphaned combining marks (a mark not attached to a base letter). Native writes reject 400; federated names are stripped on ingest; existing records were backfilled by a one-shot script that has since run in prod and been removed. These `\p{…}` atoms never ship raw to Hermes — see "Hermes Unicode Property Escapes" below.
- **Auth gate relaxation (originally 2026-06-29; the specific FedCM-era `OxyServices.sso.ts`/`sso.controller.ts` files this predated no longer exist post-wave-2):** every current sign-in/session-parsing path (`OxyServices.auth.ts`, the device-secret mint response, `formatUserResponse`) requires a structured `name` object but treats `displayName` within it as optional — never require a non-empty `displayName` string as a session-validity gate. Do NOT re-tighten this.
- Profile handle normalization belongs in `@oxyhq/core` (`packages/core/src/utils/userHandle.ts`). Consumers must use `getNormalizedUserHandle` for local/federated routes instead of local route helpers or manual domain concatenation.

## Auth / Session Contract

**Session transport (device-first — `deviceId` + `deviceSecret`):** every successful sign-in (password, 2FA, QR claim, challenge verify) returns the session's `deviceId` and a rotating 256-bit `deviceSecret`. The client persists BOTH first-party (localStorage per web origin; SecureStore on native) — the server stores only `sha256(deviceSecret)` (`DeviceSession.secretHash`, sparse-unique). To restore or refresh, the client POSTs `{ deviceId, deviceSecret }` to `POST /session/device/token` (NO bearer, NO cookies — possession of the secret is the proof) and gets a short access token plus `nextDeviceSecret` (on mint, the same proven secret echoed back — sign-in rotates the secret with a short grace for the prior hash). There is **NO refresh-token family, NO `#oxy_boot` bootstrap hop, NO device-attribution token** — all deleted in the zero-cookie cutover, and none of them comes back. A `deviceId` is per web origin / per native app-group; there is no implicit cross-subdomain or cross-app device sync. Full mechanism: `docs/auth/index.md` (the entry that is answerable for being right) → `docs/SESSION-ARCHITECTURE.md`. `docs/architecture/oxy-auth-platform.md` is the CLOSED plan record for the 2026-07 project and predates the multi-principal model — read it as history, not as the mechanism.

**The cookie rule, restated (issue #937 Phase 5, ADR 0003 — `docs/adr/0003-browser-device-session-hub.md`).** The zero-cookie cutover wrote one rule over several mechanisms. Exactly one of them is reopened, at exactly one origin:

- **Relying-party origins remain zero-cookie.** Mention, Mercaria, Syra, Console, Accounts, Inbox and every scaffolded app keep `{deviceId, deviceSecret}` + `POST /session/device/token` and set **no cookie of any kind**. Adding one to an RP is still forbidden.
- **`auth.oxy.so` alone holds `__Host-oxy-device`** — host-only (no `Domain`), `Secure`, `HttpOnly`, `SameSite=Lax`, `Path=/` — and only in a **first-party** context. Its value is an **opaque random handle and nothing else**: no token, user id, device id, account id or serialized state. The server stores only `sha256(handle)` (`device_sessions.hub_secret_hash`), rotates on sensitive transitions with a short grace, and clears the whole quadruple on `signout({all:true})`.
- **No refresh-token family and no bootstrap hop return.** The handle is a POINTER to a server-side `DeviceSession`, never a credential the browser can spend against the resource API.
- Still forbidden, unchanged: third-party cookies, hidden/silent iframes, cross-origin `localStorage`, Storage Access API as the mechanism, gesture-less popups, silent `prompt=none` loops, FedCM, automatic redirect chains across Oxy origins.

**Server authority — DeviceSession:** the `DeviceSession` model (collection `devicesessions`: `deviceId`, `accounts[{accountId, sessionId, authuser, operatedByUserId?}]`, `activeAccountId`, `secretHash`, `revision`) is the single source of truth for what is signed in on a device. REST surface: `POST /session/device/token` (the public zero-cookie mint) + `/session/device/{state,add,switch,signout}` (bearer) (`packages/api/src/routes/sessionDevice.ts`). Every mutation bumps `revision` and broadcasts a token-free `session_state` event to Socket.IO room `device:<deviceId>` — all apps on the same device sync instantly. Sockets are **bearer-only** (a signed-out client opens no socket). The client half is `SessionClient` in `@oxyhq/core` (`packages/core/src/session/`). `POST /session/device/token` also accepts an optional `accountId` that PINS the mint to one account of the device's set instead of whichever is currently active — it never mutates `activeAccountId`/`revision` and never broadcasts; a non-member account or one with a dead session answers `account_not_on_device` (deliberately indistinguishable, so a pinned miss is never an account-existence oracle). This exists for `sessionMode: 'identity'` — see below.

Frontend apps (web AND native) use the SDK as the only session authority:
- **ONE provider:** `OxyProvider` from `@oxyhq/services` with a registered `clientId` — on web (RN Web) and on Expo/RN alike. The former standalone web SDK package was deleted from the monorepo; never reintroduce a second provider.
- The SDK's device-first cold boot (`runSessionColdBoot` in `@oxyhq/core`, `packages/core/src/boot/sessionColdBoot.ts`) owns session restore end to end and NEVER auto-redirects to a login page. It is an ordered step chain: `warm-token-plant` (plant a still-valid persisted access token with zero network round-trip) → `device-secret-mint` (web + native — mint from the persisted `deviceId` + `deviceSecret`) → `shared-key-signin` (native — re-mint from the shared Commons keychain), REPLACED by `identity-key-signin` (re-mint from THIS device's primary identity key) in `sessionMode: 'identity'`. Apps do not implement local session restore or sign-in screens — the mint client, storage keys, and the re-mint handler/scheduler live once in `@oxyhq/core`.
- `runSessionColdBoot` accepts `overallDeadlineMs` (a hard ceiling forwarded to the underlying step runner so one non-settling network step can never hang routing indefinitely), `onStepDeadline` (called once per step abandoned to that deadline), and `isOffline` (a connectivity hint that skips the two NETWORK steps — an explicit offline verdict only; ambiguous/unknown always resolves to "assume online" so a flaky probe never falsely skips a real sign-in). `@oxyhq/services` wires a 12s `overallDeadlineMs` plus a best-effort, 500ms-capped NetInfo/`navigator.onLine` offline hint. The boot-path mint (`mintFromDeviceSecret`) and the native shared-key sign-in both run with `retry: false` — the proactive refresh scheduler and the reactive 401 lane already own retry/backoff, so an inner retry loop here would only multiply the cold boot's worst-case latency. Do NOT re-add retry loops to boot-path network calls; interactive (non-boot) sign-in flows keep their own retries.
- **Session ownership — `sessionMode: 'account' | 'identity'`** (`OxyProvider` prop, default `'account'`; issue #691 Phase 1). In `'identity'` mode the session is pinned PERMANENTLY to the owner of THIS device's PRIMARY identity key — never to the device's mutable `activeAccountId` — via a persisted `{publicKey, accountId}` pin (`packages/core/src/session/identityPin.ts`, storage key `oxy.identity.pin.v1`) written when the identity session is established and reconciled against the live `KeyManager.getPublicKey()` every boot (`resolveIdentityPin` / `establishIdentitySession`, `packages/core/src/session/identitySession.ts`). `switchToAccount` / `switchSession` THROW `IdentityBoundSessionError` (`@oxyhq/services`, never a silent no-op); `openAccountDialog()` is a dev-warning no-op — there is no chooser to open, since the user IS the local key's owner. Commons (`packages/commons/app/_layout.tsx`) is the one consumer (`<OxyProvider sessionMode="identity">`); every other Oxy app stays `'account'`, byte-for-byte unchanged.
- Interactive sign-in is the in-app **`OxyAccountDialog`**: existing device accounts, then ONE primary **"Continue with Oxy"** action (issue #691, Phase 5) — Oxy, not the user, then picks the delivery route (`selectCommonsDelivery`; see "Sign in with Oxy" below). There is no password option in this dialog. Scan-QR, passkey-on-this-device, and "Get Commons" sit behind a collapsed "Having trouble?" disclosure, auto-revealed only once the chosen route fails. Open it with `useOxy().openAccountDialog()` or imperative `openAccountDialog('signin')`. It never navigates to `auth.oxy.so`.
- **`OxySignInButton`** resolves the registered `Application` via `GET /auth/oauth/client/:clientId`: official apps (`first_party`/`internal`/`system`/`isOfficial`) open the dialog; `third_party` apps run OAuth + PKCE (`generatePkcePair` / `generateOAuthState` / `buildOAuthAuthorizeUrl` from `@oxyhq/core`, `packages/core/src/utils/oauthPkce.ts`). On web the transport is `webAuthMode: 'popup' | 'redirect'` (`OxyProvider` prop, default `'popup'`) — see below. Third-party integration guide: `docs/auth/integration-guide.md`.
- **Popup vs redirect web OAuth transport (`webAuthMode`).** `'popup'` opens a small `auth.oxy.so` window synchronously from the click (gesture attribution, before any `await`) with `response_mode=web_message`; the IdP relays `{type:'oxy:oauth:code'|'oxy:oauth:error', code, state}` to `window.opener` via `postMessage` at the redirect URI's EXACT registered origin (never `*`) and closes itself — it never navigates the popup to the `redirect_uri` page, so the RP's own tab/route/scroll position is never touched. A blocked/failed popup falls back to the ordinary full-page redirect automatically (`startWebOAuthSignIn`, `packages/services/src/ui/oauth/browserAuthTransport.ts`). Only the code, `state`, and a typed OAuth error ever cross `postMessage` — the PKCE `code_verifier` stays in the opener's memory. Both transports share ONE completion path (`completeOAuthCode.ts`: validate `state` → PKCE exchange → cleanup → commit session), so they can never drift on the security-critical steps.
- **The SDK NEVER navigates the top-level window on its own, in EITHER `webAuthMode`.** Every hop to the IdP starts from a real user gesture. The two automatic, gesture-less full-page navigations that used to exist are DELETED, not gated: the cold-boot `prompt=none` silent cross-origin restore (`crossOriginRestore.ts`, `legacyRedirectLanes.ts`, `allowsAutomaticIdpRedirect`) and the post-sign-in hub-ticket sync to `auth.oxy.so/sync` (`hubSync.ts`, the IdP `/sync` page, `POST /session/device/hub-ticket` + `/session/device/redeem-ticket`, the `DeviceHubTicket` model, the `@oxyhq/contracts` ticket schemas). `'none'` is deliberately absent from the `prompt` union of `buildOAuthAuthorizeUrl` (`'login' | 'consent'` only) so the silent bounce cannot be rebuilt in one line, and the IdP REFUSES an `authorize?prompt=none` that arrives anyway with a visible terminal screen — never a silent redirect back, so it cannot be hidden in an iframe or a background tab. (`login`/`consent` are type-surface only; the IdP does not act on them today — do not document them as working.) A web origin with no local device credential cold-boots SIGNED OUT and waits for the user's next "Continue with Oxy" — an accepted trade, not a regression. Do NOT reintroduce a silent restore, a hub sync, a `hubSync` prop, or any other cold-boot navigation to the IdP. Return legs the user did ask for stay: consuming a `?code=` already on the URL (`tryCompleteOAuthReturn`, which also strips any `?error=` and the stale PKCE handshake) and the blocked-popup fallback redirect.
- Private app calls wait for SDK readiness: `useAuth().canUsePrivateApi` / `useAuth().isPrivateApiPending` (same hook contract on web and native).
- App backend clients use `oxyServices.createLinkedClient({ baseURL })`. Do not add app-local token providers, Axios/fetch auth interceptors, manual `Authorization` header plumbing, refresh/mint retries, or local invalidation.

Backend APIs use `@oxyhq/core/server` for request identity and security:
- Mount `createOxyRateLimit(oxy)` near the top of the Express app when Oxy-aware rate limiting is needed.
- Use `createOptionalOxyAuth(oxy)` for optional identity, `createOxyAuthMiddleware(oxy)` / `requireOxyAuth` for private routes, and `getRequiredOxyUserId(req)` for required user identity.
- Use `authSocket` for Socket.IO/WebSocket auth. ALWAYS derive rooms from `socket.user.id` — never from client-supplied room IDs. Add ownership checks before joining session/conversation rooms.
- Use `safeFetch(url, opts)` for any fetch of user-supplied URLs (SSRF prevention — DNS-pinned lookup, private-IP denylist, bounded redirects).
- Use `createOxyCors({ appOrigins, allowCredentials })` for CORS (deny-by-default, auto-allows `*.oxy.so`; NEVER wildcard+credentials).
- **Loopback dev origins are trusted on the credentialed CORS lane in ALL environments, including production (owner-approved posture):** `http://localhost`, `http://127.0.0.1`, and `http://[::1]` on ANY port are allowed to make credentialed/state-changing requests against `api.oxy.so`, so a developer's local dev server (Expo web, Vite, etc.) can hit prod. Implemented via one shared predicate, `isLoopbackOrigin(origin)` in `packages/api/src/utils/origin.ts` (http-only, any/no port, fails closed), wired into both `dynamicOriginRegistry.getCorsDecision` (loopback wins over the third-party non-credentialed lane) and `allowedOrigins.isAllowedOrigin` (also gates the CSRF Origin guard + Socket.IO). Do NOT gate this on `NODE_ENV`, do NOT hardcode a single port, and do NOT extend it to `https://localhost` — the accepted exposure is a malicious process on the developer's own loopback riding their oxy.so cookies, since remote sites cannot forge `Origin`.
- Use `verifySecret(provided, expected)` for secret/token equality (constant-time, never `!==`).
- NEVER do `new Model(req.body)` or spread `req.body` into `findByIdAndUpdate` — resolve owner ids server-side via `getRequiredOxyUserId` and use an explicit field whitelist (mass-assignment IDOR).
- Do not define local `AuthRequest`, `requireAuth`, `getUserId`, `getAuthenticatedUserId`, bearer parsers, or token-decoding auth middleware in apps. Missing shared behavior belongs in `@oxyhq/core/server`.
- Bearer-authenticated writes do not fetch app-local CSRF tokens. CSRF remains for ambient cookie credentials and cookie-only writes.

`packages/auth` / `auth.oxy.so` is the **OAuth authorize/consent IdP** for third-party apps, NOT a Relying Party. It mounts `OxyProvider` from `@oxyhq/services` with NO special props — it is a device-first origin like every Oxy app (its own per-origin `{deviceId, deviceSecret}`, normal SDK cold boot, `useDeviceSwitcher` chooser, `signInWithPassword`/`completeTwoFactorSignIn`/`handleWebSession` funnels) — but it stays a SHELL that emits the OAuth authorization code for the third-party after authenticating; do not turn it into an RP that bounces elsewhere for its own session. There is NO transport/chooser exception anymore (the `coldBoot={false}` exception existed for the deleted SSO bounce). Trust for auto-approving OAuth consent is registry-based (`Application.isOfficial`/`isInternal`/`type`, staff-controlled via `isTrustedApplication()` in `packages/api/src/utils/trustedApplication.ts`), not domain-based. The IdP does NOT expose account management — `accounts.oxy.so` is the sole owner; the IdP's `/settings/*` routes permanently redirect there. See the "Auth App (packages/auth)" section below.

## Coding Standards

- TypeScript strict mode across all packages
- Biome for linting (`biome lint --error-on-warnings`)
- No backward-compatibility re-exports — clean imports only
- No unnecessary abstractions or over-engineering
- `packages/core/` and `packages/contracts/` build with `tsc` (CJS + ESM + types -> `dist/`)
- `packages/services/` builds with `react-native-builder-bob` (-> `lib/`)
- **Concurrent session ownership (CRITICAL):** when multiple agents or sessions may be editing `packages/api` simultaneously, CONFIRM sole ownership of shared backend files before writing. PATH-SCOPE all git adds (e.g. `git add packages/api/src/routes/civic.ts`) — NEVER `git add -A` or `git add .` in a shared package while another session may have uncommitted work. Incident: a concurrent session's uncommitted federation work was nearly swept into an unrelated commit.
- **Lockfiles before push (any repo):** after any dependency/version bump, run `bun install` to regenerate `bun.lock` and commit it in the SAME commit as the `package.json` change. When bumping a dep across multiple repos, do this per-repo.
- **`bun install --frozen-lockfile` is NOT a lockfile-sync check — do not use it as one.** Measured on bun 1.3.14 against this repo, it exits **0** on both shapes of desync actually shipped here: a workspace package's own `version` bumped without regenerating the lockfile, and a dependency range widened to something the lockfile does not record (`^15.0.0` → `>=15.0.0`). It only fails when a range resolves to nothing at all, which is a resolution error, not a sync check. Believing otherwise is how a desync introduced in `7256c8d6` survived **six** consecutive commits on `main` and two releases. The real check is `scripts/check-lockfile-sync.mjs` (CI job **Lockfile Sync**), and it has **two layers, because neither covers the other**. Layer 2 regenerates with a plain `bun install` and asks git whether `bun.lock` moved — a tracked file changing IS the desync, with no interpretation needed. Layer 1 compares what `bun.lock` RECORDS per workspace (path set, `name`, `version`, root `overrides`, `trustedDependencies`) against the manifests directly, with no install. Layer 1 exists because **whether a plain `bun install` rewrites a stale recorded `version` is repo-dependent and the boundary is not understood**: in THIS repo it does (so layer 2 sees a version bump here, and would have caught the `core@14.0.0` / `services@23.0.0` bumps), but in the CrowdSource monorepo the identical bump leaves `bun.lock` byte-identical and only layer 1 sees it. Do not rely on regeneration alone in a new repo without measuring it there. Run it locally before pushing a manifest change; it names the offending workspace package. `scripts/test-check-lockfile-sync.mjs` (same CI job) holds both layers with offline fixtures — deleting either makes a case go red.

## @oxyhq/contracts — Contract-First API Schemas

Package: `packages/contracts` → `@oxyhq/contracts`. SINGLE SOURCE OF TRUTH for API request/response contracts.

**What it contains:**
- Zod schemas: `userNameSchema` (`displayName` field is optional — `z.string().optional()`), `userResponseSchema` (includes `did?` + `verifiedDomains?`), `userProfileUpdateSchema`, `currentUserResponseSchema`, `deviceSessionAccountSchema`, `deviceSessionsResponseSchema`
- **Device-first schemas (`src/deviceBoot.ts`, wave 2):** `deviceBootReasonSchema`, `deviceBootFragmentSchema`, `deviceExchangeRequestSchema`, `tokenRefreshRequestSchema`, `tokenRefreshResponseSchema`, `deviceTokenIssueResponseSchema`, `loginResultSchema` + inferred types `DeviceBootReason`, `DeviceBootFragment`, `DeviceTokenIssueResponse`, `LoginResult`/`LoginSessionResult`/`LoginTwoFactorRequired`. The legacy multi-account refresh schemas/types (`refreshAllAccountSchema`, `refreshAllResponseSchema`) AND the IdP `deviceResolve*` chooser schemas/types (`deviceResolveRequestSchema`, `deviceResolveResponseSchema`, `DeviceResolveRequest`, `DeviceResolveAccount`, `DeviceResolveResponse`) were REMOVED — do not reference them; the IdP now enumerates the device directory via the device-first SDK (`useDeviceSwitcher`), not a cookie/resolve feed.
- **Identity schemas (`src/identity.ts`):** `didDocumentSchema` (+ `verificationMethodSchema`, `didServiceSchema`), `signedRecordEnvelopeSchema`, `verifiedDomainSchema` + domain-request/instructions schemas, `authMethodsResponseSchema` (extended with `did` + per-method `verificationMethodId`), `exportBundleSchema`
- Helpers: `resolveUserId`, `safeParseContract`
- Inferred types: `UserNameResponse` (explicit `interface`; `displayName` is **`string | undefined`** — optional; prior to being made explicit it degraded to `{}` under `moduleResolution: node`), `UserResponse`, `UserProfileUpdate`, `CurrentUserResponseContract`, `DeviceSessionAccountResponse`, `DeviceSessionsResponseContract`; identity types: `DidDocument`, `VerificationMethod`, `DidService`, `SignedRecordEnvelope`, `VerifiedDomain`, `AuthMethodsResponse`, `ExportBundle`
- **`src/civic.ts`** — civic/Oxy ID schemas: `publicCardSchema`, `idPayloadSchema`, `attestQrPayloadSchema`, `validationVoteSchema`, `personhoodSchema`, `credentialSchema` + inferred types. Consumed as `workspace:*` by `packages/api`, `packages/core`, and `packages/services`. **NOT yet published to npm** — keep as internal `workspace:*` until Fases 0–4 are fully deployed and stable.

**Build:** dual CJS+ESM+types via tsc (same pattern as core: `tsconfig.{cjs,esm,types}.json` + `scripts/fix-esm-imports.mjs`). Zero runtime deps except `zod`.

**Dockerfile:** both builder and production stages MUST include `packages/contracts`: COPY the directory, build it before core/api, copy its `dist` into the production stage. Any future workspace package consumed by oxy-api MUST be added to the Dockerfile the same way or `bun install` in the ECS image fails to resolve `workspace:*`.

**Rule:** new shared API contracts go in `@oxyhq/contracts`. Server validates output against them; clients validate input and derive `z.infer<>` types. This prevents the Zod-drift class of bug (field-shape mismatch causing `safeParse` to silently return null and the auth app to show logged-out state). Do NOT re-introduce local schema copies in `packages/auth/lib/schemas.ts` — use `@oxyhq/contracts` directly or keep schemas strictly in sync.

**CI / test build-order — resolve workspace deps from source (CRITICAL):**
`.github/workflows/ci.yml` job `api-test` runs `bun install` then `bun run test` in `packages/api` — it does NOT build workspace deps first. `@oxyhq/contracts` and `@oxyhq/core` ship compiled, so tests importing them fail in CI with `Cannot find module` unless mapped to source. Fixed by resolving both from their TypeScript source in test configs:
- **api (Jest):** `moduleNameMapper` in `packages/api/jest.config.js` → `'^@oxyhq/contracts$': '<rootDir>/../contracts/src/index.ts'` and `'^@oxyhq/core/server$': '<rootDir>/../core/src/server/index.ts'` (the latter added because `@oxyhq/api` now imports `safeFetch`/`SsrfRejection` from `@oxyhq/core/server` for federation and email SSRF fixes — PRs #259/#264/#266).
- **auth (bun test):** `mock.module('@oxyhq/contracts', …)` in `packages/auth/lib/__tests__/setup-contracts-source.ts`, loaded first via `packages/auth/lib/__tests__/preload.ts` (mirrors the existing `mock.module` pattern in `lib/__tests__/setup-mocks.ts` for `@oxyhq/bloom/avatar`).

RULE: any package whose tests import a build-required workspace dep (`@oxyhq/contracts`, `@oxyhq/core/server`, etc.) MUST either map that dep to `src/` in the test config (Jest `moduleNameMapper` or bun-test `mock.module` preload) OR the CI job must build the dep first. The contracts source uses extensionless relative imports (`from './userResponse'`), which work under both ts-jest and bun's resolver.

**api BUILD now pre-builds `@oxyhq/core` (source change):** `packages/api/package.json` build script is `bun run --filter @oxyhq/contracts build && bun run --filter @oxyhq/core build && tsc`. This is required because `@oxyhq/api` imports `@oxyhq/core/server` (safeFetch, SsrfRejection) — without the core `dist/`, tsc fails TS2307 and downstream TS18046. The federation (`federation.service.ts`) and email (`email.service.ts`) services now route outbound fetches of user/remote-supplied URLs through `safeFetch` (https-only + streaming byte caps) instead of hand-rolled DNS checks.

Build-vs-source distinction: production/Docker consumes the built `dist/` (the Dockerfile builds `packages/contracts` then `packages/core` before `packages/api`); tests consume the TS source via the mappings above. Both are intentional.

## Key Entry Points

- `packages/contracts/src/index.ts` — all public contract exports (schemas, helpers, types)
- `packages/core/src/index.ts` — all public core exports
- `packages/core/src/utils/avatarUtils.ts` — shared avatar visibility logic (platform-agnostic)
- `packages/core/src/utils/accountUtils.ts` — shared account/device helpers (`buildAccountsArray`, `createQuickAccount`, `getAccountDisplayName`, `getAccountFallbackHandle`, `formatPublicKeyHandle`) for non-DTO local account surfaces only; app/user DTO display names come from API `name.displayName`.
- `packages/core/src/mixins/OxyServices.contacts.ts` — `contacts.discoverContacts(hashedEmails, hashedPhones)` privacy-first contact discovery
- `packages/core/src/mixins/OxyServices.workspaces.ts` — `workspaces` mixin (CRUD + members + transfer); `Workspace`/`WorkspaceMember` types
- `packages/core/src/mixins/OxyServices.applications.ts` — `getApplications(workspaceId?)` + `getPublicApplication(clientId)`; `PublicApplication` type
- `packages/core/src/server/index.ts` — public `@oxyhq/core/server` exports
- `packages/core/src/server/auth.ts` — `createOptionalOxyAuth`, `createOxyAuthMiddleware`, `requireOxyAuth`, `getRequiredOxyUserId`
- `packages/core/src/server/rateLimit.ts` — `createOxyRateLimit`
- `packages/core/src/server/safeFetch.ts` — `safeFetch(url, opts)`, `assertSafePublicUrl` (SSRF-safe fetch; DNS-pinned, private-IP denylist, bounded redirects, Bun `{all:true}` lookup-array contract)
- `packages/core/src/server/cors.ts` — `createOxyCors({ appOrigins, allowCredentials })` (deny-by-default allowlist, auto-allows `*.oxy.so`, NEVER wildcard+credentials)
- `packages/core/src/server/verifySecret.ts` — `verifySecret(provided, expected)` (constant-time `crypto.timingSafeEqual` + length guard)
- `packages/core/src/mixins/OxyServices.reputation.ts` — `reputation` mixin (15 methods, fully typed). It declares NO types: the whole family lives in `packages/contracts/src/reputation.ts` (see "Oxy Trust" section)
- `packages/core/src/crypto/canonicalJson.ts` — `canonicalize(value)` (recursive key-sort/JCS-style canonical JSON) + `signedRecordSigningInput`; used by both client signing and server verify
- `packages/core/src/mixins/OxyServices.identity.ts` — `identity` mixin: `resolveDid`, `getMyDid`, `listAuthMethods`, `linkIdentityKey`, `unlinkAuthMethod`, `linkPassword`, `signRecord`, `publishRecord`, `getRecord`, `verifyRecord`, `exportMyData`, `requestDomainVerification`, `verifyDomain`, `listDomains`, `removeDomain`
- `packages/core/src/mixins/OxyServices.civic.ts` — `civic` mixin: `getPublicCard`, `getMyIdPayload`, `parseIdPayload`, `buildAttestQrPayload`, `parseAttestPayload`, `submitRealLifeAttestation`, `getValidatorInbox`, `submitValidationVote`, `denyValidation`, `vouchForPerson`, `withdrawVouch`, `getPersonhood`, `getMyPersonhood`, `issueCredential`, `listCredentials`, `listMyCredentials`, `verifyCredential`, `revokeCredential`
- `packages/core/src/session/` — `SessionClient`, `createSessionClient`, `createSessionClientHost`, session-state projection, account-dialog controller, auth-state store, token-refresh scheduler
- `packages/core/src/session/SessionClient.ts` — `SessionClient.onServerEvent(event, listener)`: generic subscription to named server-pushed Socket.IO events (survives reconnects; unsubscribe fn returned). Consumed via the `useOxyEvent(event, handler)` hook exported from `@oxyhq/services`.
- `packages/core/src/session/identityPin.ts` / `identitySession.ts` — the `sessionMode: 'identity'` pin store + `resolveIdentityPin`/`establishIdentitySession` (issue #691 Phase 1)
- `packages/core/src/utils/commonsDelivery.ts` — `selectCommonsDelivery` (issue #691 Phase 4 automatic delivery decision)
- `packages/api/src/utils/applicationCapabilities.ts` — `APPLICATION_CAPABILITIES`, `IDENTITY_APPROVAL_CAPABILITY`, `hasApplicationCapability` (staff-only `Application.capabilities` vocabulary)
- `packages/contracts/src/browserHub.ts` — `BROWSER_HUB_COOKIE_NAME` / `BROWSER_HUB_COOKIE_ATTRIBUTES` / `BROWSER_HUB_HANDLE_TTL_MS` and both hub wire surfaces (the API's `browserHub*`, the edge's `hub*`), kept as separate shapes so a refactor cannot move a credential across the boundary without a type changing
- `packages/api/src/routes/browserHub.ts` + `deviceSession.service.ts`'s `issueHubHandle` / `resolveHubDeviceId` / `revokeHubHandle` — the hub's server half
- `packages/auth/hub/` (`cookie.ts`, `upstream.ts`, `handlers.ts`) + `packages/auth/functions/hub/*.ts` — the hub's edge half at `auth.oxy.so`
- `packages/api/src/middleware/firstPartyDeviceAccess.ts` — `requireFirstPartyDeviceAccess`, shared by `/session/device/*` and `/session/browser-hub/*`
- `packages/core/src/boot/sessionColdBoot.ts` — `runSessionColdBoot` (device-first cold boot, the SOLE restore chain)
- `packages/core/src/utils/oauthPkce.ts` — `generatePkcePair`, `generateOAuthState`, `buildOAuthAuthorizeUrl` (third-party OAuth + PKCE helpers)
- `packages/services/src/ui/oauth/` — `browserAuthTransport.ts` (`startWebOAuthSignIn`, popup-vs-redirect entry point), `completeOAuthCode.ts` (the one code→session completion path both transports share), `oauthPopup.ts` (popup lifecycle)
- `packages/services/src/ui/utils/oauthReturn.ts` — `tryCompleteOAuthReturn` (consume a `?code=`/`?error=` already on the URL), `replaceUrlAfterOAuthReturn` (restore the deep link + notify the router via `popstate`)
- `packages/services/src/ui/session/identityBinding.ts` — `IdentityBoundSessionError` (thrown by `switchToAccount`/`switchSession` in `sessionMode: 'identity'`)
- `packages/services/src/index.ts` — all public UI SDK exports (web + native); includes `LogoIcon`, `LogoText`
- `packages/services/src/notifications/deviceNotifications.ts` — the ONE `expo-notifications` adapter, reached ONLY as `@oxyhq/services/notifications` (never the root barrel — see Package Boundaries)
- **`packages/services/src/ui/context/OxyContext.tsx`** — auth provider + `useOxy()` (web + native); types in `oxyContextTypes.ts`, account graph in `useOxyAccountGraph.ts`, imperative dialog in `navigation/accountDialogManager.ts` (`openAccountDialog('signin')`)
- `packages/services/src/ui/components/OxyProvider.tsx` — the ONE provider component (device-first cold boot on by default; every consumer including the IdP mounts it the same way)
- `packages/services/src/ui/components/OxyAccountDialog.tsx` — unified account switcher + sign-in dialog (Bloom `<Dialog>`)
- `packages/services/src/ui/components/OxySignInButton.tsx` — official → dialog; `third_party` → OAuth redirect + PKCE
- `packages/services/src/ui/components/OxyConsentScreen.tsx` — the IdP's OAuth consent surface

**NOTE:** `accountUtils.ts` is not a frontend display-name fallback for API user/profile DTOs. API serializers own `name.displayName` (optional); consumers render it when present, then fall back to `getNormalizedUserHandle` — not to `accountUtils`.

## Application Model (#213 + #216) — replaces the legacy developer-app model (2026-06-14)

**Clean rename, NO migration, NO back-compat.** The legacy developer-app model and `routes/developer.ts` are GONE. The production `developerapps` collection was dropped (had 1 record). New collections start empty; apps are recreated in the new Console.

**Three new models in `packages/api/src/models/`:**
- `Application` (collection `applications`): `type` first_party|third_party|internal|system, `status` active|suspended|deleted|pending_review, `isOfficial`, `isInternal`, `capabilities[]`, `redirectUris[]`, `scopes`, `privacyPolicyUrl?`, `termsUrl?` (shown on the OAuth consent screen), `createdByUserId`. NO apiKey/apiSecret on this model.
- `ApplicationMember` (collection `applicationmembers`): `applicationId`+`userId` unique; `role` owner|admin|developer|viewer|billing; `permissions[]` derived from role; `status` active|invited|removed.
- `ApplicationCredential` (collection `applicationcredentials`): `publicKey` = OAuth client_id, `secretHash` = sha256 only (secret shown ONCE on create/rotate), `type` public|confidential|service, `environment`, `scopes`, `status`.

**Roles→permissions map:** `packages/api/src/utils/applicationRoles.ts` (`ROLE_PERMISSIONS`, `permissionsForRole`).

**Staff-only fields** (`type`/`isOfficial`/`isInternal`/`capabilities`): gated by `isStaff` boolean on the User model + `packages/api/src/middleware/requireStaff.ts` (`requireStaff`, `isStaffUser`). Normal Console PATCH path silently drops these for non-staff.

**Routes:** `packages/api/src/routes/applications.ts` mounted at `/applications` (Zod schemas in `schemas/application.schemas.ts`). RBAC via `requireAppPermission(permission)`. Full CRUD + members (invite/update/remove/transfer-ownership, can't remove last owner) + credentials (create/rotate return secret ONCE, revoke) + usage. Application responses embed `callerMembership` (caller's own role+permissions) on list + detail.

**OAuth + service tokens:** `clientId` → `ApplicationCredential.publicKey` (active) → `applicationId` → `Application`. Service-token endpoint validates apiKey/apiSecret against an active `type:'service'` `ApplicationCredential` (sha256 secretHash, constant-time). The service JWT payload claim is STILL named `appId` (= applicationId string) — NOT renamed, to avoid breaking `@oxyhq/core` service-token verification. `ApiKeyUsage`/`AuthCode`/`DeveloperApiKey` model refs repointed from the legacy model name to `'Application'` (the `DeveloperApiKey` model name itself was kept). Platform-stats field renamed to `totalApplications`.

**redirectUris (#216):** `redirectUris` is the SOLE canonical redirect field. `redirectUrls` removed entirely (no dual field, no migration). OAuth authorize validates `redirect_uri` exact-match (constant-time) against `application.redirectUris`. Console writes `redirectUris`.

**SDK (@oxyhq/core — BREAKING):** Removed `OxyServices.developer.ts` + `developer` mixin. Replaced by `OxyServices.applications.ts` (getApplications/createApplication + members/credentials/usage methods). Exported interfaces: `Application`, `ApplicationMember`, `ApplicationCredential`, `ApplicationRole`, etc. `configureServiceAuth`/`getServiceToken`/`makeServiceRequest` are UNCHANGED — service token flow unaffected.

**Console:** `use-developer.ts` → `use-applications.ts`; apps list + tabbed app settings (General incl. redirectUris editor / Members / Credentials / Usage), permission-gated; staff-only fields never shown. Console now uses the shared SDK (bespoke axios client removed) + Bloom theming + macOS splash + app-name from manifest.json + app-logo/workspace-avatar uploads + invite-by-username/email + Manage-account link + docs→website.

**Commits:** api `881f81dc`, core+console `0a341882`, peer bumps `45e49063`.

## Workspaces (2026-06-15)

**Models in `packages/api/src/models/`:**
- `Workspace` (collection `workspaces`): `type` personal|team, `slug`, `ownerId`. Personal workspace is MANDATORY — created automatically for every user, NOT renamable (PATCH rejects rename for `type:'personal'`), cannot be deleted.
- `WorkspaceMember` (collection `workspacemembers`): `workspaceId`+`userId` unique; `role` owner|admin|member|viewer.

**Routes:** `packages/api/src/routes/workspaces.ts` at `/workspaces`. `GET /workspaces` calls `ensurePersonalWorkspace` UNCONDITIONALLY so every user always has a Personal workspace. RBAC via `requireWorkspacePermission`.

**Application scoping:** `Application.workspaceId` is REQUIRED. `GET /applications?workspaceId=` filters by workspace; access granted if workspace member OR `ApplicationMember`.

**SDK:** `@oxyhq/core` `workspaces` mixin — `OxyServices.workspaces.ts` with CRUD + members + transfer. `Workspace`/`WorkspaceMember` types exported. `getApplications(workspaceId?)` accepts workspace scope.

**Production "Oxy" team workspace:** `_id 6a2f9d8989b795cfdfac350f`, slug `oxy`, owned by user `oxy` (`_id 69b2d3df5d12f58c9800d651`, username `oxy`, email `hello@oxy.so` — DISTINCT from human `nateus`/`nate@oxy.so`). All 12 official Applications assigned to it. Migration `scripts/migrate-workspaces.ts` ran (idempotent).

## Oxy Trust — Reputation System (#217 + #219, 2026-06-16)

**Full hard replacement of the karma system. NO back-compat. Karma collections (`karmas`, `karmarules`) NOT auto-dropped — manual drop after migration verification.**

### API models (`packages/api/src/models/`)
- `ReputationTransaction` (collection `reputationtransactions`): ledger; `status` active|reversed|voided; `category` content|social|trust|moderation|physical|penalty|other; `sourceActionId` for idempotency.
- `ReputationBalance` (collection `reputationbalances`): cached per-user; `total`, `positive`, `negative`, `breakdown`, `reliability`, `trustTier`, `influence`; recalculated on demand.
- `ReputationDispute` (collection `reputationdisputes`): dispute lifecycle for contested transactions.
- `ReputationRule` (collection `reputationrules`): configurable award rules (replaces `KarmaRule`).
- **Deleted:** `Karma.ts`, `KarmaRule.ts`, `karma.controller.ts`, `karma.routes.ts`, `karma.schemas.ts`, the `KARMA` const, `UserStatistics.karma` field.

### Service (`packages/api/src/services/reputation.service.ts`)
Single source of truth. Key methods:
- `award(input)` — rule-driven, respects cooldown, idempotent on `(applicationId, sourceActionId)` via sparse partial-unique index.
- `reverseTransaction(id)` — marks original `reversed` + inserts compensating `-points active` txn → nets to zero. Never deletes.
- `voidTransaction(id)` — excludes from balance without compensating txn.
- `recalculateBalance(userId)` — aggregates `active`-only txns → total/positive/negative/breakdown + reliability + trustTier + influence.
- `getBalance(userId)`, `getInfluence(userId, context)`, `createDispute`, `resolveDispute`.

### Routes (`/reputation`, CSRF parity with old `/karma`)
- `GET /leaderboard`, `GET /rules`, `POST /rules` (staff)
- `GET /:userId/balance`, `POST /award` (service-token OR staff; regular users 403; service-token resolves `applicationId`/`credentialId` from `req.serviceApp`)
- `GET /:userId/transactions`, `GET /:userId/influence?context=default|report|moderation|ranking`
- `POST /transactions/:id/reverse` (staff), `POST /transactions/:id/void` (staff)
- `POST /:userId/recalculate` (staff)
- `POST /disputes`, `GET /disputes` (staff queue), `GET /:userId/disputes`, `POST /disputes/:id/resolve` (staff)

### Constants (`packages/api/src/utils/reputation.constants.ts`)
- Trust tiers (top-down): `restricted` (total<0 OR abuseScore>=0.5) → `verified` (User.verified) → `high_trust` (total>=500) → `trusted` (total>=100) → `new`.
- Influence clamped [0.1, 3.0]; base=clamp(0.1+total/500); moderation factor map: `{restricted:0, new:0.5, trusted:1.0, high_trust:1.25, verified:1.5}`; restricted floors ALL weights to 0.1.
- Reliability source keys: `report_confirmed`/`report_rejected`; abuseScore smoothing window=5.

### Rate-limit prefixes (reputation)
`rl:reputation:read:`, `rl:reputation:award:`, `rl:reputation:admin:`, `rl:reputation:dispute:`

### Migration
There is none, and there is nothing pending. Karma was hard-replaced by the reputation ledger (b28f886b, PRs #217/#219), and `karmas`/`karmarules` were verified EMPTY cluster-wide before the Postgres port — the port's own collection map recorded them as "no table, and nothing to move". `scripts/migrate-karma-to-reputation.ts` was therefore a documented no-op against production and has been deleted along with the rest of the Mongo one-shots. Do not re-add a "balances read 0 until the migration runs" note: it was never true after b28f886b, and the collection it would have read no longer exists.

### Types (`@oxyhq/contracts` — `src/reputation.ts`)
**`@oxyhq/contracts` owns the whole reputation type family** — the closed value sets (`REPUTATION_CATEGORIES`, `TRUST_TIERS`, `REPUTATION_TRANSACTION_STATUSES`, `REPUTATION_TARGET_ENTITY_TYPES`, `REPUTATION_DISPUTE_STATUSES`, `REPUTATION_INFLUENCE_CONTEXTS`), the response entities (`ReputationTransaction`, `ReputationBalanceSummary` / `ReputationBalance` / `ReputationBalanceView`, `ReputationBalanceBreakdown`, `ReputationInfluence`, `ReputationReliability`, `ReputationDispute`, `ReputationRule`, `ReputationLeaderboardUser` / `ReputationLeaderboardEntry`, `ReputationInfluenceResult`, `ReverseReputationTransactionResult`), the write-endpoint request schemas + input types, and the `isFullReputationBalance` narrowing guard. `@oxyhq/core` declares NONE of them and re-exports NONE of them; every consumer imports from `@oxyhq/contracts` directly.
- The API's Drizzle schema enums (`ReputationTransaction`/`ReputationRule`/`ReputationDispute`/`ReputationBalance`/`User`) and its `validate({ body })` schemas import the SAME tuples/schemas, so a value set cannot be widened on one side only. `packages/api/src/utils/reputation.constants.ts` keeps only the numeric TUNABLES.
- Each serializer in `packages/api/src/routes/reputation.routes.ts` builds a `const dto: <ContractType>` (compile-time guard: a missing field, an undeclared field, or a `Date` where the wire promises an ISO string all fail `tsc` and name the field) and returns `schema.parse(dto)` (runtime guard). Do NOT loosen a serializer's return type back to `Record<string, unknown>` — that is exactly what let the `/:userId/balance` view split diverge from the SDK type silently.

### SDK (`@oxyhq/core` — `reputation` mixin)
- 15 methods on `OxyServices`: `getReputationBalance`, `getMyReputationBalance`, `getReputationLeaderboard`, `getReputationRules`, `getReputationTransactions`, `getReputationInfluence`, `awardReputation`, `createReputationDispute`, `getUserReputationDisputes`, `upsertReputationRule`, `reverseReputationTransaction`, `voidReputationTransaction`, `recalculateReputation`, `getReputationDisputeQueue`, `resolveReputationDispute`.
- Writes sweep `clearCacheByPrefix('GET:/reputation/')`.
- **Deleted:** karma mixin + `KarmaRule`/`KarmaHistory`/`KarmaLeaderboardEntry`/`KarmaAwardRequest` types + `User.karma` field + `UserStats.karmaScore`.
- **SEMVER NOTE:** the karma removal was a breaking change. Peer ranges in `@oxyhq/services` were updated at publish time.

### Services (`@oxyhq/services`) — Trust screens
- 4 screens renamed Karma*→Trust* + About/FAQ under `src/ui/screens/trust/`.
- **BREAKING `RouteName` change:** removed `KarmaCenter|KarmaLeaderboard|KarmaRewards|KarmaRules|AboutKarma|KarmaFAQ`; added `TrustCenter|TrustLeaderboard|TrustRewards|TrustRules|AboutTrust|TrustFAQ`. Consumers calling `showBottomSheet('Karma...')` MUST migrate. `test-app-expo` already migrated.

## #214 — Auth App: Authorize Screen Application Identity (2026-06-16)

`packages/auth` authorize screen now resolves and displays the REAL registered `Application` identity (name, logo, redirectUri) via `sessionStatusSchema` in `packages/auth/lib/schemas.ts`. The free-form `appId` string field was replaced with a typed `application` contract wired from the API through `authorize.tsx` via `safeParse`. 10 new auth-web tests cover the authorize contract parsing.

## Trusted-Origin Registry — Application Registry (originally 2026-06-15; FedCM surface removed in wave 2)

Registering an `Application` (with `redirectUris`) now auto-authorizes that app's origin ecosystem-wide, no code change needed — this superseded the old FedCM-era approved-client-origins cache when FedCM was deleted. Trust derivation lives in `packages/api/src/config/dynamicOriginRegistry.ts`: two in-memory snapshots (`trustedOrigins` — first-party/internal/system/official, gets the credentialed CORS lane; `thirdPartyOrigins` — ordinary active third-party apps, non-credentialed CORS only) refreshed on boot + 60s interval + on-demand from Application writes. The trust gate is the single `isTrustedApplication()` predicate (`packages/api/src/utils/trustedApplication.ts`) — `status: 'active'` alone is never a trust boundary, since every self-service third-party app is active too. This same registry is what the OAuth consent auto-approve decision reads.

**12 official Applications** created in the `oxy` workspace, each with a `public` `ApplicationCredential` (client_id = `oxy_dk_…` publicKey). Their `clientId` is wired into each app's `OxyProvider` via env-with-default.

**Credential rotation:**
- `POST /applications/:appId/credentials/:credId/rotate` — mints a new `ApplicationCredential` (new `publicKey` + `secret` returned once), marks the previous one `deprecated` with `expiresAt = now + CREDENTIAL_ROTATION_GRACE_MS` (7 days). Response: `{ credential, secret, rotatedFrom, graceExpiresAt }`. `rotatedFromCredentialId` on the new credential links new → old for audit.
- Auth resolution at ALL three sites (OAuth authorize, OAuth token, service-token mint) uses the shared `isCredentialUsable()` predicate in `packages/api/src/utils/credentialUsability.ts` — accepts `active` OR `deprecated`-within-grace; rejects `revoked` or expired. Old secret works during the 7-day grace; revoke is immediate.
- Service-token JWT now embeds `credentialId` alongside `appId` (= applicationId); both are on `req.serviceApp`. The JWT claim name `appId` is unchanged.
- Secrets are sha256-hashed (`secretHash`), returned exactly once on create or rotate, never retrievable again.

## Service Tokens (Internal Service-to-Service Auth)

Internal Oxy ecosystem apps authenticate via short-lived service JWTs (OAuth2 Client Credentials pattern).

**Flow:**
1. Create an `Application` with `type: 'internal'` and an `ApplicationCredential` with `type: 'service'` (DB-only or Console staff view)
2. Service exchanges `publicKey` (client_id) + `secret` → `POST /auth/service-token` → 1h JWT
3. Service uses JWT as `Authorization: Bearer <token>` + `X-Oxy-User-Id: <userId>` for delegation
4. `@oxyhq/core` `auth()` middleware recognizes `type: 'service'` JWTs (stateless, no session DB lookup)

**Key files:**
- `packages/api/src/routes/auth.ts` — `POST /auth/service-token` endpoint (validates against `ApplicationCredential`)
- `packages/api/src/models/Application.ts` — `isInternal`, `type` field
- `packages/api/src/models/ApplicationCredential.ts` — `publicKey`, `secretHash`, `type: 'service'`
- `packages/core/src/mixins/OxyServices.utility.ts` — `auth()` service token handling, `serviceAuth()` middleware
- `packages/core/src/mixins/OxyServices.auth.ts` — `getServiceToken()`, `makeServiceRequest()`, `configureServiceAuth()`

**Usage in consuming services:**
```typescript
import { OxyServices } from '@oxyhq/core';

const oxy = new OxyServices({ baseURL: 'https://api.oxy.so' });
oxy.configureServiceAuth('oxy_dk_...', 'secret...');

// Auto-cached, auto-refreshed service token
const token = await oxy.getServiceToken();

// Or use makeServiceRequest for delegation
const result = await oxy.makeServiceRequest('POST', '/some/endpoint', data, userId);
```

**Middleware for protecting internal endpoints:**
```typescript
// Only allows service tokens (rejects user JWTs and API keys)
app.use('/internal', oxy.serviceAuth());
```

## API: userCache Invalidation Rule

**Every** API route that modifies user state (`updateUserProfile`, `PATCH /privacy/:id/privacy`, `PUT /users/:userId/privacy`, etc.) MUST call `userCache.invalidate(userId)` after the write. Skipping this causes the in-memory cache to return stale pre-write data on the next `getUserBySession`, silently reverting client updates.

Every `rateLimit()` call MUST also pass a unique `prefix` (see "Rate Limiting" below) — the factory in `packages/api/src/middleware/rateLimiter.ts` enforces it as required.

## Rate Limiting (api)

All limiters use `rate-limit-redis` with a shared ioredis client. The factory `rateLimit({ windowMs, max, prefix, ... })` in `packages/api/src/middleware/rateLimiter.ts` requires a unique `prefix` per limiter instance.

**Why unique prefixes are mandatory** (commit `ef222ecc`): without a per-instance `prefix`, every `rate-limit-redis` store writes to the same default Redis key. When a request passes through the global limiter AND a route-specific limiter, the same key is incremented twice and `rate-limit-redis` throws `ERR_ERL_DOUBLE_COUNT`, halving the effective budget. Each limiter MUST own its own key namespace.

**Convention**: `rl:<scope>:` where scope identifies the limiter purpose.

**Prefixes in use:**
- `rl:general:` — global limiter (1000 / 15min)
- `rl:idp:service:` — IdP worker server-to-server READ budget (`/session/validate/*`, 20000 / 15min prod)
- `rl:auth:` — broad auth routes (`authRateLimiter`, 300 / 15min)
- `rl:user:` — user routes (`userRateLimiter`, 200 / 15min)
- `rl:auth:challenge:`, `rl:auth:verify:`, `rl:auth:refresh:`, `rl:auth:lookup:`, `rl:auth:session-claim:`, `rl:auth:oauth-authorize:`, `rl:auth:oauth-consent:`, `rl:auth:oauth-token:`, `rl:auth:service-token:`, `rl:auth:login:`, `rl:auth:client-lookup:`
- `rl:session:device-token:` — the zero-cookie device-secret mint (`POST /session/device/token`, `packages/api/src/routes/sessionDevice.ts`)
- `rl:session:hub-establish:`, `rl:session:hub-resolve:`, `rl:session:hub-rotate:`, `rl:session:hub-revoke:` — the browser hub (`packages/api/src/routes/browserHub.ts`). Establish is keyed on the bearer's device; the other three on a PREFIX of the presented handle's hash, because every request arrives from Cloudflare's edge and an IP key would collapse the whole hub onto a few buckets. Guessing is bounded by the handle's 256 bits, not by a limiter
- `rl:apps:authorized:read:`, `rl:apps:authorized:revoke:` — connected-apps (`AppGrant`) surface; `rl:auth:grants:read:`, `rl:auth:grants:revoke:` — OAuth grant management
- `rl:contacts:discover:` (200 hashes/request, 5 req/min/user)
- `rl:social-auth:`
- `rl:email:inbound:`, `rl:email:proxy:`
- `rl:userdata:write:`
- `rl:reputation:read:`, `rl:reputation:award:`, `rl:reputation:admin:`, `rl:reputation:dispute:`
- `rl:auth:session-approve-info:`, `rl:auth:session-authorize-signed:` — Commons QR handoff endpoints
- `rl:auth:session-finalize:` — OAuth-bound Commons approval finalize (issue #691 Phase 3, `POST /auth/session/finalize/:sessionToken`); `rl:auth:session-deliver:` — automatic push delivery (Phase 4, bearer-required); `rl:auth:session-opened:` — delivery-opened progress ping (Phase 4, no bearer)
- `rl:identity:export:` (5/hr — signed data export), `rl:identity:domainreq:`, `rl:identity:domainverify:` — domain verification
- `rl:civic:attest:` (real-life QR attestation), `rl:civic:validate:` (jury vote submit), `rl:civic:vouch:` (personhood vouch/withdraw), `rl:civic:credential:` (credential issue/revoke)
- `rl:transparency:read:` — public transparency-log reads (`GET /transparency/*`, 600 / 15min)
- `rl:updates:manifest:` (public expo-updates manifest poll), `rl:updates:publish:`, `rl:updates:read:` — Oxy Updates admin surface

## Federation (`@oxyhq/federation`)

`packages/federation` → `@oxyhq/federation` (published to npm — `package.json` is the version source of truth, not this file) is the app-agnostic ActivityPub identity + follow engine substrate: the network-connector contract, normalized cross-network DTOs, HTTP signatures, the local-actor builder, and remote-actor resolution. The isomorphic `.` entry stays free of Express/Mongoose so it can be imported anywhere; the runnable engine (signed fetch, delivery transport, webfinger/actor/inbox routers) lives under the separate `./node` subpath so it never enters isomorphic bundles. Mention is the connector consumer; oxy-api imports only pure functions off the isomorphic entry — host canonicalisation (`canonicalFederationHost`, `isSameFederationHost`), the upstream-URL parser (`federatedUsernameFromUpstreamUrl`), and HTTP-signature signing (`signRequest`) — never the connector contract or the `./node` Express routers.

**Bridge relabelling — the mechanism ships here, the trust entries never do.** An account republished by a bridge (e.g. `@wired@bird.makeup`, mirroring X's `@wired`) is re-labelled onto the network it actually came from. `createBridgeRelabeller(entries)` — the derivation engine, the network vocabulary (`FEDERATION_NETWORKS`: x, instagram, bluesky), and the bidirectional upstream-profile-URL rule (`upstreamProfileUrl` / `parseUpstreamProfileUrl`, ONE declaration read forwards to render a link and backwards to recognise a pasted one) — ships with ZERO bridge entries. Which operators may be trusted to re-attribute somebody's account is a moderation judgement each consuming app commits and answers for; `entries` is a parameter, never baked in. Mention's own reviewed list lives in `Mention/packages/backend/src/connectors/activitypub/federationBridgePolicy.ts` (see that repo's `AGENTS.md`).
- `relabel: 'enabled' | 'pending_dedup'` per entry — relabelling MANUFACTURES duplicates (two bridges of one network start rendering the identical handle), so an entry can be committed and reviewed while staying inert until its collision set is measured and any pre-existing duplicates are merged.
- An empty derived handle is refused, never merged: it is the signature of a BROKEN derivation rule, not an unusual account, and merging on it would collapse every actor on a domain onto one person.
- FEP-fffd `proxyOf` (`readProxyDeclarations`, `upstreamHandleFromProxyOf`) is parsed for every actor but is only ever a derivation SOURCE inside a reviewed bridge entry — never honoured globally, because it is a claim an untrusted remote actor makes about its OWN identity (any actor on any instance can publish a `proxyOf` naming anyone). `authoritative` on a declaration defaults to `false` when absent and is read as `=== true`, never by truthiness — it is the one bit separating "this actor IS that account" from "this actor is one copy of it." Nothing in production ingests it yet (only two Nostr bridges publish it, and Nostr npubs have no `@handle@domain` form to relabel onto) — it exists so a future FEP-fffd bridge needs a reviewed entry, not new code.

**oxy-api adjudicates independently, with a second, deliberately un-consolidated trust list.** `PUT /users/resolve` binds a federated actor URI's host to the domain the caller asserts, so a service cannot vouch for a user on a host it does not own — a bridged identity is the one case those legitimately differ, and oxy-api decides for itself whether to believe a re-attribution via its OWN list, `packages/api/src/config/federationBridgeTrust.ts` (`bridgeVouchesForNetwork`), never importing Mention's. **This is not duplication and must not be "tidied" into one shared list.** Kept separate, drift fails CLOSED in both directions: an app derives for a bridge oxy-api does not trust → the resolve is refused and the actor keeps its bridge identity; oxy-api trusts a host no app derives for → nothing happens. Consolidating them would let a single unreviewed entry in either repository start re-attributing real people's writing — the redundancy is the safety mechanism, stated in comments at both this file and Mention's `federationBridgePolicy.ts` (two sites, so whoever next finds the same domains listed twice and reaches for the obvious tidy-up finds the reason first).

**Search by pasted profile URL.** Pasting an `x.com`, `instagram.com`, or `bsky.app` profile link into search now finds the account we hold under its federated handle (`nasa@x.com`) — previously unreachable by substring match, since we store the bridged identity, not the URL. `peopleSearchMatch` (`packages/api/src/utils/profileQuery.ts`) is the ONE chokepoint `/search`, `/profiles/search`, and `POST /users/search` all funnel through: when the pasted text parses as a network profile URL (via `federatedUsernameFromUpstreamUrl`, the SAME `FederationNetwork.storedUsername` rule the ingest path uses — never a second parsing rule, which is exactly how the Bluesky `.bsky.social`-suffix-dropping case would have silently diverged from ingest), the exact match REPLACES the fuzzy match rather than joining it, and a URL that parses but matches nobody returns zero rows rather than falling back to a fuzzy search. The URL is parsed only, never fetched — fetching a user-supplied URL from a search endpoint would be an SSRF surface for no benefit.

**Blocked-domain platform-data purge.** `POST /federation/domain-purge` (service auth, under the `/federation` mount's existing `federationServiceLimiter`) removes the federated identities and mirrored media Oxy holds for a blocked domain — the platform-side counterpart to an app's own content purge. Safe by default (`dryRun` defaults `true`) and doubly gated for a real deletion: the caller must pass `dryRun:false` AND the deployment needs `FEDERATION_DOMAIN_PURGE_ENABLED=true` set, else 409 — arming the endpoint is an operator decision on THIS deployment, independent of whatever calls it. Bounded and resumable (`limit` actors per call, default 200; response carries `done`/`nextCursor`/`remaining`); a repeated or already-completed purge is a no-op. A caller only ever deletes files it recorded itself (`req.serviceApp.appId` from the service credential, never the request body) — a user row shared with another application is archived, not deleted, and the response names the apps that kept it. Driven today by Mention's `run-blocked-domain-purge.yml` ECS one-shot (in-VPC, `main`-only — see `~/Oxy/Mention/AGENTS.md`).

## Oxy Updates — self-hosted OTA (api + ship + console)

Self-hosted `expo-updates`-protocol OTA server, namespaced entirely under `/updates/v1` (`packages/api/src/server.ts`) so it never clashes with the rest of the API.

- **Public manifest endpoint** (`packages/api/src/routes/updates.ts`): `GET /updates/v1/apps/:clientId/manifest` — no auth, no CSRF (mounted before the CSRF group); `:clientId` is an `ApplicationCredential.publicKey` (`oxy_dk_…`). Resolves `(channel, runtimeVersion, platform)` from expo-updates request headers and returns a signed `multipart/mixed` manifest or a `noUpdateAvailable` directive via `manifest.service.ts`.
- **Admin surface** (`packages/api/src/routes/updatesAdmin.ts`): channel/publish/rollback management, gated by the `Application`/role permission system (not a separate auth scheme).
- **Models** (`packages/api/src/models/`): `AppUpdate`, `UpdateAsset`, `UpdateChannel`.
- **Services** (`packages/api/src/services/updates/`): `manifest.service.ts`, `publish.service.ts`, `signing.service.ts` (code-signing; throws `CodeSigningNotConfiguredError` when keys aren't set up — see the keygen script), `assetKeys.ts`.
- **Publishing CLI:** `@oxyhq/ship` (`packages/ship`, bin `oxy-ship`) parses an `expo export` output, hashes assets, and publishes to a channel via the admin API — see `packages/ship/README.md`.
- **Console UI:** per-app Updates tab at `packages/console/src/routes/_layout/apps/$appId/updates.tsx` (+ `components/apps/updates-section.tsx`).

**General limiter threshold** (commit `641cea67`): raised 150 → **1000 / 15min**. The 150 ceiling was below a single authenticated user's normal traffic (feed scroll + socket fallback polling + profile loads + device-secret token mints). Per-endpoint limiters (`authRateLimiter` 300, `userRateLimiter` 200, `checkLimiter` 10/min, etc.) remain the relevant defense-in-depth. **Do NOT lower the general limiter below 1000 without measuring real production traffic.**

## No User IPs At Rest (privacy invariant, owner-mandated 2026-07-14)

Threat model: state-actor harassment of users. The platform must **never persist a user IP address** — raw, hashed, or geo-derived (country included, e.g. `cf-ipcountry`) — in the database, logs (pino fields), metrics metadata, or response DTOs. Salted hashes of the IPv4 space are brute-forceable by anyone with server access, so hashing is NOT an acceptable at-rest form.

- Removed entirely: `SecurityActivity.ipAddress`, `Session.deviceInfo.{ipAddress,location}`, `ApiKeyUsage.ipAddress`, the IP input to `deriveStableDeviceId`, IP-based anomaly detection (`detectRapidIPChanges`), and the civic `shared_ip` anti-sybil signal (`graphExclusion.ts` — device-fingerprint/interaction-history/affinity-throttle only now).
- **Anonymous rate-limit keys are the one place IPs may be touched, and only transiently:** they MUST go through `hashedIpKey` (`packages/api/src/utils/ipKey.ts` — HMAC(`DEVICE_ID_SALT`), IPv6 /56-bucketed) and live only as a Redis key with the limiter's normal TTL. Never key a limiter on raw `req.ip`.
- **The one sanctioned exception:** inbound-email `Received:` headers (third-party SMTP sender IPs, not Oxy users) stored in `Message.headers` — standard email practice, owner-approved.
- Do NOT re-add IP capture "for security" (audit trails, anomaly detection, sybil resistance, etc.) — this was a deliberate trade-off, not an oversight. Design + rollout: `docs/superpowers/specs/2026-07-14-no-ip-storage-design.md`.

## useCurrentUser Pattern (services)

- `queryFn` must be pure — never call `useAuthStore.setUser()` inside a `queryFn`.
- Side effects on fresh query data belong in a `useEffect` on `query.data` outside the queryFn.

## Published Version Notes — breaking changes not signalled by the version number

Durable record of releases whose version number does NOT tell you what changed.
Check here before assuming a range is safe.

### `@oxyhq/core@13.2.0` — a BREAKING change shipped under a MINOR (deprecated)

`13.2.0` changed **`buildPaginationParams`'s return type from `URLSearchParams`
to `Record<string, string>`** — a runtime-breaking change to a function exported
from the package root — and shipped it as a MINOR, so a `^13.0.0` range could
pick it up silently.

- **Affected:** anyone calling `.toString()`, `.get()`, `.append()`, `.set()`,
  `.has()`, `.entries()`, `.forEach()` or `for...of` on the result. Those throw a
  `TypeError` — a runtime failure, not a compile error. Migration: use
  `buildSearchParams`, which is unchanged and still returns a `URLSearchParams`.
- **NOT affected:** anyone passing the result to `makeRequest`/`HttpService` —
  the common case, and the one the change exists to repair. `HttpService` reads
  GET params with `Object.keys(...)`, and `Object.keys(new URLSearchParams(...))`
  is `[]`, so that path was silently dropping the entire query string and
  collapsing every page onto one cache key. Those callers are fixed, not broken.
- **Status:** `13.2.0` is deprecated on npm. npm now resolves `^13.0.0` to
  `13.0.0` rather than `13.2.0`; an explicit `13.2.0` install still works but
  warns. The identical content is published as **`14.0.0`** under the correct
  major — **prefer `^14.0.0`**. `@oxyhq/services@23.1.0` pinned `core@^13.2.0`
  and is deprecated in favour of `23.2.0`, which pins `^14.0.0`.

Full detail: `packages/core/CHANGELOG.md`.

**The rule this cost us:** a publicly exported function's signature is public API
even when you can prove no consumer in this org uses it — the package is on
public npm, and semver exists precisely so consumers you cannot enumerate do not
have to trust your grep. When a change is runtime-breaking rather than type-only,
take the major.

## SDK Cache Sweep on Profile Writes (core)

`oxyServices.updateProfile()` calls `clearCacheByPrefix()` for:
- `GET:/session/user/`
- `GET:/users/me`
- `GET:/profiles/username/`
- The specific user id

Without this sweep the HTTP cache returns stale data and the username onboarding step loops.

## KeyManager Safety (core — critical)

- `createIdentity` / `importKeyPair` throw `IdentityAlreadyExistsError` if an identity already exists. Pass `{ overwrite: true }` to replace.
- Writes use `_persistIdentityAtomic`: backs up the EXISTING identity first, writes new primary → sign/verify probe → only then refreshes backup. A failed `createIdentity({overwrite:true})` rolls primary back to the exact prior bytes — never destroys the prior identity.
- **Identity slots live under DEDICATED expo-secure-store `keychainService`s — never the default.** Primary = `oxy_identity`, backup = `oxy_identity_backup`, both with `_v2`-suffixed key names (`keyManager.ts` `V2_SLOT_LAYOUT`). On Android, anything written WITHOUT an explicit `keychainService` shares expo-secure-store's single default AndroidKeyStore key (`key_v1`) — and expo-secure-store PERMANENTLY DELETES the ciphertext on the read path the instant decryption fails (BadPadding / missing key → `deleteItemImpl` + return `null`, never a throw), so co-located slots die together the moment that one shared key is invalidated. Any NEW secret slot class must get its own `keychainService`. Migration off the legacy default-service layout is lazy (runs on first touch) and interruption-safe (copy → read-back-verify → only then delete legacy) — never bypass it with a direct SecureStore read of an identity key.
- **A non-secret identity marker** (`oxy_identity_marker_v1` in AsyncStorage/localStorage, `identityMarker.ts`) records that an identity was ever provisioned on this device, independent of the keychain. Written by `_persistIdentityAtomic`, cleared only by `deleteIdentity`. It disambiguates "keys empty because this is a fresh install" from "keys empty because the keystore died" — a distinction the keys alone cannot make.
- `KeyManager.getIdentityStatus()` is the authoritative identity probe: `present` / `absent` (no keys, no marker — the ONLY state that may route to create/onboarding) / `lost` (marker present, keys gone — route to recovery, NEVER create) / `unavailable` (a storage read threw — NEVER cached, so callers retry).
- `hasIdentity()` / `getPublicKey()` THROW `IdentityUnavailableError` on a storage read failure instead of degrading to `false`/`null` — never catch that error and treat it as "no identity".
- `attemptIdentityRecovery()` restores a `lost` identity from the v2 backup slot, then the cross-app shared slot (Android EncryptedSharedPreferences bridge / iOS keychain group), validating the recovered public key against the marker's before accepting it — a source holding a different account is skipped, never silently switched.
- `hasIdentity()` requires both keys present, well-formed, and matching (not just key existence).
- `verifyIdentityIntegrity()` performs a full sign/verify probe, not just byte parsing.
- `restoreIdentityFromBackup()` is transient-error-safe: a keychain-read EXCEPTION is treated as transient → refuses to clobber a healthy-but-locked primary. Dual mismatch guards prevent silently switching accounts.
- Strict hex/length/range validation on all private/public key material.
- `canonicalPrivateKey(key) = key.toLowerCase().padStart(64, '0')` applied at every `ec.keyFromPrivate(...)` callsite.
- `isValidPrivateKey` rejects degenerate scalars via `^0{56}` check (rejects `'1'`, `'2'`, etc.).
- `deleteIdentity` signature: `(skipBackup=false, force=false, userConfirmed=false)`. `force=true` deletes the backup slot.

## PrivacySettings Type (core)

`PrivacySettings` interface lives in `packages/core/src/models/interfaces.ts`. `updateProfile`, `getPrivacySettings`, and `updatePrivacySettings` on `OxyServices` are typed against it — no `Record<string, any>` or `Promise<any>` on the SDK surface.

## Contact Discovery (api + core)

- Endpoint: `POST /contacts/discover` — accepts `{ hashedEmails: string[], hashedPhones: string[] }` (SHA-256 on client before sending; no PII stored server-side)
- Rate limited: 200 hashes per request, 5 requests/min/user
- Core mixin: `oxy.contacts.discoverContacts(hashedEmails, hashedPhones)`
- `User` model has `hashedEmail`, `hashedPhone`, `phone` fields; `hashedEmail` / `hashedPhone` auto-computed via pre-validate hook

## Accounts App Patterns (packages/accounts — "Accounts by Oxy")

**Post-PR #415: Accounts is KEYLESS and management-only.** All identity creation, key management, recovery phrase, backup, and key-based flows moved to `packages/commons`. Accounts signs in via the shared `OxyAccountDialog` from `@oxyhq/services` — one primary "Continue with Oxy" action, Commons QR / shared-keychain / automatic delivery (issue #691 Phases 4–5); there is no password option in this dialog. Account deletion deep-links to `commons://delete-account` — Accounts no longer owns the key-signed deletion flow.

- **i18n**: `LocaleProvider` + `useTranslation` hook in `packages/accounts/lib/i18n/`; 11 locales (EN + ES fully populated); device locale via `Intl.DateTimeFormat().resolvedOptions().locale` (no `expo-localization` native module needed)
- **Typed routes**: `typedRoutes: true` in `app.json` — all `router.push()` calls must use typed path strings, no `as any` casts
- **Error boundaries**: at root, `(tabs)`, and `(auth)` layout levels using an `ErrorFallback` component
- **Activity History**: `/(tabs)/activity.tsx` using `GET /security/activity` with infinite scroll
- **Font**: do NOT set `fontFamily: 'Inter-*'` — `BloomThemeProvider` sets Inter as `Text.defaultProps` globally
- **expo-router v56**: no `@react-navigation/*` direct imports; synthesize `{ type: 'OPEN_DRAWER' }` payloads inline
- **`(auth)` routing** (session-only gate): `(auth)`↔`(tabs)` now keys **purely on session** — `needsAuth = isAuthResolved ? !isAuthenticated : true`. No `hasIdentity`/`KeyManager` in routing. `(auth)/index.tsx`: session resolved + authenticated → `/(tabs)`; not authenticated → sign-in. Always clean up timers from entrance animations.
- **Username step**: use `useUpdateProfile().mutateAsync()`, NOT `oxyServices.updateProfile()` directly — gets optimistic update + cache invalidation. Stable initial value via lazy `useState` initializer (no `useEffect` reset on remount).
- **`useUpdatePrivacySettings`**: do NOT call `invalidateAccountQueries(queryClient)` in `onSuccess` (defeats optimistic merge). Use `{ ...previous, ...requested, ...incoming }` merge in `onMutate`. `onError` does targeted `invalidateQueries({ queryKey: queryKeys.privacy.settings(...) })` for reconciliation.
- **Web sign-in**: same in-app `OxyAccountDialog` as native — no redirects. No web identity creation (Commons is native-only; Accounts web is management after sign-in only).
- **Shared modules** (use these, don't re-duplicate): `utils/relative-time.ts` + `hooks/useRelativeTime.ts` (i18n-aware relative time); `utils/device-utils.ts` (getDeviceIcon, getDeviceDisplayName, DeviceRecord, groupDevicesByType); `hooks/useAvatarUrl.ts`; `hooks/useDebounce.ts`; `constants/payments.ts` (FAIRCOIN_WALLET_URL); `constants/drawer-screens.ts` (typed DrawerScreenConfig[] — lives in `constants/` NOT `app/` so expo-router doesn't register it as a route); `constants/styles.ts` (`floatingPosition`: `Platform.select({ web: 'fixed', default: 'absolute' })` for floating action bar / FAB — used by `(tabs)/_layout.tsx` + `components/ui/bottom-action-bar.tsx`).
- **Shared UI components** (use these, don't re-duplicate): `components/ui/empty-state-card.tsx` — `EmptyStateCard` (icon + title + subtitle, optional `subtitleColor?`) — single shared empty-state used by security + payments sections (replaced 3 duplicated inline empty states); `components/ui/circle-icon-badge.tsx` — `CircleIconBadge` (36dp circular icon wrapper) — shared across identity cards, payments info, home actions; `components/ui/quick-action-button.tsx` — accepts `size?` prop (default 48) — reused by `bottom-action-bar` and `home-bottom-actions` (home footer no longer hand-rolls badge buttons).
- **God-screen decomposition**: section components under `components/sections/` (+ shared `GroupedItem`/`PrioritizedGroupedItem` types in `components/sections/types.ts`), `components/security/`, `components/home/`, `components/payments/`; hooks under `hooks/home/*`; identity auto-sync in `hooks/identity/useIdentitySync.ts`; pure helpers `utils/security-recommendations.ts`, `utils/payment-utils.ts`.
- **`payments.tsx`**: reads `timestamp` field (NOT `createdAt`) for payment/transaction dates.
- **Removed unused deps**: `@radix-ui/react-tabs`, `react-responsive`, `@lottiefiles/dotlottie-react-native`, `expo-symbols`. KEEP `expo-document-picker` + `expo-image-manipulator` (lazy-loaded optional peers of `@oxyhq/services`) and `@lottiefiles/dotlottie-react` (hard-required by web lottie export).

## Commons App (packages/commons — "Commons by Oxy", PR #415)

**NATIVE-ONLY identity vault — no web build, no Cloudflare Pages project.** All key/identity UX from Accounts has been extracted here.

- **Bundle**: `so.oxy.commons`, scheme `commons`/`oxycommons`, package name `commons`
- **Purpose**: Hello Human onboarding, create/import identity, recovery phrase, encrypted backup, key display, biometric sign-in, QR scanner + approval screens for "Sign in with Oxy"
- **Metro config** (MANDATORY): mirrors `packages/accounts/metro.config.js` exactly — the Bloom single-instance `resolveRequest` rewrite is required to prevent duplicate React context crashes
- **Pinned native deps**: match accounts / whatever the current Expo SDK bundles — `package.json` is the source of truth, do not hardcode versions here; honor root `overrides`
- **Routing**: bidirectional Stack guard; `useOnboardingStatus` with `hasIdentity` gate is correct here (Commons legitimately owns the identity gate). Native-only: Hello Human → welcome → create/import → vault group `(vault)`. No web entry variants or web blockers.
- **Onboarding gate is LOCAL-FIRST — never key it on session/network state.** `useOnboardingStatus` decides routing PURELY from local reads (`KeyManager.getIdentityStatus()` + an offline-safe onboarding-complete milestone); `isAuthResolved` / the SDK's cold-boot loading flag must never gate, delay, or downgrade that local verdict (an active session is only consulted as an earlier, authoritative override, never a routing precondition). `'none'` (welcome/auto-create) requires a positive `absent` verdict AND no identity marker — a marker-backed `lost` verdict routes to the recover-identity screen, and `unavailable` (storage threw) routes to a neutral retry surface, never to welcome/create. The create/import preflight uses `KeyManager.getIdentityStatus({ bypassCache: true })` plus the marker to decide whether it's safe to generate a new identity — do not reintroduce a cached `getPublicKey()` preflight for this decision.
- **For account management**: Commons deep-links to `accounts://` (Accounts). Accounts deep-links to `commons://` for key/backup/recovery/delete.
- **Delete account flow**: `commons://delete-account` — key-signed deletion via `KeyManager.getPublicKey()` → sign `delete:${publicKey}:${ts}` → `DELETE /users/me`. Strict order: `deleteAccount` → `purgeIdentity` (primary AND backup, success-only) → `signOutAll`; local-purge failure is non-fatal.
- **Recovery phrase**: mandatory acknowledgement screen at `/(auth)/create-identity/recovery-phrase` before identity creation completes; persistent reminder in Security screen until acknowledged.
- **CI wiring**: `packages/commons` added to root bun workspaces + `commons:*` scripts. No Cloudflare Pages deploy job. Ships via EAS only.
- **A0 prereqs:** Commons' `oxy_dk_…` `ApplicationCredential` (clientId) is registered in production → `packages/commons/constants/oxy.ts` (overridable via `EXPO_PUBLIC_OXY_CLIENT_ID`), minted/reconciled idempotently by `bun run register:commons-clients` (`packages/api/scripts/register-commons-clients.ts`), which also UNIONs the staff-only `identity:approval` capability onto Commons' `Application` record — the deploy step that makes its installs eligible push-delivery targets for `POST /auth/session/deliver/:authorizeCode` (issue #691 Phase 4). **Still pending:** a real EAS project ID (`packages/commons/app.config.js` `projectId` is still empty).

**On-device testing safety (CRITICAL) — the hazard is UID-scoped, not Commons-package-scoped:** AndroidKeyStore aliases, which `expo-secure-store` wraps, belong to the shared Linux UID (`android:sharedUserId="so.oxy.shared"`), not to any individual package. EVERY package that declares that `sharedUserId` — Commons, Mention, Accounts, Allo, Homiio, and any dev/debug variant that still declares it — sits inside the SAME UID as a real Commons identity, so installing or updating ANY of them in place can orphan and destroy that identity's keys, not just an install of Commons itself. Critically, Android does NOT refuse a same-signer install of a *different* package into that UID: a debug build signed with the shared release keystore (e.g. a `.dev` variant sharing Commons' signer) installs cleanly as a new member of the UID, exactly as if Commons itself had been reinstalled. Mechanism: on next launch after any in-place install/update inside the UID, `expo-secure-store` can detect a "no corresponding KeyStore key" condition on the identity's alias and DELETE the now-undecryptable entry — BOTH the primary identity AND the on-device backup (same keystore master key) — dropping the user into create-identity onboarding. Commons is self-custody: there is NO server-side copy of the private key, so recovery is possible ONLY via the user's written 12-word recovery phrase (`RecoveryPhraseService.restoreFromPhrase`). Without it, the identity and account are permanently unrecoverable. Uninstalling the LAST package of a UID clears that UID's keystore entirely — so never `adb uninstall` anything sharing `so.oxy.shared` on a device with a live identity either.

**Safe pattern for device testing:** build a clean-room variant with a fresh `applicationId`/package name and `android:sharedUserId` REMOVED, so Android assigns it its own UID that can neither update nor share a keystore with anything already installed. Trade-off: it cold-boots with no shared session, so any test that needs a signed-in account has to sign in manually inside that variant.

**Verification recipe (get the field name right — this is the part that bites):** after installing, run `adb shell dumpsys package <id>` and read the **`appId=`** field — an isolated package shows its own numeric appId (e.g. `appId=10226`) distinct from the shared UID's appId (e.g. `10533` for `so.oxy.shared`). The field is `appId=`, NOT `userId=` — grepping the dumpsys output for `userId` returns zero lines even against a CORRECTLY isolated package, which is indistinguishable from a mistyped command, so don't rely on it. Also grep for `sharedUser` in the same output (expect zero hits for an isolated package), and diff `so.oxy.commons`'s own `lastUpdateTime` (`adb shell dumpsys package so.oxy.commons`) before and after as proof the real identity's package was never touched.

Rule: test identity/SSO flows on the EMULATOR, or on a physical device holding only a disposable test identity you can recreate. Ship real Commons updates to real devices ONLY through the store / EAS update channel (which handles keystore/data migration correctly) — never a developer `adb install -r` / `expo run:android` of ANY package sharing the UID. Treat any device holding a real identity as untouchable; see also "Android release signing — shared keychain" in `~/Oxy/AGENTS.md`.

## Self-Sovereign Identity Layer (PR #415)

### DID document (`did:web:oxy.so:u:<userId>`)

- DID is **account-anchored** on stable `_id`, not the keypair. Keypair = a verification method under `authMethods[]`.
- **Custodial** (no local key): `controller: [OXY_DID]`; `verificationMethod[]` from `publicKey` field if present.
- **Self-sovereign** (has Commons key): `controller: [did, OXY_DID]`; `verificationMethod[]` from `authMethods` (`EcdsaSecp256k1VerificationKey2019`, `publicKeyHex`, `#key-1`); `authentication`/`assertionMethod`.
- `alsoKnownAs[]` = `acct:<username>@oxy.so` + profile URL + `https://<verifiedDomain>` for each domain.
- `service[]` = Oxy API + profile endpoints.
- **Fully reversible**: link identity → DID becomes self-sovereign; unlink → reverts custodial. `userCache.invalidate(userId)` called on every link/unlink (pre-existing gap — now fixed in `authLinking.ts`).

**New API files:**
- `packages/api/src/services/did.service.ts` — `buildUserDid(userId)`, `buildDidDocument(user)` (derived on-demand, not stored)
- `packages/api/src/routes/did.ts` — `GET /u/:userId/did.json` (public; `Content-Type: application/json`; `Access-Control-Allow-Origin: *`; `Cache-Control: public, max-age=300`); `GET /.well-known/did.json` (Oxy org DID). Mounted in `server.ts` at root alongside federation handlers, **outside** the `/users` rate-limit group, no auth/CSRF.
- **Infra requirement** (pending): apex proxy must forward `oxy.so/u/*/did.json` + `oxy.so/.well-known/did.json` to the API. Fallback: anchor `did:web:api.oxy.so:u:<id>` (zero proxy work). See "Pending (post-merge)".

**New `User` model additions** (`packages/api/src/models/User.ts`):
- `did` virtual (derived from `_id`, surfaced in `toJSON`)
- `verifiedDomains?: [{domain, verifiedAt, method:'dns-txt'|'well-known'}]` + sparse index
- No new verification-method state — `authMethods` remains the single source.

### Signed Records

Envelope schema (in `@oxyhq/contracts`): `{version, type:'identity'|'profile', subject, issuer, record, issuedAt, publicKey, alg:'ES256K-DER-SHA256', signature}`. Signing input = `canonicalize` of everything except `publicKey` + `signature`.

- **`packages/core/src/crypto/canonicalJson.ts`**: `canonicalize(value)` (recursive key-sort/JCS-style; safe for nested objects unlike the flat `signRequestData` scheme). Export from `@oxyhq/core`.
- **`SignatureService.signRecord(type, subject, record)`** — client-side signing. Custodial users: server signs with Oxy's key as provenance attestation.
- **New API**: `packages/api/src/models/SignedRecord.ts` (append-only collection `signedrecords`); `packages/api/src/services/signedRecord.service.ts` (`verifyEnvelope`: recompute canonical input, verify sig, assert publicKey is a current VM, check freshness); `packages/api/src/routes/identity.ts`: `POST /identity/records` (auth), `GET /identity/records/:userId/:type` (public), `/verify`.

### Data Export

`GET /users/me/export` in `routes/identity.ts` (auth + `rl:identity:export:` 5/hr): signed open-format bundle `{$schema, exportedAt, did, didDocument, profile, verifiedDomains, authMethods (no secrets), signedRecords, appData, social, attestation}`. Oxy attestation = signature over `canonicalize(bundle)` with the Oxy key (`OXY_PRIVATE_KEY` env). No secrets leak — mirrors `formatUserResponse`.

**OXY signing key** (`OXY_PUBLIC_KEY` / `OXY_PRIVATE_KEY` env): required on oxy-api ECS for custodial DID attestation + export attestation. Pending — see "Pending (post-merge)".

### Domain Verification

`routes/identity.ts`:
- `POST /identity/domains` — issue token; instructions for DNS-TXT `_oxy-identity.<domain>=oxy-domain-verification=<token>` and HTTP `/.well-known/oxy-domain`
- `POST /identity/domains/:domain/verify` — DNS via `dns.promises.resolveTxt` OR well-known via `safeFetch` (SSRF-safe, never raw fetch), then push to `verifiedDomains`, invalidate userCache
- `DELETE /identity/domains/:domain`, `GET /identity/domains`
- Optional `DomainVerification` model (TTL token, mirrors `AuthChallenge`)
- Rate limits: `rl:identity:domainreq:` + `rl:identity:domainverify:`

Domain verification = a **badge** only (`alsoKnownAs` in DID). NOT domain-as-handle.

### Core Identity Mixin (`OxyServices.identity.ts`)

Registered in `MIXIN_PIPELINE` + `AllMixinInstances`. Methods: `resolveDid`, `getMyDid`, `listAuthMethods`, `linkIdentityKey` (sign + `/auth/link`), `unlinkAuthMethod`, `linkPassword`, `signRecord`, `publishRecord`, `getRecord`, `verifyRecord`, `exportMyData`, `requestDomainVerification`, `verifyDomain`, `listDomains`, `removeDomain`. Cache-sweeps `/users/me` + DID cache after mutations. Exports new types + `canonicalize` + `buildSignedRecord`.

## Sign in with Oxy — QR/Shared-Key Handoff (PR #415, extended by issue #691)

**User-facing label everywhere: "Sign in with Oxy"** — never say "Sign in with Commons"; the mechanism is invisible plumbing. The in-app `OxyAccountDialog` entry (issue #691, Phase 5) is NOT a menu of co-equal methods: it shows existing device accounts plus ONE primary **"Continue with Oxy"** action, and Oxy — not the user — picks how the request reaches the Commons identity (see "Automatic delivery selection" below). Scan-QR, passkey-on-this-device, and "Get Commons" are subordinate links behind a collapsed "Having trouble?" disclosure; there is no password option anywhere in this dialog.

### Mechanism A — Same-device shared-keychain SSO (native-only)

- Commons writes shared identity at creation (`createSharedIdentity` / `migrateToSharedIdentity`); optionally `storeSharedSession` for warm SSO.
- `OxyServices.signInWithSharedIdentity()` (native-only): `requestChallenge(sharedPubKey)` → sign with shared key → `verifyChallenge` (plants tokens). Returns null on web.
- **`shared-key-signin`** is a native-only step in the unified device-first cold boot (`runSessionColdBoot` in `@oxyhq/core`), with a per-step timeout.
- Each native app must declare iOS `keychain-access-groups` including `group.so.oxy.shared` (same Team ID) + Android shared-store config.

### Mechanism B — Cross-device QR handoff

New API endpoints (`packages/api/src/routes/auth.ts` + `authSession.service.ts`):

| Endpoint | Auth | Notes |
|----------|------|-------|
| `POST /auth/session/create` (extended) | optional | Adds `authorizeCode` (public QR handle) + `qrPayload` (`oxycommons://approve?v=1&code=<authorizeCode>&...`); `sessionToken` stays secret and is NEVER in the QR |
| `GET /auth/session/approve-info/:authorizeCode` | none | Returns server-resolved `Application` identity + scopes + `boundOrigin` + status; Commons renders this — never trusts raw QR strings |
| `POST /auth/session/authorize-signed/:authorizeCode` | none (key-signed) | `{publicKey, challenge, signature, timestamp}` via `verifyChallengeResponse` + atomic burn; resolves `User` by `publicKey`; `sessionService.createSession`; emits socket on `sessionToken` row |
| `POST /auth/session/deny/:authorizeCode` | none | Cancel + emit socket |

**QR payload**: `oxycommons://approve?v=1&code=<authorizeCode>&app=<appId>&origin=<rp-origin>&nonce=<rand>&exp=<ms>`. `authorizeCode` = 128-bit single-use 5-min origin-bound; `sessionToken` stays secret. Cross-device: Commons in-app camera scanner. Same-device: `oxycommons://` custom-scheme deep link.

**New rate-limit prefixes**: `rl:auth:session-approve-info:`, `rl:auth:session-authorize-signed:`

**Flow**: RP `startCommonsSignIn` → `POST /auth/session/create` (gets `sessionToken` + public `authorizeCode`) → render QR (web) / deep-link (same-device) → Commons scans → `GET /auth/session/approve-info/:code` → biometric → `POST /auth/session/authorize-signed/:code` (key-signed, no bearer) → RP socket/poll → existing `claimSessionByToken` → tokens planted.

### Automatic delivery selection (issue #691, Phase 4)

Rather than a menu of transports, the RP asks Oxy to DELIVER the pending request and lets the answer pick the route:

- **`PushToken`** (`packages/api/src/models/PushToken.ts`) gained `deviceId` + `applicationId` — the latter resolved SERVER-side from the caller's `clientId` at registration, never client-asserted. Commons registers an **Expo push token** (`getExpoPushTokenAsync`, never a raw device token) via `oxyServices.registerPushToken`/`unregisterPushToken`.
- **`POST /auth/session/deliver/:authorizeCode`** — **bearer REQUIRED, and the bearer IS the security control:** delivery targets only the AUTHENTICATED caller's own installs, never an identity resolved from the request body/QR — so a sign-in prompt can never be pushed at someone by typing their username into an unauthenticated browser. Eligible installs are those registered by an `Application` carrying the staff-controlled **`identity:approval`** capability (`packages/api/src/utils/applicationCapabilities.ts`, `APPLICATION_CAPABILITIES`/`hasApplicationCapability`) — a registry decision, never a hardcoded client/bundle id. Push payload is exactly `{ type, approvalUrl }` — no app name, no scopes, no action buttons (Commons re-fetches all display data from `GET /auth/session/approve-info`; approval always happens inside the vault behind biometrics). Responds with COUNTS only, `{ delivered, targets }` — `targets: 0` is a NORMAL "no capable install" outcome, not an error.
- **`POST /auth/session/opened/:authorizeCode`** — no bearer (the public `authorizeCode` is the credential); writes `openedAt` **at most once**, only while `pending`, and never touches `status`.
- **Progress is timestamps, never statuses.** `AuthSession.pushSentAt` / `openedAt` ride beside the small authoritative state machine (`pending → authorized → consumed`, plus `cancelled`/`expired`) — `GET /auth/session/status/:sessionToken` reports `pushSentAt`/`openedAt` alongside `authorized` so a progress signal can never be mistaken for an authorization.
- **`selectCommonsDelivery({ platform, commonsAvailable, pushTargets })`** (`@oxyhq/core`, `packages/core/src/utils/commonsDelivery.ts`) is the pure decision, run by `AccountDialogController`: mobile + a VERIFIED Commons app-link openable on this device → `'open-commons'`; else `pushTargets >= 1` → `'await-push'`; else → `'qr'`. Exactly ONE route is primary, resolved once; the SDK never silently cascades from one delivery surface to the next.
- **Deploy step:** push delivery has zero eligible targets until Commons' `Application` record carries `identity:approval`. `bun run register:commons-clients` (`packages/api/scripts/register-commons-clients.ts` — idempotent, `DRY_RUN=1` supported, run as a one-shot ECS task like the reputation migration) mints/reuses Commons' `oxy_dk_…` client id AND UNIONs the capability onto the existing record; already applied in production (`packages/commons/constants/oxy.ts` carries the real minted id).

### One primary action, one confirmation (issue #691, Phase 5)

- `OxyAuthChooser`'s `signin`/`add` entry (`packages/services/src/ui/components/authChooser/SignInEntryView.tsx`): existing device accounts, then ONE primary "Continue with Oxy" button. Scan-QR / passkey-on-this-device / "Get Commons" are `TroubleDisclosure` links (`authChooser/TroubleDisclosure.tsx`) behind "Having trouble?", collapsed by default and auto-revealed only when the chosen route reports `signIn.routeFailed`. Account CREATION keeps its own visible subordinate link (it is not a competing auth method).
- Commons' approval screen (`packages/commons/components/commons-signin/approval-request.tsx`) is ONE confirmation: "Confirm identity" opens the device biometric/passcode prompt DIRECTLY — no intermediate "Continue" step. The only other answer is "This wasn't me"; a plain dismiss answers nothing. `POST /auth/session/deny/:authorizeCode` accepts an optional `reason` from a CLOSED set — `COMMONS_DENY_REASONS` in `@oxyhq/contracts` (`['declined', 'not_me']`) — anything else 400s before the handler runs.
- The approval screen shows a coarse, server-derived `requesterLabel` (e.g. "Chrome on Windows", max 64 chars — no full User-Agent, no IP, no geolocation), computed from the REQUEST'S OWN User-Agent header — never from the scanned QR/deep-link, which is requester-controlled and must never be a display source.

### Mechanism C — OAuth-bound Commons approval (issue #691, Phase 3 + IdP lane)

`AuthSession` also carries an optional OAuth binding so the SAME request model (create → approve → finalize) can mint a standard OAuth authorization code instead of a device sign-in: `purpose: 'device_sign_in' | 'oauth_authorization'` + `oauth?: { redirectUri, codeChallenge, codeChallengeMethod: 'S256', scopes, subjectAccountId? }`. `oxy.startCommonsSignIn({ clientId, oauth })` / `POST /auth/session/create` attach the binding — the `redirectUri` is validated against the SAME exact-match, constant-time allowlist `POST /auth/oauth/authorize` uses, and a non-S256 challenge is refused. Commons' approval screen and `approveCommonsSignIn`/`denyCommonsSignIn` are purpose-agnostic and need NO change to approve one. `oxy.finalizeCommonsOAuth(sessionToken)` / `POST /auth/session/finalize/:sessionToken` (no bearer — the secret `sessionToken` is the credential) mints exactly ONE single-use `AuthCode` via a reservation-style atomic `findOneAndUpdate` — the code id is allocated in the SAME update that spends the session, so a lost race or a later mint failure leaves the request spent rather than risking a double-mint — and refuses to run twice. A delegated `subjectAccountId` ("app will act as: org") is re-checked against the identity's live `account:act_as` membership at BOTH approval and finalize; a personal account can never be a delegated subject. `POST /auth/session/claim` (the device-sign-in claim) explicitly refuses an `oauth_authorization`-purpose session — an OAuth approval mints no access token, ever.

**IdP no-session lane (`packages/auth`):** when `auth.oxy.so/authorize` receives a full PKCE-bound OAuth request and cold boot finds no usable bearer on the IdP origin, `CommonsOAuthLane` (`packages/auth/components/commons-oauth-request.tsx`, orchestrated by `packages/auth/lib/commons-oauth-request.ts`) creates an OAuth-bound `AuthSession`, shows the QR, polls for approval, and finalizes into the authorization code — one continuous action with no sign-in on the IdP. The secret `sessionToken` never reaches the view/QR/URL; only the public `authorizeCode` travels. OAuth-bound `session/create` from the IdP skips the trusted-app browser-origin gate (redirect_uri is already exact-matched) and binds `boundOrigin` to the relying party's redirect origin, not `auth.oxy.so`. Visitors who already hold a bearer on the IdP still use the unchanged session-bearing consent path.

### SDK methods (core + services)

- `@oxyhq/core` `OxyServices.auth.ts`: `startCommonsSignIn({ clientId, oauth? })`, poll (reuse `pollSessionStatus`), `signInWithSharedIdentity`, `deliverCommonsSignIn(authorizeCode)` (bearer, Phase 4 push delivery), `finalizeCommonsOAuth(sessionToken)` (Phase 3); Commons-side `getCommonsApprovalInfo` / `approveCommonsSignIn` / `denyCommonsSignIn` / `markCommonsApprovalOpened(authorizeCode)` (Phase 4 progress ping, no bearer, best-effort) / `registerPushToken` / `unregisterPushToken`.
- `@oxyhq/services`: `OxyAccountDialog` surfaces `authorizeCode` + the structured `qrPayload` — renders the QR on web (QR only; shared-key is native-only) and deep-links Commons on the same device natively; `AccountDialogController` (`@oxyhq/core`) drives `selectCommonsDelivery` end to end.

## HttpService (services)

- On React Native (Expo 56), FormData uploads route through `XMLHttpRequest` — do NOT use fetch for multipart uploads on RN (Expo 56's fetch rejects RN file descriptors).
- **Web `{uri}` upload descriptors:** the browser's `FormData` can't read bytes from a `{uri}` object (only RN's can). On web, `assetUpload` materializes `{uri}` → `Blob` via `fetch` before appending (core ≥3.10.1); the API rejects 0-byte uploads with `400 Empty file`. Never persist/append an empty file.

## Offline Mutation Queue (services)

- React Query `networkMode: 'offlineFirst'` with stable `mutationKey` on all mutations
- `useMutationStatus` aggregator hook surfaces "Syncing…" indicators across the app

## Offline-First Persistence (services)

- `@tanstack/react-query-persist-client` wired in `@oxyhq/services` (AsyncStorage; localStorage-backed on web).
- Query whitelist: `accounts`, `users`, `sessions`, `devices`, `privacy`, `payments` queries are persisted; mutations always persisted; 30-day TTL; 1s throttle; v1 cache cleanup on startup.
- `OxyProvider` awaits `restored` before exposing the QueryClient → first paint serves cached data, not a loading spinner.
- `useOnlineStatus()` hook in `@oxyhq/services` — built on `useSyncExternalStore` over `onlineManager`; use for offline banners in app UIs.
- TanStack Query must use a consistent `^5.x` major version across services, console, and test-app-expo — check each workspace's `package.json` for the pinned range.

## useSessionSocket (services)

- Uses an **explicit switch with a strict whitelist**: only `session_removed`, `device_removed`, `sessions_removed` events may trigger a local sign-out.
- **Never** add an `else` / default branch that calls sign-out — unknown events log a dev warning only.
- Shape: `SessionEventType` union + `SessionUpdatePayload` interface; extracted `refreshSessionsSafe` + `triggerLocalSignOut` helpers; no `logout` prop.

## BottomSheet Gesture Patterns (services)

- `closeGenerationRef` bumped on each `open()`; every close callback captures the generation at commit time — stale callbacks from cancelled close cycles no-op.
- Body pan uses `manualActivation()` with `simultaneousWithExternalGesture(scrollViewRef)` — only activates when scroll is at top AND downward movement >8dp. Handle pan is unconditional.
- Modal contents **must** wrap children in `<GestureHandlerRootView>` — RN's `Modal` renders into its own window; the app-root GHRV does not extend into it.
- Backdrop dims proportionally with drag distance (iOS Photos pattern).
- `scrollable?: boolean` prop (default `true`). Set `false` for sheets that own a `VirtualizedList` (no internal ScrollView wrapping).
- `getSheetConfig(routeName, screenProps)` in `navigation/routes.ts` returns `{ scrollable }` per route. `FileManagement` in image-only-picker mode gets `scrollable: false`.

## PhotoPickerView (services)

Activated inside `FileManagementScreen` when `isImageOnlyPicker` is true. Apple Photos-style UI:
- Translucent top bar, full-bleed black backdrop, 3-up phone / 4-up tablet grid.
- Primary ring + spring pulse on selection; sibling dim to 0.6 opacity; numbered selection badge.
- FadeIn stagger 15ms/cell capped at 800ms; skips when `AccessibilityInfo.isReduceMotionEnabled()`.
- Non-blocking 2px upload progress in header; pull-to-refresh; haptics via dynamic `expo-haptics` import.
- Existing file-management flow untouched.

## AvatarCropScreen (services — accounts)

- Translucent top bar (Cancel / title / primary Done CTA), full-bleed `#000` canvas.
- 3×3 thirds grid fades 800ms after gestures end; white ring; floating zoom chip during pinch.
- Entrance spring; haptics on reset / zoom limits / confirm.
- `ActivityIndicator` + "Saving…" during processing; Reset link; full a11y + `announceForAccessibility`; reduced-motion respect.
- i18n keys under `editProfile.crop.*` and `editProfile.toasts.crop*` in en-US.json + es-ES.json.

## Auth (device-first)

Auth is device-first: `deviceId` + `deviceSecret` as transport (mint via `POST /session/device/token`; no refresh-token family, no `#oxy_boot` bootstrap), `DeviceSession` as server authority, one `OxyProvider` (`@oxyhq/services`) on web and native. Relying-party origins are **zero-cookie**; `auth.oxy.so` alone holds the host-only `__Host-oxy-device` handle — see "The cookie rule, restated" in the Auth / Session Contract above and `docs/adr/0003-browser-device-session-hub.md`. Canonical docs: `docs/auth/index.md` (start there — it is the one page answerable for being right, and it names what is built, what is not, and what is unverified) + `docs/SESSION-ARCHITECTURE.md` (see also `docs/auth/device-session.md`, `docs/auth/integration-guide.md`, and the ADRs under `docs/adr/`). `docs/architecture/` holds closed plan records that predate the multi-principal model — provenance, not mechanism. The full contract lives in "Auth / Session Contract" above — legacy browser-federation/SSO machinery (FedCM etc.) and the refresh/bootstrap transport were deleted end to end; do not reintroduce any of it.

- **Invalidated bearer token = local sign-out in `@oxyhq/services`**: `HttpService` clears tokens on 401 and emits `onTokensChanged(null)`. `OxyContext` MUST treat that as authoritative when a user is currently authenticated: clear session state, clear managed accounts, and disable private fetches until a new token/session is restored. Never let `isAuthenticated` remain true after `oxyServices.getAccessToken()` becomes null. Consumer apps gate private work with SDK state only: `useAuth().canUsePrivateApi` / `useAuth().isPrivateApiPending`.

## Sign-In Token Planting

`@oxyhq/core` `OxyServices.verifyChallenge()` now calls `setTokens(accessToken, refreshToken ?? '')` internally before returning — matching the behaviour of `claimSessionByToken`. Consumers (including `services` `useAuthOperations.performSignIn`) no longer need to hand-plant the token or fall back to the bearer-protected `getTokenBySession` after `verifyChallenge`. Just await `verifyChallenge` and proceed; the SDK has already planted the token.

**Token-less new-identity onboarding**: the 401 fix (avoiding bearer-protected `getTokenBySession` for a brand-new identity that has no session yet) is preserved — `verifyChallenge`'s internal `setTokens` call handles it.

## New React Query Hooks (@oxyhq/services — exported from package root)

`useUserSubscription`, `useUserPayments`, `useUserWallet`, `useUserWalletTransactions`, `useAccountStorageUsage` — with typed returns (`Subscription`, `Payment`, `Wallet`, `WalletTransaction` in `ui/hooks/queries/paymentTypes.ts`). `payments` + `storage` query-key namespaces added; `payments` whitelisted for offline persistence.

## Bloom Worklets Safety (@oxyhq/bloom)

- BottomSheet pan context must use a **primitive** `SharedValue` (`contextY = useSharedValue(0)`), NEVER an object-valued SharedValue — object SharedValues mutated inside worklets crash under `react-native-worklets@0.8.3` (`removeListener` on UI thread).
- `hooks/mergeRefs.ts` returns a plain `(instance: T|null) => void` (not `React.RefCallback`) so the ref stays assignable across duplicate `@types/react` copies (RN 0.85 / React 19).

## Terminology

- **OxyServices** — main API client class (in core)
- **OxyProvider** — the ONE React context provider (in services; web + native)
- **useOxy / useAuth** — auth hooks (services; web + native)
- **OxyAccountDialog** — unified account switcher + sign-in dialog (Bloom `<Dialog>`)
- **Bottom sheet** — native modal navigation system in services (29+ screens; auth flows use the dialog, not sheets)
- **LogoIcon / LogoText** — Bloom-themed logo exports from `@oxyhq/services`

## Auth App (packages/auth)

Standalone Vite app at `auth.oxy.so` — the **OAuth authorize/consent IdP** for third-party "Sign in with Oxy" (login, signup, authorize, recover, social-callback). It renders the shared `@oxyhq/services` auth surfaces via RN Web.

**ARCHITECTURE: the auth app is a device-first origin AND the OAuth authorize/consent IdP — NOT a Relying Party**
- It mounts `OxyProvider` from `@oxyhq/services` with NO special props (`packages/auth/src/main.tsx`): it runs the SAME device-first cold boot every Oxy app runs (restore THIS origin's device session from its own persisted `{deviceId, deviceSecret}`), enumerates the device directory through `useDeviceSwitcher`, authenticates through the SDK's `signInWithPassword` / `completeTwoFactorSignIn` / `handleWebSession` funnels, and switches through `activateContext`. There is NO transport/chooser exception — the IdP is a device-first origin like accounts.oxy.so. The former `coldBoot={false}` exception existed for the SSO bounce the zero-cookie cutover deleted; it is gone.
- **Still a shell, NOT a Relying Party:** the IdP does not lose its authorize/consent role. After the SDK authenticates the user device-first, `authorize.tsx` still emits the OAuth authorization code for the third-party (`POST /auth/oauth/authorize`, gated by `GET /auth/oauth/consent`) using the SDK's ACTIVE-account bearer (`oxyServices.getAccessToken()`). Do NOT turn it into an RP that bounces elsewhere for its own session.
- `authorize.tsx` renders **`OxyConsentScreen`** from `@oxyhq/services` — the single OAuth consent surface (shows the registered `Application` identity + `privacyPolicyUrl`/`termsUrl`; the auto-approve decision is the registry-based `isTrustedApplication()` predicate server-side). The account chooser is the shared `AccountChooser` fed by `useDeviceSwitcher` (more than one context) or the consent screen directly (a single one).
- Consent/password/signup/recover keep their DOM+Bloom shell (`AuthFormLayout`, `login-form.tsx`, etc.); the login page drives the SDK device-first funnels.
- **No account management.** `accounts.oxy.so` owns it exclusively; the IdP's `/settings` + `/settings/password` + `/settings/linked-accounts` routes permanently redirect to `accounts.oxy.so/security`, and `/settings/sessions` → `accounts.oxy.so/sessions` (`ExternalRedirect` routes in `src/main.tsx`).
- RP apps (Mention, accounts, console, inbox, Allo, Homiio) never redirect users to `auth.oxy.so` for first-party sign-in — their in-app dialog handles it; `auth.oxy.so` exists for the third-party OAuth redirect flow.

**Device-account chooser — same device-first SDK chain as every app (no bespoke IdP feed)**
- The chooser reads `useDeviceSwitcher()` from `@oxyhq/services` (the SAME device directory + `buildSwitcherRows` projection the SDK's own switcher renders); selecting a row calls `activateContext(contextId)` — the `principal acting as account` PAIR, never an account id. There is NO `oxy_device` cookie, NO `/auth/device/resolve` call, NO `/api/device-accounts` Pages Function, and NO `deviceResolve*` contract — all deleted in the 2c cutover. (The IdP's own `__Host-oxy-device` hub handle is a different thing entirely: it addresses THIS browser's device session server-side and is never a chooser feed.) `login-form.tsx` and `authorize.tsx` feed the shared presentational `AccountChooser` with `SwitcherPrincipalRow[]`, grouped by person.
- `user.name` is ALWAYS the structured object `{ first?, last?, full?, displayName? }` — NEVER a plain `z.string()`. `displayName` is optional (see `@oxyhq/contracts` `userNameSchema`).

**Key patterns:**
- `AuthFormLayout` + `AuthFormHeader` — shared layout for all auth screens
- `AuthLayout` (route layout) — persistent logo/footer, route-level fade transitions via `useNavigationType()`
- Login form multi-step: identifier → password → 2FA, with per-step animations
- `applyColorPreset()` from `lib/bloom-css.ts` — applies user's Bloom color theme to CSS vars on `:root`
- `OxyServices.lookupUsername()` — lightweight user lookup for login flow (validates existence + gets color)
- Zod schemas in `lib/schemas.ts` for API response validation (the shared `loginResultSchema` from `@oxyhq/contracts` validates the `/auth/login` + `/auth/signup` session responses committed via `handleWebSession`)

**Anti-patterns to avoid:**
- No `useEffect` for syncing props to state — derive from props during render
- No `useEffect` for firing toasts — call `toast()` directly in event handlers
- No `useEffect` for focus — use `requestAnimationFrame` in event handlers
- No `Suspense` wrappers unless using `React.lazy()` or `use()`
- No render-body side effects — use `useEffect` for `window.location.href`, or `<Navigate>` from react-router

**API endpoints used:**
- `GET /auth/lookup/:username` — lightweight username lookup (exists, color, avatar, displayName)
- `POST /auth/login` — password login
- `POST /security/2fa/verify-login` — complete a login that requires 2FA (NOT `/auth/2fa/verify` — that path validates/enables 2FA on an already-authenticated session)
- `POST /auth/signup` — account creation
- `POST /auth/recover/*` — password recovery flow
- `GET /users/me` — current session check
- `POST /auth/oauth/authorize`, `GET /auth/oauth/consent`, `GET /auth/oauth/client/:clientId`, `POST /auth/oauth/token`, `GET /auth/oauth/userinfo` — the third-party OAuth authorize/consent/token surface this app exists to serve. The token and userinfo endpoints speak RFC 6749 / OIDC on the wire (form-urlencoded request, FLAT response, `{ error, error_description }` failures) and are the one place in the API that does NOT use the `{ data }` / `{ error, message }` envelopes — see `packages/api/src/utils/oauthResponse.ts`
- `POST /auth/social/:provider` — social sign-in (now returns the device-first session arm incl. `deviceSecret`, committed via `handleWebSession`)

**`bun test` module mocks — the `@oxyhq/core` allowlist is the one that bites.** `packages/auth/lib/__tests__/setup-contracts-source.ts` maps `@oxyhq/contracts` to its WHOLE source (`mock.module("@oxyhq/contracts", () => contractsSource)`), as do the eight Jest `moduleNameMapper` entries in the other packages — those cannot drift when a runtime export is added. `setup-core-source.ts` is different: it is a hand-written ALLOWLIST of individual `@oxyhq/core` helpers, because importing core's real entry pulls optional RN modules bun cannot parse. Adding a `@oxyhq/core` VALUE import to auth app source without adding it there makes bun abort the WHOLE importing test file (`SyntaxError: Export named '…' not found`), so its cases silently leave the run rather than failing — `120 pass, 1 fail` while four `hub-passkey` cases had vanished. `core-mock-surface.test.ts` now fails the build on that drift, in both directions. Do NOT replace that allowlist with a whole-source mock; the RN-module parse failure is why it exists.

**Debugging rule this cost a session, twice in one day: check the layer BELOW the one the error names before accepting its diagnosis.** The bun error above names `packages/core/dist/esm/index.js` and a function nobody had touched — the truth was auth's test-time mock of that specifier, one layer down; core's built output was correct (the export was present at `dist/esm/index.js:39`). The same shape appeared in an AWS IAM trust policy where "the entry is missing" and "the entry does not match" are indistinguishable from a `describe`. Reproduce on a clean checkout of the BASE branch first: it separates "my change broke this" from "this was already broken", which a warm worktree cannot. Note also that a `pull_request` check runs on the MERGE commit, so a PR inherits `main`'s failures — read `HEAD is now at <sha> Merge <pr> into <base>` in the checkout log before assuming a red check is yours.

**The SPA plus ONE Pages Functions directory — `functions/hub/*`, and nothing else.** The device-account chooser is still served entirely by the device-first SDK (`useDeviceSwitcher`); the `/api/device-accounts` feed deleted in the 2c cutover stays deleted. What `functions/` carries now is the browser DeviceSession hub (issue #937 Phase 5, ADR 0003): six `POST /hub/*` routes that read/set/rotate/revoke `__Host-oxy-device`, resolve the browser's device session, and run the authorize lane. Everything else is static, with SPA history-fallback for unmatched navigations.
- The handlers live in `packages/auth/hub/` and each `functions/hub/*.ts` is a three-line adapter, so the layer is testable under `bun test` (`hub/__tests__`) with no Worker.
- **Neither credential reaches the browser's script context.** The handle is `HttpOnly`; the device-wide access token the API mints from it is used at the edge and discarded. That is why `/hub/authorize` exists at all rather than the SPA calling `POST /auth/oauth/authorize` itself.
- CSRF is live again for these six, and nowhere else: `POST`-only, `Origin` exactly equal to the deployment's own origin (**absent is refused**), `Sec-Fetch-Site: same-origin` when sent, and a required `X-Oxy-Hub: 1` that no cross-site context can set without a preflight this layer never answers.
- **Use a Cloudflare Pages Functions DIRECTORY (`functions/`, file-based routing), never an advanced-mode single `dist/_worker.js`.** CF Pages was not detecting/invoking the advanced-mode worker on this project AT ALL (reproduced even on the direct `<hash>.oxy-auth.pages.dev` deployment URL); the fix (commit `1141ddb7`/#545) was migrating to the Functions-directory shape CF reliably detects. Deploy via a direct `bunx wrangler@4 pages deploy dist ...` `run:` step — never through npm/npx (npm's Arborist chokes on the repo-root `overrides["@oxyhq/bloom"]`, `npm error EOVERRIDE`; only bun's resolver tolerates it).
- `_headers` covers static assets only, NOT Function responses — the hub handlers restate `no-store`, `X-Frame-Options: DENY` and `X-Content-Type-Options` themselves.
- **The page half is behind ONE flag, `VITE_OXY_BROWSER_HUB`, default OFF, and strictly `"1"`.** OFF is byte-for-byte today's IdP: the SDK's per-origin `{deviceId, deviceSecret}`, the normal cold boot, `/authorize` served by `src/pages/authorize.tsx`, and not one `/hub/*` request. ON routes `/authorize` to `src/pages/hub-authorize.tsx` AND mounts `OxyProvider` with `deviceCredentialStorage="ephemeral"` — the hub is AUTHORITATIVE, not first in a fallback order, so this origin persists no device credential of its own. Never make it a fallback: "try the hub, else localStorage" is the dual authority ADR 0003 removes, and its failure mode is a revoked hub the browser silently survives.
- **Flipping that flag is the BROWSER-VERIFICATION GATE.** It comes out when somebody has actually run Chrome, Safari and Firefox, private windows and third-party-cookies-blocked against the lane — never on reasoning, and never on the strength of the suite, which cannot see a cookie jar.
- The hub's establishment lane is a plain `device_sign_in` Commons request, NOT the OAuth-bound one: an OAuth approval mints no session by design, so it can never establish a hub. Password and passkey sign-in on the IdP do not establish one either — that lane is not built.
- Leftover per-apex `auth.<rp-apex>` CNAMEs and the deleted federation-era IdP env vars are INERT — nothing reads them; pending decommission in `oxy-infra`. Do not add new configuration that depends on them.
- Changes require a redeploy of auth.oxy.so to take effect in production.

## Commons Civic Identity Layer — Oxy ID (Fases 0–4)

**Concept:** Commons by Oxy (`packages/commons`, native-only) is the user-facing UI for their **"Oxy ID"** — a self-sovereign civic identity built on DID + cryptographic keys + verifiable reputation + credentials + proof-of-personhood. The civic ENGINE lives server-side in `packages/api/src/services/civic/` + `packages/api/src/routes/civic.ts`. Ownership is proven by CRYPTO (per-subject hash-chained signed records), not by Oxy granting it. There is **zero "DNI"** terminology anywhere — the canonical name is "Oxy ID".

**Civic contracts:** `packages/contracts/src/civic.ts` — Zod schemas + inferred types for all civic surfaces. Consumed as `workspace:*` by api/core/services. **NOT published to npm.** Do not bump `@oxyhq/contracts` version for civic-only additions until Fases 0–4 are deployed and stable.

### Fase 0 — Signed Records v2 (hash chain)

- **Envelope v2** (`version:2, seq, prev, collection, rkey`): adds sequential ledger semantics on top of the v1 signing envelope. `seq` = monotone counter per `(subject, collection)`; `prev` = SHA-256 of the previous envelope JSON (or null for the first). Forms a per-subject, per-collection hash chain.
- **`RepoHead`** model (collection `repoheads`): one document per `(subject, collection)`, stores `seq + envelopeHash` — O(1) head lookup without scanning the chain.
- **`SignedRecord.nsid`** — the column name for `collection` is `nsid` (Namespaced Identifier, e.g. `app.oxy.card`, `app.oxy.credential`). Use `nsid` in queries; `collection` is the schema/SDK alias.
- **`signedRecordSigningInput` / `canonicalize`** from `packages/core/src/crypto/canonicalJson.ts` — signing input is `canonicalize(envelopeWithoutSignature)`. Used identically by client and server.
- **`verifyEnvelope` branching** in `packages/api/src/services/signedRecord.service.ts`: issuer === subject → self-signed (verify against subject's current VM); issuer === `OXY_DID` → custodial (verify via `verifySecret`-gated Oxy key); else → untrusted, reject.

### Fase 1 — Oxy Trust Civic Engine (reputation via attestations)

Reputation awards are NEVER self-issued. The flow: users generate signed attestation payloads client-side → civic service evaluates quorum/rules → calls `reputationService.award(...)` in-process with `emitAttestation:true` → awards are appended to the ledger as Oxy-signed `reputation_attestation` records.

**Award weights (civic categories):**
| Action | Points | Category |
|--------|--------|----------|
| `real_life_attested` | +25 | `physical` |
| `peer_validated` | +8 | `trust` |
| `validation_correct` | +3 | `trust` |
| `validation_incorrect` | -10 | `trust` |
| `personhood_vouched` | +5 | `trust` |
| `vouch_slashed` | -20 | `penalty` |

**Trust tiers** (same as base reputation): new → trusted (≥100) → high_trust (≥500) → verified (`User.verified`) → restricted (total<0 or abuseScore≥0.5).

### Fase 2 — Anti-gaming (real-life QR attestation + validator jury)

**Real-life QR attestation:** B opens Commons and scans A's `oxycommons://attest?subject=…&ctx=…&nonce=…&exp=…` QR. Commons shows A's public card, biometric-gates B's approval, then B signs an attestation on-device and POSTs to `POST /civic/attest`. Server verifies both signatures, checks exclusion rules, and awards `real_life_attested`.

**Validator jury:** contested or fresh attestations queue for random jury review. Selection: weighted-reservoir algorithm with `rngSeed` stored in the `ValidationRequest` document for audit. Graph/device/IP exclusion via `packages/api/src/services/civic/graphExclusion.ts` (rejects validators who share a device fingerprint, IP range, or have previously interacted with the subject). Affinity throttle prevents any pair from repeatedly validating each other. Quorum tally → `peer_validated` award; reversal of a prior vote → `vouch_slashed` penalty.

**Key files:**
- `packages/api/src/services/civic/graphExclusion.ts` — exclusion predicate
- `packages/api/src/services/civic/jury.service.ts` — weighted-reservoir selection, quorum, slash
- `packages/api/src/routes/civic.ts` — all civic endpoints (`/civic/*`)

### Real-Life Attestation transport — QR only

- The ONLY transport is the attest QR: `buildAttestQrPayload` → `oxycommons://attest?subject=…&ctx=…&nonce=…&exp=…` (raw query keys, there is NO `payload=` wrapper). A shows it, B scans it — in-app via `(scan)/index.tsx`, or from the system camera, which deep-links straight into `(scan)/attest`.
- **NFC/HCE was removed (2026-07-22).** It carried byte-for-byte the same payload, could only ever emit on Android (Apple gives no HCE to third-party apps), and forced a patch of the abandoned `react-native-hce` (dead `jcenter()` repos vs Gradle 9). Do NOT reintroduce it without owning the native module — `react-native-hce` is not an option. Design: `docs/superpowers/specs/2026-07-21-remove-nfc-hce-design.md`.
- Card feedback: the `attestGlow` SharedValue is threaded through `TiltContext` into the Skia canvas, driven by the `civic:attested` socket event to room `user:<subjectUserId>` emitted by `POST /civic/attestations` (payload `{byUserId, recordId, points, at, subjectUserId}` — clients drop malformed payloads whole and scope the effect to the active identity).
- Deploy-order rule: the api must deploy before a Commons build that requires new `civic:attested` payload fields ships (old api + new client = events dropped by the strict whitelist).

### Fase 3 — Proof of Personhood

**Mechanism:** multi-signal web-of-trust combining signed personhood vouches + real-life attestations + biometric confirmation.

**`utils/personhoodDerive.ts`:** evidence scoring formula — `evidence = 0.50 × vouches + 0.35 × realLife + 0.15 × biometric`; threshold θ = 0.60; if evidence ≥ θ, sets `User.verified = true` → reputation tier becomes `verified`.

**Vouch staking:** `POST /civic/vouch` — voucher signs a `personhood_vouch` record on-device; stake is burned if the vouch is later reversed (sets `vouch_slashed` penalty). `POST /civic/vouch/withdraw` — explicit withdrawal before system reversal avoids the slash penalty.

**Sybil clustering:** `packages/api/src/services/sybil.service.ts` — graph clustering on shared device fingerprints, IP ranges, and attestation patterns. Flagged clusters receive reduced evidence weight.

**Random audits:** reuse the Fase 2 jury mechanism on a random sample of verified users. Audit failure triggers `vouch_slashed` cascade on all vouches that user issued.

**`User.isSeedVerifier`:** bootstrap field on the `User` model. Set manually for the first batch of trusted users to seed the web-of-trust (required before personhood flows can propagate). Pending: populate seed verifiers in production.

### Fase 4 — Verifiable Credentials

**Collection NSID:** `app.oxy.credential`. One signed record per credential; `rkey` = credential UUID (unique per holder DID).

**Issuers:**
- **User-issued (self-signed):** `issuer === subject`. For personal attestations, claims about oneself.
- **Org-issued:** `issuer` = an Application's DID (Oxy key signing on behalf of the Application). Requires Application to be `type:'internal'` or `isOfficial`.

**`verifyCredential` checks (order):**
1. Parse and verify the outer signed envelope against the issuer DID's CURRENT active verification method (rejects if key was rotated/unlinked since issuance).
2. Check `credential.status` — rejects if `revoked`.
3. Check `credential.expiresAt` — rejects if past.
4. Returns parsed credential claims on success.

**Routes:** `packages/api/src/routes/civic.ts` at `/civic/credentials/` — `POST /issue`, `GET /list/:holderDid`, `GET /my`, `POST /verify`, `DELETE /revoke/:rkey`.

### Commons Nav (Oxy ID UI)

`packages/commons` tab structure — 3 NativeTabs:

| Tab | Route group | Content |
|-----|-------------|---------|
| ID (default) | `(id)` | Oxy ID card + DID + verifications + domain badges |
| Reputation | `(reputation)` | Standing hero + Skia composition donut + civic-duty CTA + signed activity ledger |
| Settings | `(settings)` | Trust & verification → Proof of personhood → Credentials |

- Active tab tint = `colors.text`; indicator/ripple = `primarySubtle`; background = `card`.
- **Scan FAB:** Bloom `Fab` on the ID landing screen opens `app/(scan)/` as a `fullScreenModal` — handles both `oxycommons://attest` (real-life attestation) and `oxycommons://approve` (sign-in handoff).
- **Reputation screen:** `components/reputation/*` — standing hero, Skia composition donut (shows breakdown arc per category), civic-duty CTA (prompts next action to grow standing), signed activity ledger (reads `GET /reputation/:userId/transactions` + `GET /civic/attest/history`).
- **QR schemes:** ALL use `oxycommons://` — `oxycommons://card` (share identity card), `oxycommons://attest?subject=…&ctx=…&nonce=…&exp=…` (real-life attestation), `oxycommons://approve?v=1&code=<authorizeCode>&...` (sign-in handoff). `oxydni://` scheme is removed entirely.

## Cursor Cloud specific instructions

Local dev is a **Bun workspace monorepo** (`bun@1.3.14`, on `PATH` via `/usr/local/bin/bun`). The startup update script runs only `bun install`. Everything below is not auto-run — do it per session as needed. Standard build/dev/test commands live in the root `README.md`, root `package.json` scripts, and the "Commands" section above; only the non-obvious local caveats are captured here.

**Local infra (not auto-started):**
- **PostgreSQL (required for API + tests)** — start with `docker compose -f docker-compose.dev.yml up -d postgres` (or any local Postgres on `127.0.0.1:5432`). API tests create a throwaway database on every `bun run test` via `jest.globalSetup.ts` and need `TEST_DATABASE_URL` or `DATABASE_URL` pointing at it. Verify with `pg_isready -h 127.0.0.1 -p 5432`.
- **Redis is intentionally unset** — the API falls back to in-memory stores (BullMQ queues, distributed rate limiting, and the multi-instance Socket.IO adapter are disabled). This is fine for local dev.
- **`packages/api/.env`** holds local dev config (Postgres `DATABASE_URL`, locally-generated JWT/`DEVICE_ID_SALT` secrets, and placeholder `AWS_*` values). It is gitignored and persists on the VM. `packages/api/src/config/env.ts` hard-requires `DATABASE_URL`, `ACCESS_TOKEN_SECRET`, `REFRESH_TOKEN_SECRET`, `AWS_REGION`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_S3_BUCKET` to boot (`DEVICE_ID_SALT` is required in production; dev installs a placeholder when unset). Values are only validated for presence/shape, not connectivity. The placeholder S3 creds let the API boot; **S3-backed features (avatar / email-attachment uploads) will fail** until real S3 or a local MinIO (`AWS_ENDPOINT_URL`) is configured — auth/signup/login flows do not touch S3.

**Build shared libs before running apps:** the API and the web apps resolve `@oxyhq/contracts`, `@oxyhq/protocol`, `@oxyhq/core`, and `@oxyhq/services` from their built output (`dist/` / `lib/`), NOT from source. Built output persists in the VM snapshot, but after changing any of those packages' source you must rebuild them (e.g. `bun run core:build`, `bun run services:build`, or `bun run build:all`) or downstream `bun --watch`/Vite dev servers fail to resolve the workspace dep (Vite reports `@oxyhq/services ... could not be resolved`). The API dev server needs contracts+protocol+core built; the web apps additionally need `@oxyhq/services` built.

**Run the stack (dev mode):**
- API: `bun run api:dev` → Express + Socket.IO on **:4100** (`GET /health` → `{"status":"operational"}`). Hot-reloads via `bun --watch`.
- Auth IdP web app: `VITE_OXY_API_URL=http://localhost:4100 bun run --filter auth dev` → Vite on **:8105**. Point every web/Expo frontend at the local API via its own env var (`auth`: `VITE_OXY_API_URL`; `console`: `VITE_OXY_URL`; Expo apps: `EXPO_PUBLIC_API_URL`). Loopback origins are trusted on the credentialed CORS lane, so `http://localhost:*` can hit the local API directly.

**Hello-world sanity check (auth end-to-end, no S3/Redis needed):**
```bash
curl -s -X POST http://localhost:4100/auth/signup -H 'Content-Type: application/json' \
  -d '{"email":"devtest@example.com","username":"devtester","password":"HelloWorld123!","name":{"first":"Dev","last":"Tester"}}'
curl -s -X POST http://localhost:4100/auth/login -H 'Content-Type: application/json' \
  -d '{"identifier":"devtester","password":"HelloWorld123!"}'
```
Signup passwords must include a special character (server-enforced, beyond the Zod `min(8)`). Both return a device-first session (`accessToken` + `deviceSecret`); use the token as `Authorization: Bearer` against `GET /users/me`. The `auth` web app drives the same flow through its multi-step login form.
