# Auth, sessions and identity — the mechanisms

> Moved out of `AGENTS.md` unchanged. The one-line rules stay there.

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
- **Explicit consent is a gesture, never a migration.** An authenticated official app that receives a typed missing/revoked-grant error renders a user action and calls `useOxy().requestOAuthConsent({ scopes, redirectUri })` from that press. The SDK validates exact configured scopes, keeps web/native on the existing state + PKCE transports, rejects a different returned subject, and commits no grant locally. No mount effect, automatic retry, whitespace normalization, name lookup or default scope may stand in for consent.
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

## Auth (device-first)

Auth is device-first: `deviceId` + `deviceSecret` as transport (mint via `POST /session/device/token`; no refresh-token family, no `#oxy_boot` bootstrap), `DeviceSession` as server authority, one `OxyProvider` (`@oxyhq/services`) on web and native. Relying-party origins are **zero-cookie**; `auth.oxy.so` alone holds the host-only `__Host-oxy-device` handle — see "The cookie rule, restated" in the Auth / Session Contract above and `docs/adr/0003-browser-device-session-hub.md`. Canonical docs: `docs/auth/index.md` (start there — it is the one page answerable for being right, and it names what is built, what is not, and what is unverified) + `docs/SESSION-ARCHITECTURE.md` (see also `docs/auth/device-session.md`, `docs/auth/integration-guide.md`, and the ADRs under `docs/adr/`). `docs/architecture/` holds closed plan records that predate the multi-principal model — provenance, not mechanism. The full contract lives in "Auth / Session Contract" above — legacy browser-federation/SSO machinery (FedCM etc.) and the refresh/bootstrap transport were deleted end to end; do not reintroduce any of it.

- **Invalidated bearer token = local sign-out in `@oxyhq/services`**: `HttpService` clears tokens on 401 and emits `onTokensChanged(null)`. `OxyContext` MUST treat that as authoritative when a user is currently authenticated: clear session state, clear managed accounts, and disable private fetches until a new token/session is restored. Never let `isAuthenticated` remain true after `oxyServices.getAccessToken()` becomes null. Consumer apps gate private work with SDK state only: `useAuth().canUsePrivateApi` / `useAuth().isPrivateApiPending`.

## Sign-In Token Planting

`@oxyhq/core` `OxyServices.verifyChallenge()` now calls `setTokens(accessToken, refreshToken ?? '')` internally before returning — matching the behaviour of `claimSessionByToken`. Consumers (including `services` `useAuthOperations.performSignIn`) no longer need to hand-plant the token or fall back to the bearer-protected `getTokenBySession` after `verifyChallenge`. Just await `verifyChallenge` and proceed; the SDK has already planted the token.

**Token-less new-identity onboarding**: the 401 fix (avoiding bearer-protected `getTokenBySession` for a brand-new identity that has no session yet) is preserved — `verifyChallenge`'s internal `setTokens` call handles it.

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
