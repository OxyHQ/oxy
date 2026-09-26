# Auth, sessions and identity — the mechanisms

> Moved out of `AGENTS.md` unchanged. The one-line rules stay there.

## Auth / Session Contract

**Session transport (device-first — `deviceId` + `deviceSecret`):** every successful sign-in (email code or link, password, authenticator, QR claim, shared-identity mint, challenge verify) returns the session's `deviceId` and a NEW 256-bit holder `deviceSecret`. The client persists BOTH first-party (localStorage per web origin; SecureStore on native) — the server stores only `sha256(deviceSecret)`, one `device_credentials` row per holder (unique `secret_hash`). To restore or refresh, the client POSTs `{ deviceId, deviceSecret }` to `POST /session/device/token` (NO bearer, NO cookies — possession of the secret is the proof) and gets a short access token plus `nextDeviceSecret` (the same proven secret echoed back). Nothing rotates: every official web app that joins the browser's device — through the browser bridge (`auth.oxy.so/bridge` → `POST /session/device/join-code` → `POST /session/device/join`, opened once from the app's first sign-in press when it holds no credential) or through `/oauth/token` — gets its own credential and never invalidates `auth.oxy.so`'s or an earlier app's (ADR 0029 D2). A sign-in that carries `device: { deviceId, deviceSecret }` (QR claim, passkey login, sign-up, recovery; the SDK attaches it from the provider's store) is created ON that device; an invalid proof is ignored, never an error. Full mechanism and the bridge's security properties: `docs/SESSION-ARCHITECTURE.md` "One browser, one session". Holder credentials are deleted when the device ends with no account signed in, on `signout({all:true})`, or past 32 per device (LRU). There is **NO refresh-token family, NO `#oxy_boot` bootstrap hop, NO device-attribution token** — all deleted in the zero-cookie cutover, and none of them comes back. A `deviceId` is per web origin / per native app-group; there is no implicit cross-subdomain or cross-app device sync. Full mechanism: `docs/auth/index.md` (the entry that is answerable for being right) → `docs/SESSION-ARCHITECTURE.md`. `docs/architecture/oxy-auth-platform.md` is the CLOSED plan record for the 2026-07 project and predates the multi-principal model — read it as history, not as the mechanism.

**Zero cookies on every origin, `auth.oxy.so` included.** Mention, Mercaria, Syra, Console, Accounts, Inbox, the IdP and every scaffolded app keep `{deviceId, deviceSecret}` + `POST /session/device/token` and set **no cookie of any kind**. ADR 0003's browser hub (`__Host-oxy-device` on `auth.oxy.so`) was never deployed and is deleted; do not bring it back. Still forbidden: third-party cookies, hidden/silent iframes, cross-origin `localStorage`, Storage Access API as the mechanism, gesture-less popups, silent `prompt=none` loops, FedCM, automatic redirect chains across Oxy origins.

**Server authority — DeviceSession:** the `DeviceSession` model (collection `devicesessions`: `deviceId`, `accounts[{accountId, sessionId, authuser, operatedByUserId?}]`, `activeAccountId`, `revision`; holder credentials in `device_credentials`) is the single source of truth for what is signed in on a device — and on the web ONE device per browser is shared by every official app, so a switch or sign-out in one applies to all of them (ADR 0029 D2). REST surface: `POST /session/device/token` (the public zero-cookie mint), the bridge's `POST /session/device/{register,join-code}` (auth.oxy.so only) and `POST /session/device/join` (the app's own origin), + `/session/device/{state,add,switch,signout}` (bearer) (`packages/api/src/routes/sessionDevice.ts`). Every mutation bumps `revision` and broadcasts a token-free `session_state` event to Socket.IO room `device:<deviceId>` — all apps on the same device sync instantly. Sockets are **bearer-only** (a signed-out client opens no socket). The client half is `SessionClient` in `@oxy.so/core` (`packages/core/src/session/`). `POST /session/device/token` also accepts an optional `accountId` that PINS the mint to one account of the device's set instead of whichever is currently active — it never mutates `activeAccountId`/`revision` and never broadcasts; a non-member account or one with a dead session answers `account_not_on_device` (deliberately indistinguishable, so a pinned miss is never an account-existence oracle). This exists for `sessionMode: 'identity'` — see below.

Frontend apps (web AND native) use the SDK as the only session authority:
- **ONE provider:** `OxyProvider` from `@oxy.so/services` with a registered `clientId` — on web (RN Web) and on Expo/RN alike. The former standalone web SDK package was deleted from the monorepo; never reintroduce a second provider.
- The SDK's device-first cold boot (`runSessionColdBoot` in `@oxy.so/core`, `packages/core/src/boot/sessionColdBoot.ts`) owns session restore end to end and NEVER auto-redirects to a login page. It is an ordered step chain: `warm-token-plant` (plant a still-valid persisted access token with zero network round-trip) → `device-secret-mint` (web + native — mint from the persisted `deviceId` + `deviceSecret`) → `shared-key-signin` (native — re-mint from the shared Commons keychain), REPLACED by `identity-key-signin` (re-mint from THIS device's primary identity key) in `sessionMode: 'identity'`. Apps do not implement local session restore or sign-in screens — the mint client, storage keys, and the re-mint handler/scheduler live once in `@oxy.so/core`.
- `runSessionColdBoot` accepts `overallDeadlineMs` (a hard ceiling forwarded to the underlying step runner so one non-settling network step can never hang routing indefinitely), `onStepDeadline` (called once per step abandoned to that deadline), and `isOffline` (a connectivity hint that skips the two NETWORK steps — an explicit offline verdict only; ambiguous/unknown always resolves to "assume online" so a flaky probe never falsely skips a real sign-in). `@oxy.so/services` wires a 12s `overallDeadlineMs` plus a best-effort, 500ms-capped NetInfo/`navigator.onLine` offline hint. The boot-path mint (`mintFromDeviceSecret`) and the native shared-key sign-in both run with `retry: false` — the proactive refresh scheduler and the reactive 401 lane already own retry/backoff, so an inner retry loop here would only multiply the cold boot's worst-case latency. Do NOT re-add retry loops to boot-path network calls; interactive (non-boot) sign-in flows keep their own retries.
- **Session ownership — `sessionMode: 'account' | 'identity'`** (`OxyProvider` prop, default `'account'`; issue #691 Phase 1). In `'identity'` mode the session is pinned PERMANENTLY to the owner of THIS device's PRIMARY identity key — never to the device's mutable `activeAccountId` — via a persisted `{publicKey, accountId}` pin (`packages/core/src/session/identityPin.ts`, storage key `oxy.identity.pin.v1`) written when the identity session is established and reconciled against the live `KeyManager.getPublicKey()` every boot (`resolveIdentityPin` / `establishIdentitySession`, `packages/core/src/session/identitySession.ts`). `switchToAccount` / `switchSession` THROW `IdentityBoundSessionError` (`@oxy.so/services`, never a silent no-op); `openAccountDialog()` is a dev-warning no-op — there is no chooser to open, since the user IS the local key's owner. Commons (`packages/commons/app/_layout.tsx`) is the one consumer (`<OxyProvider sessionMode="identity">`); every other Oxy app stays `'account'`, byte-for-byte unchanged.
- Interactive sign-in is the in-app **`OxyAccountDialog`**, rendering THE sign-in screen — `OxySignInPanel` (`packages/services/src/ui/components/signIn/`), the one auth.oxy.so's `/login` renders too: the device's accounts first ("Choose an account"), then the steps, all INSIDE the dialog on every platform and domain (ADR 0030 D1): email or username → the code from the email (or its link, opened in the same browser) → "Use your password instead" → the authenticator step when the account has one. On the web, from `md`, Bloom `AuthCard`'s split card shows the embedded Commons QR beside the form (below `md` "Continue with Oxy" on top); on native "Continue with Oxy" leaves the delivery route to Oxy (`selectCommonsDelivery`; see "Sign in with Oxy" below), or "Get Commons" without it. "Create account" is `OxySignUpPanel` (username → email → code). Open it with `useOxy().openAccountDialog()` or imperative `openAccountDialog('signin')`. It opens no auth.oxy.so window except the browser bridge (ADR 0029 D2) and never navigates the tab.
- **`OxySignInButton`** resolves the registered `Application` via `GET /auth/oauth/client/:clientId`: official apps (`first_party`/`internal`/`system`/`isOfficial`) open the dialog; `third_party` apps run OAuth + PKCE (`generatePkcePair` / `generateOAuthState` / `buildOAuthAuthorizeUrl` from `@oxy.so/core`, `packages/core/src/utils/oauthPkce.ts`). On web the transport is `webAuthMode: 'popup' | 'redirect'` (`OxyProvider` prop, default `'popup'`) — see below. Third-party integration guide: `docs/auth/integration-guide.md`.
- **Explicit consent is a gesture, never a migration.** An authenticated official app that receives a typed missing/revoked-grant error renders a user action and calls `useOxy().requestOAuthConsent({ scopes, redirectUri })` from that press. The SDK validates exact configured scopes, keeps web/native on the existing state + PKCE transports, rejects a different returned subject, and commits no grant locally. No mount effect, automatic retry, whitespace normalization, name lookup or default scope may stand in for consent.
- **Popup vs redirect web OAuth transport (`webAuthMode`).** `'popup'` opens a small `auth.oxy.so` window synchronously from the click (gesture attribution, before any `await`) with `response_mode=web_message`; the IdP relays `{type:'oxy:oauth:code'|'oxy:oauth:error', code, state}` to `window.opener` via `postMessage` at the redirect URI's EXACT registered origin (never `*`) and closes itself — it never navigates the popup to the `redirect_uri` page, so the RP's own tab/route/scroll position is never touched. A blocked/failed popup falls back to the ordinary full-page redirect automatically (`startWebOAuthSignIn`, `packages/services/src/ui/oauth/browserAuthTransport.ts`). Only the code, `state`, and a typed OAuth error ever cross `postMessage` — the PKCE `code_verifier` stays in the opener's memory. Both transports share ONE completion path (`completeOAuthCode.ts`: validate `state` → PKCE exchange → cleanup → commit session), so they can never drift on the security-critical steps.
- **The SDK NEVER navigates the top-level window on its own, in EITHER `webAuthMode`.** Every hop to the IdP starts from a real user gesture. The two automatic, gesture-less full-page navigations that used to exist are DELETED, not gated: the cold-boot `prompt=none` silent cross-origin restore (`crossOriginRestore.ts`, `legacyRedirectLanes.ts`, `allowsAutomaticIdpRedirect`) and the post-sign-in hub-ticket sync to `auth.oxy.so/sync` (`hubSync.ts`, the IdP `/sync` page, `POST /session/device/hub-ticket` + `/session/device/redeem-ticket`, the `DeviceHubTicket` model, the `@oxy.so/contracts` ticket schemas). `'none'` is deliberately absent from the `prompt` union of `buildOAuthAuthorizeUrl` (`'login' | 'consent'` only) so the silent bounce cannot be rebuilt in one line, and the IdP REFUSES an `authorize?prompt=none` that arrives anyway with a visible terminal screen — never a silent redirect back, so it cannot be hidden in an iframe or a background tab. (`login`/`consent` are type-surface only; the IdP does not act on them today — do not document them as working.) A web origin with no local device credential cold-boots SIGNED OUT and waits for the user's next "Continue with Oxy" — an accepted trade, not a regression. Do NOT reintroduce a silent restore, a hub sync, a `hubSync` prop, or any other cold-boot navigation to the IdP. Return legs the user did ask for stay: consuming a `?code=` already on the URL (`tryCompleteOAuthReturn`, which also strips any `?error=` and the stale PKCE handshake) and the blocked-popup fallback redirect.
- Private app calls wait for SDK readiness: `useAuth().canUsePrivateApi` / `useAuth().isPrivateApiPending` (same hook contract on web and native).
- App backend clients use `oxyServices.createLinkedClient({ baseURL })`. Do not add app-local token providers, Axios/fetch auth interceptors, manual `Authorization` header plumbing, refresh/mint retries, or local invalidation.

Backend APIs use `@oxy.so/core/server` for request identity and security:
- Mount `createOxyRateLimit(oxy)` near the top of the Express app when Oxy-aware rate limiting is needed.
- Use `createOptionalOxyAuth(oxy)` for optional identity, `createOxyAuthMiddleware(oxy)` / `requireOxyAuth` for private routes, and `getRequiredOxyUserId(req)` for required user identity.
- Use `authSocket` for Socket.IO/WebSocket auth. ALWAYS derive rooms from `socket.user.id` — never from client-supplied room IDs. Add ownership checks before joining session/conversation rooms.
- Use `safeFetch(url, opts)` for any fetch of user-supplied URLs (SSRF prevention — DNS-pinned lookup, private-IP denylist, bounded redirects).
- Use `createOxyCors({ appOrigins, allowCredentials })` for CORS (deny-by-default, auto-allows `*.oxy.so`; NEVER wildcard+credentials).
- **Loopback dev origins are trusted on the credentialed CORS lane in ALL environments, including production (owner-approved posture):** `http://localhost`, `http://127.0.0.1`, and `http://[::1]` on ANY port are allowed to make credentialed/state-changing requests against `api.oxy.so`, so a developer's local dev server (Expo web, Vite, etc.) can hit prod. Implemented via one shared predicate, `isLoopbackOrigin(origin)` in `packages/api/src/utils/origin.ts` (http-only, any/no port, fails closed), wired into both `dynamicOriginRegistry.getCorsDecision` (loopback wins over the third-party non-credentialed lane) and `allowedOrigins.isAllowedOrigin` (also gates the CSRF Origin guard + Socket.IO). Do NOT gate this on `NODE_ENV`, do NOT hardcode a single port, and do NOT extend it to `https://localhost` — the accepted exposure is a malicious process on the developer's own loopback riding their oxy.so cookies, since remote sites cannot forge `Origin`.
- Use `verifySecret(provided, expected)` for secret/token equality (constant-time, never `!==`).
- NEVER do `new Model(req.body)` or spread `req.body` into `findByIdAndUpdate` — resolve owner ids server-side via `getRequiredOxyUserId` and use an explicit field whitelist (mass-assignment IDOR).
- Do not define local `AuthRequest`, `requireAuth`, `getUserId`, `getAuthenticatedUserId`, bearer parsers, or token-decoding auth middleware in apps. Missing shared behavior belongs in `@oxy.so/core/server`.
- `api.oxy.so` has no CSRF layer and no cookie parser: it sets no cookie and accepts no ambient credential, so every write authenticates by header (#1044). Adding a cookie credential would bring the threat back, and the defence with it.

`packages/auth` / `auth.oxy.so` is the **OAuth authorize/consent IdP** for third-party apps, NOT a Relying Party. It mounts `OxyProvider` from `@oxy.so/services` with NO special props — it is a device-first origin like every Oxy app (its own per-origin `{deviceId, deviceSecret}`, normal SDK cold boot, `useDeviceSwitcher` chooser, the SDK's own sign-in screens and funnels) — but it stays a SHELL that emits the OAuth authorization code for the third-party after authenticating; do not turn it into an RP that bounces elsewhere for its own session. There is NO transport/chooser exception anymore (the `coldBoot={false}` exception existed for the deleted SSO bounce). Trust for auto-approving OAuth consent is registry-based (`Application.isOfficial`/`isInternal`/`type`, staff-controlled via `isTrustedApplication()` in `packages/api/src/utils/trustedApplication.ts`), not domain-based. The IdP does NOT expose account management — `accounts.oxy.so` is the sole owner; the IdP's `/settings/*` routes permanently redirect there. See the "Auth App (packages/auth)" section below.

## Application Model (#213 + #216) — replaces the legacy developer-app model (2026-06-14)

**Clean rename, NO migration, NO back-compat.** The legacy developer-app model and `routes/developer.ts` are GONE. The production `developerapps` collection was dropped (had 1 record). New collections start empty; apps are recreated in the new Console.

**Three new models in `packages/api/src/models/`:**
- `Application` (collection `applications`): `type` first_party|third_party|internal|system, `status` active|suspended|deleted|pending_review, `isOfficial`, `isInternal`, `capabilities[]`, `redirectUris[]`, `scopes`, `privacyPolicyUrl?`, `termsUrl?` (shown on the OAuth consent screen), `createdByUserId`. NO apiKey/apiSecret on this model.
- `ApplicationMember` (collection `applicationmembers`): `applicationId`+`userId` unique; `role` owner|admin|developer|viewer|billing; `permissions[]` derived from role; `status` active|invited|removed.
- `ApplicationCredential` (collection `applicationcredentials`): `publicKey` = OAuth client_id, `secretHash` = sha256 only (secret shown ONCE on create/rotate), `type` public|confidential|service, `environment`, `scopes`, `status`.

**Roles→permissions map:** `packages/api/src/utils/applicationRoles.ts` (`ROLE_PERMISSIONS`, `permissionsForRole`).

**Staff-only fields** (`type`/`isOfficial`/`isInternal`/`capabilities`): gated by `isStaff` boolean on the User model + `packages/api/src/middleware/requireStaff.ts` (`requireStaff`, `isStaffUser`). Normal Console PATCH path silently drops these for non-staff.

**Routes:** `packages/api/src/routes/applications.ts` mounted at `/applications` (Zod schemas in `schemas/application.schemas.ts`). RBAC via `requireAppPermission(permission)`. Full CRUD + members (invite/update/remove/transfer-ownership, can't remove last owner) + credentials (create/rotate return secret ONCE, revoke) + usage. Application responses embed `callerMembership` (caller's own role+permissions) on list + detail.

**OAuth + service tokens:** `clientId` → `ApplicationCredential.publicKey` (active) → `applicationId` → `Application`. Service-token endpoint validates apiKey/apiSecret against an active `type:'service'` `ApplicationCredential` (sha256 secretHash, constant-time). The service JWT payload claim is STILL named `appId` (= applicationId string) — NOT renamed, to avoid breaking `@oxy.so/core` service-token verification. `ApiKeyUsage`/`AuthCode`/`DeveloperApiKey` model refs repointed from the legacy model name to `'Application'` (the `DeveloperApiKey` model name itself was kept). Platform-stats field renamed to `totalApplications`.

**redirectUris (#216):** `redirectUris` is the SOLE canonical redirect field. `redirectUrls` removed entirely (no dual field, no migration). OAuth authorize validates `redirect_uri` exact-match (constant-time) against `application.redirectUris`. Console writes `redirectUris`.

**SDK (@oxy.so/core):** applications live in `oxy.apps` (`packages/core/src/api/apps.ts`: `list`/`get`/`create`/`update`/`delete`, `credentials.*`, `usage`) inside the account graph (`oxy.accounts`); types `Application`, `ApplicationCredential`, … are exported from `@oxy.so/core`. The service-token lane is `OxyServer` (`@oxy.so/core/server`).

**Console:** `use-developer.ts` → `use-applications.ts`; apps list + tabbed app settings (General incl. redirectUris editor / Members / Credentials / Usage), permission-gated; staff-only fields never shown. Console now uses the shared SDK (bespoke axios client removed) + Bloom theming + macOS splash + app-name from manifest.json + app-logo/workspace-avatar uploads + invite-by-username/email + Manage-account link + docs→website.

**Commits:** api `881f81dc`, core+console `0a341882`, peer bumps `45e49063`.

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
4. `@oxy.so/core/server` `middleware.auth()` recognizes `type: 'service'` JWTs (stateless, no session DB lookup)

Service tokens are EdDSA only, verified against `/.well-known/jwks.json` (ADR 0012). HS256 is refused everywhere. `oxy-api` does not boot in production without `SERVICE_TOKEN_PRIVATE_KEY` + `SERVICE_TOKEN_SIGNING_KEY_ID`, and outside production it mints with a per-process ephemeral key. Decide "is this a service token?" with `verifyServiceToken`, never with `jwt.verify(…, ACCESS_TOKEN_SECRET)`.

**Workload identity — a first-party service with NO credential (ADR 0026):**

An official service does not need step 1 or 2. It proves what it IS to the
infrastructure it runs on and receives the same 1h JWT:

1. `POST /auth/service-token/workload/challenge` → a single-use nonce (60s, Redis)
2. `POST /auth/service-token/workload` with `{ provider, nonce, attestation }` → the same 1h JWT

On AWS the attestation is a SigV4-signed `GetCallerIdentity` the caller never
sends; Oxy replays it to STS and believes STS's answer. The verifier is the only
module that knows which cloud we are on — another provider is one more
implementation of `AttestationVerifier`, with no change to callers or verifiers of
the token.

`application_workload_identities` maps `(provider, subject)` → application. On AWS
the subject is the ROLE ARN (`arn:aws:iam::<account>:role/<name>`): STS answers with
the per-task `assumed-role/<name>/<session>`, and the verifier reduces it, so a
binding survives the tasks that present it. The row carries no secret, is created at
deploy time, and deleting it is how a workload is cut off. The mint re-applies
`isTrustedApplication` and stamps the DEPLOYMENT's environment (an attestation
cannot ask for one).

**Scopes come from the BINDING, decided exactly as the credential path decides
them** (ADR 0026, amended 2026-09-19). The binding names scopes → the
intersection with the application's, so a privileged scope survives only when
BOTH hold it; the binding names none → the application's non-privileged grants,
which is what every binding written before the column says. The attestation
contributes nothing here: it selects a binding, and the binding — a row staff
wrote, naming one role and one application — names the authority, the way an
`ApplicationCredential` does. Naming a privileged scope on a binding is
staff-only, under the same gate as `POST /applications/:appId/credentials`.

**What an attested token says minted it.** `credentialId` is `wl_` + 96 bits of
SHA-256 over the canonical subject — the ROLE — so it is ONE value for every
task of a service, across every deploy, forever. It is a thing a consumer can
pin, and `bind-workload-identity.ts` prints it so nobody has to capture a token
to learn it. A service that asserts a fixed `credentialId` today (Homiio's Sindi
check, Clarity's exact-claims check) accepts both its credential id and the
`wl_…` handle, deploys, migrates, then drops the old one. The binding row's id
was considered instead and rejected: delete-and-recreate is this path's only way
to move a binding, so a row id would break every pin on an operator action that
changed no identity, and it is not derivable without a production query.

**An Oxy lane that pins one credential needs its own line, not just a binding.**
A check comparing `credentialId` to a fixed UUID refuses an attested caller
however good its binding is. `NATIVE_PRODUCT_AGENT_ENTRY_POINTS`
(`config/nativeProductAgents.ts`, ADR 0025) is the one such lane today: an entry
declares the canonical IAM role beside the credential id and derives the handle
with `workloadAttestationHandle`, so the value is reviewable and computable from
a task definition rather than a digest nobody can check. The role is written out
in that file and NOT read from `application_workload_identities` — binding a role
is a routine deploy step, and it must never be, by itself, a grant of a pinned
lane. An attested caller then re-reads its BINDING as the live ceiling
(`resolveLiveAgencyWorkload`), on the same grounds a credential-minted one
re-reads its credential.

**Before a service gives up its key pair, its binding must name every privileged
scope the credential named.** Not a nicety: removing Mention's pair first cost
313 × `Missing required scope: federation:write` in one morning. Bind with
`--scopes`, check the token, then remove the pair.

Ecosystem activity publishing follows the same path: `createEcosystemTraffic`
accepts a process with no key pair when it can attest, so removing
`OXY_SERVICE_API_KEY`/`OXY_SERVICE_API_SECRET` from a task definition no longer
kills the service at boot.

Third-party applications keep the credential flow above: they run where we cannot
attest, which is exactly where registration belongs.

**Creating a binding — the one manual step:**

```bash
bun run packages/api/scripts/bind-workload-identity.ts \
  --app-id <application id> \
  --role-arn arn:aws:iam::237343248947:role/oxy-mention-task \
  [--provider aws-iam] [--description "Mention ECS task role"] \
  [--scopes federation:write,signals:write,catalogs:write] \
  [--expires-at 2026-12-31T00:00:00Z]

bun run packages/api/scripts/bind-workload-identity.ts --app-id <id> --list
```

Once per service, against that environment's database, by staff. There is no
route: a binding says one service IS one application, and exposing that over HTTP
means designing who may call it when the honest answer is "an operator, out of
band, when the service is deployed". The script is a thin entrypoint over
`services/workloadIdentityBinding.service.ts`, which is where the decisions are and
where they are tested. Exit codes: `0` done, `1` bad invocation, `2` refused.

`--role-arn` takes either form — the role ARN, or the `assumed-role/<name>/<session>`
one a running task reports — and runs it through the verifier's own
`canonicalAwsSubject`, so what is stored and what will be attested are the same
string by construction rather than by inspection. What that function does NOT do is
judge: it passes an ARN it does not recognise through unchanged, which is right for
reporting what AWS said and wrong for an operator at a terminal, so the script
refuses anything that is not a role ARN afterwards. A role with an IAM path must be
given without it, because the assumed-role ARN omits the path and the pathless form
is the only one an attestation can present.

A binding grants IDENTITY, and — with `--scopes` — the authority the mint gives
that identity. What it can never do is exceed the application: the app's own
grants are the ceiling, refused at the write and intersected away at every mint.
A privileged scope may be named, because a human writes this row; running the
script IS the staff check `isStaffUser` performs on a route, and the service
takes that as an explicit claim rather than a default, so a future caller with a
real actor to check must say so and fails closed if it does not. The environment
is still the deployment's, so a staging workload can never mint a production
token.

`--scopes` takes a comma-separated list. OMITTING it leaves an existing
binding's scopes untouched — the deploy step re-running this command predates
the flag and must not revoke what it never mentioned, which is exactly how
Mention's granted `signals:write` was wiped by routine application edits.
`--scopes=` is the explicit way to say "name none".

What the script refuses, and the failure each refusal prevents:

- **Repointing a subject already bound to another application.** The loud one. A
  repoint is silent and total — the old service keeps attesting, keeps receiving
  tokens, and every token now carries someone else's `applicationId`, so its writes
  land in another tenant's data with confident audit attribution to the wrong party.
  Moving a role means deleting the old row first, which leaves a trace.
- **An unknown application id**, on bind and on `--list` alike. An empty list and a
  mistyped id look identical in a terminal, and what follows the mistake is a second
  binding created under the id somebody meant.
- **An inactive or third-party application.** The mint re-applies both gates, so the
  row would be written, read as a finished rollout, and 403 at every use.
- **A subject that is not a role** — an IAM user, the account root, a federated
  user, a typo. All of them imply a long-lived secret, a human, or nothing at all.
- **A scope the application was never granted**, for staff too. The mint would
  drop it, leaving a row that reads as granting authority every token it
  produced silently lacked. Granting it on the application is a separate,
  deliberate act with its own staff gate.
- **A privileged scope from a caller that is not staff**, or from one that never
  said who is asking. Omitting an already-named privileged scope does not revoke
  it either: it is preserved and said out loud, because a re-run's silence is
  the arguments a deploy step has always carried, not a decision.
- **A misspelt scope.** It would sit in the table reading as granted while the
  mint dropped it, and surface as a 403 from another service with nothing
  pointing back at the row.

Re-running an identical bind is a no-op that reports the existing row, because a
bind is part of deploying a service and will be run twice. A re-run asking for a
different description or expiry says so and changes nothing, rather than letting
a create quietly become an edit.

Scopes are the one field a re-run DOES apply (`updated`, naming what moved), and
the asymmetry is deliberate: every service migrating today already HAS a binding
row, so naming its scopes on the existing row is the migration step. Under a
no-edit rule the only alternative is delete-and-recreate, which cuts a running
workload off between two commands. And unlike an expiry, a scope change cannot
be a silent widening — it is bounded by the application's grants and staff-gated
before the write is reached.

Nothing in the output is a secret. Unlike `create-service-credential.ts`, which
encrypts what it emits, a binding is an account number, a role name and an
application id — worthless without possession of the IAM role it names, which is
the whole reason ADR 0026 prefers it to a shared secret.

**Key files:**
- `packages/api/src/routes/auth.ts` — `POST /auth/service-token` (credential) and `/auth/service-token/workload*` (attestation)
- `packages/api/src/services/workloadAttestation.service.ts` — the provider seam; AWS STS verifier; `workloadAttestationHandle` (the pinnable `wl_…` id)
- `packages/api/src/services/workloadIdentity.service.ts` — challenge, binding lookup, scope and trust gates
- `packages/api/src/services/workloadIdentityBinding.service.ts` — creating a binding: canonicalisation, idempotence, refusals
- `packages/api/src/services/agencyServicePrincipal.service.ts` — the LIVE ceiling for both paths: `resolveLiveAgencyCoordinator` (credential) and `resolveLiveAgencyWorkload` (binding)
- `packages/api/scripts/bind-workload-identity.ts` — the operator entrypoint (`--app-id`, `--role-arn`, `--scopes`, `--list`)
- `packages/api/src/services/serviceTokenMint.service.ts` — the ONE signer both paths share
- `packages/api/src/models/Application.ts` — `isInternal`, `type` field
- `packages/api/src/models/ApplicationCredential.ts` — `publicKey`, `secretHash`, `type: 'service'`
- `packages/core/src/server/middleware.ts` — `middleware.auth()` service token handling, `middleware.service()`
- `packages/core/src/server/OxyServer.ts` — `serviceToken()`, `serviceRequest()`, `configureServiceAuth()`

**Usage in consuming services:**
```typescript
import { OxyServer } from '@oxy.so/core/server';

const oxy = new OxyServer({
  baseURL: 'https://api.oxy.so',
  serviceAuth: { apiKey: 'oxy_dk_...', apiSecret: 'secret...' },
});

// Auto-cached, auto-refreshed service token
const token = await oxy.serviceToken();

// Or act as a user
const result = await oxy.serviceRequest('POST', '/some/endpoint', data, { actAs: userId });
```

**Middleware for protecting internal endpoints:**
```typescript
// Only allows service tokens (rejects user JWTs and API keys)
app.use('/internal', oxy.middleware.service());
```

**A refusal is always observable to the host, and never to the client.** Every
branch of `middleware.auth()` that rejects a PRESENTED credential records
`req.oxyAuthRefusal` (`{ code, stage, reason, status, optional }`, read it with
`getOxyAuthRefusal` from `@oxy.so/core/server`), logs one `warn` carrying that
code, and calls the optional `onRefusal` observer — on the `optional: true`
mount too, where the request otherwise continues unauthenticated and the host
answers its own generic 401 with nothing written down anywhere. Response bodies
are unchanged, and a request carrying NO credential is an absence, not a
refusal. Delegation against a verifier that holds no service credential of its
own cannot reach `/internal/service-acting-as/verify` and so refuses every user:
verify with a credentialed client, or refuse at startup.

**The failure this was bought for:** `/.well-known/jwks.json` served
`{"keys":[]}` — no Ed25519 signing key bound — so every service token failed
`Oxy service-token key set is unavailable`, the optional mount swallowed it,
and the fault existed in no log on either side. That reason now reaches the
host's own logs.

## Self-Sovereign Identity Layer (PR #415)

### DID document (`did:web:oxy.so:u:<userId>`)

- DID is **account-anchored** on stable `_id`, not the keypair. Keypair = a verification method under `authMethods[]`.
- **Custodial** (no local key): `controller: [OXY_DID]`; `verificationMethod[]` from `publicKey` field if present.
- **Self-sovereign** (has Commons key): `controller: [did, OXY_DID]`; `verificationMethod[]` from `authMethods` (`EcdsaSecp256k1VerificationKey2019`, `publicKeyHex`, `#key-1`); `authentication`/`assertionMethod`.
- `alsoKnownAs[]` = `acct:<username>@oxy.so` + profile URL + `https://<verifiedDomain>` for each domain.
- `service[]` = Oxy API + profile endpoints.
- **Linking is one-way**: linking a root makes the DID self-sovereign; a root is never unlinked (ADR 0024 D8), only rotated. `userCache.invalidate(userId)` is called on every link.

**New API files:**
- `packages/api/src/services/did.service.ts` — `buildUserDid(userId)`, `buildDidDocument(user)` (derived on-demand, not stored)
- `packages/api/src/routes/did.ts` — `GET /u/:userId/did.json` (public; `Content-Type: application/json`; `Access-Control-Allow-Origin: *`; `Cache-Control: public, max-age=300`); `GET /.well-known/did.json` (Oxy org DID). Mounted in `server.ts` at root alongside federation handlers, **outside** the `/users` rate-limit group, no auth/CSRF.
- **Infra requirement** (pending): apex proxy must forward `oxy.so/u/*/did.json` + `oxy.so/.well-known/did.json` to the API. Fallback: anchor `did:web:api.oxy.so:u:<id>` (zero proxy work). See "Pending (post-merge)".

**New `User` model additions** (`packages/api/src/models/User.ts`):
- `did` virtual (derived from `_id`, surfaced in `toJSON`)
- `verifiedDomains?: [{domain, verifiedAt, method:'dns-txt'|'well-known'}]` + sparse index
- No new verification-method state — `authMethods` remains the single source.

### Signed Records

Envelope schema (in `@oxy.so/contracts`): `{version, type:'identity'|'profile', subject, issuer, record, issuedAt, publicKey, alg:'ES256K-DER-SHA256', signature}`. Signing input = `canonicalize` of everything except `publicKey` + `signature`.

- **`packages/core/src/crypto/canonicalJson.ts`**: `canonicalize(value)` (recursive key-sort/JCS-style; safe for nested objects unlike the flat `signRequestData` scheme). Export from `@oxy.so/core`.
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

### Core identity namespace (`oxy.identity`, `packages/core/src/api/identity.ts`)

`resolveDid`, `did` (getter), `authMethods`, `rootStatus`, `rotateKey`, `export` (signed bundle), `links.*` (Commons ↔ an account without a key; `links.complete` confirms with an emailed code), `domains.*` (`requestVerification`/`verify`/`list`/`remove`), `backup.*`. Cache-sweeps `/users/me` + DID cache after mutations. Heavy crypto loads on first use from `@oxy.so/core/crypto`.

## Accounts without a key — email, code, password, authenticator (ADR 0030)

Inventory and invariants: [`docs/identity/holders-and-recovery.md`](../identity/holders-and-recovery.md); the decision and its security design: [ADR 0030](../adr/0030-email-code-password-authenticator.md). There is no passkey and no web identity carrier (no envelope, no PRF, no web phrase, no move).

- **An account without a key signs in by email.** `users.public_key` is NULL; the dialog (`OxySignInPanel`, `packages/services/src/ui/components/signIn/`) runs `POST /auth/signin/email/start {identifier, device?}` → one email with a 6-digit code AND a link → `…/confirm {requestId, requestSecret, code}` or, when the link was opened in the same browser, `…/collect {requestId, requestSecret}`. "Use your password instead" → `POST /auth/signin/password` (`OxyPasswordPanel`). An account with an authenticator gets a second-factor challenge instead of a session → `POST /auth/signin/second-factor` (TOTP or backup code). Routes: `routes/signIn.ts`; the one session tail: `services/signInSession.service.ts`.
- **The link approves only the browser that asked.** It lands on `auth.oxy.so/email-signin` (`packages/auth/src/pages/email-signin.tsx`), which proves its credential for the browser's shared device (`POST /auth/signin/email/link`); the request is approved only when that is the device the dialog proved at `start`. The session is collected only with the dialog's `requestSecret` (stored as `email_signin_requests.request_secret_hash`).
- **Sign-up is one transaction.** `OxySignUpPanel`: username → `POST /auth/email/verify/start {purpose:'signup', email}` → code → `…/confirm` → a one-use ticket → `POST /auth/signup {username, email, emailTicket, device?}`, which spends the ticket in the transaction that creates the account. A taken email gets a notice instead of a code; the answer is the same.
- **Recovery is signing in by email.** There is no recovery flow and no `recovery` email purpose; a lost password is replaced after signing in with a code.
- **Password and authenticator live in settings** (`routes/accountSecurity.ts`, mounted at `/users/me`): `GET /sign-in-methods`, `PUT /password`, `POST /totp/{enroll,confirm,disable,backup-codes}`. Password: scrypt (`services/password.service.ts`); TOTP secret sealed (`utils/secretBox.ts`), backup codes HMAC'd, one use (`services/totp.service.ts`).
- **Sensitive changes need a fresh proof** (`services/reauth.service.ts`): the current password or a code from `POST /users/me/reauth/email {action}` for that ONE action (`change_password`, `totp`, `link_commons`, `delete_account`), plus the authenticator code when it is on.
- **Deletion.** `OxyDeleteAccountPanel`: typed username + `reauth` → `DELETE /users/me`; a Commons account signs `delete:{publicKey}:{timestamp}` with its key. The workflow (holds, closure fence, optional data, archive-or-delete + `account.deleted`) is `services/accountDeletion.service.ts`, shared with the operator script `packages/api/src/scripts/delete-accounts.ts` (dry run unless `--confirm`; local personal accounts only).
- **Linking Commons.** `OxyLinkCommonsPanel` opens `POST /identity/link` and shows its QR; Commons (`app/(auth)/link-account/`) signs the `link_identity` proof over the QR's challenge and posts it (`/identity/link/:linkId/proof`, no bearer); both devices show `deriveIdentityLinkCode`; the app completes it with an email `reauth` (`/complete`). `linkRootToAccount` (`services/identityLink.service.ts`) is the one place a root is first linked — also behind `POST /auth/link` — and deletes the email, the password and the authenticator in the same transaction.
- **Official apps only.** `/auth/signin/*`, `/auth/signup`, `/auth/email/*` and `/users/me/{reauth,password,totp}` answer only official Oxy apps and auth.oxy.so (`requireOfficialOrigin`); third parties use OAuth + PKCE. Rate limits by `hashedIpKey`, lockouts per identifier and per account, mail budgets per hashed requester and address (`reserveSendBudget`) — no IP is persisted. Mail: `smtpOutbound.sendSystem` from `noreply@`.
- **The email is not a profile field.** `PUT /users/me` does not write `email`, `/auth/register` (Commons) ignores one, and `GET /auth/check-email` is deleted.

## Sign in with Oxy — QR/Shared-Key Handoff (PR #415, extended by issue #691)

**User-facing label everywhere: "Sign in with Oxy"** — never say "Sign in with Commons"; the mechanism is invisible plumbing. The in-app `OxyAccountDialog` entry is the shared sign-in screen (see "Interactive sign-in" above): "Continue with Oxy" leaves it to Oxy — not the user — how the request reaches the Commons identity (see "Automatic delivery selection" below), and the embedded QR is a QR-only request (`AccountDialogController.startInlineQr`, `signIn.inline`) that pushes to no phone and opens no Commons, because the screen starts it by itself. Beside it, the same screen offers the email steps (code or link, password, authenticator; ADR 0030).

### Mechanism A — Same-device shared-keychain SSO (native-only)

- Commons writes shared identity at creation (`createSharedIdentity` / `migrateToSharedIdentity`); optionally `storeSharedSession` for warm SSO.
- `OxyServices.signInWithSharedIdentity()` (native-only): `requestChallenge(sharedPubKey)` → sign with shared key → `verifyChallenge` (plants tokens). Returns null on web.
- **`shared-key-signin`** is a native-only step in the unified device-first cold boot (`runSessionColdBoot` in `@oxy.so/core`), with a per-step timeout.
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
- **`selectCommonsDelivery({ platform, commonsAvailable, pushTargets })`** (`@oxy.so/core`, `packages/core/src/utils/commonsDelivery.ts`) is the pure decision, run by `AccountDialogController`: mobile + a VERIFIED Commons app-link openable on this device → `'open-commons'`; else `pushTargets >= 1` → `'await-push'`; else → `'qr'`. Exactly ONE route is primary, resolved once; the SDK never silently cascades from one delivery surface to the next.
- **Deploy step:** push delivery has zero eligible targets until Commons' `Application` record carries `identity:approval`. `bun run register:commons-clients` (`packages/api/scripts/register-commons-clients.ts` — idempotent, `DRY_RUN=1` supported, run as a one-shot ECS task like the reputation migration) mints/reuses Commons' `oxy_dk_…` client id AND UNIONs the capability onto the existing record; already applied in production (`packages/commons/constants/oxy.ts` carries the real minted id).

### The sign-in screen, one confirmation (issue #691)

- `OxyAuthChooser`'s `signin`/`add` entry is `OxySignInPanel` and `signup` is `OxySignUpPanel` (`packages/services/src/ui/components/signIn/`) — the same screens auth.oxy.so's `/login` renders. The ACTIVE REQUEST (`qr` view, `OxySignInRequestSurface`) still keeps its alternatives behind "Having trouble?" (`authChooser/TroubleDisclosure.tsx`), auto-revealed only when the chosen route reports `signIn.routeFailed`.
- Commons' approval screen (`packages/commons/components/commons-signin/approval-request.tsx`) is ONE confirmation: "Confirm identity" opens the device biometric/passcode prompt DIRECTLY — no intermediate "Continue" step. The only other answer is "This wasn't me"; a plain dismiss answers nothing. `POST /auth/session/deny/:authorizeCode` accepts an optional `reason` from a CLOSED set — `COMMONS_DENY_REASONS` in `@oxy.so/contracts` (`['declined', 'not_me']`) — anything else 400s before the handler runs.
- The approval screen shows a coarse, server-derived `requesterLabel` (e.g. "Chrome on Windows", max 64 chars — no full User-Agent, no IP, no geolocation), computed from the REQUEST'S OWN User-Agent header — never from the scanned QR/deep-link, which is requester-controlled and must never be a display source.

### Mechanism C — OAuth-bound Commons approval (issue #691, Phase 3 + IdP lane)

`AuthSession` also carries an optional OAuth binding so the SAME request model (create → approve → finalize) can mint a standard OAuth authorization code instead of a device sign-in: `purpose: 'device_sign_in' | 'oauth_authorization'` + `oauth?: { redirectUri, codeChallenge, codeChallengeMethod: 'S256', scopes, subjectAccountId? }`. `oxy.startCommonsSignIn({ clientId, oauth })` / `POST /auth/session/create` attach the binding — the `redirectUri` is validated against the SAME exact-match, constant-time allowlist `POST /auth/oauth/authorize` uses, and a non-S256 challenge is refused. Commons' approval screen and `approveCommonsSignIn`/`denyCommonsSignIn` are purpose-agnostic and need NO change to approve one. `oxy.finalizeCommonsOAuth(sessionToken)` / `POST /auth/session/finalize/:sessionToken` (no bearer — the secret `sessionToken` is the credential) mints exactly ONE single-use `AuthCode` via a reservation-style atomic `findOneAndUpdate` — the code id is allocated in the SAME update that spends the session, so a lost race or a later mint failure leaves the request spent rather than risking a double-mint — and refuses to run twice. A delegated `subjectAccountId` ("app will act as: org") is re-checked against the identity's live `account:act_as` membership at BOTH approval and finalize; a personal account can never be a delegated subject. `POST /auth/session/claim` (the device-sign-in claim) explicitly refuses an `oauth_authorization`-purpose session — an OAuth approval mints no access token, ever.

**IdP no-session lane (`packages/auth`):** when `auth.oxy.so/authorize` receives a full PKCE-bound OAuth request and cold boot finds no usable bearer on the IdP origin, `CommonsOAuthLane` (`packages/auth/components/commons-oauth-request.tsx`, orchestrated by `packages/auth/lib/commons-oauth-request.ts`) creates an OAuth-bound `AuthSession`, shows the QR, polls for approval, and finalizes into the authorization code — one continuous action with no sign-in on the IdP. The secret `sessionToken` never reaches the view/QR/URL; only the public `authorizeCode` travels. OAuth-bound `session/create` from the IdP skips the trusted-app browser-origin gate (redirect_uri is already exact-matched) and binds `boundOrigin` to the relying party's redirect origin, not `auth.oxy.so`. Visitors who already hold a bearer on the IdP still use the unchanged session-bearing consent path.

**IdP device-approval page (`auth.oxy.so/device?user_code=<authorizeCode>`):** a client with no browser of its own (a CLI in a terminal, over SSH, in a container) starts a `device_sign_in` request and shows the person the PUBLIC `authorizeCode`; `packages/auth/src/pages/device.tsx` lets them approve it in an ordinary tab. The parameter is `user_code`, never `code` — `OxyProvider`'s cold boot consumes and strips any `?code=`. It adopts the existing request (public `approve-info` first, so an expired/used code never sends anyone through sign-in), sends a person with no bearer to `/login?user_code=…` and back, offers the device chooser when several accounts are here, prints the code for comparison with the one the device shows, and fires `POST /auth/session/authorize-code/:code` ONLY from an explicit Allow press behind the same MANDATORY, un-defaulted acknowledgement as the hub (whatever `originVerified` says). The secret `sessionToken` never reaches this page; the device finishes by polling. No shipped client prints this link yet — the route answers only a well-formed code a device minted.

### SDK methods (core + services)

- `@oxy.so/core` `oxy.auth.commons` (`packages/core/src/api/auth.ts`): `start({ clientId, oauth? })`, `poll`, `deliver(authorizeCode)` (bearer, Phase 4 push delivery), `finalizeOAuth(sessionToken)` (Phase 3); Commons-side `approvalInfo` / `approve` / `deny` / `markOpened(authorizeCode)` (Phase 4 progress ping, no bearer, best-effort). Also `oxy.auth.signInWithSharedIdentity`, and `oxy.notifications.registerPushToken` / `unregisterPushToken`.
- `@oxy.so/services`: `OxyAccountDialog` surfaces `authorizeCode` + the structured `qrPayload` — renders the QR on web (QR only; shared-key is native-only) and deep-links Commons on the same device natively; `AccountDialogController` (`@oxy.so/core/session`) drives `selectCommonsDelivery` end to end.

## Auth (device-first)

Auth is device-first: `deviceId` + `deviceSecret` as transport (mint via `POST /session/device/token`; no refresh-token family, no `#oxy_boot` bootstrap), `DeviceSession` as server authority, one `OxyProvider` (`@oxy.so/services`) on web and native. No origin holds a cookie, `auth.oxy.so` included — see the Auth / Session Contract above. Canonical docs: `docs/auth/index.md` (start there — it is the one page answerable for being right, and it names what is built, what is not, and what is unverified) + `docs/SESSION-ARCHITECTURE.md` (see also `docs/auth/device-session.md`, `docs/auth/integration-guide.md`, and the ADRs under `docs/adr/`). `docs/architecture/` holds closed plan records that predate the multi-principal model — provenance, not mechanism. The full contract lives in "Auth / Session Contract" above — legacy browser-federation/SSO machinery (FedCM etc.) and the refresh/bootstrap transport were deleted end to end; do not reintroduce any of it.

- **Invalidated bearer token = local sign-out in `@oxy.so/services`**: `HttpService` clears tokens on 401 and emits `session.onChange(null)`. `OxyContext` MUST treat that as authoritative when a user is currently authenticated: clear session state, clear managed accounts, and disable private fetches until a new token/session is restored. Never let `isAuthenticated` remain true after `oxyServices.session.accessToken` becomes null. Consumer apps gate private work with SDK state only: `useAuth().canUsePrivateApi` / `useAuth().isPrivateApiPending`.
- **A sign-out outranks anything already in flight.** `oxy.session.clear()` is `HttpService.endSession()`: it bumps a session epoch, and a re-mint that started before it (device-secret arm, native shared-keychain arm, the handler's own plant) plants nothing — the device-secret arm persists the rotated secret only if the store still holds the credential it presented, so a store the sign-out cleared stays clear — and the native shared-keychain arm stays off until a token is planted again. A LATER device-secret mint is deliberately not blocked: it is how a signed-out tab joins a sign-in made in another tab. `OxyRuntime.clearSession()` does the same for projections: one whose profile fetch was in flight publishes nothing, because the revision guard cannot see a local teardown that left `SessionClient` at the same revision. A plain `HttpService.clearTokens()` (a linked client mirroring its parent) ends nothing.

## Sign-In Token Planting

`@oxy.so/core` `oxy.auth.verifyChallenge()` plants the access token internally before returning — matching `oxy.auth.claimSession`. Consumers (including `services` `useAuthOperations.performSignIn`) never hand-plant the token or fall back to the bearer-protected `getTokenBySession` after it. Just await `verifyChallenge` and proceed.

**Token-less new-identity onboarding**: the 401 fix (avoiding bearer-protected `getTokenBySession` for a brand-new identity that has no session yet) is preserved — `verifyChallenge`'s internal token plant handles it.

## External MCP connections — several accounts, one connector (ADR 0020)

A person authorizes an MCP connector once, for one account, and can then add more
accounts to that same connector without re-authorizing it. Oxy owns the account
set; a resource server only relays. The shapes:

- **Grant** (`mcp_oauth_grants`) — unchanged: one (principal, account, client,
  resource), with its own scopes, listed and revoked by that account's owner.
- **Connection** (`mcp_oauth_connections`) — the connector itself, keyed by the
  ORIGIN grant (the one whose token family the client refreshes), plus the
  currently selected member in `active_account_id` (NULL means the origin).
- **Membership** (`mcp_oauth_connection_accounts`) — one row per member grant. A
  junction rather than a `connection_id` column on the grant, because one grant
  can be its own connection's origin AND a member of somebody else's; a column
  would leak the first connector's account list into the second.
- **Link intent** (`mcp_oauth_account_link_intents`) — a single-use invitation,
  stored as a SHA-256 verifier of the opaque secret in the URL.

The flow, from inside an assistant:

1. The app's MCP tool asks its backend, which calls `POST
   /auth/mcp/oauth/connections/link-intent` (service credential, body `{ token }`
   = the live MCP access token). Oxy answers with
   `https://auth.oxy.so/mcp/link?intent=…`, valid once, for 15 minutes.
2. The person opens it, signs in or switches to the account they want to add, and
   approves (`src/pages/mcp-link.tsx` → `POST
   /auth/mcp/oauth/connections/link/{describe,approve}`). Approval writes an
   ORDINARY grant for that account with the connection's scopes and a membership
   row. `?mcp_link_intent=` carries the invitation across the sign-in hop.
3. `POST /auth/mcp/oauth/connections/active` selects a member. Oxy refuses a
   non-member, or one whose approver no longer holds `account:act_as`.
4. Introspection answers `{ active: true, …claims, connection: { connection_id,
   origin_account_id, active_account_id, accounts[] } }`. **The token is never
   re-minted:** its `account_id` stays the origin account. Serve
   `connection.active_account_id` — `@oxy.so/mcp` exposes it as
   `McpPrincipal.activeAccountId`, and `createCatalogMcpHttpService` binds the
   app's authorization decision to that, not to `accountId`.

5. `POST /auth/mcp/oauth/connections/viewer-graph` (service credential, body
   `{ token }`) answers `{ account_id, graph }`: the follows, mutuals, blocks and
   restrictions of the connection's ACTIVE account, the one introspection
   reports. This is how a resource server enforces the served account's privacy
   on an MCP request. `GET /users/me/graph` cannot: it never discloses blocks or
   restrictions to a service credential, because its `X-Oxy-User-Id` is a bare
   header any `user:read` service could set. Here the live token is the proof,
   it must be for a resource the calling application registered, and Oxy picks
   the account. Refuse a graph whose `account_id` is not the account you serve.

6. `POST /auth/mcp/oauth/connections/follow` (service credential, body
   `{ token, tool, target_user_id, action }`) follows or unfollows a LOCAL
   account as the connection's active account. A local follow graph moves only
   with its owner's consent, and here that consent is the token. `tool` must be
   a non-read tool in the resource's registered catalog, and the token must hold
   every capability that tool requires. That is the write action the person
   approved at consent. A federated target is refused (409): the resource
   server follows it over its own protocol.

Revocation needs no special path: a member revokes its own grant, `revokeGrant`
retires its memberships, and a selection that is no longer usable falls back to
the origin account on the next introspection.

## Auth App (packages/auth)

Standalone Vite app at `auth.oxy.so` — the **OAuth authorize/consent IdP** for third-party "Sign in with Oxy", the browser bridge (`/bridge`), the landing page of the email sign-in link (`/email-signin`), plus the MCP (`/mcp/link`) and CLI (`/device`) approval pages. It owns NO sign-in UI: `/login` renders the SDK's own screen (`OxySignInPanel` from `@oxy.so/services`), the same one every Oxy app's account dialog renders, via RN Web.

**ARCHITECTURE: the auth app is a device-first origin AND the OAuth authorize/consent IdP — NOT a Relying Party**
- It mounts `OxyProvider` from `@oxy.so/services` with NO special props (`packages/auth/src/main.tsx`): it runs the SAME device-first cold boot every Oxy app runs (restore THIS origin's device session from its own persisted `{deviceId, deviceSecret}`), enumerates the device directory through `useDeviceSwitcher`, and signs in through the SDK's own screens and funnels (the email/password/authenticator steps, the account dialog's Commons request). There is NO transport/chooser exception — the IdP is a device-first origin like accounts.oxy.so.
- **Still a shell, NOT a Relying Party:** after the SDK authenticates the user device-first, `authorize.tsx` still emits the OAuth authorization code for the third-party (`POST /auth/oauth/authorize`, gated by `GET /auth/oauth/consent`) using the SDK's ACTIVE-account bearer (`oxyServices.getAccessToken()`). Do NOT turn it into an RP that bounces elsewhere for its own session.
- `authorize.tsx` renders **`OxyConsentScreen`** from `@oxy.so/services` — the single OAuth consent surface (shows the registered `Application` identity + `privacyPolicyUrl`/`termsUrl`; the auto-approve decision is the registry-based `isTrustedApplication()` predicate server-side). The account chooser is the SDK's `OxyAccountPicker` fed by `useDeviceSwitcher` (more than one context) or the consent screen directly (a single one).
- **No UI of its own.** Every screen is built from the SDK's `OxyAuthScreen` / `OxyAuthScreenHeader` / `OxyAuthLoading` / `OxyAccountPicker` (`packages/services/src/ui/components/signIn/`). What stays here is only what is the IdP's: the routes, where a sign-in continues (`lib/auth-utils.ts` — `postLoginRedirectFrom`, `withRequestQuery`), the OAuth request lane (`lib/commons-oauth-request.ts`), the `web_message` relay (`lib/oauth-web-message.ts`) and the copy of its own pages (`lib/i18n/`, which follows the SDK's `currentLanguage`). There is no shadcn/Tailwind component kit here any more — do not reintroduce one.
- **No account management.** `accounts.oxy.so` owns it exclusively; the IdP's `/settings` routes permanently redirect to `accounts.oxy.so/security`, and `/settings/sessions` → `accounts.oxy.so/sessions` (`ExternalRedirect` routes in `src/main.tsx`).
- RP apps (Mention, accounts, console, inbox, Allo, Homiio) never redirect users to `auth.oxy.so` for first-party sign-in — their in-app dialog handles it, with the same screen; `auth.oxy.so` exists for the third-party OAuth redirect flow.
- `globals.css` scans the SDK's built `lib` for the NativeWind classes its screens use. Services is scanned at the workspace sibling (`../../services/lib`): bun links it under `packages/auth/node_modules`, never the repo root's, so a root-`node_modules` path scans nothing and every SDK class silently drops out of the bundle.

**Device-account chooser — same device-first SDK chain as every app (no bespoke IdP feed)**
- The chooser reads `useDeviceSwitcher()` from `@oxy.so/services` (the SAME device directory + `buildSwitcherRows` projection the SDK's own switcher renders); selecting a row activates `contextId` — the `principal acting as account` PAIR, never an account id. There is NO `oxy_device` cookie, NO `/auth/device/resolve` call, NO `/api/device-accounts` Pages Function, and NO `deviceResolve*` contract — all deleted in the 2c cutover.
- `user.name` is ALWAYS the structured object `{ first?, last?, full?, displayName? }` — NEVER a plain `z.string()`. `displayName` is optional (see `@oxy.so/contracts` `userNameSchema`).

**API endpoints used (the IdP's own; sign-in itself goes through the SDK):**
- `POST /auth/oauth/authorize`, `GET /auth/oauth/consent`, `GET /auth/oauth/client/:clientId`, `POST /auth/oauth/token`, `GET /auth/oauth/userinfo` — the third-party OAuth authorize/consent/token surface this app exists to serve. The token and userinfo endpoints speak RFC 6749 / OIDC on the wire (form-urlencoded request, FLAT response, `{ error, error_description }` failures).
- `GET /auth/session/approve-info/:code`, `POST /auth/session/authorize-code/:code` — the device-approval page (`/device`).

**`bun test` module mocks — the `@oxy.so/core` allowlist is the one that bites.** `packages/auth/lib/__tests__/setup-contracts-source.ts` maps `@oxy.so/contracts` to its WHOLE source (`mock.module("@oxy.so/contracts", () => contractsSource)`), as do the eight Jest `moduleNameMapper` entries in the other packages — those cannot drift when a runtime export is added. `setup-core-source.ts` is different: it is a hand-written ALLOWLIST of individual `@oxy.so/core` helpers, because importing core's real entry pulls optional RN modules bun cannot parse. Adding a `@oxy.so/core` VALUE import to auth app source without adding it there makes bun abort the WHOLE importing test file (`SyntaxError: Export named '…' not found`), so its cases silently leave the run rather than failing — `120 pass, 1 fail` while four `hub-passkey` cases had vanished. `core-mock-surface.test.ts` now fails the build on that drift, in both directions. Do NOT replace that allowlist with a whole-source mock; the RN-module parse failure is why it exists.

**Debugging rule this cost a session, twice in one day: check the layer BELOW the one the error names before accepting its diagnosis.** The bun error above names `packages/core/dist/esm/index.js` and a function nobody had touched — the truth was auth's test-time mock of that specifier, one layer down; core's built output was correct (the export was present at `dist/esm/index.js:39`). The same shape appeared in an AWS IAM trust policy where "the entry is missing" and "the entry does not match" are indistinguishable from a `describe`. Reproduce on a clean checkout of the BASE branch first: it separates "my change broke this" from "this was already broken", which a warm worktree cannot. Note also that a `pull_request` check runs on the MERGE commit, so a PR inherits `main`'s failures — read `HEAD is now at <sha> Merge <pr> into <base>` in the checkout log before assuming a red check is yours.

**The SPA plus ONE Pages Function — the root `functions/_middleware.ts`, and nothing else.** It records edge activity (`docs/edge-app-activity.md`) and passes every request through untouched. The device-account chooser is served entirely by the device-first SDK (`useDeviceSwitcher`); the `/api/device-accounts` feed deleted in the 2c cutover stays deleted. Everything else is static, with SPA history-fallback for unmatched navigations.
- **Use a Cloudflare Pages Functions DIRECTORY (`functions/`, file-based routing), never an advanced-mode single `dist/_worker.js`.** CF Pages was not detecting/invoking the advanced-mode worker on this project AT ALL (reproduced even on the direct `<hash>.oxy-auth.pages.dev` deployment URL); the fix (commit `1141ddb7`/#545) was migrating to the Functions-directory shape CF reliably detects. Deploy via a direct `bunx wrangler@4 pages deploy dist ...` `run:` step — never through npm/npx (npm's Arborist chokes on the repo-root `overrides["@oxy.so/bloom"]`, `npm error EOVERRIDE`; only bun's resolver tolerates it).
- Leftover per-apex `auth.<rp-apex>` CNAMEs and the deleted federation-era IdP env vars are INERT — nothing reads them; pending decommission in `oxy-infra`. Do not add new configuration that depends on them.
- Changes require a redeploy of auth.oxy.so to take effect in production.
