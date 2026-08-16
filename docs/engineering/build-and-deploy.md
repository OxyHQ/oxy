# Build, packaging and deployment

> Moved out of `AGENTS.md` unchanged. The one-line rules stay there.

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

