# @oxyhq/services

A comprehensive TypeScript UI library for the Oxy API providing authentication, user management, and UI components for React Native, Expo, and web (React Native Web) applications.

> **For web apps (Vite + React Native Web):** Use this same package — `OxyProvider` is universal. See the [Platform Guide](./PLATFORM_GUIDE.md).
>
> **For backend / Node.js:** Use [`@oxyhq/core`](../core) only (`@oxyhq/core/server` for auth middleware).
>
> **For the full platform guide:** See [PLATFORM_GUIDE.md](./PLATFORM_GUIDE.md).

## Table of Contents

- [Features](#features)
- [Installation](#installation)
- [Quick Start](#quick-start)
- [Typography - Inter Font](#typography---inter-font)
- [Usage Patterns](#usage-patterns)
- [API Reference](#api-reference)
- [Configuration](#configuration)
- [Authentication](#authentication)
- [UI Components](#ui-components)
- [Internationalization (i18n)](#internationalization-i18n)
- [Troubleshooting](#troubleshooting)
- [Requirements](#requirements)

## Features

- **Zero-Config Authentication**: Automatic token management and refresh
- **Device-First Sessions**: Sign in once per device; every Oxy app on the device restores silently and syncs account changes live over Socket.IO
- **Universal Provider**: Single `OxyProvider` works on iOS, Android, Expo Web, and React Native Web
- **UI Components**: Pre-built components for auth, profiles, and more
- **Inter Font Included**: Default Oxy ecosystem font with automatic loading
- **Cross-Platform**: Works in Expo and React Native (iOS, Android, Web)
- **Multi-Session Support**: Manage multiple user sessions simultaneously
- **TypeScript First**: Full type safety and IntelliSense support
- **Performance Optimized**: Automatic caching with TanStack Query
- **Production Ready**: Error handling, retry logic, and security best practices

## Architecture

The OxyHQ SDK is split into three packages:

| Package | Use Case | Dependencies |
|---------|----------|--------------|
| `@oxyhq/services` | Expo / React Native / Web (React Native Web) | Full (RN, Expo) |
| `@oxyhq/core` | All platforms (types, API client, crypto, server middleware) | None |
| `@oxyhq/contracts` | Shared API schemas (Zod) | zod only |

This package (`@oxyhq/services`) is the **single UI SDK** for every React surface. It provides `OxyProvider`, the unified account dialog, UI components, screens, bottom sheet routing, fonts, and hooks.

See [PLATFORM_GUIDE.md](./PLATFORM_GUIDE.md) for the complete architecture guide.

### This package does not declare `sideEffects: false`

It used to, and the declaration was **wrong**. Three modules in the build have
top-level side effects, one of them the entry itself:

| Module | Effect |
|---|---|
| `lib/module/index.js` | `setPlatformOS(Platform.OS)` — configures `@oxyhq/core` |
| `lib/module/ui/navigation/surfaceBackBridge.js` | `installEscapeHandler()` — installs a global key handler |
| `lib/module/ui/components/SettingsIcon.js` | assigns `displayName` |

Removing a false declaration would be worth doing on its own. It also fixed a
production outage, and that is the part worth remembering, because the symptom
looked nothing like a `package.json` field.

`auth.oxy.so/authorize` rendered a blank page with React error #130 ("element
type is undefined") for every request that reached `OxySignInRequestSurface`,
which blocked every OIDC login into Allo ([#784]). Source and dev server were
fine; only the production bundle was broken. Two facts combined:

1. **The UI graph was one large import cycle.** `ui/context/OxyContext` reaches
   `ui/navigation/bottomSheetManager` → `navigation/routes`, `routes` reached
   every screen (through `require()` calls it made for Metro's benefit), and
   every screen reaches back into the context — a 67-module strongly connected
   component that included `OxySignInRequestSurface`. A bundler cannot
   concatenate a cycle, so it emits each member as a lazily-initialized wrapper
   whose exported bindings are `undefined` until the initializer runs. Modules
   outside the cycle, `OxyConsentScreen` among them, are emitted inline and were
   never affected — which is exactly why only some screens broke.
2. **`sideEffects: false` told the bundler that running those initializers was
   unobservable**, so rolldown-vite omitted the initializer call at the
   consuming import site in `packages/auth` while still emitting the reference.
   The binding was therefore never assigned, and React was handed `undefined`.

That cycle was the deeper defect, and it has since been cut down. `routes.ts`
registers screens as `lazy(() => import(...))` rather than `require()`, so the
registry no longer drags all 40 screens into the context's component; the two
remaining `require()` sites became static imports read at call time. Measured on
the built ESM output, the largest strongly connected component went from **67
modules to 2**, and `OxySignInRequestSurface` is no longer inside any cycle.
What is left is two mutual pairs — `surfaces` ↔ `SurfaceScreen` and
`OxyContext` ↔ `useFollow` — each of which only ever reads the other at call or
render time.

Cycles still exist, so do not re-add `sideEffects` in any form. A narrowed,
truthful list would leave every component still in a cycle exactly as exposed,
because none of *them* has a top-level side effect either. The cost of not
declaring it was measured at the time on the IdP's own production bundle, which
is the heaviest consumer of this package on the web: **5,483.86 kB → 5,489.99 kB
raw (+0.11%)** and **1,457.31 kB → 1,458.66 kB gzip (+0.09%)**.

**No module in this package's source may call `require()`.** The build is ESM,
and a surviving `require()` puts bundlers back into CommonJS interop — the same
lazily-initialized wrappers, reachable the same silent way. To defer a read, use
a thunk over a static import; to defer a *load*, use `import()`.
`src/__tests__/esmSourcePurity.test.ts` enforces this.

`packages/auth/lib/__tests__/authorize-surface-bundle.test.ts` builds the IdP's
real production bundle and renders the surface out of it, so a regression fails
in CI with React's own message instead of on auth.oxy.so.

[#784]: https://github.com/OxyHQ/OxyHQServices/issues/784

## Installation

```bash
bun add @oxyhq/services @oxyhq/core
```

### Peer Dependencies

To avoid duplicate native modules and ensure smooth integration across apps, install (or ensure your app already includes) the following peer dependencies:

- react: >=18, react-native: >=0.76
- react-native-reanimated: >=3.16, react-native-gesture-handler: >=2.16
- react-native-safe-area-context: ^5.4.0, react-native-svg: >=13
- Expo projects: expo, expo-font, expo-image, expo-linear-gradient
- Navigation (if you use the provided screens): @react-navigation/native


Example for Expo:
```bash
npm i react-native-reanimated react-native-gesture-handler react-native-safe-area-context react-native-svg \
  expo expo-font expo-image expo-linear-gradient @react-navigation/native
```

### React Native/Expo Setup

For React Native and Expo projects, add the polyfill import at the very top of your entry file:

```javascript
// index.js or App.js (very first line)
import 'react-native-url-polyfill/auto';
```

**Note**: This polyfill is already included in the package dependencies, but you need to import it to activate it.

## Quick Start

### Expo Apps (Native + Web)

```typescript
import { OxyProvider, useAuth } from '@oxyhq/services';

function App() {
  return (
    <OxyProvider
      baseURL="https://api.oxy.so"
      clientId={process.env.EXPO_PUBLIC_OXY_CLIENT_ID}
    >
      <YourApp />
    </OxyProvider>
  );
}

function UserProfile() {
  const { user, isAuthenticated, signIn, signOut } = useAuth();

  if (!isAuthenticated) {
    return <Button onPress={() => signIn()} title="Sign In" />;
  }

  return (
    <View>
      <Text>Welcome, {user?.username}!</Text>
      <Button onPress={signOut} title="Sign Out" />
    </View>
  );
}
```

`OxyProvider` handles iOS, Android, and Expo web. Always use `OxyProvider` in Expo apps.

## Typography

Typography is owned entirely by `@oxyhq/bloom`. `BloomThemeProvider` ships the
Inter, BlomusModernus and Geist Mono families — variable `.ttf` files loaded via
`expo-font` on native, `@font-face` rules injected as data URLs on web — and
applies the default family to every `<Text>`. This package bundles no fonts and
loads none, so it adds no font weight to consumer app binaries.

```typescript
import { BloomThemeProvider } from '@oxyhq/bloom/theme';
import { OxyProvider } from '@oxyhq/services';

function App() {
  return (
    <BloomThemeProvider>
      <OxyProvider baseURL="https://api.oxy.so">
        <YourAppContent />
      </OxyProvider>
    </BloomThemeProvider>
  );
}
```

Style text with Bloom's NativeWind font classes (`font-sans`, `font-mono`, …)
rather than raw `fontFamily` strings.

## Usage Patterns

### 1. OxyProvider + useAuth Hook (Recommended)

`OxyProvider` works on all platforms (iOS, Android, Web). Use `useAuth` for authentication.

```typescript
import { OxyProvider, useAuth, OxySignInButton } from '@oxyhq/services';

// App.tsx - Setup the provider
function App() {
  return (
    <OxyProvider
      baseURL="https://api.oxy.so"
      onAuthStateChange={(user) => {
        console.log('Auth state changed:', user ? 'logged in' : 'logged out');
      }}
    >
      <YourApp />
    </OxyProvider>
  );
}

// Component.tsx - Use the hook
function UserProfile() {
  const { user, isAuthenticated, signIn, signOut, isLoading } = useAuth();

  if (isLoading) return <ActivityIndicator />;

  if (!isAuthenticated) {
    return (
      <View>
        <Text>Welcome! Please sign in.</Text>
        <OxySignInButton />
        {/* Or use signIn() directly: */}
        <Button onPress={() => signIn()} title="Sign In" />
      </View>
    );
  }

  return (
    <View>
      <Text style={styles.title}>Welcome, {user?.username}!</Text>
      <Button onPress={signOut} title="Sign Out" />
    </View>
  );
}
```

### 2. Direct Import (Non-React Files)

For utility functions, services, or non-React Native files:

```typescript
import { oxyClient } from '@oxyhq/core';

// utils/api.ts
export const userUtils = {
  async fetchUserById(userId: string) {
    return await oxyClient.getUserById(userId);
  },

  async fetchProfileByUsername(username: string) {
    return await oxyClient.getProfileByUsername(username);
  },

  async updateUserProfile(updates: any) {
    return await oxyClient.updateProfile(updates);
  }
};
```

### 3. Mixed Usage (Hooks + Direct Client)

You can use both hooks and the direct client in the same Expo app:

```typescript
// App.tsx - React Native setup
import { OxyProvider } from '@oxyhq/services';

function App() {
  return (
    <OxyProvider baseURL="https://api.oxy.so">
      <YourApp />
    </OxyProvider>
  );
}

// utils/api.ts - Direct import
import { oxyClient } from '@oxyhq/core';

export const apiUtils = {
  async fetchData() {
    return await oxyClient.getCurrentUser();
  }
};

// Component.tsx - React Native hook
import { useOxy } from '@oxyhq/services';

function Component() {
  const { oxyServices } = useOxy();
  // Both oxyServices and oxyClient share the same tokens
}
```

## API Reference

### Core Exports (from @oxyhq/core)

```typescript
import {
  OxyServices,           // Main service class
  oxyClient,            // Pre-configured instance
  OXY_CLOUD_URL,        // Default API URL
  OxyAuthenticationError,
  OxyAuthenticationTimeoutError,
  KeyManager,
  SignatureService,
  RecoveryPhraseService
} from '@oxyhq/core';
```

### React Native Exports (from @oxyhq/services)

```typescript
import {
  OxyProvider,          // Context provider
  useOxy,              // React Native hook
  useAuth,             // Auth hook
  OxySignInButton,     // UI components
  Avatar,
  FollowButton
} from '@oxyhq/services';
```

### OxyServices Methods

```typescript
// Authentication (Public Key Based)
await oxyClient.register(publicKey, username, signature, timestamp, email?);
await oxyClient.requestChallenge(publicKey);
await oxyClient.verifyChallenge(publicKey, challenge, signature, timestamp, deviceName?, deviceFingerprint?);
await oxyClient.checkPublicKeyRegistered(publicKey);
await oxyClient.getUserByPublicKey(publicKey);

// User Management
const user = await oxyClient.getCurrentUser();                    // Get current user
const userById = await oxyClient.getUserById('user123');          // Get user by ID
const profileByUsername = await oxyClient.getProfileByUsername('john_doe'); // Get profile by username
await oxyClient.updateProfile({ name: 'John Doe' });             // Update current user
await oxyClient.updateUser('user123', { name: 'John' });         // Update user by ID (admin)

// Session Management
const userBySession = await oxyClient.getUserBySession('session123'); // Get user by session
const sessions = await oxyClient.getSessionsBySessionId('session123'); // Get all sessions
await oxyClient.logoutSession('session123');                     // Logout specific session
await oxyClient.logoutAllSessions('session123');                 // Logout all sessions

// Social Features
await oxyClient.followUser('user123');                           // Follow user
await oxyClient.unfollowUser('user123');                         // Unfollow user
const followStatus = await oxyClient.getFollowStatus('user123'); // Check follow status
const followers = await oxyClient.getUserFollowers('user123');   // Get user followers
const following = await oxyClient.getUserFollowing('user123');   // Get user following

// Notifications
const notifications = await oxyClient.getNotifications();        // Get notifications
const unreadCount = await oxyClient.getUnreadCount();            // Get unread count
await oxyClient.markNotificationAsRead('notification123');       // Mark as read
await oxyClient.markAllNotificationsAsRead();                    // Mark all as read
await oxyClient.deleteNotification('notification123');           // Delete notification

// File Management
const fileData = await oxyClient.uploadFile(file);                     // Upload file
const file = await oxyClient.getFile('file123');                       // Get file info
await oxyClient.deleteFile('file123');                                 // Delete file
const downloadUrl = oxyClient.getFileDownloadUrl('file123', 'thumb'); // Get download/stream URL
const userFiles = await oxyClient.listUserFiles('user123');            // List user files

// Payments
const payment = await oxyClient.createPayment(paymentData);      // Create payment
const paymentInfo = await oxyClient.getPayment('payment123');    // Get payment info
const userPayments = await oxyClient.getUserPayments();          // Get user payments

// Trust
showBottomSheet('TrustCenter');                                  // Trust center
showBottomSheet('TrustLeaderboard');                             // Trust leaderboard

// Location Services
await oxyClient.updateLocation(40.7128, -74.0060);              // Update location
const nearby = await oxyClient.getNearbyUsers(1000);             // Get nearby users

// Analytics
await oxyClient.trackEvent('user_action', { action: 'click' });  // Track event
const analytics = await oxyClient.getAnalytics('2024-01-01', '2024-01-31'); // Get analytics

// Device Management
await oxyClient.registerDevice(deviceData);                      // Register device
const devices = await oxyClient.getUserDevices();                // Get user devices
await oxyClient.removeDevice('device123');                       // Remove device
const deviceSessions = await oxyClient.getDeviceSessions('session123'); // Get device sessions
await oxyClient.logoutAllDeviceSessions('session123');           // Logout device sessions
await oxyClient.updateDeviceName('session123', 'iPhone 15');     // Update device name

// Utilities
const metadata = await oxyClient.fetchLinkMetadata('https://example.com'); // Fetch link metadata
```

### useOxy Hook

```typescript
const {
  // Service instance
  oxyServices,

  // Authentication state
  user,
  isAuthenticated,
  isLoading,
  canUsePrivateApi,   // Gate private API calls on this
  isPrivateApiPending,
  error,

  // Identity (public-key auth; identities are created in Commons by Oxy)
  signIn,             // Sign in with stored identity
  hasIdentity,        // Check if identity exists on device
  getPublicKey,       // Get stored public key

  // Account dialog (switcher + sign-in)
  openAccountDialog,
  closeAccountDialog,

  // Session management
  logout,
  sessions,
  activeSessionId,
  switchToAccount,    // Switch active account (device session + account graph)
  removeSession
} = useOxy();
```

## Configuration

### OxyProvider Props

```typescript
<OxyProvider
  baseURL="https://api.oxy.so"            // API base URL
  clientId="oxy_dk_..."                   // Registered Application credential (Oxy Console)
  storageKeyPrefix="oxy_session"          // Storage key prefix
  onAuthStateChange={(user) => {}}        // Auth state callback
  onError={(error) => {}}                 // Error callback
>
  {children}
</OxyProvider>
```

### Environment Variables

```bash
# .env
EXPO_PUBLIC_API_URL=https://api.oxy.so
EXPO_PUBLIC_OXY_CLIENT_ID=oxy_dk_...
```

### Custom Configuration

```typescript
import { OxyServices } from '@oxyhq/core';

const oxy = new OxyServices({
  baseURL: process.env.OXY_API_URL || 'https://api.oxy.so'
});
```

## Authentication

Oxy supports **public/private key cryptography** (ECDSA secp256k1) as the primary identity system, with optional password-based accounts. Users create and manage their cryptographic identity in the **Commons by Oxy** app (the native identity vault); every app integrates the same **"Sign in with Oxy"** surface.

### How it works (device-first)

- **Cold boot is silent.** On mount, `OxyProvider` restores the ambient device session — the server-side `DeviceSession` records which accounts are signed in on this device and which one is active. No redirects, no browser identity APIs, no UI. See [device sessions](../../docs/auth/device-session.md).
- **Interactive sign-in is a dialog.** `useAuth().signIn()` or `useOxy().openAccountDialog('signin')` opens the unified account dialog (Bloom Dialog — bottom sheet on phones, centered on desktop): existing device accounts above ONE primary "Continue with Oxy" action (issue #691, Phase 5) — Oxy automatically picks how the request reaches your Commons identity (same-device deep link → known-install push → QR); there is no password option in this dialog. Scan-QR, passkey-on-this-device, and "Get Commons" sit behind a collapsed "Having trouble?" disclosure.
- **Cross-app sync.** Adding, switching, or signing out an account bumps the device-session revision and is pushed over the `session_state` socket event to every Oxy app on the device.

```tsx
import { useAuth } from '@oxyhq/services';

function SignInCTA() {
  const { isAuthenticated, signIn } = useAuth();
  if (isAuthenticated) return null;
  return <Button title="Sign in" onPress={() => signIn()} />; // opens the dialog
}
```

### Cross-App Authentication (Sign in with Oxy)

`OxySignInButton` resolves your registered Application (`GET /auth/oauth/client/:clientId`) and picks the right flow:

```tsx
import { OxySignInButton } from '@oxyhq/services';

function LoginScreen() {
  return <OxySignInButton variant="contained" />;
}
```

- **Official Oxy apps** (`isOfficial` / first-party types): opens the in-app account dialog.
- **Third-party apps** (`type: 'third_party'`): starts the standard OAuth 2.0 Authorization Code + PKCE flow against `auth.oxy.so` (the SDK generates `state` + PKCE via `@oxyhq/core`). On web the transport is `OxyProvider` prop `webAuthMode: 'popup' | 'redirect'` (default `'popup'`; issue #691 Phases 2/7b) — `'popup'` opens a small window and relays the result via `postMessage` without navigating your app's tab, falling back to a redirect if the browser blocks it. Pass `oauthRedirectUri`; on native handle `onOAuthResult` to complete the token exchange.

See the [integration guide](../../docs/auth/integration-guide.md) for Console registration, OAuth endpoints, and backend verification, and [AUTHENTICATION.md](../../docs/AUTHENTICATION.md) for the full model.

### Documentation

See [Complete Public Key Authentication Guide](./docs/PUBLIC_KEY_AUTHENTICATION.md) for architecture, concepts, user flows, developer integration, crypto module API reference, security best practices, and migration from password auth.

## UI Components

### Built-in Components

```typescript
import {
  OxySignInButton,
  Avatar,
  FollowButton,
  OxyLogo
} from '@oxyhq/services';

function MyComponent() {
  return (
    <View style={styles.container}>
      <OxyLogo />
      <Avatar userId="user123" size={40} />
      <FollowButton userId="user123" />
      <OxySignInButton />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    padding: 16,
  },
});
```

### Account Dialog (auth + switcher)

Sign-in and account switching do **not** use the bottom sheet — they live in the unified account dialog:

```typescript
import { useOxy } from '@oxyhq/services';

function MyComponent() {
  const { openAccountDialog } = useOxy();

  return (
    <Button
      onPress={() => openAccountDialog('signin')}
      title="Sign in with Oxy"
    />
  );
}
```

Views: `'accounts'` (switcher, default), `'signin'`, `'qr'`, `'add'`. The exported `ProfileButton` component opens it for you.

### Bottom Sheet Routing System

The bottom sheet routing system provides a clean, professional way to display account management and other non-auth UI flows within a modal bottom sheet.

**Quick Example:**

```typescript
import { useOxy } from '@oxyhq/services';

function MyComponent() {
  const { showBottomSheet } = useOxy();

  return (
    <Button
      onPress={() => showBottomSheet('ManageAccount')}
      title="Manage account"
    />
  );
}
```

**Features:**
- Full navigation history with back button support
- Step-based screen navigation (multi-step flows)
- Keyboard-aware (automatically adjusts for keyboard)
- Dynamic sizing (fits content automatically)
- Type-safe route names
- 25+ pre-built screens available

**Available Screens:**
- `ManageAccount`, `AccountSettings`, `AccountMembers`, `CreateAccount`
- `Profile`, `EditProfile`, `PaymentGateway`, `TrustCenter`, `ConnectedApps`
- `FileManagement`, `LanguageSelector`, `PrivacySettings`, `Preferences`
- And many more (see `RouteName` in `src/ui/navigation/routes.ts`)

## Internationalization (i18n)

OxyHQ Services includes built-in language selection and storage. The selected language can be accessed and synced with your app's i18n system.

### Getting Current Language

```typescript
import { useOxy } from '@oxyhq/services';

function MyComponent() {
  const {
    currentLanguage,           // 'en-US'
    currentLanguageName,       // 'English'
    currentNativeLanguageName, // 'Espanol' (if Spanish is selected)
    currentLanguageMetadata    // Full metadata object
  } = useOxy();

  return <Text>Current language: {currentLanguageName}</Text>;
}
```

### Syncing with Your i18n Library

To integrate with react-i18next, i18n-js, next-intl, or other i18n libraries, see the comprehensive guide:

See the language utilities and `useOxy()` hook sections above for integration with your i18n system.

### Using OxyServices (Non-React)

```typescript
import { OxyServices } from '@oxyhq/core';

const oxy = new OxyServices({ baseURL: 'https://api.oxy.so' });

// Get current language code
const languageCode = await oxy.getCurrentLanguage();

// Get language name
const languageName = await oxy.getCurrentLanguageName();

// Get full metadata
const metadata = await oxy.getCurrentLanguageMetadata();
```

### Language Utilities

```typescript
import {
  SUPPORTED_LANGUAGES,
  getLanguageName,
  getLanguageMetadata
} from '@oxyhq/services';

// Get all supported languages
const languages = SUPPORTED_LANGUAGES;

// Get language name from code
const name = getLanguageName('es-ES'); // 'Spanish'

// Get full metadata
const metadata = getLanguageMetadata('es-ES');
// { id: 'es-ES', name: 'Spanish', nativeName: 'Espanol', flag: '...', ... }
```

## Troubleshooting

### Common Issues

#### 1. "useOxy() was called outside &lt;OxyProvider&gt;"

**Solution**: Wrap your app with `OxyProvider`

```typescript
import { OxyProvider } from '@oxyhq/services';

function App() {
  return (
    <OxyProvider baseURL="https://api.oxy.so">
      <YourApp />
    </OxyProvider>
  );
}
```

#### 2. FormData Issues in React Native/Expo

**Solution**: Add polyfill import at the very top of your entry file

```javascript
// index.js or App.js (very first line)
import 'react-native-url-polyfill/auto';
```

**Why needed**: Your app uses file uploads which require `FormData`. React Native with Hermes engine does not include `FormData` natively, so it needs to be polyfilled.

#### 3. Authentication Not Persisting

**Solution**: Check storage configuration

```typescript
<OxyProvider
  baseURL="https://api.oxy.so"
  storageKeyPrefix="my_app_oxy"  // Custom storage key
>
  {children}
</OxyProvider>
```

### Error Handling

```typescript
import { OxyAuthenticationError } from '@oxyhq/core';

try {
  await oxyClient.getCurrentUser();
} catch (error) {
  if (error instanceof OxyAuthenticationError) {
    // Handle authentication errors
    console.log('Auth error:', error.message);
  } else {
    // Handle other errors
    console.log('Other error:', error.message);
  }
}
```

## Payment & Storage Query Hooks

The following React Query hooks are exported from the package root:

```typescript
import {
  useUserSubscription,
  useUserPayments,
  useUserWallet,
  useUserWalletTransactions,
  useAccountStorageUsage,
} from '@oxyhq/services';
```

Typed returns are defined in `ui/hooks/queries/paymentTypes.ts` (`Subscription`, `Payment`, `Wallet`, `WalletTransaction`). The `payments` query namespace is whitelisted for offline persistence alongside `accounts`, `users`, `sessions`, `devices`, and `privacy`.

## Sign-In Token Planting

`@oxyhq/core` `OxyServices.verifyChallenge()` plants `setTokens(accessToken)` internally before returning. `useAuthOperations.performSignIn` no longer needs to hand-plant the token or call a session-token fallback — just await `verifyChallenge` and proceed.

## Requirements

- **React Native**: 0.76+ (for mobile components)
- **Expo**: 56+ (recommended)
- **TypeScript**: 4.0+ (optional but recommended)

### Peer Dependencies

For React Native/Expo projects:

```bash
bun add jwt-decode invariant
```

**Note**: `react-native-url-polyfill` is already included as a dependency in this package.

## Examples

### Complete React Native App

```typescript
// App.tsx
import { OxyProvider } from '@oxyhq/services';

function App() {
  return (
    <OxyProvider baseURL="https://api.oxy.so">
      <UserDashboard />
    </OxyProvider>
  );
}

// UserDashboard.tsx
import { useOxy } from '@oxyhq/services';
import { View, Text, StyleSheet } from 'react-native';

function UserDashboard() {
  const { user, isAuthenticated, oxyServices } = useOxy();

  const [followers, setFollowers] = useState([]);

  useEffect(() => {
    if (isAuthenticated && user) {
      oxyServices.getUserFollowers(user.id).then(setFollowers);
    }
  }, [isAuthenticated, user]);

  if (!isAuthenticated) {
    return <Text>Please sign in</Text>;
  }

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Welcome, {user?.name}!</Text>
      <Text>Followers: {followers.length}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    padding: 16,
    justifyContent: 'center',
  },
  title: {
    fontSize: 24,
    fontWeight: 'bold',
    marginBottom: 16,
  },
});
```

---

## Documentation

Comprehensive documentation is available in the `/docs` directory:

- **[Getting Started](./GET_STARTED.md)** - Quick start guide for new developers
- **[Platform Guide](./PLATFORM_GUIDE.md)** - Platform-specific setup guide
- **[AUTHENTICATION.md](../../docs/AUTHENTICATION.md)** - Authentication model (device-first sessions)
- **[Device sessions](../../docs/auth/device-session.md)** - DeviceSession API, socket events, multi-account
- **[Integration guide](../../docs/auth/integration-guide.md)** - Sign in with Oxy for third-party apps

---

## License

This package is licensed under the Apache License, Version 2.0, (c) The Oxy Collective, Inc. See the [LICENSE](LICENSE) and [NOTICE](NOTICE) files for details.

Versions published before `28.0.0` were AGPL-3.0-only and stay that way; a licence change binds future versions only.
