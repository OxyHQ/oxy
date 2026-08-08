# {{APP_NAME}}

An Oxy ecosystem app — Expo / React Native{{#backend}} + Express + Socket.IO{{/backend}}, scaffolded with `create-oxy-app`.

## Getting started

```bash
bun install
bun run dev:frontend        # Expo dev server (press w for web)
```
{{#backend}}
### Backend

The API needs a PostgreSQL database. From the repository root:

```bash
docker compose -f docker-compose.postgres.yml up -d postgres   # local Postgres on :5437
cp packages/backend/.env.example packages/backend/.env
bun run db:migrate --target-database={{APP_SCHEME}}_dev         # apply the schema
bun run dev:backend                                            # Express + Socket.IO API on :3000
```

`GET /health` is liveness; `GET /ready` answers 200 only when Postgres is
reachable **and** every migration this build ships has been applied.

### Changing the schema

Tables are declared in `packages/backend/src/db/schema/` and re-exported from
`schema/index.ts` — a table missing from that barrel gets neither a migration nor
a typed query. After editing:

```bash
bun run db:generate                                     # writes drizzle/<tag>.sql
# open the new drizzle/<tag>.sql and add ONE line at the top:
#   -- oxy:deploy-phase=pre     additive (new table/column, widened CHECK)
#   -- oxy:deploy-phase=post    drops, renames, narrowed constraints
bun run db:migrate --target-database={{APP_SCHEME}}_dev
```

Both flags are deliberate, and neither has a default. `--target-database` is the
guard that fails loudly when the migrator is pointed at the wrong database —
without it a wrong URL finds an empty ledger, applies everything, and exits 0.
The deploy-phase marker is what lets a rollout apply additive migrations before
the new image and destructive ones after it; `db:migrate` refuses an unmarked
migration before running any DDL.
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
  backend/        Express + PostgreSQL (drizzle) + Socket.IO API{{/backend}}
```

All Expo config is centralized in `@oxyhq/app-preset` — see `AGENTS.md`.
