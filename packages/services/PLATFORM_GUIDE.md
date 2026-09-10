# OxyHQ SDK Platform Guide

Guide for using the OxyHQ SDK across different platforms and runtimes.

The SDK is split into packages with clear responsibilities:

- **@oxy.so/contracts** — Contract-first API schemas (Zod). No React, no React Native.
- **@oxy.so/core** — Platform-agnostic foundation: `OxyServices`, `SessionClient`, OAuth + PKCE helpers, crypto utilities, types, and the `@oxy.so/core/server` middleware for backends.
- **@oxy.so/services** — The **single UI SDK**: `OxyProvider`, hooks, screens, and components for Expo, React Native, **and web** (React Native Web).

There is exactly one auth provider: `OxyProvider` from `@oxy.so/services`. It runs on iOS, Android, Expo web, and plain React web apps bundled through `react-native-web`. There is no separate web-only auth package.

## Quick Reference

| Platform | Packages | Provider | Notes |
|----------|----------|----------|-------|
| **Expo / React Native** | `@oxy.so/services` + `@oxy.so/core` | `OxyProvider` | Full UI, components, screens |
| **Web (Vite + React Native Web)** | `@oxy.so/services` + `@oxy.so/core` | `OxyProvider` | Same provider; `packages/console` is the reference setup |
| **IdP shell (auth.oxy.so)** | `@oxy.so/services` + `@oxy.so/core` | `OxyProvider` | Same device-first cold boot as every Oxy app; emits OAuth codes after auth |
| **Node.js / Backend** | `@oxy.so/core` | N/A | API client + `@oxy.so/core/server` middleware, no React |

## Package Details

### @oxy.so/core

Platform-agnostic package. Use everywhere.

**Provides:**
- `OxyServices` class with all API methods
- `oxyClient` pre-configured instance
- `SessionClient` — device-session state machine consumed by `OxyProvider` (see [device sessions](../../docs/auth/device-session.md))
- OAuth helpers for third-party sign-in: `generatePkcePair`, `generateOAuthState`, `buildOAuthAuthorizeUrl`
- All TypeScript types and interfaces
- `KeyManager`, `SignatureService`, `RecoveryPhraseService` (crypto)
- `@oxy.so/core/server` — Express middleware (`createOxyAuthMiddleware`, `getRequiredOxyUserId`, `createOxyCors`, `safeFetch`, …)

**Install:**
```bash
bun add @oxy.so/core
```

**Example:**
```typescript
import { OxyServices, oxyClient } from '@oxy.so/core';
import type { User } from '@oxy.so/core';

// Use the pre-configured client
const user = await oxyClient.getUserById('123');

// Or create a custom instance
const oxy = new OxyServices({ baseURL: 'https://api.oxy.so' });
```

---

### @oxy.so/services

The UI SDK for every React surface — Expo, React Native, and web via React Native Web.

**Provides:**
- `OxyProvider` (universal provider: iOS, Android, Expo web, React Native Web)
- `useOxy`, `useAuth` hooks
- The unified account dialog (account switcher + sign-in), opened via `useOxy().openAccountDialog()` or the exported `ProfileButton`
- UI components (`OxySignInButton`, `OxyConsentScreen`, `Avatar`, `FollowButton`, `OxyLogo`)
- Bottom sheet routing system for non-auth screens (files, payments, trust, …)
- Inter font family with automatic loading
- i18n language selection

**Install:**
```bash
bun add @oxy.so/services @oxy.so/core
```

**Peer dependencies (Expo):**
```bash
bun add react-native-reanimated react-native-gesture-handler \
  react-native-safe-area-context react-native-svg \
  expo expo-font expo-image expo-linear-gradient \
  @react-navigation/native @tanstack/react-query
```

**Example:**
```tsx
import { OxyProvider, useAuth, OxySignInButton } from '@oxy.so/services';
import type { User } from '@oxy.so/core';

export default function App() {
  return (
    <OxyProvider baseURL="https://api.oxy.so" clientId={process.env.EXPO_PUBLIC_OXY_CLIENT_ID}>
      <YourApp />
    </OxyProvider>
  );
}
```

`clientId` is the app's registered Application credential (`oxy_dk_…`) from the [Oxy Console](https://console.oxy.so). Official Oxy apps get in-app sign-in; third-party apps get the standard OAuth redirect. See [AUTHENTICATION.md](../../docs/AUTHENTICATION.md).

---

## Platform-Specific Setup

### Expo / React Native

**Install:**
```bash
bun add @oxy.so/services @oxy.so/core
bun add react-native-reanimated react-native-gesture-handler \
  react-native-safe-area-context react-native-svg
```

**Entry file setup:**
```javascript
// index.js or App.js (first line)
import 'react-native-url-polyfill/auto';
```

**App setup:**
```tsx
import { OxyProvider } from '@oxy.so/services';

export default function App() {
  return (
    <OxyProvider baseURL="https://api.oxy.so" clientId={process.env.EXPO_PUBLIC_OXY_CLIENT_ID}>
      <YourApp />
    </OxyProvider>
  );
}
```

Works on iOS, Android, and Expo web. On cold boot the provider silently restores the device session (see [device sessions](../../docs/auth/device-session.md)) — it never redirects to a login page. Interactive sign-in happens in the in-app account dialog: `useAuth().signIn()` opens it.

---

### Web (Vite + React Native Web)

Web apps use the **same** `@oxy.so/services` provider, bundled through `react-native-web`. The reference setup is `packages/console` (rolldown-vite):

**Install:**
```bash
bun add @oxy.so/services @oxy.so/core react-native-web
bun add -d vite-plugin-react-native-web
```

**vite.config.ts:**
```typescript
import { defineConfig } from 'vite';
import viteReact from '@vitejs/plugin-react';
import reactNativeWeb from 'vite-plugin-react-native-web';

export default defineConfig({
  plugins: [reactNativeWeb(), viteReact()],
});
```

The plugin aliases `react-native` → `react-native-web`, applies `.web.*` extension priority, and handles the RN package graph (JSX in `.js`, Flow stripping, RN globals).

**Usage:**
```tsx
import { OxyProvider } from '@oxy.so/services';

function App() {
  return (
    <OxyProvider baseURL="https://api.oxy.so" clientId={import.meta.env.VITE_OXY_CLIENT_ID}>
      <YourApp />
    </OxyProvider>
  );
}
```

On web, the account dialog offers Commons QR sign-in (scan from the Oxy app on your phone) plus a collapsed username/password form.

---

### IdP shell (auth.oxy.so)

The identity provider mounts the same `OxyProvider` with the same device-first cold boot as every other Oxy app. It renders sign-in and `OxyConsentScreen` surfaces for the OAuth authorize/consent flow after authenticating on its own origin.

---

### Node.js (Backend)

**Install:**
```bash
bun add @oxy.so/core
```

Backends validate incoming Oxy bearer tokens with `@oxy.so/core/server` — never hand-roll token parsing or session-validation middleware:

```typescript
import { OxyServices } from '@oxy.so/core';
import { createOxyAuthMiddleware, getRequiredOxyUserId } from '@oxy.so/core/server';
import express from 'express';

const oxy = new OxyServices({ baseURL: 'https://api.oxy.so' });
const app = express();
app.use(express.json());

// Validates `Authorization: Bearer <access_token>` and attaches identity
app.use('/api', createOxyAuthMiddleware(oxy));

app.get('/api/me', (req, res) => {
  res.json({ userId: getRequiredOxyUserId(req) });
});

app.listen(3000);
```

Frontends that call your backend should use `oxyServices.createLinkedClient({ baseURL })` — no app-local auth interceptors or manual `Authorization` headers.

---

## Import Patterns

Each package has a single entry point (plus `@oxy.so/core/server` for backends).

```typescript
// Expo / React Native / Web (React Native Web)
import { OxyProvider, useOxy, useAuth, Avatar } from '@oxy.so/services';
import { OxyServices, oxyClient } from '@oxy.so/core';
import type { User } from '@oxy.so/core';

// Node.js backend
import { OxyServices, oxyClient, KeyManager } from '@oxy.so/core';
import { createOxyAuthMiddleware, getRequiredOxyUserId } from '@oxy.so/core/server';
import type { User } from '@oxy.so/core';
```

---

## Best Practices

1. **Use @oxy.so/core for types everywhere.** All shared types, interfaces, and the `OxyServices` class live in `@oxy.so/core`. API contract types come from `@oxy.so/contracts`.
2. **Use @oxy.so/services on every React surface.** One provider for native and web — do not build a parallel web auth layer.
3. **Use @oxy.so/core alone for backends.** No React or UI dependencies are pulled in; auth middleware comes from `@oxy.so/core/server`.
4. **Pass a registered `clientId`.** Register your app in the [Oxy Console](https://console.oxy.so) and pass the credential to `OxyProvider`.
5. **Gate private API calls on SDK readiness.** Use `useAuth().canUsePrivateApi` / `isPrivateApiPending` instead of firing requests during cold boot.

---

## Troubleshooting

### Web bundle fails on React Native imports

**Problem:** Vite/webpack cannot resolve `react-native` modules from `@oxy.so/services`.

**Solution:** Add `react-native-web` and `vite-plugin-react-native-web` (see the web setup above). `packages/console` is the working reference.

### Types not available

**Problem:** Cannot find type definitions.

**Solution:** Install `@oxy.so/core`. All shared types are exported from this package.

### OxyProvider not found

**Problem:** Cannot import `OxyProvider`.

**Solution:** `OxyProvider` is exported from `@oxy.so/services` on all platforms, including web.

### Session does not restore on web

**Problem:** Reloading the page shows the logged-out state.

**Solution:** Cold boot restores silently from the device session; a brand-new browser origin is logged out until the user signs in there once. See [device sessions](../../docs/auth/device-session.md).

---

## Summary

| Package | Use Case | Key Exports |
|---------|----------|-------------|
| `@oxy.so/core` | All platforms | `OxyServices`, `oxyClient`, `SessionClient`, OAuth/PKCE helpers, types, crypto |
| `@oxy.so/core/server` | Backends | `createOxyAuthMiddleware`, `getRequiredOxyUserId`, `createOxyCors`, `safeFetch` |
| `@oxy.so/services` | Expo / React Native / Web | `OxyProvider`, `useOxy`, `useAuth`, `OxySignInButton`, screens |

For the full authentication model see [AUTHENTICATION.md](../../docs/AUTHENTICATION.md); third-party integration lives in [the integration guide](../../docs/auth/integration-guide.md).
