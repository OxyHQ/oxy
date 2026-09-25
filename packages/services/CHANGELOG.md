# Changelog

## Unreleased

### Removed

- **Breaking:** `useOxy().registerWithPasskey`. An Oxy account is created WITH
  its self-custody root in the account dialog's creation flow
  (`openAccountDialog('signup')`), never by a local passkey ceremony (ADR 0024
  D4). No ecosystem app called it; `auth.oxy.so` opens the canonical flow.

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
