# create-oxy-app

Scaffold a new Oxy ecosystem app — an Expo / React Native + Express monorepo
wired to the Oxy SDK (`@oxyhq/services`, `@oxyhq/app-preset`) with the canonical
provider stack, device-first auth, Bloom theming, and an AWS deploy workflow.

## Usage

```bash
bun create oxy-app            # interactive
bun create oxy-app my-app     # into ./my-app
bunx create-oxy-app my-app --yes
```

### Options

```
--name <name>        App display name
--slug <slug>        Package/workspace slug (kebab-case)
--scheme <scheme>    Expo URL scheme
--bundle-id <id>     iOS/Android bundle identifier
--domain <domain>    Backend API domain
--no-backend         Skip the Express + Socket.IO backend
--no-deploy          Skip the AWS deploy workflow
--minimal            Skip the example authenticated screen
--no-install         Do not run `bun install`
--no-git             Do not initialize a git repository
--no-register        Do not register an Oxy client
-y, --yes            Accept all defaults (non-interactive)
```

## What you get

```
my-app/
  packages/
    frontend/       Expo Router · NativeWind · Bloom · @oxyhq/services
    shared-types/   Shared TypeScript types
    backend/        Express · PostgreSQL (drizzle) · Socket.IO · @oxyhq/core/server  (optional)
  docker-compose.postgres.yml     Local Postgres for the backend                     (optional)
  .github/workflows/deploy-aws.yml                                                   (optional)
```

All Expo config comes from **`@oxyhq/app-preset`** — the config plugin,
`createOxyMetroConfig`, the Babel/ESLint configs, `base.css`, and the tsconfig
bases — so apps track the ecosystem with a version bump instead of copy-pasting.

The frontend ships the canonical provider stack
(`GestureHandlerRootView → KeyboardProvider → SafeAreaProvider →
BloomThemeProvider → OxyProvider → ImageResolver → LocaleProvider`) with the root
`Stack` as the sole `(auth)`↔`(app)` authority, keyed on the device-first
session.

## The backend's datastore

Generated backends run on **PostgreSQL** via drizzle-orm + postgres.js, built
through **`@oxyhq/db`** — the same substrate every Oxy backend uses, so a new app
inherits the ecosystem's column builders, casing authority, migration ledger and
deploy-phase planner rather than reinventing them.

```bash
docker compose -f docker-compose.postgres.yml up -d postgres
cp packages/backend/.env.example packages/backend/.env
bun run db:migrate --target-database=myapp_dev
bun run dev:backend
```

The scaffold ships one example table (`notes`) with its migration `0000` already
generated and phase-marked, so `db:migrate` applies a real schema from zero
before you have written anything. Editing `src/db/schema/` and running
`bun run db:generate` produces the next migration; add its
`-- oxy:deploy-phase=pre|post` marker before applying it.

The local compose file uses plain `postgres:17-alpine`. Apps that need PostGIS
add `postgis` to `REQUIRED_EXTENSIONS` in `packages/backend/src/db/migrate.ts`
**and** swap the compose image to `postgis/postgis:17-3.5`; on a managed database
the extension additionally needs a privileged role to install it once (see
oxy-infra `docs/runbooks/30-postgres-database-provisioning.md`).

## Oxy client registration

By default the CLI offers to register an `Application` + public credential with
Oxy and write the resulting `clientId` into `packages/frontend/.env`. Skip it
with `--no-register` and register manually at https://console.oxy.so.
