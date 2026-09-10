# Plan — fluid popup OAuth with identity-bound Commons approvals (#691)

Grounded in the current code (2026-07-27). Seven phases, one PR per phase, merged to `main` when CI is green.

## What the code actually does today (findings that shape the plan)

- **Commons has no account-switcher UI already.** It never calls `switchToAccount` / `openAccountDialog`. The bug is *not* UI: it is the session projection and the token mint.
- **The projection seam** is `OxyContext.syncFromClient` (`packages/services/src/ui/context/OxyContext.tsx:319-366`) → `activeUserOf(state, usersById)` (`packages/core/src/session/projectSessionState.ts:64-72`), which resolves the active user as `usersById.get(state.activeAccountId)` on *every* `SessionClient` notify (socket push, bootstrap, reconnect heal, tab focus). Nothing compares it to the local identity key.
- **The token seam** is `POST /session/device/token` (`packages/api/src/routes/sessionDevice.ts:60`): it accepts **only** `{deviceId, deviceSecret}` and mints for the device's `activeAccountId`. The client has no channel to request a different account, so pinning the *user* without pinning the *token* would leave the two disagreeing — which `SessionClient.applyState:230-233` explicitly guards against.
- **The durable drift** is `refresh.ts:155-162`: each background re-mint rewrites `PersistedAuthState.userId` from `state.activeAccountId`, so drift survives a reload through `warm-token-plant`.
- **Commons signs in identity-authoritatively already** (`useSilentKeySignIn` → `requestChallenge`/`verifyChallenge` with `KeyManager.getPublicKey()`). `POST /auth/verify` resolves the user from the *verified signer* and ignores `activeAccountId`. Sign-in is correct; everything downstream drifts.
- **`shared-key-signin` cold-boot step uses the SHARED keychain slot**, which Commons' own code documents as possibly "a different identity than THIS device's primary" — it must not run in identity mode.
- **There is no password fallback anywhere** (removed ecosystem-wide). The issue's "password/passkey fallback" means **passkey**.
- **Push infrastructure is email-only.** `PushToken` (userId+token, no deviceId), `push.service.ts` with a hardcoded `channelId: 'email'`, register/unregister routes. Commons requests notification *permission* and never registers a token. Phase 4 is real infrastructure work, not wiring.
- **Popup precedent exists**: `passkeyHubPopup.ts` opens synchronously before any `await`; `accountDialogController.ts` has `PopupWindowHandle`, open-late-navigate, and `closed`-polling.
- **The IdP always ends with `window.location.href = redirect_uri?code=…`** (`packages/auth/src/pages/authorize.tsx:549-552`). Popup mode needs a relay branch there.

## Phase 1 — Commons identity isolation

### Contract (frozen, so api/core/services can be built in parallel)

`@oxy.so/contracts` `deviceTokenMintRequestSchema` gains one optional field:

```ts
{ deviceId: string; deviceSecret: string; accountId?: string }
```

`POST /session/device/token` semantics when `accountId` is present:

- the account must be a member of that device's `DeviceSession.accounts[]` with a live session → else `401 account_not_on_device`
- mint the short access token **for that account**
- **never** mutate `DeviceSession.activeAccountId`, never bump `revision`, never broadcast
- rotate the device secret exactly as today; `state` in the response still reports the true `activeAccountId`

New response error string: `account_not_on_device`. No other endpoint changes.

### Core (`@oxy.so/core`)

- `packages/core/src/session/identityPin.ts` — persisted `{ publicKey, accountId }` in the same storage as `authStateStore`. Written at identity sign-in, read on boot, cleared when the local key no longer matches.
- `mintFromDeviceSecret(deviceId, secret, opts?: { accountId?: string })`.
- `refreshDeviceSecretArm` passes the pin and, when pinned, resolves `sessionId`/`userId` from the **pinned** account rather than `state.activeAccountId`.
- `runSessionColdBoot({ sessionMode })`:
  - `identity` mode: `warm-token-plant` only accepts a token whose identity tag equals the pin; `device-secret-mint` passes `accountId`; `shared-key-signin` is **replaced** by a new `identity-key-signin` step using `KeyManager.getPublicKey()` + `SignatureService.signChallenge` (the primary local key, never the shared slot).
  - `account` mode: unchanged.
- `SessionClient` accepts a pinned account: no `activeToken` planting on state whose `activeAccountId` ≠ pin; `session_state` pushes never re-plant a switched token.

### Services (`@oxy.so/services`)

- `OxyProvider` prop `sessionMode?: 'account' | 'identity'` (default `'account'`), threaded through `types/navigation.ts` **and** `oxyContextTypes.ts` (the provider currently drops props declared in only one of the two).
- `syncFromClient`: in identity mode the active user is the pinned account, not `activeUserOf(state)`. A pin absent from the device account list re-establishes the identity session instead of accepting the switch.
- `switchToAccount` rejects with an explicit error in identity mode; the account graph is not fetched; `openAccountDialog` is unavailable.
- `tokenTransport` skips the "converge on `activeAccountId`" preflight when pinned.

### Commons

- mount `<OxyProvider sessionMode="identity">`; delete the app-local silent key sign-in now owned by core.

### Tests

Remote `session_state` switch / `session_accounts_changed` / restart / mismatch each leave the Commons user and token pinned; `switchToAccount` throws in identity mode; the mint rejects a non-member `accountId` and never mutates `activeAccountId`.

## Phase 2 — Shared popup OAuth transport

`webAuthMode: 'popup' | 'redirect'` on `OxyProvider`. New `packages/services/src/ui/oauth/`: `oauthPopup.ts` (open synchronously on the click, before any `await`; retain the handle; poll `closed`; timeout; deterministic listener/timer teardown), `oauthPopupMessages.ts` (runtime-validated `{code, state}` / typed error only), `oauthHandshake.ts`, `completeOAuthCode.ts` (the single state-validate → PKCE exchange → commit → cleanup path used by **both** modes), `browserAuthTransport.ts`, `types.ts`. The main window keeps the PKCE verifier. IdP `authorize.tsx` relays to `window.opener` with an exact target origin when it is a child window, else keeps the redirect.

## Phase 3 — OAuth-bound AuthSession

`AuthSession` gains `purpose: 'device_sign_in' | 'oauth_authorization'` and `oauth?: { redirectUri, codeChallenge, codeChallengeMethod: 'S256', scopes, subjectAccountId? }`. `POST /auth/session/create` accepts the OAuth context; the existing signed Commons approval authorizes it; a dedicated atomic finalizer mints exactly one `AuthCode` (reusing `issueAuthCode`) and cannot mint a second. Delegated `subjectAccountId` requires an `account:act_as` check.

## Phase 4 — Automatic Commons delivery

Device-scoped push tokens (`PushToken` gains `deviceId` + `appId`), Commons token registration through the SDK, `push.service` channel/category parameterisation, a notification-response handler that opens `/approve?code=…` (never approves), and automatic route selection: mobile verified link → known Commons install (push) → QR. Progress events (`request_created`, `push_sent`, `opened_in_commons`, …) over the existing `/auth-session` namespace, payloads still treated as wake signals only.

## Phase 5 — Simplified UI

One primary CTA in `OxyAuthChooser`; everything else behind "Having trouble?". Commons `/approve`: one primary action that invokes biometric directly.

## Phase 6 — Mention pilot

Popup mode in Mention; verify deep routes stay mounted, personal + delegated org, Commons stays pinned, Chrome/Safari/Firefox incl. blocked third-party cookies.

## Phase 7 — Legacy removal

Delete `crossOriginRestore.ts`, `hubSync.ts`, the `/sync` page, hub-ticket endpoints and the `prompt=none` effects from the popup path; popup becomes the default; docs + `AGENTS.md` updated.
