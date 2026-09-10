# Getting Started with @oxy.so/services

Zero-config authentication for Expo, React Native, and React Native Web apps. Session state syncs automatically across every Oxy app on the same device.

> **Web apps:** Use `@oxy.so/services` too — via `react-native-web`. See the [Platform Guide](./PLATFORM_GUIDE.md).
>
> **Backend / Node.js:** Use `@oxy.so/core` only. See the [Platform Guide](./PLATFORM_GUIDE.md).

## Installation

```bash
bun add @oxy.so/services @oxy.so/core
```

### Peer Dependencies

```bash
bun add react-native-reanimated react-native-gesture-handler \
  react-native-safe-area-context react-native-svg \
  expo expo-font expo-image expo-linear-gradient \
  @react-navigation/native @tanstack/react-query
```

---

## Quick Start

### 1. Wrap with Provider

```tsx
import { OxyProvider } from '@oxy.so/services';

export default function App() {
  return (
    <OxyProvider
      baseURL="https://api.oxy.so"
      clientId={process.env.EXPO_PUBLIC_OXY_CLIENT_ID}
    >
      <YourApp />
    </OxyProvider>
  );
}
```

`OxyProvider` works on iOS, Android, Expo web, and React Native Web. `clientId` is your app's registered credential (`oxy_dk_…`) from the [Oxy Console](https://console.oxy.so).

### 2. Use Authentication

```tsx
import { useAuth, OxySignInButton } from '@oxy.so/services';

function HomeScreen() {
  const { user, isAuthenticated, isLoading, signOut } = useAuth();

  if (isLoading) return <Loading />;

  if (!isAuthenticated) {
    return (
      <View>
        <Text>Please sign in</Text>
        <OxySignInButton />
      </View>
    );
  }

  return (
    <View>
      <Text>Welcome, {user?.username}!</Text>
      <Button title="Sign Out" onPress={signOut} />
    </View>
  );
}
```

That is it. On cold boot the SDK silently restores the device session — if the user has already signed in to any Oxy app on this device, they are signed in to yours too. The full model is documented in [AUTHENTICATION.md](../../docs/AUTHENTICATION.md).

---

## How sign-in works

**Cold boot (silent).** `OxyProvider` restores the ambient device session on mount. It never redirects to a login page and never opens UI on its own. If there is no session, the app simply renders logged-out.

**Interactive sign-in.** `useAuth().signIn()` (or pressing `OxySignInButton` / `ProfileButton`) opens the unified in-app account dialog — a Bloom dialog (bottom sheet on phones, centered on desktop) with:

- the account switcher for accounts already on this device,
- **Sign in with Oxy** via the Oxy app (QR scan on web, deep link / shared keychain on native),
- a collapsed username + password form.

**`OxySignInButton` and third-party apps.** The button resolves your registered Application via `oxyServices.getPublicApplication(clientId)` (`GET /auth/oauth/client/:clientId`):

- **Official Oxy apps** → opens the in-app dialog above.
- **`third_party` apps** → starts the standard OAuth 2.0 Authorization Code + PKCE redirect to `auth.oxy.so` (the SDK generates `state` and the PKCE pair for you). Pass `oauthRedirectUri`, and on native handle `onOAuthResult` to finish the code exchange.

Third-party integration (Console setup, OAuth endpoints, backend verification) is covered end to end in the [integration guide](../../docs/auth/integration-guide.md).

**Server authority.** The server keeps one `DeviceSession` per device — the signed-in accounts and the active one. Every add/switch/sign-out bumps a revision and is pushed over Socket.IO to all apps on the device, so switching accounts in app A updates app B instantly. Details: [device sessions](../../docs/auth/device-session.md).

---

## useAuth Hook Reference

```tsx
import { useAuth } from '@oxy.so/services';

const {
  // State
  user,               // User | null - current user
  isAuthenticated,    // boolean - is user signed in
  isLoading,          // boolean - initial auth check
  isReady,            // boolean - ready for API calls
  isAuthResolved,     // boolean - cold boot finished (before this, "logged out" is undetermined)
  canUsePrivateApi,   // boolean - authenticated AND bearer token available
  isPrivateApiPending,// boolean - hold private screens in loading state while true
  error,              // string | null - error message

  // Actions
  signIn,             // () => Promise<User> - opens the account dialog
  signOut,            // () => Promise<void> - sign out current session
  signOutAll,         // () => Promise<void> - sign out all devices
  refresh,            // () => Promise<void> - refresh auth state

  // Advanced
  oxyServices,        // OxyServices instance
} = useAuth();
```

Gate private API calls on `canUsePrivateApi` / `isPrivateApiPending` — never fire authenticated requests before cold boot resolves.

---

## Native Apps (React Native / Expo)

### Setup Entry Point

Add polyfill at the very top of your entry file:

```javascript
// index.js or App.js (first line)
import 'react-native-url-polyfill/auto';
```

### Full Example

```tsx
// app/_layout.tsx
import 'react-native-url-polyfill/auto';
import { OxyProvider } from '@oxy.so/services';

const API_URL = process.env.EXPO_PUBLIC_API_URL ?? 'https://api.oxy.so';
const OXY_CLIENT_ID = process.env.EXPO_PUBLIC_OXY_CLIENT_ID;

export default function RootLayout() {
  return (
    <OxyProvider
      baseURL={API_URL}
      clientId={OXY_CLIENT_ID}
    >
      <YourApp />
    </OxyProvider>
  );
}
```

### Account dialog and bottom sheets

Auth and account switching live in the account dialog:

```tsx
import { useOxy } from '@oxy.so/services';

const { openAccountDialog } = useOxy();

openAccountDialog();          // account switcher (default view)
openAccountDialog('signin');  // sign-in view
```

Non-auth surfaces still use the bottom-sheet router:

```tsx
const { showBottomSheet } = useOxy();

showBottomSheet('ManageAccount');      // Account hub (profile, security, devices)
showBottomSheet('FileManagement');     // Files
showBottomSheet('LanguageSelector');   // Language
showBottomSheet('TrustCenter');        // Trust
showBottomSheet({ screen: 'PaymentGateway', props: { amount: 10 } });
```

---

## Web Apps

Web apps use the **same package** through `react-native-web`. Install `react-native-web` + `vite-plugin-react-native-web` and mount the same `OxyProvider` — see the [Platform Guide](./PLATFORM_GUIDE.md) for the Vite config (`packages/console` is the reference app).

### How web session restore works

There is no browser-identity API, hidden iframe, or redirect chain involved. The device session is anchored server-side:

1. The user signs in once on this device (dialog: Oxy-app QR, or password).
2. The API records the account in the device's `DeviceSession` and issues tokens backed by a durable first-party device credential and a rotating refresh-token family.
3. On reload, `OxyProvider`'s cold boot silently exchanges that device credential for a fresh access token — no UI, no redirects.
4. Account changes anywhere on the device are pushed live over the `session_state` socket event.

A brand-new browser origin starts logged out until the user signs in there once. Full contract: [device sessions](../../docs/auth/device-session.md).

---

## Backend (Node.js / Express / Next.js API)

For server-side usage, install `@oxy.so/core` only.

### Installation

```bash
bun add @oxy.so/core
```

### Verifying Oxy users (Express)

Use `@oxy.so/core/server` — do not hand-roll bearer parsing or session-validation middleware:

```typescript
import { OxyServices } from '@oxy.so/core';
import { createOxyAuthMiddleware, getRequiredOxyUserId } from '@oxy.so/core/server';
import express from 'express';

const oxy = new OxyServices({ baseURL: 'https://api.oxy.so' });
const app = express();
app.use(express.json());

app.use('/api', createOxyAuthMiddleware(oxy));

app.get('/api/me', (req, res) => {
  res.json({ userId: getRequiredOxyUserId(req) });
});
```

### Reading public data

```typescript
import { oxyClient } from '@oxy.so/core';

const user = await oxyClient.getUserById('123');
const profile = await oxyClient.getProfileByUsername('john_doe');
```

### Next.js API Route

```typescript
// app/api/user/[id]/route.ts
import { oxyClient } from '@oxy.so/core';
import { NextResponse } from 'next/server';

export async function GET(req, { params }) {
  try {
    const user = await oxyClient.getUserById(params.id);
    return NextResponse.json(user);
  } catch {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }
}
```

### Available Methods

```typescript
// Users
await oxyClient.getUserById(id);
await oxyClient.getProfileByUsername(username);
await oxyClient.getCurrentUser();

// Sessions
await oxyClient.validateSession(sessionId);
await oxyClient.logoutSession(sessionId);

// Social
await oxyClient.getUserFollowers(userId);
await oxyClient.getUserFollowing(userId);
await oxyClient.followUser(userId);
await oxyClient.unfollowUser(userId);

// Files
await oxyClient.listUserFiles();
await oxyClient.deleteFile(fileId);
```

Trust surfaces are exposed as `Trust*` bottom-sheet routes in `@oxy.so/services`.

---

## Advanced: useOxy Hook

For full control, use `useOxy` instead of `useAuth`:

```tsx
import { useOxy } from '@oxy.so/services';

const {
  // All useAuth state plus:
  sessions,            // Sessions signed in on this device
  activeSessionId,     // Current session ID
  switchToAccount,     // Switch active account (device session + account graph)
  refreshSessions,     // Refresh session list

  // Account dialog
  openAccountDialog,   // Open switcher / sign-in dialog
  closeAccountDialog,

  // Language
  currentLanguage,     // 'en', 'es', etc.
  setLanguage,         // Change language

  // UI
  showBottomSheet,     // Show bottom sheet screens
  openAvatarPicker,    // Open avatar picker

  // Identity
  hasIdentity,         // Check for crypto identity
  getPublicKey,        // Get public key
} = useOxy();
```

---

## Environment Variables

```bash
# React Native/Expo
EXPO_PUBLIC_API_URL=https://api.oxy.so
EXPO_PUBLIC_OXY_CLIENT_ID=oxy_dk_...

# Node.js
OXY_API_URL=https://api.oxy.so
```

---

## Troubleshooting

### "useAuth/useOxy must be used within OxyProvider"

Wrap your app with `<OxyProvider>` from `@oxy.so/services` (all platforms).

### Session not restoring on web

1. Cold boot is silent — check `isAuthResolved` before treating the user as logged out
2. A brand-new browser origin is logged out until the user signs in there once
3. Verify your `clientId` is a registered, active credential in the [Oxy Console](https://console.oxy.so)

### Native keychain issues

1. iOS: Enable "Keychain Sharing" in Xcode with group `group.so.oxy.shared`
2. Android: Add `android:sharedUserId="so.oxy.shared"` to manifest
3. Both: Apps must be signed with same certificate/team

---

## Full Documentation

- [README.md](./README.md) - Full API reference
- [PLATFORM_GUIDE.md](./PLATFORM_GUIDE.md) - Platform-specific setup guide
- [AUTHENTICATION.md](../../docs/AUTHENTICATION.md) - Authentication model
- [Device sessions](../../docs/auth/device-session.md) - DeviceSession API, socket events, multi-account
- [Integration guide](../../docs/auth/integration-guide.md) - Sign in with Oxy for third-party apps
