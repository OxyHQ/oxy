# {{APP_NAME}}

Expo / React Native frontend{{#backend}} + Express + Socket.IO backend{{/backend}}, wired to the Oxy SDK. Generated with `create-oxy-app`.

## Package manager

Always use **bun** (never npm/yarn). After changing any `package.json`, run `bun install` and commit `bun.lock` in the same commit.

## Architecture

```
packages/
  frontend/       @{{APP_SLUG}}/frontend       Expo Router · NativeWind · Bloom · @oxyhq/services
  shared-types/   @{{APP_SLUG}}/shared-types   Shared TypeScript types (CJS){{#backend}}
  backend/        @{{APP_SLUG}}/backend        Express · Postgres/drizzle · Socket.IO · @oxyhq/core/server{{/backend}}
```

## Commands

```bash
bun install
bun run dev:frontend        # Expo dev server{{#backend}}
bun run dev:backend         # Express + Socket.IO API{{/backend}}
bun run build:frontend      # expo export --platform web{{#backend}}
bun run build:backend       # tsc -> dist{{/backend}}
```

## Oxy SDK conventions (do not deviate)

- **One provider:** `OxyProvider` from `@oxyhq/services` (web + native) with the registered `clientId` (`EXPO_PUBLIC_OXY_CLIENT_ID`). Interactive sign-in is the in-app `OxyAccountDialog` — never redirect to an IdP.
- **Config:** all Expo config comes from `@oxyhq/app-preset` — the app plugin (`['@oxyhq/app-preset', {}]`), `createOxyMetroConfig`, the shared Babel/ESLint configs, `base.css`, and the tsconfig bases. Do not copy-paste that config back into the app; update the preset instead.
- **Theming:** NativeWind className-based only, via `BloomThemeProvider`. Never hardcode brand colors.
- **Session gating:** gate private API calls on `useAuth().canUsePrivateApi`; the root `Stack` is the sole authority for the `(auth)`↔`(app)` swap.{{#backend}}
- **Backend auth:** `@oxyhq/core/server` only (`createOxyAuthMiddleware`, `createOxyCors`, `createOxyRateLimit`, `authSocket`). No app-local auth middleware, bearer parsers, or CORS. App backends talk to their own API via `oxyServices.createLinkedClient({ baseURL })`.{{/backend}}
