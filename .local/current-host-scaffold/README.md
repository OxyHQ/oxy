# Current host probe

An Oxy ecosystem app — Expo / React Native, scaffolded with `create-oxy-app`.

## Getting started

```bash
bun install
bun run dev:frontend        # Expo dev server (press w for web)
```

## Oxy client id

The frontend authenticates through the Oxy SDK using a registered client id. Set it in `packages/frontend/.env`:

```
EXPO_PUBLIC_OXY_CLIENT_ID=oxy_dk_...
EXPO_PUBLIC_API_URL=https://localhost:9
```

Register an Application + public credential at https://console.oxy.so if you did not do it during scaffolding.

## Layout

```
packages/
  frontend/       Expo Router app (@oxy.so/services + @oxy.so/bloom + NativeWind)
  shared-types/   Shared TypeScript types
```

All Expo config is centralized in `@oxy.so/app-preset` — see `AGENTS.md`.
