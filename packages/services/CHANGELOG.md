# Changelog

## [Unreleased]

### Removed
- **BREAKING**: Dropped the bundled Inter font family and the font-loading API.
  - Deleted the 7 static Inter TTFs (`src/assets/fonts/Inter/`, 2.41 MB) that shipped
    inside every consumer APK/AAB. No component in this package ever referenced the
    `Inter-*` families they registered.
  - Removed the `FontLoader` component and `setupFonts()` function from all entry
    points (`@oxyhq/services`, `/ui`, `/ui/client`, `/ui/server`), and the implicit
    `setupFonts()` call in `OxyProvider`.
  - Dropped the now-unused `expo-font` peer dependency.
  - Typography is owned by `@oxyhq/bloom`: `BloomThemeProvider` already ships a
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

## [Unreleased]

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
Before this fix, even when using `@oxyhq/services/web` or `@oxyhq/services/core`, bundlers would encounter `import { Platform } from 'react-native'` in core modules, causing build failures in pure web/Node.js environments. This is now fixed.

## [5.22.0] - 2026-01-27

### Added
- **New `/web` entry point** (`@oxyhq/services/web`) for pure React/Next.js/Vite apps
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
import { WebOxyProvider } from '@oxyhq/services';

// After (cleaner, no config needed)
import { WebOxyProvider } from '@oxyhq/services/web';
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
