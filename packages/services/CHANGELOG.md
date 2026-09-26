# Changelog

## [7.0.0] - 2026-09-26

Requires `@oxy.so/core` ^2.2.0.

**Sign-in happens in the dialog, by email** (the plan "Oxy sin passkeys", PR 2
of 4): no passkey, and no auth.oxy.so window except the browser bridge.

### Changed

- `OxySignInPanel` is a sequence of steps, in the dialog of every app (web and
  native) and on auth.oxy.so's `/login`: an email or username → "Check your
  email" (one field takes the 6-digit code or the 10-character `XXXXX-XXXXX`
  code and submits itself once complete; meanwhile the screen asks every 2 s
  whether the email's link was opened in this browser, and signs in when it
  was; "Send a new email" after a 30 s cooldown) → optionally "Use your password
  instead" (with "Forgot it? Get a code by email") → the authenticator's code,
  or a backup code, when the account has one. Errors are inline and never say
  whether an account exists; a 429 counts down. The web split card with the
  Commons QR stays (the QR on the first step only), and "Continue with Oxy"
  stays on top on native and below `md`.
- `OxySignUpPanel` creates the account in place on every platform — username
  (availability checked) → email → its code → signed in — with "Create it in
  Commons instead". Props: `{ onSignedIn, onSignIn }`.
- `OxyDeleteAccountPanel` deletes an account without a key with a code by email
  (+ the authenticator's code), and says where to go for a keyed account.
  `OxyLinkCommonsPanel` confirms the link with a code by email (+ the
  authenticator's). Both are for the account's settings, not auth pages.
- "Manage your account" opens the `DeleteAccount` panel for an account without a
  key (and on the web), and lists Password, Authenticator app and Link Commons
  for it.
- The request view's "Having trouble?" no longer offers a passkey.

### Added

- `OxyPasswordPanel` (set or change the password) and `OxyAuthenticatorPanel`
  (set up an authenticator app from its QR and setup key, backup codes shown
  once with "Copy codes", new backup codes, turn off), each confirmed with a
  code by email or the current password (+ the authenticator's code).
- Routes `DeleteAccount`, `LinkCommons`, `SignInPassword` and
  `SignInAuthenticator` for `showBottomSheet`.
- `useSignInMethods()` — `GET /users/me/sign-in-methods`.

### Removed

- `useOxy().continueOnAuth`, `signInWithPasskey`, `addPasskey`,
  `removePasskey`; `useAuthMethods().passkeys`; `OxyCreateAccountPanel` and
  `OxyRecoverAccountPanel` (recovering an account is signing in with a code);
  `OxySignInPanelProps.onRecover`; the `@simplewebauthn/browser` dependency.

## [6.3.0] - 2026-09-26

### Added

- One browser, one session (ADR 0029 D2): the first time a person opens the
  account dialog on the web in an app that holds no device credential, the
  provider opens `auth.oxy.so/bridge` from that press — a window as small as the
  browser allows that joins the app to the browser's device and closes at once.
  If the browser is already signed in, the app is signed in and the dialog
  closes; otherwise the dialog's sign-in carries the device proof, so the
  account is shared with every Oxy app in that browser. Never on page load, on
  auth.oxy.so itself or with `sessionMode: 'identity'`; a blocked window only
  means the app signs in on its own device, as before. Native is unchanged.
- `OxyProvider` wires `OxyServices.setDeviceCredentialProvider` from its store
  on the web, so every sign-in proves the device this origin holds.

### Changed

- Requires `@oxy.so/core` ^1.19.0.
- A lost-token recovery waits only on a credential that still names an account:
  a web credential kept after `no_active_session` (core 1.19.0) can mint again
  once someone signs in, but cannot bring back a session that ended, so the app
  signs out locally as before.

## [6.2.0] - 2026-09-26

### Changed

- Sign-in happens in the account dialog again (ADR 0029 D1, amended): on the
  web it is the split card — the Commons QR on the right ("Continue with Oxy"
  below `md`), the passkey and "Create account" on the left — and only the
  passkey and account creation open auth.oxy.so's window, for that one step.
  6.0's dialog, which moved the whole screen into that window, is gone.

### Added

- `useSurfaceFrameWidth` and `OxyAuthSplit`'s `bare` are back: the dialog grows
  to the 880 split card.

## [6.1.0] - 2026-09-26

Requires `@oxy.so/core` `^1.18.0`.

**Web accounts are a username, a passkey and a recovery email** (ADR 0029 D3):
no web identity, no web recovery phrase.

### Added

- `OxyCreateAccountPanel` (username → recovery email → its code → passkey),
  `OxyRecoverAccountPanel` (username or email → the code sent to the recovery
  email → a new passkey) and `OxyDeleteAccountPanel` (typed username → a
  passkey assertion): auth.oxy.so's `/signup`, `/recover` and
  `/delete-account`, built from the sign-in shell.
- `OxyLinkCommonsPanel`: auth.oxy.so's `/link-commons` — a QR Commons scans
  and signs, the code both devices show, then the passkey. The account
  becomes self-custodied and its recovery email is deleted.
- `useOxy().handleWebSession` takes a `LoginSessionResult` too (a passkey
  registration's session).

### Changed

- "Delete account" on the web opens `auth.oxy.so/delete-account`; the native
  handoff's "elsewhere" copy points there for a passkey account.

### Removed

- The account menu's "Your identity" row (`onOpenIdentity`): there is no web
  identity to open.
- Editing the email in `EditProfileScreen` / `EditProfileFieldScreen`: the
  recovery email is not a profile field.

## [6.0.0] - 2026-09-26

**Web sign-in in auth.oxy.so's window** (ADR 0029 D1). On the web, an app's
account dialog shows "Continue with Oxy" and "Create account", and both open
auth.oxy.so in a window over the app, like "Sign in with Google": the QR, the
username and the passkey are there, on every domain alike. No code picks a
route by domain any more.

### Changed

- `useOxy().continueOnAuth(screen)` opens auth.oxy.so's window
  (`transport: 'popup'`) instead of leaving the tab; a blocked window still
  falls back to the tab. `startWebOAuthSignIn`'s `transport` takes `'popup'`
  as well as `'redirect'`, and passes `screen` in both.
- `OxySignInPanel`: the username, passkey and QR run only on a page
  (`host="page"`, auth.oxy.so). In the dialog on the web it is "Continue with
  Oxy", which reports `onSignedIn` once the window signs the app in.
  `onRecover` has no default: recovery is on auth.oxy.so.
- `OxySignUpPanel` takes `onCreateOnWeb`, the web's one action.

### Removed

- The passkey ceremony inside an app's dialog on `*.oxy.so`, and the
  `isOxyRpOrigin` route choice (`PasskeyRoute`).
- The dialog's 880 split (`useSurfaceFrameWidth`) and `OxyAuthSplit`'s `bare`.

- `OxyProvider`'s `deviceCredentialStorage` prop and the `'ephemeral'` auth
  store. Its one caller was auth.oxy.so with the browser hub on; the hub is
  deleted, and every origin persists its device credential.
- The dead hub-sync lane: `maybeSyncHubAfterCommit` and
  `legacyRedirectLanes` (`allowsAutomaticIdpRedirect`), which nothing called.

## [5.1.0] - 2026-09-26

Requires `@oxy.so/bloom` `^4.26.0`, and includes 4.0.7's fixes (the
`FollowButton` accessible name, OxyHQ/oxy#1375 item 22).

Requires `@oxy.so/core` `^1.16.0`.

**No identity popups** (ADR 0028 D1b). What only auth.oxy.so can do — create an
account with its root, recover it, assert an `oxy.so` passkey from another
domain — happens there, in the same tab, and the person comes back signed in.

### Added

- `useOxy().continueOnAuth(screen)`: go to auth.oxy.so for `signup`, `recover`
  or `signin`, and come back signed in, through the ordinary authorization-code
  redirect. `startWebOAuthSignIn` takes `transport: 'redirect'` and `screen`.
- The sign-in screen's "Lost your passkey? Recover your account" link
  (`OxySignInPanel`'s `onRecover`; on the web it defaults to
  `continueOnAuth('recover')`).

### Changed

- "Create account" in the dialog goes straight to auth.oxy.so/signup on the
  web; the passkey off an `oxy.so` origin is asserted on auth.oxy.so. Neither
  opens a window.

### Removed

- The passkey popup (`passkeyHubPopup`), and `OxySignUpPanel`'s `host` and
  `onSignedIn` props, which only its popup flow used.

## [5.0.1] - 2026-09-26

Requires `@oxy.so/core` `^1.15.0`.

### Changed

- The web identity carrier is `auth.oxy.so` (ADR 0028). The account menu's
  identity row, web account deletion and the deletion hand-off copy point at
  `auth.oxy.so/identity`; the passkey window is `auth.oxy.so/continue`.

### Removed

- `OxyAuthChooser`'s `autoStartSignIn` prop, which had no effect.

## [5.0.0] - 2026-09-26

Requires `@oxy.so/core` `^1.14.0`.

**One sign-in screen.** The account dialog and auth.oxy.so now render the same
screens, from this package: `OxySignInPanel` (sign-in), `OxySignUpPanel`
(account creation) and `OxyAccountPicker` ("Choose an account"), on a shared
shell (`OxyAuthScreen`, `OxyAuthScreenHeader`, `OxyAuthLoading`,
`OxyAuthTerms`). auth.oxy.so mounts them as a page (`host="page"`); the dialog
mounts them in place.

### Added

- The sign-in screen: the device's accounts first, then the Oxy mark and a
  large title, the Commons way in, the username with its Continue, "or
  continue with" a passkey, and "Create account". On the
  web from `md` it is Bloom `AuthCard`'s split card — the form on the left, the
  embedded Commons QR over a photo carousel on the right — and the account
  dialog grows to 880 for it; below `md`, and on native, "Continue with Oxy"
  takes the QR's place ("Get Commons" on a native device without Commons).
  Continue is a username-first passkey sign-in, which also takes a hardware
  security key with no resident credential; the passkey button is the
  discoverable ceremony, with nothing to type. Both run on the page on an
  `oxy.so` origin and in the identity window everywhere else on the web;
  native has none. Layout is NativeWind `className`.
- `useSurfaceFrameWidth(maxWidth)`: a surface screen's say in its dialog's
  width, for a screen whose views differ in width.
- `useOxy().signInWithPasskey` sends the device fingerprint every other
  sign-in path sends when the caller passes none.

### Changed

- **Breaking:** `react-native-css` is a required peer. The root barrel already
  imported it statically (`ProfileButton`); the optional flag only hid that.
- The sign-in entry is no longer one "Continue with Oxy" button with its
  alternatives behind "Having trouble?": every method is on the screen. The
  active request (`qr` view) keeps its disclosure.
- "Create account" in the dialog opens the account-creation screen, whose
  one action opens the identity window, instead of opening the window at once.

### Removed

- **Breaking:** the `OxyAuthChooser` export. The dialog renders it; a page of
  its own mounts `OxySignInPanel` / `OxySignUpPanel` / `OxyAccountPicker`.
- The old sign-in entry and sign-up views (`SignInEntryView`, `SignUpView`)
  and their dead styles.
- **Breaking:** `useOxy().registerWithPasskey`. An Oxy account is created WITH
  its self-custody root in the account dialog's creation flow
  (`openAccountDialog('signup')`), never by a local passkey ceremony (ADR 0024
  D4). No ecosystem app called it; `auth.oxy.so` opens the canonical flow.

## [4.0.7] - 2026-09-26

Requires `@oxy.so/bloom` `^4.26.0` (the `FollowButton` accessible-name override).

### Fixed

- `FollowButton` showed "Following" while a screen reader still heard
  "Follow": Bloom named it by its idle label and left the state to the pressed
  flag, which TalkBack reads as "selected" (OxyHQ/oxy#1375 item 22). The name
  now follows the state in every case: "Checking whether you follow @nate"
  while the status loads, "Follow @nate", and "Following @nate" with the hint
  "Unfollows @nate". While a follow or unfollow is in flight it keeps the state
  it shows and drops the hint. The new optional `username` prop supplies the
  handle; without it the name is "Follow" / "Following". The "Follow all" mode
  names its state the same way, with the account count in the hint.
- `FollowTargetButton` is named by the state it shows ("Following",
  "Requested", "Off here") instead of its idle verb.

## [4.0.6] - 2026-09-26

Requires `@oxy.so/core` `^1.12.0`. The new copy is English until the next core
release carries its `deleteAccount.handoff.*` strings (en-US, es-ES).

### Fixed

- "Delete account" in an app whose identity key Oxy Commons keeps on the same
  device no longer fails with "No identity found on this device". Before
  anything is deleted, the screen checks whether this app holds the key: if it
  does, its own confirmation runs as before; if Commons is installed, it offers
  to open Commons' delete-account screen (`oxycommons://delete-account`);
  otherwise it explains where the account can be deleted (Oxy Commons, Settings
  > Delete account, on the device that holds the identity, or `id.oxy.so` in a
  browser that holds it). None of those paths calls the deletion API. An
  unreadable keystore is reported, never treated as "the key is elsewhere"
  (OxyHQ/Mention#1169).
- A failed deletion's message was error-coloured text on an error-tinted box,
  which read as an empty red rectangle. It is Bloom's error `Admonition` now:
  theme text colour on the theme background with an error border
  (OxyHQ/Mention#1169).

## [4.0.5] - 2026-09-25

Requires `@oxy.so/core` `^1.12.0`.

### Fixed

- Signed out, tapping the device account listed on the sign-in sheet (the
  Commons shared identity) closed the sheet and left the app signed out. It
  now signs in exactly as "Continue with Oxy" does, through
  `AccountDialogController.chooseContext` (OxyHQ/oxy#1375 item 20).
- Signed out, the sheet no longer reads "Add Another Account — Sign in with
  another account", and the listed account no longer carries a check as if it
  were signed in. The title is "Sign in" whenever this app holds no session,
  whatever the device directory lists, and each row reads "Continue as
  @handle" with the account's name beneath (OxyHQ/oxy#1375 item 21).
- Android: `OxyIdentityStore` no longer deletes the androidx master key
  (`_androidx_security_master_key_`) when its keyset cannot be rebuilt. That key
  is one Keystore entry for the whole `so.oxy.shared` UID, so deleting it made
  every other Oxy app's encrypted prefs unreadable. Every store now opens with
  `RecoveryPolicy.RebuildFileOnly`; `RegenerateSharedMasterKey` is removed
  (OxyHQ/oxy#1388).

## [4.0.4] - 2026-09-25

### Fixed

- A signed-out app no longer gets its account back. A device projection whose
  profile fetch was in flight when the session was cleared locally (a token
  refresh firing just before sign-out) finished afterwards and republished the
  account — so a signed-out visitor was greeted by the previous user's name.
  `OxyRuntime.clearSession()` now abandons every projection already in flight.
  With `@oxy.so/core` 1.10.0, the refresh that triggered it cannot plant a bearer
  after the sign-out either.

## [4.0.3] - 2026-09-25

Requires `@oxy.so/core` `^1.9.1`.

### Fixed

- A signed-in app is no longer signed out when its access token is cleared by
  a transient failure (a 401 whose refresh was rate limited, cooling down or
  offline). While the durable device credential survives, the provider keeps
  the user, pauses private queries and re-mints with backoff, the way a
  relaunch does. It signs out once the refresh handler drops the credential on
  a definitive verdict (`invalid_device_secret`, `no_active_session`), or after
  a bounded retry through the shared identity / identity key
  (OxyHQ/Mention#1140). Recovery decisions log at `warn`.

## [4.0.2] - 2026-09-25

Requires `@oxy.so/core` `^1.9.0` and `@oxy.so/bloom` `^4.21.1`.

### Fixed

- The account menu rendered a giant circular "Switch account" row, a huge
  storage card and ~250dp-tall storage chips on Android. Bloom < 4.21 declared
  its type-scale line-heights in px, and react-native-css multiplies a
  line-height it reads through `var()` by the font size (`text-body`: 22 × 15 =
  330dp). Bloom 4.21 writes them as ratios; the Bloom peer floor moves to
  `^4.21.1`, which also brings the bottom-sheet safe-area inset, the inline ✕
  header, the Accordion trigger that no longer wraps, and a collapsed sheet
  header that paints its background on Android (it overlapped the rows of
  "Manage your Oxy Account").

- Signed out, Back from "Create your account" returned to the SIGNED-IN account
  menu. The account dialog's Back now follows the controller's `backView`
  (`@oxy.so/core` 1.9.0), and `OxyAuthChooser` never renders the account menu
  without a signed-in user — the sign-in entry renders in its place
  (OxyHQ/oxy#1375).
- The account menu's icon-font glyphs no longer reach the accessibility tree
  (TalkBack announced `"\u{F0140}"` beside "Switch account"). Both SDK icon
  families hide every glyph with `aria-hidden`, which callers cannot override.
- The "Having trouble?" disclosure spans the content width with a compact,
  centred trigger, instead of a shrink-wrapped column that wrapped the trigger
  to "Having / trouble?" on Android and squeezed its options.
- The sign-in surfaces' primary actions are Bloom's `lg` button (44dp), not the
  36dp default.
- "Manage your Oxy Account": a "Sessions & devices" row read "undefined (This
  device)" — the endpoint sends no device name. The current session is "This
  device" and another is named by its account. "Switch account" reads
  "1 account", not "1 accounts".

## [4.0.1] - 2026-09-21

### Fixed

- `ProfileButton` imports its icons through Bloom's per-glyph subpaths instead
  of the `@oxy.so/bloom/icons` barrel, which Metro retains whole (465 icon
  modules in a consumer's common chunk). `bloomSubpathsResolve.test.ts` rejects
  a runtime import of the barrel.

## [4.0.0] - 2026-09-21

### Changed

- **Breaking:** requires `@oxy.so/bloom` `^4.2.0` and `@oxy.so/core` `^1.7.3`.
  Apps and Services must share ONE Bloom instance (theme, dialog and
  interaction contexts). Shared UI adopts Bloom 4 controls: `FollowButton`,
  `ProfileButton`, user lists, file management, headers and account members.
  See `docs/engineering/bloom-4-migration.md`.
- **Breaking:** `OxySignInButton.size` follows Bloom's `SocialButtonSize`
  (`sm`, `md`), replacing `small` and `medium`.

### Removed

- The duplicate animated file-mode button and the unused PIN renderer.

## [30.2.5] - 2026-09-03

### Added

- Added explicit cross-platform OAuth reconsent through
  `requestOAuthConsent`, with exact scope validation, PKCE and state binding,
  byte-exact redirect verification, and no grant without user interaction.

## [30.2.1] - 2026-09-02

### Changed

- Replaced the full Ionicons and Material Community Icons assets reachable from
  Services UI with exact-shape generated subsets. The consumer payload falls
  from 1,697,384 bytes to 75,172 bytes for those two families. A build gate now
  rejects stale subsets, changed source versions, unrecorded glyph names, or
  reintroduced full-family imports.
- Centralized session commit handling so account activation, token state and
  legacy OAuth redirect lanes converge through one tested flow.

## [28.0.0] - 2026-08-06

### Licence: AGPL-3.0-only becomes Apache-2.0

**Breaking for anyone who tracks the licence, and for nobody else.**
`@oxy.so/services` is now Apache-2.0. The code, the API surface and the
behaviour are unchanged in this release. It exists to carry the licence change.

This is a widening. Every right the AGPL granted you, Apache-2.0 grants too,
and Apache-2.0 additionally drops the network copyleft and adds an express
patent grant. Nobody has to do anything, and no existing use of this package
becomes non-compliant.

Versions published before this one keep the licence they were published under,
permanently. `27.1.3` stays AGPL-3.0-only for anyone who already has it. A licence
change binds future versions only.

The major is bumped rather than the change being slipped into a patch, so that
nobody on `^27.0.0` is moved to a new licence by a routine install. That is
exactly what happened at `22.5.0`, and it is not happening again.

### Also breaking: the `@oxy.so/core` peer range moves to `^20.0.0`

Core's own relicensing bumped it to `20.0.0`, so the declared peer range has to
follow. Bump `@oxy.so/core` alongside this package. Nothing in the services API
surface changed.

### Added

- A `NOTICE` file, which Apache-2.0 section 4(d) requires downstream
  redistributors to reproduce, and a verbatim `LICENSE`.

## [25.0.0] - 2026-07-30

### Changed
- **BREAKING**: Raised the `@oxy.so/core` peer dependency to `^16.0.0`. Consumers
  must bump core to 16.x when upgrading services — the services API surface is
  unchanged, but the declared peer range was stale after core 16 shipped.

### Removed
- **BREAKING**: Dropped the bundled Inter font family and the font-loading API.
  - Deleted the 7 static Inter TTFs (`src/assets/fonts/Inter/`, 2.41 MB) that shipped
    inside every consumer APK/AAB. No component in this package ever referenced the
    `Inter-*` families they registered.
  - Removed the `FontLoader` component and `setupFonts()` function from all entry
    points (`@oxy.so/services`, `/ui`, `/ui/client`, `/ui/server`), and the implicit
    `setupFonts()` call in `OxyProvider`.
  - Dropped the now-unused `expo-font` peer dependency.
  - Typography is owned by `@oxy.so/bloom`: `BloomThemeProvider` already ships a
    variable Inter (plus BlomusModernus and Geist Mono) and loads it on both native
    and web. Apps that mount `BloomThemeProvider` need no changes.

## [10.2.3] - 2026-06-18

### Fixed
- `OxyProvider` now treats provider-token invalidation as a local sign-out when a user is currently authenticated. If `HttpService` clears the access token after a 401, the provider clears session state and managed accounts instead of leaving stale `isAuthenticated` state active.
- `refreshManagedAccounts` now requires an authenticated, token-ready session and handles a managed-accounts 401 by clearing local auth state. This stops cascades of private endpoint 401s after a stale token is rejected.

## [8.7.0] - 2026-06-14

### Added
- **`appName` prop on `OxyProvider`** — a human-readable display name for the consuming app, surfaced on the central Oxy sign-in / consent experience as "{appName} wants to access your Oxy account".
  - New `resolveAppDisplayName` utility (`src/ui/utils/appName.ts`) resolves the name in order: explicit `appName` → capitalized `storageKeyPrefix` (only when the consumer overrode the default) → `document.title` (web only) → `Platform.OS`.
  - Exposed as a non-empty `appName: string` on the `OxyContext` state.
  - `SignInModal` and `OxyAuthScreen` now send the resolved `appName` as the `appId` on `POST /auth/session/create` instead of `Platform.OS` / an ad-hoc capitalized prefix.

### Fixed
- The consent page no longer shows the literal platform string **"web"** for web consumers that did not pass a name. It now derives a correct brand name from the `storageKeyPrefix` or `document.title`, and only falls back to the platform when an app supplies none of those. (Mention #143)

### Fixed
- **Fixed react-native imports in core modules** - Critical packaging bug fix
  - `HttpService.ts`: Removed direct `Platform` import from react-native
  - `keyManager.ts`: Removed direct `Platform` import from react-native
  - `sonner.ts`: Split into platform-specific files (`sonner.web.ts`, `sonner.native.ts`)
  - `/web` and `/core` entry points now truly have **zero react-native dependencies**

### Added
- **New platform detection utility** (`src/utils/platform.ts`)
  - Provides `isWeb()`, `isNative()`, `isIOS()`, `isAndroid()`, `getPlatformOS()`
  - Works in all environments without importing react-native
  - Platform is auto-initialized in React Native via main entry point

### Changed
- Core modules now use the new platform utility instead of importing `react-native` directly
- Bundlers (Vite, Webpack) no longer need react-native stubs for `/web` or `/core` entry points

### Why This Matters
Before this fix, even when using `@oxy.so/services/web` or `@oxy.so/services/core`, bundlers would encounter `import { Platform } from 'react-native'` in core modules, causing build failures in pure web/Node.js environments. This is now fixed.

## [5.22.0] - 2026-01-27

### Added
- **New `/web` entry point** (`@oxy.so/services/web`) for pure React/Next.js/Vite apps
  - Optimized for web-only applications without Expo or React Native
  - Excludes all React Native dependencies for smaller bundle size
  - No bundler configuration needed (no react-native-web required)
  - Exports `WebOxyProvider` and all web-compatible features
  - Recommended for all pure web applications

### Changed
- Updated package.json exports to properly support all platforms:
  - **Expo 54 (native)**: Uses source files via `react-native` condition
  - **Expo 54 (web)**: Uses pre-built files with react-native-web
  - **Pure React web**: Use `/web` entry point (no RN deps) or main entry with bundler config
  - **Node.js**: Uses core-only build via `node` condition
- Improved TypeScript type exports for better IDE support

### Documentation
- Added comprehensive platform usage guide in README
- Added web bundler configuration section (Vite, Webpack, Next.js)
- Documented when to use each entry point
- Added examples for all supported platforms

### Migration Guide
For pure web apps (Vite, Next.js, CRA), switch to the new `/web` entry point:

```typescript
// Before (requires bundler config)
import { WebOxyProvider } from '@oxy.so/services';

// After (cleaner, no config needed)
import { WebOxyProvider } from '@oxy.so/services/web';
```

No changes needed for Expo apps or Node.js backends - they continue to work as before.

## [Unreleased]

### Changed
- **BREAKING**: Migrated from Phudu to Inter as the default font family for the entire Oxy ecosystem
  - Inter font is now included and automatically loaded
  - All font references updated to use Inter
  - Apps using this package will automatically get Inter fonts
  - See [FONTS.md](./FONTS.md) for complete typography guide

### Added
- Added comprehensive typography documentation ([FONTS.md](./FONTS.md))
- Exported `fontFamilies` and `fontStyles` constants for consistent font usage
- Exported `FontLoader` component and `setupFonts()` function
- Added 7 Inter font weights: Light (300), Regular (400), Medium (500), SemiBold (600), Bold (700), ExtraBold (800), Black (900)

### Removed
- Removed Phudu font family and all related files
- Removed hardcoded platform-specific font checks in favor of centralized constants

### Migration Guide
If you were using the Phudu fonts from this package:

1. Replace all `fontFamilies.phudu*` with `fontFamilies.inter*`:
   ```typescript
   // Before
   fontFamily: fontFamilies.phuduBold
   
   // After
   fontFamily: fontFamilies.interBold
   ```

2. The `fontStyles` constants remain the same (already updated to Inter)

3. No other changes required - Inter fonts load automatically via `FontLoader`

See [FONTS.md](./FONTS.md) for complete documentation.
