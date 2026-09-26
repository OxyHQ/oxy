# auth.oxy.so — the Oxy IdP

> This page describes ONE component. The canonical entry for the whole
> authentication model is [index.md](./index.md) — read that first if you
> are looking for principals, contexts, the device directory, or what is
> and is not built.

`packages/auth` is the standalone identity-provider app served at **auth.oxy.so**: a pure-static Vite + React DOM SPA deployed to Cloudflare Pages (no Pages Function — see "Development" below). It owns:

- The **OAuth 2.0 authorize + consent** surface for third-party "Sign in with Oxy" (Authorization Code + PKCE) — see [integration-guide.md](./integration-guide.md).
- The **login** page — the same services `OxySignInPanel` every app's dialog renders (email or username → emailed code or link → optional password → optional authenticator; sign-up in place with `?screen=signup`), and `/email-signin`, where the email's link lands ([ADR 0030](../adr/0030-email-code-password-authenticator.md)).
- The **device-account chooser feed** that lets a returning device pick one of its signed-in accounts before authorizing an app.

It does **not** own account management: every `/settings/*` path permanently redirects to **accounts.oxy.so**, the sole owner of security, sessions, and profile settings.

## What the IdP is — and is not

| | |
|---|---|
| **Is** | The OAuth authorize/consent screen for `type: 'third_party'` Applications registered in Console |
| **Is** | The login page (the services sign-in panel) and the email link's landing page, authenticating against `api.oxy.so` |
| **Is not** | A third-party Relying Party — it authenticates device-first on its own origin, then emits OAuth codes for RPs |
| **Is not** | The session authority — that is `api.oxy.so` (`DeviceSession`, see below) |
| **Is not** | An account-management surface — `/settings/*` redirects to accounts.oxy.so |

Session authority and transport live entirely in `api.oxy.so`: `deviceId` + `deviceSecret` persisted first-party by the client, minted/refreshed via `POST /session/device/token` (no bearer, no cookies — possession of the secret is the proof). The server-side model is `DeviceSession` (`/session/device/*` + the `session_state` socket event) — see [device-session.md](./device-session.md). There is no refresh-token family. FedCM and the legacy silent/cross-domain restore machinery were deleted from the IdP and the SDK.

This origin sets no cookie, like every other Oxy origin: it persists its own `{deviceId, deviceSecret}` in `localStorage`. The browser hub cookie of [ADR 0003](../adr/0003-browser-device-session-hub.md) was never deployed and is deleted.

The multi-person evolution of that model — principals, account contexts, and one globally active context — is specified in [principals-and-account-contexts.md](./principals-and-account-contexts.md) and the records under [`docs/adr/`](../adr/). Where the two disagree, the ADRs describe the target and this page describes what is deployed.

## Provider mount — `OxyProvider`, device-first like every app

The IdP mounts the single UI SDK, `@oxy.so/services`, with NO special props — it is a device-first origin exactly like accounts.oxy.so (`packages/auth/src/main.tsx`). The previous separate web SDK package no longer exists in the monorepo.

```tsx
import { OxyProvider } from '@oxy.so/services';

<OxyProvider baseURL={getApiBaseUrl()} clientId={OXY_CLIENT_ID}>
  <BrowserRouter>{/* routes */}</BrowserRouter>
</OxyProvider>
```

The provider runs the SAME device-first cold boot every Oxy app runs (restore this origin's session from its own persisted `{deviceId, deviceSecret}`), enumerates the device directory through `useDeviceSwitcher`, authenticates through the services sign-in panel (`/auth/signin/*`, ADR 0030), and switches through `activateContext`. It still supplies the `OxyAccountDialog` (Commons QR device-flow sign-in) and the `OxyConsentScreen` context. **It remains a SHELL** — after authenticating device-first it emits the OAuth authorization code for the third-party; it is NOT a Relying Party that bounces elsewhere for its own session. The former `coldBoot={false}` exception existed for the SSO bounce the zero-cookie cutover deleted.

## Routes / pages

| Route | Page / handler | Purpose |
|-------|----------------|---------|
| `/login`, `/auth/login` | `src/pages/login.tsx` | Account chooser (device accounts), then the services `OxySignInPanel`: email or username → the emailed code (or the link, same browser) → "Use your password instead" → the authenticator step when the account has one; the Commons QR. `?screen=signup` renders `OxySignUpPanel` in place. Accepts OAuth params (`client_id`, `redirect_uri`, `state`, `code_challenge`, `scope`, `login_hint`) to resume an authorize flow after sign-in |
| `/authorize`, `/auth/authorize` | `src/pages/authorize.tsx` | OAuth authorize: resolves the Application via `GET /auth/oauth/client/:clientId`, shows the account chooser, checks `GET /auth/oauth/consent`, renders **`OxyConsentScreen`** (from `@oxy.so/services`; shows the Application's name, logo, scopes, `privacyPolicyUrl`/`termsUrl`), mints the single-use code via `POST /auth/oauth/authorize`, redirects to the RP's `redirect_uri` |
| `/email-signin` | `src/pages/email-signin.tsx` | The email link's landing page: reads the token from `#t=` (and strips it from history), approves the request with THIS browser's device (`POST /auth/signin/email/link`); in another browser it asks for the code instead |
| `/device`, `/mcp/link` | `src/pages/device.tsx`, `src/pages/mcp-link.tsx` | Device-flow approval (CLI) and adding an account to an MCP connection |
| `/settings` | `ExternalRedirect` | → `https://accounts.oxy.so/security` |
| `/settings/sessions` | `ExternalRedirect` | → `https://accounts.oxy.so/sessions` |
| `/` | `ExternalRedirect` | → `https://oxy.so` |
| `*` | `Navigate` | → `/login` |

## Device-account chooser — device-first SDK (no bespoke feed)

The chooser ("Choose an account to continue") uses the SAME device-first SDK chain every Oxy app uses — there is NO server-side feed, NO `oxy_device` cookie, and NO Pages Function anymore (all deleted in the 2c cutover):

1. `useDeviceSwitcher()` (from `@oxy.so/services`) reads the server's device directory (ADR 0002) — every principal on this device and the contexts each may act as — through the same `buildSwitcherRows` projection the SDK's own switcher renders.
2. The SDK's `OxyAccountPicker` renders those rows on `/login` (inside `OxySignInPanel`), `/authorize`, `/device` and `/mcp/link`, grouped by person: the same organization reachable through two people is two rows, and the operator is named once anybody holds more than one account.
3. Selecting the active context continues immediately; selecting any other calls `activateContext(contextId)` — the pair, never an account id — which re-plants the active bearer, then proceeds. A refusal (including a context id the server has since healed away) falls back to `/login?login_hint=…` for explicit re-auth.

The app's own pages (login, authorize, device, MCP link, email sign-in) are a static Vite SPA with history-fallback — no dynamic routes and no advanced-mode worker. The only Pages Function on this origin is the root `functions/_middleware.ts`, which records edge activity and serves no page.

## API endpoints the IdP calls

All against `api.oxy.so` (`VITE_OXY_API_URL` in dev):

| Endpoint | Used by |
|----------|---------|
| `POST /auth/signin/email/{start,confirm,collect}` · `POST /auth/signin/password` · `POST /auth/signin/second-factor` | The sign-in panel |
| `POST /auth/email/verify/{start,confirm}` · `POST /auth/signup` | The sign-up panel |
| `POST /auth/signin/email/link` | `/email-signin` (auth.oxy.so only) |
| `GET /auth/session/status/:token` · `POST /auth/session/{authorize,cancel}/:token` | Cross-device session handoff (QR approve/deny) |
| `GET /auth/oauth/client/:clientId` | Resolve the requesting Application (public identity) |
| `GET /auth/oauth/consent` | Consent decision for the signed-in user |
| `POST /auth/oauth/authorize` | Mint the single-use authorization code |

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
