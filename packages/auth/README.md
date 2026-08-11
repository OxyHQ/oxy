# Oxy Auth Web

Standalone Vite app — the Oxy authentication gateway (OAuth-like, similar to "Sign in with Google"): OAuth 2.0 authorize/consent IdP for third-party "Sign in with Oxy". Handles sign in, sign up, recovery, and authorization for third-party apps. Not a user dashboard.

## Routes

- `/login` - Password sign-in (email/username + password)
- `/signup` - Password sign-up (email + username + password)
- `/recover` - Password recovery (request → verify → reset)
- `/authorize?token=...&redirect_uri=...&state=...` - Approve a third-party auth session

There is no landing page at `/`.

## API Base URL

The web app calls the API directly. In development it defaults to
`http://localhost:4100`. Override with:

- `VITE_OXY_API_URL` (preferred) — Example: `http://localhost:4100`
- `VITE_OXY_AUTH_URL` (legacy alias)

## Development

```bash
# Terminal 1 (API)
cd ../api
bun run dev

# Terminal 2 (Auth web)
cd ../auth
bun run dev
```

Default ports:
- Auth web: http://localhost:8105
- API: http://localhost:4100

## Flow Overview

1. A third-party app creates an auth session via the API.
2. The user is sent to `/authorize?token=...` (web) or the Accounts app (mobile).
3. The auth gateway signs in the user and authorizes the session.
4. The app receives the session token/access token and completes login.

**Popup delivery (issue #691, Phase 2):** when the relying party asked for `response_mode=web_message` and `/authorize` has a real `window.opener`, step 4 is a `postMessage` relay — `{code, state}` or a typed OAuth error posted to the opener at the redirect URI's EXACT origin (never `*`), followed by `window.close()` — instead of a redirect to `redirect_uri`. `lib/oauth-web-message.ts` owns this decision; every other request (no opener, or no `response_mode=web_message`) redirects exactly as before.

## Deploy Safety (IdP is production-only — there is NO staging)

`auth.oxy.so` is the OAuth authorize/consent IdP for the entire Oxy ecosystem and has **no staging environment** — every push to `main` deploys straight to production for all users. The IdP is a **pure-static Vite SPA** deployed to Cloudflare Pages — no Pages Function, no `_worker.js`, no server directory. It authenticates device-first through the same `OxyProvider` (`@oxyhq/services`) every Oxy app uses; the device-account chooser enumerates the server's device directory via the shared device-first SDK (`useDeviceSwitcher`), not a bespoke feed. FedCM and the legacy `/sso` bounce machinery were removed from the IdP entirely. A broken IdP build (blank SPA, or a regression that re-adds the FedCM manifest) takes "Sign in with Oxy" down everywhere.

One gate protects the deploy (`.github/workflows/deploy-cloudflare.yml`, job `deploy-auth`): after the Cloudflare Pages deploy, `bun run smoke:idp` (`scripts/smoke-idp.ts`) hits the LIVE host on PUBLIC, unauthenticated endpoints only and turns the job RED on any failure. It asserts: `/login`, `/signup`, and `/authorize` carry the SPA root marker (build not broken); and `/.well-known/web-identity` does NOT serve a FedCM manifest (asserts the deletion stays deleted — a regression that re-adds `provider_urls` fails the gate).

Run it locally against production any time:

```bash
cd packages/auth
bun run smoke:idp                                   # default target https://auth.oxy.so
SMOKE_TARGET=https://auth.mention.earth bun run smoke:idp
```

**Contribution norm for IdP changes:**

- **Batch IdP changes and land them via PR**, not rapid direct-to-`main` cosmetic pushes. Each push is an un-staged production deploy; a flawed intermediate build briefly broke `auth.oxy.so` exactly because cosmetic changes were pushed straight to `main` one at a time.
- The **post-deploy smoke gate must stay green**. If it goes red, the live IdP is broken — treat it as an incident, not a flaky test.
- **Always verify the logged-OUT cold-boot path** (`/login` and `/signup` for a fresh, no-cookie visitor). That is the real first-time user path and the one that broke today; a logged-in spot check is not sufficient.

## Key Patterns

- `AuthFormLayout` + `AuthFormHeader` — shared layout for all auth screens
- `AuthLayout` (route layout) — persistent logo/footer, route-level fade transitions via `useNavigationType()`
- Login form: multi-step (identifier → password → 2FA) with per-step animations
- `applyColorPreset()` from `lib/bloom-css.ts` — applies user's Bloom color theme to CSS vars on `:root`
- `OxyServices.lookupUsername()` — lightweight user lookup (validates existence, gets color/avatar)
- Zod schemas in `lib/schemas.ts`; shared types in `lib/types.ts`

## Anti-patterns to Avoid

- No `useEffect` for syncing props to state — derive during render
- No `useEffect` for firing toasts — call `toast()` in event handlers
- No `useEffect` for focus — use `requestAnimationFrame` in event handlers
- No `Suspense` wrappers unless using `React.lazy()` or `use()`
- No render-body side effects — use `useEffect` for `window.location.href`, or `<Navigate>` from react-router
