# Architecture

## Monorepo Structure

OxyHQ Services is a Bun workspaces monorepo (`@oxy.so/sdk`) built with Turbo. All packages live under `packages/`.

```
packages/
  contracts/      @oxy.so/contracts   Contract-first API schemas (Zod, zero React/RN)
  protocol/       @oxy.so/protocol    Signed-record envelope, canonical JSON, platform crypto
  core/           @oxy.so/core        Platform-agnostic foundation (zero React/RN)
  services/       @oxy.so/services    The single UI SDK — Expo, React Native, and web (RN Web)
  expo-splash/    @oxy.so/expo-splash Shared native-splash toolkit for Oxy Expo apps
  api/            @oxy.so/api         Express.js backend API
  node/           @oxy.so/node        Self-hostable personal data node
  auth/                              auth.oxy.so — OAuth authorize/consent IdP (Vite + RN Web)
  accounts/                          Accounts by Oxy (management-only Expo app)
  commons/                           Commons by Oxy (native-only identity vault)
  inbox/                             Inbox app
  console/                           Developer console (Application registry)
  test-app-expo/                     Expo test/playground app
```

There is no separate web-only auth SDK package — web apps consume `@oxy.so/services` via React Native Web, so every platform shares one provider (`OxyProvider`) and one auth UI.

## Dependency Graph

```
@oxy.so/contracts      no internal deps (only zod)
@oxy.so/protocol       dep: @oxy.so/contracts
@oxy.so/core           dep: @oxy.so/contracts + @oxy.so/protocol
@oxy.so/services       dep: @oxy.so/core + @oxy.so/contracts
@oxy.so/api            dep: @oxy.so/contracts + @oxy.so/core (server middleware) + @oxy.so/protocol
@oxy.so/node           dep: @oxy.so/contracts + @oxy.so/core + @oxy.so/protocol
accounts / commons / inbox / console  dep: @oxy.so/services + @oxy.so/core
auth (IdP)            dep: @oxy.so/services (device-first cold boot — same as every Oxy app)
```

## Package Boundaries (strict)

| Package | Cannot import |
|---------|---------------|
| `@oxy.so/contracts` | `react`, `react-native`, `expo-*` — only `zod` |
| `@oxy.so/core` | `react`, `react-native`, `expo-*` (dynamic imports for optional RN modules allowed) |
| `@oxy.so/services` | Does NOT re-export from `@oxy.so/core` or `@oxy.so/contracts` — consumers import those directly |
| `@oxy.so/api` | Schemas from `@oxy.so/contracts` directly; server auth helpers from `@oxy.so/core/server` only |

## Auth / Session (device-first)

- The server-side `DeviceSession` (collection `devicesessions`: `deviceId`, `accounts[]`, `activeAccountId`, `revision`) is the single session authority; clients read/mutate it via `/session/device/{state,add,switch,signout}`.
- Every mutation broadcasts a token-free `session_state` event to the Socket.IO room `device:<deviceId>` — all apps on one device sync instantly.
- `SessionClient` (`packages/core/src/session/`) owns the client half; `OxyProvider` (`@oxy.so/services`) wires it up with a registered `clientId`. Apps implement no local session restore.
- Interactive sign-in is the in-app `OxyAccountDialog` (Commons QR / password). Cold boot never redirects to a login page.
- Third-party apps use standard OAuth 2.0 + PKCE via `auth.oxy.so` — see `docs/auth/integration-guide.md`. Device-session details: `docs/auth/device-session.md`.

## ESM/CJS Dual Build

`@oxy.so/core` ships CJS + ESM builds. The ESM build **must never contain `require()` calls** — Vite and other ESM-only bundlers will crash.

Rules:
- Never use `require()` in `packages/core/`
- Use `import ... from` for static imports
- Use `await import(moduleName)` for optional/platform-specific modules
- Guard unavoidable `require()` with `typeof require !== 'undefined'`

## Build Tooling

| Package | Build tool | Output |
|---------|-----------|--------|
| `@oxy.so/contracts` | `tsc` | CJS + ESM + types -> `dist/` |
| `@oxy.so/core` | `tsc` | CJS + ESM + types -> `dist/` |
| `@oxy.so/services` | `react-native-builder-bob` | -> `lib/` |
| `@oxy.so/api` | `tsc` | -> `dist/` |

## Key Entry Points

| File | Purpose |
|------|---------|
| `packages/contracts/src/index.ts` | All public contract exports (schemas, helpers, types) |
| `packages/core/src/index.ts` | All public core exports |
| `packages/core/src/session/` | `SessionClient` + device-session projection/state |
| `packages/core/src/server/index.ts` | `@oxy.so/core/server` Express helpers |
| `packages/services/src/index.ts` | All public services exports |
| `packages/services/src/ui/context/OxyContext.tsx` | Auth provider + `useOxy()` (web + native) |
| `packages/services/src/ui/context/oxyContextTypes.ts` | `OxyContextState`, `PasswordSignInResult`, provider props |
| `packages/services/src/ui/context/useOxyAccountGraph.ts` | Account graph hook (`accounts`, `switchToAccount`, …) |
| `packages/services/src/ui/navigation/accountDialogManager.ts` | Imperative `openAccountDialog` / `closeAccountDialog` |
| `packages/services/src/ui/components/OxyProvider.tsx` | Provider component (all platforms) |

## Import Conventions

```typescript
// All React platforms (Expo, React Native, web via RN Web)
import { OxyProvider, useOxy, useAuth, OxySignInButton } from '@oxy.so/services';
import type { User } from '@oxy.so/core';

// Server / Node
import { OxyServices } from '@oxy.so/core';
import { createOxyAuthMiddleware, getRequiredOxyUserId } from '@oxy.so/core/server';
```

Use `import type` for type-only imports, regular `import` for values.

## Terminology

| Term | Meaning |
|------|---------|
| **OxyServices** | Main API client class (in core) |
| **OxyProvider** | The single React context provider (in services; all platforms) |
| **SessionClient** | Device-session engine in core; consumed by OxyProvider |
| **useOxy / useAuth** | Auth hooks (services) |
| **OxyAccountDialog** | The single account switcher + sign-in surface (Bloom Dialog) |
| **OxySignInButton** | "Sign in with Oxy" button — dialog for official apps, OAuth redirect for third party |
| **OxyConsentScreen** | The IdP consent surface (rendered by auth.oxy.so) |
