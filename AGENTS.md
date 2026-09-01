# OxyHQServices (`@oxyhq/sdk`)

> Universal standards live in `~/AGENTS.md` and `~/Oxy/AGENTS.md`. **Architecture and how-it-works belong in `docs/`; history belongs in git.** This file holds only RULES, commands and pointers. **Budget: under 16 KB.**

Docs: `docs/ARCHITECTURE.md`, `docs/AUTHENTICATION.md`, `docs/SESSION-ARCHITECTURE.md`, `docs/architecture/oxy-auth-platform.md`, `docs/auth/{device-session,integration-guide}.md`, `docs/DEPLOYMENT.md`, `docs/INFRASTRUCTURE.md`, `docs/EMAIL.md`, `packages/ship/README.md`.

## Packages

`contracts` (Zod contracts, zod only) · `protocol` · `core` (platform-agnostic foundation) · `services` (the ONLY UI SDK, web via RN Web + native) · `api` (Express backend) · `node` · `accounts` · `commons` (native-only identity vault) · `auth` (Vite IdP) · `console` · `inbox` · `test-app-expo` · `expo-splash` · `app-preset` · `create-oxy-app` · `ship`.

Build order: `contracts → core → services → rest` (turbo derives it). **`@oxyhq/services` is the single UI SDK for web AND native** — the standalone web SDK package was deleted; never recreate it.

## Package boundaries (strict)

- **`@oxyhq/contracts`** must never import `react`/`react-native`/`expo-*`. Only `zod`.
- **`@oxyhq/core`** must never import `react`/`react-native`/`expo-*`. `await import(...)` for optional RN modules is allowed.
- **`@oxyhq/services` does NOT re-export** from core or contracts — consumers import each directly.
- **`@oxyhq/api`** imports schemas from `@oxyhq/contracts` and server auth from `@oxyhq/core/server`; never route contracts through core re-exports.
- **New shared API contracts go in `@oxyhq/contracts`.** Server validates output, clients validate input and derive `z.infer<>`. Never re-introduce local schema copies (e.g. in `packages/auth/lib/schemas.ts`).

## Commands and test runners

```bash
bun run core:build / services:build / build:all / dev / test
```

- **The runner is per-package.** `api`, `core`, `services`, `contracts` and `commons` use **Jest**; `packages/auth` uses **`bun test`**. Always run each package's own `bun run test` (the root script delegates through turbo). **NEVER blanket-invoke `bun test` across the monorepo** — it runs Bun's runner over the Jest packages and produces dozens of false failures.
- Do not record test-count baselines here — re-verify with each package's own script.
- **A test importing a build-required workspace dep must map it to `src/`** in the test config (Jest `moduleNameMapper`, bun-test `mock.module` preload) or CI must build the dep first — CI's `api-test` does NOT build workspace deps.
- **`packages/api`'s build pre-builds contracts and core** because it imports `@oxyhq/core/server`; without core's `dist/` tsc fails TS2307.
- **Rebuild shared libs before running apps** — API and web apps resolve contracts/protocol/core/services from BUILT output, not source.

## ESM/CJS

Core and contracts ship dual CJS+ESM. **The ESM build must contain no `require()`** or Vite crashes. Use `import ... from`, `await import()` for optional/platform modules, and guard any unavoidable `require()` with `typeof require !== 'undefined'`. Platform crypto: `isReactNative()` → expo-crypto, `isNodeJS()` → node crypto, else Web Crypto.

## Hermes Unicode property escapes (critical)

Mobile Hermes throws `SyntaxError: Invalid RegExp` at RUNTIME on EVERY `\p{…}`/`\P{…}` atom in a `u`-flag regex. V8 never reproduces it, and `hermesc` accepts them at compile time — **verify on a real device build.** Core builds with `tsc` (no Babel), so a property escape ships verbatim into `dist/`; one in a module-load-time regex crashes every consuming RN app at BOOT.

**Never ship a `\p{…}` atom in any package that runs on Hermes.** Transpile to explicit code-point ranges at BUILD time with `regexpu-core` (`rewritePattern(pattern, 'u', { unicodePropertyEscapes: 'transform' })` — no `unicodeFlag`), keeping the readable `\p{scx=…}` as the semantic source and never hand-editing generated ranges. Shipped `dist/` must contain zero `\p{`; `validationUtils.test.ts` guards it — extend it for new policy regexes.

## React Compiler

`@oxyhq/services` SOURCE is React-Compiler-compiled inside the `commons` and `accounts` apps (Metro resolves the workspace symlink to real TS source, so Expo's `isNodeModule` gate treats it as app source). **`packages/services/src/` must therefore be React-Compiler-safe** — no render-phase side effects or mutations in memoizable positions, no out-of-band reads of external mutable state in render.

## Identity contract

- **Oxy API owns `name.displayName`.** `composeDisplayName` returns a real name or `undefined` — it never falls back to username, publicKey or `'Anonymous'`, and `formatUserNameResponse` omits it when absent.
- **`User.name.displayName` is OPTIONAL.** Consumers render it when present and otherwise fall back to the handle via `getNormalizedUserHandle`. The pattern is `displayName ?? handle` — do NOT rebuild multi-field chains. `getAccountDisplayName` (`accountUtils`) is for LOCAL account surfaces only and is never a fallback for API DTOs.
- **`user.name` is ALWAYS the structured object**, never a plain string.
- **Never require a non-empty `displayName` as a session-validity gate** — every sign-in/session-parsing path requires the structured `name` and treats `displayName` within it as optional. Do not re-tighten.
- **`cleanDisplayName` policy:** letters + marks + spaces + apostrophe only; strips emoji, symbols, shortcodes, digits, hyphens, dots and orphaned combining marks. Native writes 400; federated names are stripped at ingest.
- Handle normalization belongs in `@oxyhq/core` (`utils/userHandle.ts`) — never a local route helper or manual domain concatenation.

## Auth / session contract

**Zero-cookie, device-first.** Sign-in returns `deviceId` + a rotating 256-bit `deviceSecret`; the client persists both first-party and mints a short access token at `POST /session/device/token` (no bearer, no cookies — possession is the proof). The server stores only `sha256(deviceSecret)`. `DeviceSession` is the single server authority; every mutation bumps `revision` and broadcasts a token-free `session_state` event. Sockets are bearer-only. **There is NO cookie, refresh-token family, bootstrap hop or device-attribution token — never reintroduce any of it**, and a `deviceId` is per web origin / per app-group with no implicit cross-subdomain sync.

- **ONE provider:** `OxyProvider` from `@oxyhq/services`, web and native alike, with a registered `clientId`. Never a second provider.
- **`runSessionColdBoot` (`@oxyhq/core`) owns restore end to end and NEVER auto-redirects to a login page.** Apps implement no local session restore and no sign-in screens.
- **Boot-path network calls run with `retry: false`** — the refresh scheduler and the 401 lane own retry/backoff. Do NOT re-add retry loops there; interactive sign-in keeps its own.
- **`sessionMode: 'identity'`** pins the session permanently to the owner of this device's PRIMARY identity key, never to the mutable `activeAccountId`. `switchToAccount`/`switchSession` THROW `IdentityBoundSessionError` — never a silent no-op. Commons is the only consumer; every other app stays `'account'`.
- **Interactive sign-in is the in-app `OxyAccountDialog`** — existing device accounts plus ONE primary "Continue with Oxy"; scan-QR, passkey and "Get Commons" sit behind a collapsed "Having trouble?" disclosure. **There is no password option in this dialog, and it never navigates to `auth.oxy.so`.** User-facing label is always "Sign in with Oxy", never "Sign in with Commons".
- **`webAuthMode: 'popup'` relays only `{code, state}` or a typed error to the EXACT registered origin** (never `*`); the PKCE verifier stays in the opener's memory, and both transports share ONE completion path. Popup mode also disables the SDK's own automatic non-gesture navigations to the IdP; a popup-mode domain with no local credential simply resolves signed-out.
- **`selectCommonsDelivery` resolves exactly ONE primary route** — the SDK never silently cascades between delivery surfaces.
- **`POST /auth/session/deliver/:authorizeCode` requires a bearer, and the bearer IS the control** — delivery targets only the authenticated caller's own installs, never an identity from the request body or QR. Eligible installs are those of an `Application` carrying the staff-controlled `identity:approval` capability — a registry decision, never a hardcoded bundle id. The push payload is exactly `{type, approvalUrl}`; the response is COUNTS only, and `targets: 0` is a normal outcome.
- **Progress is timestamps, never statuses** (`pushSentAt`/`openedAt` beside `pending → authorized → consumed`), so a progress signal can never be mistaken for an authorization.
- **The approval screen's `requesterLabel` is server-derived from the REQUEST's own User-Agent**, coarse and ≤64 chars — never from the scanned QR, which is requester-controlled. Deny reasons are a CLOSED set.
- **An OAuth-purpose session can never be claimed for an access token**, and its finalize mints exactly ONE single-use code via a reservation-style atomic update. A delegated `subjectAccountId` is re-checked against live `account:act_as` membership at BOTH approval and finalize.
- **Private app calls wait on `useAuth().canUsePrivateApi` / `isPrivateApiPending`.** Backend clients use `oxyServices.createLinkedClient({baseURL})` — no app-local token providers, interceptors, manual `Authorization`, refresh retries or local invalidation.
- **An invalidated bearer is authoritative:** `HttpService` clears tokens on 401 and emits `onTokensChanged(null)`; `OxyContext` must clear session state and disable private fetches. `isAuthenticated` must never stay true once `getAccessToken()` is null.
- **`verifyChallenge` plants tokens internally** — consumers must not hand-plant or fall back to the bearer-protected `getTokenBySession`.

## Backend rules (`@oxyhq/core/server`)

- Use `createOptionalOxyAuth` / `createOxyAuthMiddleware` / `requireOxyAuth` / `getRequiredOxyUserId`, `authSocket`, `safeFetch`, `createOxyCors`, `verifySecret`, `createOxyRateLimit`. **Never define local `AuthRequest`, `requireAuth`, `getUserId`, bearer parsers or token-decoding middleware** — missing behavior belongs in `@oxyhq/core/server`.
- **Always derive Socket.IO rooms from `socket.user.id`**, with ownership checks before joins.
- **Never `new Model(req.body)` or spread `req.body` into an update** — server-side owner ids plus an explicit field whitelist.
- **Loopback dev origins are trusted on the credentialed CORS lane in ALL environments, including production** (owner-approved). One predicate, `isLoopbackOrigin` (http-only, any port, fails closed). Do NOT gate it on `NODE_ENV`, hardcode a port, or extend it to `https://localhost`.
- Bearer-authenticated writes do not fetch app-local CSRF tokens; CSRF remains for ambient cookie credentials.
- **Every route that modifies user state MUST call `userCache.invalidate(userId)`** after the write, or the next `getUserBySession` silently reverts the client's update.
- **Every `rateLimit()` call MUST pass a unique `prefix`** (convention `rl:<scope>:`) — the factory enforces it. Without it, two limiters share one Redis key and `rate-limit-redis` throws `ERR_ERL_DOUBLE_COUNT`, halving the budget. Existing prefixes are in `packages/api/src/middleware/rateLimiter.ts` and each route file.
- **Do NOT lower the general limiter below 1000/15min** without measuring real production traffic.
- **`oxyServices.updateProfile()` must sweep the SDK cache** (`GET:/session/user/`, `/users/me`, `/profiles/username/`, the user id) or username onboarding loops on stale data.

## No user IPs at rest (privacy invariant, owner-mandated)

**Never persist a user IP — raw, hashed, or geo-derived (country included)** — in Mongo, logs, metrics metadata or DTOs. A salted hash of the IPv4 space is brute-forceable, so hashing is not an acceptable at-rest form.

- **Anonymous rate-limit keys are the only place an IP may be touched, and only transiently** — through `hashedIpKey` (HMAC, IPv6 /56-bucketed), living only as a Redis key with the limiter's TTL. Never key a limiter on raw `req.ip`.
- The one sanctioned exception is inbound-email `Received:` headers (third-party SMTP senders, not Oxy users).
- **Do NOT re-add IP capture "for security"** — audit trails, anomaly detection and sybil resistance were all deliberately given up.

## KeyManager safety (core — critical)

- `createIdentity`/`importKeyPair` throw `IdentityAlreadyExistsError` unless `{overwrite:true}`. Writes go through `_persistIdentityAtomic` (back up existing → write primary → sign/verify probe → refresh backup), so a failed overwrite rolls back to the exact prior bytes.
- **Identity slots live under DEDICATED `keychainService`s, never the default.** On Android everything written without one shares a single default AndroidKeyStore key, and expo-secure-store PERMANENTLY DELETES ciphertext on a failed decrypt — so co-located slots die together. Any NEW secret slot class needs its own `keychainService`. The migration off the legacy layout is lazy and interruption-safe — never bypass it with a direct SecureStore read.
- **`getIdentityStatus()` is the authoritative probe**: `present` / `absent` (the ONLY state that may route to create/onboarding) / `lost` (marker present, keys gone → recovery, NEVER create) / `unavailable` (a read threw — never cached). The non-secret identity marker is what distinguishes a fresh install from a dead keystore.
- **`hasIdentity()`/`getPublicKey()` THROW `IdentityUnavailableError` on a storage failure** — never catch it and treat it as "no identity". `hasIdentity()` requires both keys present, well-formed AND matching; `verifyIdentityIntegrity()` does a full sign/verify probe.
- `restoreIdentityFromBackup` treats a read EXCEPTION as transient and refuses to clobber a healthy-but-locked primary; recovery validates the recovered public key against the marker and skips a source holding a different account.
- Strict hex/length/range validation on all key material; `canonicalPrivateKey` at every `keyFromPrivate` call site; degenerate scalars rejected.

## Commons on-device hazard (UID-scoped, CRITICAL)

AndroidKeyStore aliases belong to the shared UID `so.oxy.shared`, not to a package — so installing or updating ANY package declaring it (Commons, Mention, Accounts, Allo, Homiio, or a same-signer `.dev` variant) can orphan and DESTROY a real identity's keys, primary and backup. Commons is self-custody: recovery is possible ONLY via the user's 12-word phrase. Uninstalling the LAST package of the UID clears the keystore entirely.

**Test identity/SSO flows on the emulator, or on a device holding only a disposable identity.** For a device build, use a clean-room variant with a fresh `applicationId` and `sharedUserId` REMOVED. **Verify with `adb shell dumpsys package <id>` and read the `appId=` field** — NOT `userId=`, which returns zero lines even against a correctly isolated package and is indistinguishable from a mistyped command. Also grep for `sharedUser` (expect zero hits) and diff the real package's `lastUpdateTime`. Ship real updates only through the store / EAS.

## App and SDK rules

- **`queryFn` must be pure** — never call `useAuthStore.setUser()` inside one; side effects belong in a `useEffect` on `query.data`.
- **`useSessionSocket` uses a strict whitelist** (`session_removed`, `device_removed`, `sessions_removed`). **Never add an `else`/default branch that signs out** — unknown events log a dev warning only.
- **RN FormData uploads route through `XMLHttpRequest`**, never fetch. On web, `{uri}` descriptors are materialized to a `Blob` first; the API rejects 0-byte uploads.
- **BottomSheet:** modal contents must wrap children in `<GestureHandlerRootView>` (RN's `Modal` renders into its own window). Body pan uses `manualActivation()` + `simultaneousWithExternalGesture`. Set `scrollable: false` for sheets owning a `VirtualizedList`.
- **Bloom worklets:** BottomSheet pan context must use a PRIMITIVE `SharedValue` — an object-valued one mutated in a worklet crashes on the UI thread. `mergeRefs` returns a plain callback so the ref stays assignable across duplicate `@types/react` copies.
- **Offline persistence:** `OxyProvider` awaits `restored` before exposing the QueryClient, so first paint serves cache. Mutations need stable `mutationKey` with `networkMode: 'offlineFirst'`. TanStack Query must stay on one `^5.x` major across services, console and test-app-expo.
- **Accounts is KEYLESS and management-only**; all key/identity/recovery UX lives in Commons (native-only, no web build). Do not set `fontFamily` (BloomThemeProvider sets Inter globally); `(auth)`↔`(tabs)` routing keys purely on SESSION, never on `hasIdentity`.
- **Commons' onboarding gate is LOCAL-FIRST** — routing decides purely from `getIdentityStatus()` plus an offline-safe milestone; session/cold-boot state must never gate, delay or downgrade it. The create/import preflight uses `{bypassCache: true}` plus the marker; never a cached `getPublicKey()`.
- **Expo native-module alignment:** when `@oxyhq/services`' pinned native module diverges from the SDK-bundled version, align the whole monorepo UP and add the package to `expo.install.exclude`. Never let two versions of one native module coexist.
- **Commons' Metro config mirrors accounts'** — the Bloom single-instance `resolveRequest` rewrite is required to prevent duplicate React context crashes.

## The IdP (`packages/auth`, auth.oxy.so)

An OAuth authorize/consent **shell**, NOT a Relying Party — and a device-first origin like every other app, mounting `OxyProvider` with NO special props. It authenticates through the SDK's own funnels and then emits the authorization code for the third party. **Do not turn it into an RP that bounces elsewhere for its own session**, and do not reintroduce the deleted cookie/resolve chooser feed or `coldBoot={false}`.

- **No account management** — `accounts.oxy.so` owns it exclusively; `/settings/*` permanently redirects there.
- **RP apps never redirect users to `auth.oxy.so` for first-party sign-in.**
- Trust for auto-approving consent is registry-based (`isTrustedApplication()`), never domain-based. `status: 'active'` alone is never a trust boundary.
- The account chooser is the shared `AccountChooser` fed by `useSwitchableAccounts` — no bespoke IdP feed.
- **Anti-patterns:** no `useEffect` for syncing props to state, firing toasts, or focus; no `Suspense` without `React.lazy()`/`use()`; no render-body side effects.
- **Pure-static SPA — no Pages Function.** If one is ever needed again, use a Cloudflare Pages Functions DIRECTORY, never an advanced-mode `dist/_worker.js`, and deploy with `bunx wrangler` (npm's Arborist chokes on the root `overrides`).

## Credentials, applications and service tokens

- **`clientId` is an `ApplicationCredential.publicKey`.** Secrets are sha256-hashed, returned exactly ONCE on create or rotate, never retrievable.
- **All three auth resolution sites use `isCredentialUsable()`** — `active` OR `deprecated`-within-grace, rejecting revoked/expired. The service JWT claim is named `appId` and must NOT be renamed.
- **Staff-only fields** (`type`/`isOfficial`/`isInternal`/`capabilities`) are gated by `requireStaff`; the normal Console PATCH path silently drops them.
- **`redirectUris` is the sole canonical redirect field**, validated exact-match and constant-time.
- **A personal workspace is mandatory**, auto-created, not renamable, not deletable.
- **Reputation awards are never self-issued** — `reputationService.award` is called in-process after the civic service evaluates quorum, idempotent on `(applicationId, sourceActionId)`. Corrections are compensating transactions; nothing is deleted.
- **Civic contracts (`packages/contracts/src/civic.ts`) stay internal `workspace:*`** — do not publish them or bump the contracts version for civic-only additions.
- **NFC/HCE was removed and must not be reintroduced** — `react-native-hce` is abandoned; the attest QR is the only transport.
- **Deploy order:** the API must deploy before a Commons build requiring new socket-payload fields (old API + new client = events dropped by the strict whitelist).

## Deploy

`oxy-api` on ECS Fargate (`us-west-2`, cluster `oxy-cluster`), port `8080`, `api.oxy.so` (also serves the website API). `git push origin main` → `deploy-aws.yml` → `linux/arm64` image → ECR `oxy/oxy-api` → force-new-deployment. GitHub OIDC role `oxy-github-deploy`. Secrets: GitHub → SSM `/oxy/oxy-api/*`, shared to `/oxy/_shared/*`. **Never register a secret with a placeholder value** — the workflow skips empty/`-` values as defence in depth, but a placeholder crash-loops the service. Never put secret values in this file.

- **Inbound email:** Cloudflare Email Routing → Worker `email-inbound` → `POST /email/inbound`. Four invariants, any of which silently loses mail: the Worker's `API_URL` must be `https://api.oxy.so`; its webhook secret must equal SSM's; the raw body parser must be registered BEFORE `express.json()`; and `/email/inbound` must be mounted BEFORE `/email`. CloudWatch log group is `/oxy/ecs`.
- **The Dockerfile installs only the lean `core+contracts+api` workspace subset.** Do NOT switch it to a full-workspace `--frozen-lockfile` install — that pulls `esbuild`, whose arm64/alpine postinstall hard-fails. A proper fix needs a SCOPED frozen install or a single-esbuild override, validated on a real arm64 build.
- **Any workspace package consumed by oxy-api MUST be added to the Dockerfile** (copy, build before core/api, copy its `dist` into the production stage) or `bun install` fails to resolve `workspace:*`.
- **Bun's isolated linker means deps are NOT at `/app/node_modules/<pkg>`** but under `/app/node_modules/.bun/<pkg>@<ver>+<hash>/node_modules/<pkg>`, so a `node -e` one-liner inside the container needs an absolute path or a script inside the resolution graph.
- Redis/Valkey is unreachable from a laptop (security groups) — run a one-shot Fargate task with a container command override.

## Working in this repo

- **Confirm sole ownership of shared backend files before writing** when several sessions may touch `packages/api`, and PATH-SCOPE every `git add` — never `git add -A` in a shared package.
- **Commit `bun.lock` in the SAME commit as the `package.json` change**, verified with `bun install --frozen-lockfile`.
- TypeScript strict everywhere; Biome with `--error-on-warnings`; no back-compat re-exports.

## Local dev (Cursor Cloud / fresh VM)

- **MongoDB is installed but not auto-started** — run `mongod` in tmux before the API. Redis is intentionally unset (in-memory fallbacks; BullMQ, distributed limits and the Socket.IO adapter are disabled).
- **On a brand-new empty database the API crashes** with `ns does not exist: <db>.files` — pre-create the collection once (`db.createCollection("files")`).
- `packages/api/src/config/env.ts` hard-requires Mongo/JWT/AWS variables to boot; the placeholder S3 creds let it start but S3-backed features fail.
