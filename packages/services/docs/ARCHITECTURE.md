# @oxyhq/services — Architecture

`@oxyhq/services` is the **single UI SDK** for the Oxy ecosystem. It ships one provider and one set of auth/account surfaces for **Expo native and React Native Web**. The former web-only auth SDK package has been removed from the monorepo — web apps (Console, and the IdP at `auth.oxy.so` via RN Web) mount the same `OxyProvider` as native apps.

Related docs:

- [Session & device model](../../../docs/auth/device-session.md) — DeviceSession API, socket events, multi-account
- [Third-party integration guide](../../../docs/auth/integration-guide.md) — "Sign in with Oxy" OAuth + PKCE
- [Platform plan](../../../docs/architecture/oxy-auth-platform.md) — product/architecture decisions

## Layer map

| Layer | Package | Role |
|-------|---------|------|
| Contracts | `@oxyhq/contracts` | Zod schemas shared by server and clients (`deviceSessionStateSchema`, OAuth/consent contracts). Zero React/RN. |
| Foundation | `@oxyhq/core` | `OxyServices` API client, the session module (`SessionClient`, cold boot, account projection, auth-state store), OAuth + PKCE helpers, i18n catalog, server middleware. Zero React/RN. |
| UI SDK | `@oxyhq/services` (this package) | `OxyProvider` + `OxyContext`, `useAuth`/`useOxy`, `OxyAccountDialog`, `OxySignInButton`, `OxyConsentScreen`, `RequireOxyAuth`, account/management screens, bottom sheets, React Query hooks. |
| Apps | accounts, console, inbox, commons, the IdP, third-party RPs | Mount `OxyProvider` with a registered `clientId`. No app-local auth code. |

`@oxyhq/services` does **not** re-export from `@oxyhq/core` or `@oxyhq/contracts` — consumers import core/contract types directly from the owning package.

## OxyProvider / OxyContext

`OxyProvider` ([src/ui/components/OxyProvider.tsx](../src/ui/components/OxyProvider.tsx)) is the app root. It mounts:

`OxyRuntimeProvider` — the internal auth/session state machine (never mounted by
consumers; `OxyProvider` is the only public provider). Implementation split across:

| Module | Role |
|--------|------|
| [OxyContext.tsx](../src/ui/context/OxyContext.tsx) | Provider, session commit funnel, cold boot wiring |
| [oxyContextTypes.ts](../src/ui/context/oxyContextTypes.ts) | `OxyContextState`, `PasswordSignInResult`, props |
| [oxyContextHelpers.ts](../src/ui/context/oxyContextHelpers.ts) | Shared helpers (`loadUseFollowHook`, HTTP status) |
| [useOxyAccountGraph.ts](../src/ui/context/useOxyAccountGraph.ts) | Account graph (`accounts`, `switchToAccount`, `createAccount`) |
| [accountDialogManager.ts](../src/ui/navigation/accountDialogManager.ts) | Imperative `openAccountDialog` / `closeAccountDialog` |
- TanStack `QueryClientProvider` with offline persistence (first paint serves cached data)
- Bloom dialog + toast outlets, `SafeAreaProvider`, `GestureHandlerRootView`
- Lazy overlays: `BottomSheetRouter` and the unified `OxyAccountDialog`

```tsx
import { OxyProvider, useAuth } from '@oxyhq/services';

export default function App() {
  return (
    <OxyProvider
      clientId={process.env.EXPO_PUBLIC_OXY_CLIENT_ID}
      baseURL="https://api.oxy.so"
    >
      <Root />
    </OxyProvider>
  );
}

function Root() {
  const { user, isAuthenticated, isLoading, signIn } = useAuth();
  if (isLoading) return null;
  if (!isAuthenticated) return <SignedOutHome onSignIn={() => signIn()} />;
  return <Home user={user} />;
}
```

Key props (`OxyProviderProps`):

| Prop | Default | Purpose |
|------|---------|---------|
| `clientId` | — | The app's registered OAuth client id (`ApplicationCredential.publicKey`, `oxy_dk_…`). Required for the cross-app device sign-in flow (`POST /auth/session/create` identifies the requesting app by it). |
| `authRedirectUri` | origin | OAuth redirect URI for third-party sign-in. Defaults to the current web origin (origin-only, e.g. `https://mention.earth`). Optional `/oauth/callback` path for new apps — mount `OxyOAuthCallback` on that route. |
| `webAuthMode` | `'popup'` | How a web sign-in reaches the IdP. `'popup'` keeps the tab on its route; `'redirect'` navigates it. The popup transport falls back to a redirect on its own when the browser blocks the window, so the callback route must keep working in either mode. |
| `baseURL` | — | Oxy API origin (`https://api.oxy.so`). |
| `requireAuth` | `'off'` | Convenience wrapper: `'soft'` / `'hard'` wraps children in `<RequireOxyAuth prompt=…>`. |
| `storageKeyPrefix`, `queryClient`, `oxyServices`, `onAuthStateChange` | — | Advanced overrides. |

### Device-first cold boot

On mount every app runs `runProviderColdBoot` → `runSessionColdBoot` from `@oxyhq/core` — an ordered step chain: `warm-token-plant` (replay a still-valid persisted access token, no network), then `device-secret-mint` (persisted `{deviceId, deviceSecret}` → `POST /session/device/token`, web + native), then `shared-key-signin` (native; `identity-key-signin` instead under `sessionMode: 'identity'`).

**Cold boot never navigates the top-level window.** An origin with no local credential resolves signed OUT and waits for the user's "Continue with Oxy" — there is no silent `prompt=none` restore and no post-login hub sync in any mode. Both were removed (issue #691 phase 7b) precisely because they moved the tab without a gesture, destroying in-page state on every cold boot. Do not reintroduce either, nor a `hubSync` prop.

## Session model (consumed from `@oxyhq/core`)

The SDK contains no session logic of its own — it binds UI to the shared session module in `packages/core/src/session/`:

| Module | Role |
|--------|------|
| `SessionClient` / `createSessionClient` / `createSessionClientHost` | Client of the server-authoritative device session: fetch/mutate state, subscribe to realtime sync. Consumers inject a `TokenTransport` and a `socketFactory` (socket.io-client's `io`). |
| `projectSessionState` helpers | Pure projections of `DeviceSessionState` → client sessions / active user. |
| `deviceDirectory` / `deviceSwitcherRows` | The ONE switcher list: the server's device directory (ADR 0002) grouped by PRINCIPAL, with names/handles/avatars resolved. The client no longer unions device sign-ins with a fetched account graph — it cannot enumerate another principal's memberships, so switchability is the server's answer. |
| `accountSwitchTargets` | `isSwitchTargetAccount` / `canSwitchIntoAccount` — the switch-target predicates over the account GRAPH (what a caller can manage), asked by the Console's workspace tree and the Accounts app's managed-account rows. Not the device switcher. |
| `accountDialogController` | Headless state machine for the account dialog (views, sign-in flow phases). Framework-agnostic; bound via `useSyncExternalStore`. |
| `authStateStore`, `refresh` | Persisted auth state + the unified token-refresh handler/scheduler. |
| `boot/sessionColdBoot` | `runSessionColdBoot` — ordered cold-boot runner (`device-secret-mint` then `shared-key-signin`). |

**Server authority:** the `DeviceSession` document (Mongo collection `devicesessions`: `deviceId`, `accounts[{ accountId, sessionId, authuser, operatedByUserId? }]`, `activeAccountId`, `secretHash`, `revision`) behind `/session/device/{token,state,add,switch,signout}`. Every mutation bumps `revision` and broadcasts a token-free `session_state` event to the Socket.IO room `device:<deviceId>`, so all apps on the same device converge instantly. See [device-session.md](../../../docs/auth/device-session.md).

**Session transport (zero-cookie):** every successful sign-in returns `deviceId` + a 256-bit `deviceSecret`, persisted first-party (localStorage per web origin; SecureStore on native) — the server stores only `sha256(deviceSecret)` (`DeviceSession.secretHash`). To restore or refresh, the client POSTs `{ deviceId, deviceSecret }` to `POST /session/device/token` (no bearer, no cookies — possession of the secret is the proof) and gets a short access token plus `nextDeviceSecret` (on mint, the same proven secret echoed back; sign-in rotates the secret with a short grace for the prior hash). There is no cookie, no refresh-token family, and no `#oxy_boot` bootstrap hop — all deleted in the zero-cookie cutover. A `deviceId` is per web origin / per native app-group; there is no implicit cross-subdomain or cross-app device sync.

## Auth surfaces

### OxyAccountDialog

[src/ui/components/OxyAccountDialog.tsx](../src/ui/components/OxyAccountDialog.tsx) — the ONE unified account dialog, mounted automatically by `OxyProvider`. A thin RN binding over core's `AccountDialogController`, presented on Bloom's `<Dialog>` (`@oxyhq/bloom/dialog`) with responsive placement — bottom sheet on narrow viewports, centered card on wide ones (`placement={{ base: 'bottom', md: 'center' }}`). It replaced the five drifting legacy surfaces (profile/account menus, switcher, chooser, standalone sign-in modal).

Views: `accounts` (the device switcher, grouped by person, + "Add account"), `signin`/`add` (primary "Sign in with Oxy" device flow, QR scan), and `qr` (cross-device QR). Selecting a row activates a `contextId`; each person carries a sign-out of their own, and each row a removal of that pair alone. Base styling is `useTheme()` + `StyleSheet` so it renders in apps without NativeWind.

Entry points: `useOxy().openAccountDialog(view?)` inside React, `ProfileButton` (sidebar trigger), or imperative `openAccountDialog('signin')`.

### OxySignInButton

[src/ui/components/OxySignInButton.tsx](../src/ui/components/OxySignInButton.tsx) — the public "Sign in with Oxy" button. On first press it resolves the registered `Application` via `oxyServices.getPublicApplication(clientId)` (`GET /auth/oauth/client/:clientId`) and routes by type:

- **Official apps** (`first_party` / `internal` / `system` / `isOfficial`) → opens the account dialog (`openAccountDialog('signin')`).
- **`third_party`** → standard OAuth 2.0 Authorization Code + PKCE redirect to `auth.oxy.so/authorize`, built with `generatePkcePair` / `generateOAuthState` / `buildOAuthAuthorizeUrl` from `@oxyhq/core`. On web, the CSRF `state` and PKCE `code_verifier` persist across the redirect under `OXY_OAUTH_STATE_STORAGE_KEY` / `OXY_OAUTH_CODE_VERIFIER_STORAGE_KEY` (sessionStorage); on native the flow completes inside a `WebBrowser` auth session and surfaces the handshake via `onOAuthResult` (`OxyOAuthResult`).

See the [integration guide](../../../docs/auth/integration-guide.md) for the full third-party flow (Console registration, redirect URIs, `POST /auth/oauth/token`).

### OxyConsentScreen

[src/ui/components/OxyConsentScreen.tsx](../src/ui/components/OxyConsentScreen.tsx) — the unified OAuth authorize/consent surface. Pure and presentational: the caller (the IdP authorize page) resolves the requesting application, scopes, and user, and handles `onAllow` / `onDeny`; the component fetches nothing and owns no session state. `OxyConsentApplication` carries the registered app's identity including `privacyPolicyUrl` / `termsUrl` (fields on the `Application` model, shown as links). This is the RN/Bloom port of the IdP's web consent card, keeping both surfaces in lockstep.

### RequireOxyAuth

[src/ui/components/RequireOxyAuth.tsx](../src/ui/components/RequireOxyAuth.tsx) — the optional signed-out gate. `prompt`: `'off'` (render always), `'soft'` (dismissible sign-in banner), `'hard'` (block behind a signed-out wall). It gates on the SDK's own readiness (`canUsePrivateApi` / `isPrivateApiPending`), so the wall never flashes before cold boot resolves, and its sign-in CTA opens the one account dialog. Wrap a subtree directly, or the whole app via `OxyProvider`'s `requireAuth` prop.

## Hooks: `useAuth` vs `useOxy`

- **`useAuth()`** ([src/ui/hooks/useAuth.ts](../src/ui/hooks/useAuth.ts)) — the small standard surface: `user`, `isAuthenticated`, `isLoading`, `isReady`, `hasAccessToken`, `canUsePrivateApi`, `isPrivateApiPending`, plus `signIn`, `signOut`, `signOutAll`, `refresh`. Recommended for most app code.
- **`useOxy()`** ([src/ui/context/OxyContext.tsx](../src/ui/context/OxyContext.tsx) + [oxyContextTypes.ts](../src/ui/context/oxyContextTypes.ts)) — the full `OxyContextState`: multi-session state (`sessions`, `activeSessionId`, `switchSession`), the account graph (`accounts`, `switchToAccount`, `createAccount` via [useOxyAccountGraph.ts](../src/ui/context/useOxyAccountGraph.ts)), the account dialog (`openAccountDialog`, `closeAccountDialog`, `isAccountDialogOpen`), password sign-in (`signInWithPassword` → `PasswordSignInResult`, `completeTwoFactorSignIn`), the device-flow commit (`handleWebSession`), language state, and the raw `oxyServices` instance.

**Readiness rule:** private API calls wait for `canUsePrivateApi` (or hold on `isPrivateApiPending`). `isAuthResolved` marks the first cold-boot conclusion — before it, `isAuthenticated: false` is undetermined, not a definitive signed-out.

Account switching is **uniform**: `switchToAccount(accountId)` switches through the server-authoritative `SessionClient.switchAccount()` when the account is already in the device set; only the first switch into a graph account mints a session (with `operatedByUserId` audit for managed accounts) and registers it into the `DeviceSession`, after which it persists across reloads like any device sign-in.

## i18n

The string catalog lives in `@oxyhq/core` (`packages/core/src/i18n/` — `translate(locale, key, vars)` + 11 locale JSON files, en-US fallback). This package binds it through the internal `useI18n()` hook on `useOxy().currentLanguage`; apps change language via `useOxy().setLanguage(languageId)`. SDK surfaces (dialog, consent, gate) are localized under their own key namespaces (e.g. `consent.*`).

## Non-auth UI

Bottom sheets remain for **non-auth** screens (`showBottomSheet` / `closeBottomSheet`, 29+ routes: ManageAccount, FileManagement, payments, Trust, etc.). Auth surfaces do not route through bottom sheets — the account dialog is a Bloom `<Dialog>`. Query hooks, mutation hooks, offline persistence, and the file/photo pickers are documented in [API_REFERENCE.md](./API_REFERENCE.md) and [EXAMPLES.md](./EXAMPLES.md).
