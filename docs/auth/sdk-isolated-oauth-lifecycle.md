# Isolated OAuth session lifecycle (I11 candidate)

Status: source candidate, not released, published or adopted. The examples draft
[examples#4](https://github.com/OxyHQ/examples/pull/4) still uses published
`@oxy.so/services@11.0.0` and `@oxy.so/core@4.1.0`, whose isolated logout defect
is reproduced by the browser runner below. Candidate tarballs keep those nominal
versions solely for local verification and are **not publishable**. The release
must coordinate core + services (and composed contracts); services must require
at least the concrete new core version containing `apps.getPublic` cache options
and `SessionClient.resetLocalState`. The currently shipped core minimum cannot
remain the acceptance condition for the new services build. No version has been
selected, bumped or substituted into the public examples.

## Existing authority and resulting behavior

[tokens and credentials](tokens-and-credentials.md#third-party-isolation),
[ADR0029](../adr/0029-one-oxy-session.md) and the API authorize
exchange distinguish registered trusted applications from external OAuth clients.
`packages/api/src/routes/auth.ts:3202` preserves the trusted shared device lane,
but binds a third-party result to application/client/scopes without shared device
credentials. An operator's ownership of other sessions does not authorize an
external app to manage them.

The API now uses already verified `req.oxyToken` and `req.sessionId` in local
handler guards. It does not reinterpret a JWT or modify the shared resolver:

| Handler / routes | App-bound result | Existing unbound result |
| --- | --- | --- |
| POST `/session/logout/:sessionId` (+ optional `/:targetSessionId`) | Exact verified self only; cross-target403 | Existing same-owner target path retained |
| POST `/session/logout-all/:sessionId` |403, no global revocation | Existing behavior retained |
| POST `/session/device/logout-all/:sessionId` |403 | Existing behavior retained |
| GET `/session/device/sessions/:sessionId` |403, no device metadata | Existing behavior retained |
| PUT `/session/device/name/:sessionId` |403, no metadata mutation | Existing behavior retained |

The last two previously returned200 for an app-bound bearer targeting a different
unbound session of the same person; a synthetic PostgreSQL reproduction recorded
that violation before the fix. The negative now requires403, unchanged name and
both sessions still active, with positive unbound read/rename coverage.
The app-bound guards are tied to the verified token/session binding, including
older isolated grants; they do not add a registry lookup that might broaden that
existing grant into device authority.

SDK provenance is private provider-local state set only by its OAuth finalizer.
A missing device account alone never selects isolated logout. A legitimate
credential-free OAuth response commits one isolated session, hydrates its user,
and uses exact self-revocation on logout. Success or an expired bearer (401)
tears down local token/runtime/cache state; a transient failure retains the
session. It cannot sign out another app, enumerate/switch the shared device,
recover through Commons, or perform global/device logout.

On device→isolated transition the provider stops its socket and discards its
local projection and host credential, clears only its own persisted auth blob,
and replaces its session list. OAuth exchange already planted a bearer; teardown
reinstalls only that newly exchanged token. It never revokes other apps, erases
the cross-app credential slot, or calls Commons identity/key deletion. A private
SessionClient generation rejects old REST responses and socket callbacks even
after a later device lifecycle. Runtime projection generation and HttpService
session epochs retain their existing stale-response protections.
`core/src/session/__tests__/refresh.test.ts:338` already proves that a sign-out
mid-refresh with an erased secret cannot refill the store or plant an old bearer;
those cases pass in the 61-case core regression group. SDK teardown calls
`session.clear()`→HttpService.endSession, which moves the same epoch.

## Registry classification before restore

Cold boot resolves the registered client through the active public API projection
with `cache:false`, validates the existing public-application schema, and shares
one private predicate with the sign-in button and native finalizer. Registry
first_party/internal/system or explicit official/internal flags select the
existing device lane; names, origins and Oxy branding grant no trust.

Classification has a 5-second bound before the existing device boot deadlines.
Third-party clients complete an already pending OAuth callback or resolve signed
out; they never read a prior device secret, join the shared device or probe
Commons. Identity pin work runs only after a valid device classification. Host,
refresh/recovery, bridge, dialog and credential-provider side paths are gated as
well. Metadata errors, inactive/unusable credentials, invalid metadata and a
missing clientId fail closed; no privileged offline fallback exists. Consequently
an offline initial mount cannot restore even a trusted device until registry
classification succeeds. OAuth sessions remain ephemeral: a new process requires
an explicit OAuth sign-in; no refresh token, shared device directory or local
native-key recovery is invented.

The monorepo's production mounts in accounts, auth, Console, Commons, test apps
and create-oxy-app pass clientId; those values still require active registry
verification before adoption. Existing SDK examples/comments and callers that
omit it can no longer restore or route to the account dialog. The matrix scan of
previously inspected consumer sources found 29 provider openings: three omitted
explicit clientId at the original examples pin03f9d52 (Next, Vite, Expo).
Next/Vite are corrected only in the candidate examples#4; Expo remains pending
this SDK's actual release. The attached scan is selective source evidence, not
an exhaustive registry or deployment audit of all 50 repositories.

## Expo usage after a coordinated release

Configure a public clientId and a byte-exact registered redirect URI, including
any fixed query, in app configuration. These are existing application registration
inputs, not credentials this task creates. After installing the actual released
versions, the one provider and SDK button own the entire native exchange:

```tsx
<OxyProvider baseURL={apiUrl} clientId={registeredClientId}>
  <OxySignInButton
    oauthRedirectUri={registeredRedirectUri}
    nativeOAuthCompletion="sdk"
  />
</OxyProvider>
```

A custom UI may call `useOxy().startNativeOAuthSignIn({redirectUri})` from a user
gesture. It independently enforces native platform, registered external
classification and clientId. State and PKCE remain inside the SDK; the SDK
observes the in-app auth-session result and uses its common OAuth finalizer.
Exact fixed-query callback, duplicate code/state, error and mismatched-state
callbacks are validated before exchange. Cancellation commits nothing; overlapping
attempts cannot replace a pending handshake. No app-local callback, token store,
code exchange, fake deviceId or cast to SessionLoginResponse is needed.

Existing `onOAuthResult` manual handling is preserved for transition. Combining
it with `nativeOAuthCompletion="sdk"` fails before opening/exchange, preventing a
double exchange. No Linking fallback is used by the SDK completion lane because
it cannot observe and validate that return URL. This is source guidance; native
runtime/Expo adoption, Android device SSO and real OAuth/consent remain pending.

## Reproducible verification

Run each package's own test command. `scripts/rehearsal/isolated-oauth-browser.mjs`
accepts local ports and `OXY_PLAYWRIGHT_MODULE` for an installed Playwright module.
It intercepts all API/authorize traffic and aborts other nonlocal traffic; mock
metadata and tokens are synthetic and do not establish real registration or SSO.

```sh
# From an isolated Oxy worktree after frozen installation and SDK builds:
node node_modules/vite/bin/vite.js scripts/rehearsal/isolated-oauth-browser \
  --config scripts/rehearsal/isolated-oauth-browser/vite.config.ts \
  --host localhost --port 17857
# A separate shell, with Playwright already installed:
OXY_PLAYWRIGHT_MODULE=/absolute/path/to/playwright/index.mjs \
  node scripts/rehearsal/isolated-oauth-browser.mjs 17857
# Published examples preview; intentional exit 1 reproduces outstanding logout:
OXY_PLAYWRIGHT_MODULE=/absolute/path/to/playwright/index.mjs \
  node scripts/rehearsal/isolated-oauth-browser.mjs 17853 --expect-published-red
```

The packed-consumer fixture is copied outside every workspace. Its package.json
and overrides reference SHA-named core/services/contracts/protocol/telemetry
tarballs, all built locally with `bun run build && bun pm pack`. Its own Bun lock
and realpath proof show that every Oxy package resolves within that installation,
never to workspace sources. Neither this fixture nor the public examples was
published or deployed. Exact artifacts, installed paths and log hashes are in
`../audits/2026-10-02-isolated-oauth-lifecycle.json`.
