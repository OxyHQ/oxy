# {{APP_NAME}}

An Oxy ecosystem app — Expo / React Native{{#backend}} + Express + Socket.IO{{/backend}}, scaffolded with `create-oxy-app`.

## Getting started

```bash
bun install
bun run dev:frontend        # Expo dev server (press w for web)
```
{{#backend}}
```bash
bun run dev:backend         # Express + Socket.IO API on :3000
```
{{/backend}}
## Oxy client id

The frontend authenticates through the Oxy SDK using a registered client id. Set it in `packages/frontend/.env`:

```
EXPO_PUBLIC_OXY_CLIENT_ID=oxy_dk_...
EXPO_PUBLIC_API_URL=https://{{API_DOMAIN}}
```

Register an Application + public credential at https://console.oxy.so if you did not do it during scaffolding.

## Layout

```
packages/
  frontend/       Expo Router app (@oxyhq/services + @oxyhq/bloom + NativeWind)
  shared-types/   Shared TypeScript types{{#backend}}
  backend/        Express + Postgres (drizzle) + Socket.IO API{{/backend}}
```

All Expo config is centralized in `@oxyhq/app-preset` — see `AGENTS.md`.
