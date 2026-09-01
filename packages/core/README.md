# @oxyhq/core

OxyHQ SDK Foundation. Platform-agnostic core library that works in Node.js, browser, and React Native environments. No React dependency.

## Installation

```bash
bun add @oxyhq/core
```

## Contents

- **OxyServices API client** — all API methods for interacting with OxyHQ services
- **Device-first session engine** — `SessionClient` (`src/session/`), `runSessionColdBoot`, and the device-session mixin that back `OxyProvider` in `@oxyhq/services`
- **OAuth helpers** — `generatePkcePair`, `generateOAuthState`, `buildOAuthAuthorizeUrl` for third-party "Sign in with Oxy" (see [docs/auth/integration-guide.md](../../docs/auth/integration-guide.md))
- **Crypto** — KeyManager, SignatureService, RecoveryPhraseService
- **Models and types** — User, ApiError, ClientSession, and more
- **i18n** — translate function and locale files
- **Shared utilities** — color, theme, error, network, debug helpers
- **Platform detection utilities**
- **Device management**
- **Linked clients** for app backends that need the active Oxy bearer token
- **User identity contracts and handle normalization** so apps render display names and build local/federated profile handles consistently
- **Server middleware** for Express request identity, per-user rate limiting, and shared security headers / CSP baseline

## Exports

The package exposes two public entry points:

- `@oxyhq/core` — main entry (API client, session, crypto, models, shared utilities, i18n, platform, device)
- `@oxyhq/core/server` — Express-only helpers (`createOxyRateLimit`, `createOxyAuthMiddleware`, `requireOxyAuth`, `getOxyUserId`, `getRequiredOxyUserId`, `createOxyCors`, `createOxySecurityHeaders`, `buildOxyCspDirectives`, `safeFetch`, `verifySecret`, and request types)

All client/runtime symbols (including `SessionClient`, `KeyManager`, `SignatureService`, `RecoveryPhraseService`, and the shared color / theme / error / network / debug helpers) are re-exported from the package root. Server-only Express helpers live under `@oxyhq/core/server` so React Native and browser bundles never import Express.

## Usage

```ts
import { OxyServices, oxyClient, KeyManager } from '@oxyhq/core';
import type { User, ApiError } from '@oxyhq/core';

// Get user
const user = await oxyClient.getUserById('123');

// Crypto (KeyManager methods are static)
const hasIdentity = await KeyManager.hasIdentity();
```

## Device-First Sessions

The session authority is the server-side `DeviceSession` (one document per device: signed-in accounts + active account + revision). `@oxyhq/core` owns the whole client side of that contract:

- **`SessionClient`** (`src/session/`) — reads `GET /session/device/state`, mutates via `POST /session/device/{add,switch,signout}`, and applies `session_state` socket pushes (room `device:<deviceId>`, token-free payload) so every app on the same device stays in sync.
- **`runSessionColdBoot`** (`src/boot/sessionColdBoot.ts`) — the ordered, short-circuit cold-boot runner used by `OxyProvider`. It restores silently from device state or resolves to logged-out; it NEVER auto-redirects to a login page.
- **Zero-cookie transport** — every successful sign-in returns `deviceId` + a 256-bit `deviceSecret`, which the client persists first-party (localStorage per web origin; SecureStore on native). `POST /session/device/token` mints/refreshes a short access token from `{ deviceId, deviceSecret }` (no bearer, no cookies — possession of the secret is the proof) and rotates the secret in-use. There is no cookie, no refresh-token family, and no `#oxy_boot` bootstrap hop. Full contract: [docs/auth/device-session.md](../../docs/auth/device-session.md).

Consumers never build session restore themselves — mount `OxyProvider` from `@oxyhq/services` with a registered `clientId`.

## OAuth Helpers (third party)

Third-party apps sign users in with standard OAuth 2.0 Authorization Code + PKCE against `auth.oxy.so`:

```ts
import { generatePkcePair, generateOAuthState, buildOAuthAuthorizeUrl } from '@oxyhq/core';

const [pkce, state] = await Promise.all([generatePkcePair(), generateOAuthState()]);
const url = buildOAuthAuthorizeUrl({
  clientId: 'oxy_dk_…',
  redirectUri: 'https://merchant.example/auth/callback',
  codeChallenge: pkce.codeChallenge,
  state,
});
```

`OxySignInButton` in `@oxyhq/services` uses these internally when the resolved Application is `third_party`. See [docs/auth/integration-guide.md](../../docs/auth/integration-guide.md).

## User Identity And Handles

SDK user payloads may arrive with either `id` or Mongo-style `_id`; normalize
them before exposing state to apps:

```ts
import { getNormalizedUserId, normalizeUserIdentity } from '@oxyhq/core';

const id = getNormalizedUserId(user);
const normalizedUser = normalizeUserIdentity(user);
```

`User.name.displayName` is **optional** — federated or unresolved actors routinely
omit it. Render it directly when present; when absent, fall back to the
normalized handle (`displayName ?? handle`). Never rebuild names from
`name.first`, `name.last`, `name.full`, or `username`.

For profile display/routing, use `getNormalizedUserHandle()`. It strips a
leading `@`, preserves an existing `user@instance` handle, and appends
`instance`/`federation.domain` only for federated users:

```ts
import { getNormalizedUserHandle } from '@oxyhq/core';

getNormalizedUserHandle({ username: 'alice' }); // "alice"
getNormalizedUserHandle({ username: 'alice', isFederated: true, instance: 'example.social' }); // "alice@example.social"
```

## Linked App API Clients

Apps that call their own backend should derive API clients from the active SDK
instance instead of re-implementing auth headers, session restore, CSRF fetches,
or user forwarding.

```ts
import { OxyServices } from '@oxyhq/core';

const oxy = new OxyServices({ baseURL: 'https://api.oxy.so' });
const mentionApi = oxy.createLinkedClient({ baseURL: 'https://api.mention.earth' });

await mentionApi.post('/posts', { content: 'Hello from Oxy' });
```

Linked clients send the current Oxy bearer token for authenticated requests.
State-changing bearer requests do not fetch app-local CSRF tokens; cookie-only
writes still use CSRF.

**GET response caching is OFF by default for linked clients.** The
SDK's per-instance GET cache is only safe on the canonical `OxyServices` client,
where every mutation (`updateProfile`, `followUser`, `blockUser`, …) busts the
matching cached GET. A linked client targets the consuming app's own backend,
whose resources and write endpoints the SDK cannot know or invalidate — so a
cached GET there would serve stale data after the app mutates its own data.
Caching is left to the consumer's own layer (React Query / stores). Pass
`oxy.createLinkedClient({ baseURL, enableCache: true })` to opt back in when the
consumer accepts responsibility for invalidation.

## Backend Auth Middleware

Backends should use the SDK server helpers instead of local auth request types
or `requireAuth` copies.

```ts
import { OxyServices } from '@oxyhq/core';
import {
  createOxyRateLimit,
  requireOxyAuth,
  getRequiredOxyUserId,
  type OxyAuthRequest,
} from '@oxyhq/core/server';

const oxy = new OxyServices({ baseURL: 'https://api.oxy.so' });

app.use(createOxyRateLimit(oxy, { store: redisStore }));
router.use(requireOxyAuth);

router.get('/me', (req: OxyAuthRequest, res) => {
  const userId = getRequiredOxyUserId(req);
  res.json({ userId });
});
```

For routers that are not mounted after `createOxyRateLimit`, use
`createOxyAuthMiddleware(oxy)` to resolve the bearer session and require a user
in one middleware.

## Security Headers And CSP

`createOxySecurityHeaders` is Helmet plus the Oxy-wide Content-Security-Policy
baseline: the Cloudflare Web Analytics beacon (which Cloudflare injects into
proxied HTML, and which needs `static.cloudflareinsights.com` in `script-src`
AND `cloudflareinsights.com` in `connect-src`), the Oxy API and CDN origins the
SDK talks to, and the standard hardening floor. Apps never name those hosts
themselves.

Mount it on backends that SERVE HTML. A JSON-only API gains nothing from a
source-list CSP — it governs no browsing context — so harden those with the
non-CSP headers (`hsts`, `noSniff`, `frameguard`, CORP) instead.

```ts
import { createOxySecurityHeaders } from '@oxyhq/core/server';

app.use(createOxySecurityHeaders({
  csp: {
    connectSrc: ['https://api.example.com', 'wss://api.example.com'],
    frameSrc: ['https://player.vimeo.com'],
  },
  helmet: { crossOriginResourcePolicy: { policy: 'cross-origin' } },
}));
```

`csp` entries are ADDED to the baseline and deduped — a directive can never be
replaced, so `'self'` (and the beacon hosts) cannot be dropped; extending a
directive the baseline does not define seeds it with `'self'` first. The
`helmet` passthrough covers every non-CSP header (`hsts`, `frameguard`,
`referrerPolicy`, CORP/COOP, …) and rejects `contentSecurityPolicy` at compile
time so the baseline cannot be bypassed. Surfaces that set the header
themselves (a Next.js `headers()`, an edge worker) can call
`buildOxyCspDirectives(extensions)` for the resolved directive map.

## User Identity Normalization

`@oxyhq/core` normalizes user payloads returned by auth and user APIs so `id` is
always present when `_id` is the only identifier provided by the backend.
Consumers should compare `user.id` for ownership and permissions instead of
using backend-specific fields.

## Build

```bash
bun run build
```

Compiles with TypeScript, producing CJS, ESM, and type declaration outputs. The
ESM build must never contain `require()` calls — use `await import()` for
optional/platform-specific modules.

## KeyManager Safety

- `_persistIdentityAtomic` backs up the EXISTING identity before any overwrite, writes the new primary, runs a sign/verify probe, then refreshes the backup. A failed `createIdentity({overwrite:true})` rolls the primary back to the exact prior bytes — prior identity is never destroyed.
- `restoreIdentityFromBackup()` treats keychain-read exceptions as transient — never clobbers a healthy-but-locked primary. Rejects mismatched backups (dual mismatch guards).
- `deleteIdentity(skipBackup=false, force=false, userConfirmed=false)` — `force=true` also deletes the backup slot.

## `verifyChallenge` Token Planting

`OxyServices.verifyChallenge()` plants the freshly-minted access token internally before returning. Callers do not need to plant tokens manually after `verifyChallenge` — the SDK handles it.
