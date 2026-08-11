# auth.oxy.so — the Oxy IdP

> This page describes ONE component. The canonical entry for the whole
> authentication model is [index.md](./index.md) — read that first if you
> are looking for principals, contexts, the device directory, or what is
> and is not built.

`packages/auth` is the standalone identity-provider app served at **auth.oxy.so**: a pure-static Vite + React DOM SPA deployed to Cloudflare Pages (no Pages Function — see "Development" below). It owns:

- The **OAuth 2.0 authorize + consent** surface for third-party "Sign in with Oxy" (Authorization Code + PKCE) — see [integration-guide.md](./integration-guide.md).
- The fallback **login / signup / recover** flows (keyless password accounts, 2FA, social providers).
- The **device-account chooser feed** that lets a returning device pick one of its signed-in accounts before authorizing an app.

It does **not** own account management: every `/settings/*` path permanently redirects to **accounts.oxy.so**, the sole owner of security, sessions, and profile settings.

## What the IdP is — and is not

| | |
|---|---|
| **Is** | The OAuth authorize/consent screen for `type: 'third_party'` Applications registered in Console |
| **Is** | A login/signup/recover UI that authenticates against `api.oxy.so` |
| **Is not** | A third-party Relying Party — it authenticates device-first on its own origin, then emits OAuth codes for RPs |
| **Is not** | The session authority — that is `api.oxy.so` (`DeviceSession`, see below) |
| **Is not** | An account-management surface — `/settings/*` redirects to accounts.oxy.so |

Session authority and transport live entirely in `api.oxy.so`: zero-cookie `deviceId` + `deviceSecret` persisted first-party by the client, minted/refreshed via `POST /session/device/token` (no bearer, no cookies — possession of the secret is the proof). The server-side model is `DeviceSession` (`/session/device/*` + the `session_state` socket event) — see [device-session.md](./device-session.md). There is no cookie and no refresh-token family. FedCM and the legacy silent/cross-domain restore machinery were deleted from the IdP and the SDK.

The multi-person evolution of that model — principals, account contexts, one globally active context, and the browser DeviceSession hub this IdP is becoming — is specified in [principals-and-account-contexts.md](./principals-and-account-contexts.md) and the records under [`docs/adr/`](../adr/). Where the two disagree, the ADRs describe the target and this page describes what is deployed.

## Provider mount — `OxyProvider`, device-first like every app

The IdP mounts the single UI SDK, `@oxyhq/services`, with NO special props — it is a device-first origin exactly like accounts.oxy.so (`packages/auth/src/main.tsx`). The previous separate web SDK package no longer exists in the monorepo.

```tsx
import { OxyProvider } from '@oxyhq/services';

<OxyProvider baseURL={getApiBaseUrl()} clientId={OXY_CLIENT_ID}>
  <BrowserRouter>{/* routes */}</BrowserRouter>
</OxyProvider>
```

The provider runs the SAME device-first cold boot every Oxy app runs (restore this origin's session from its own persisted `{deviceId, deviceSecret}`), enumerates device accounts through `useSwitchableAccounts`, authenticates through the SDK funnels (`signInWithPassword` / `completeTwoFactorSignIn` / `handleWebSession`), and switches accounts through `switchToAccount`. It still supplies the `OxyAccountDialog` (Commons QR device-flow sign-in) and the `OxyConsentScreen` context. **It remains a SHELL** — after authenticating device-first it emits the OAuth authorization code for the third-party; it is NOT a Relying Party that bounces elsewhere for its own session. The former `coldBoot={false}` exception existed for the SSO bounce the zero-cookie cutover deleted.

## Routes / pages

| Route | Page / handler | Purpose |
|-------|----------------|---------|
| `/login`, `/auth/login` | `src/pages/login.tsx` → `LoginForm` | Account chooser (device accounts) → identifier → password → 2FA. "Sign in with Oxy" opens the services `OxyAccountDialog` (Commons QR). Accepts OAuth params (`client_id`, `redirect_uri`, `state`, `code_challenge`, `scope`, `login_hint`) to resume an authorize flow after sign-in |
| `/signup`, `/auth/signup` | `src/pages/signup.tsx` | Keyless password account creation (`POST /auth/signup`) |
| `/authorize`, `/auth/authorize` | `src/pages/authorize.tsx` | OAuth authorize: resolves the Application via `GET /auth/oauth/client/:clientId`, shows the account chooser, checks `GET /auth/oauth/consent`, renders **`OxyConsentScreen`** (from `@oxyhq/services`; shows the Application's name, logo, scopes, `privacyPolicyUrl`/`termsUrl`), mints the single-use code via `POST /auth/oauth/authorize`, redirects to the RP's `redirect_uri` |
| `/recover`, `/auth/recover` | `src/pages/recover.tsx` | Password recovery (`/auth/recover/request` → `verify` → `reset`) |
| `/auth/social/callback` | `src/pages/social-callback.tsx` | Social-provider OAuth callback (no layout) |
| `/settings`, `/settings/password`, `/settings/linked-accounts` | `ExternalRedirect` | → `https://accounts.oxy.so/security` |
| `/settings/sessions` | `ExternalRedirect` | → `https://accounts.oxy.so/sessions` |
| `/` | `ExternalRedirect` | → `https://oxy.so` |
| `*` | `Navigate` | → `/login` |

## Device-account chooser — device-first SDK (no bespoke feed)

The chooser ("Choose an account to continue") uses the SAME device-first SDK chain every Oxy app uses — there is NO server-side feed, NO `oxy_device` cookie, and NO Pages Function anymore (all deleted in the 2c cutover):

1. `useSwitchableAccounts()` (from `@oxyhq/services`) projects the device's account set (`projectSwitchableAccounts` — the same projection accounts.oxy.so renders).
2. `components/account-chooser.tsx` renders that `SwitchableAccount[]` on `/login` and `/authorize`.
3. Selecting the active account continues immediately; selecting a sibling calls `useOxy().switchToAccount(accountId)` (the uniform device-first switch, which re-plants the active bearer), then proceeds. A switch that can't complete falls back to `/login?login_hint=…` for explicit re-auth.

The whole app (login, signup, authorize, recover) is a pure-static Vite SPA with history-fallback — no dynamic routes, no Pages Function, no advanced-mode worker.

## API endpoints the IdP calls

All against `api.oxy.so` (`VITE_OXY_API_URL` in dev):

| Endpoint | Used by |
|----------|---------|
| `POST /auth/login` · `POST /auth/signup` | Login / signup forms |
| `POST /security/2fa/verify-login` | 2FA step |
| `POST /auth/recover/{request,verify,reset}` | Recovery flow |
| `GET /auth/social/:provider` + `/auth/social/callback` | Social sign-in |
| `GET /auth/session/status/:token` · `POST /auth/session/{authorize,cancel}/:token` | Cross-device session handoff (QR approve/deny) |
| `GET /auth/oauth/client/:clientId` | Resolve the requesting Application (public identity) |
| `GET /auth/oauth/consent` | Consent decision for the signed-in user |
| `POST /auth/oauth/authorize` | Mint the single-use authorization code |
| `GET /csrf-token` | CSRF for cookie-credentialed writes |

The code→token exchange (`POST /auth/oauth/token`, RFC 6749 §4.1.3) happens on the RP side, never on the IdP — see [integration-guide.md](./integration-guide.md).

## Development

- **Tests:** `cd packages/auth && bun run test` — this package uses Bun's native test runner (`bunfig.toml` preload), not Jest. Never blanket-run `bun test` across the monorepo.
- **Deploy:** Cloudflare Pages (pure-static SPA — no `functions/` directory / Pages Function anymore).

## Related docs

- [oxy-auth-platform.md](../architecture/oxy-auth-platform.md) — master plan and decisions
- [integration-guide.md](./integration-guide.md) — third-party "Sign in with Oxy" (OAuth + PKCE)
- [device-session.md](./device-session.md) — `DeviceSession` API, socket sync, multi-account
- [principals-and-account-contexts.md](./principals-and-account-contexts.md) — the vocabulary: identity, principal, account, device session, context
- [tokens-and-credentials.md](./tokens-and-credentials.md) — access token v2 claims, resource-server validation, third-party isolation, the v1 window
