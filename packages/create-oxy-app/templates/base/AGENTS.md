# {{APP_NAME}}

Expo / React Native frontend{{#backend}} + Express + Socket.IO backend{{/backend}}, wired to the Oxy SDK. Generated with `create-oxy-app`.

## Package manager

Always use **bun** (never npm/yarn). After changing any `package.json`, run `bun install` and commit `bun.lock` in the same commit.

## Architecture

```
packages/
  frontend/       @{{APP_SLUG}}/frontend       Expo Router · NativeWind · Bloom · @oxyhq/services
  shared-types/   @{{APP_SLUG}}/shared-types   Shared TypeScript types (CJS){{#backend}}
  backend/        @{{APP_SLUG}}/backend        Express · PostgreSQL (drizzle) · Socket.IO · @oxyhq/core/server{{/backend}}
```

## Commands

```bash
bun install
bun run dev:frontend        # Expo dev server{{#backend}}
bun run dev:backend         # Express + Socket.IO API{{/backend}}
bun run build:frontend      # expo export --platform web{{#backend}}
bun run build:backend       # tsc -> dist
bun run db:generate         # drizzle-kit: schema diff -> drizzle/<tag>.sql
bun run db:migrate --target-database={{APP_SCHEME}}_dev{{/backend}}
```

## Oxy SDK conventions (do not deviate)

- **One provider:** `OxyProvider` from `@oxyhq/services` (web + native) with the registered `clientId` (`EXPO_PUBLIC_OXY_CLIENT_ID`). Interactive sign-in is the in-app `OxyAccountDialog` — never redirect to an IdP.
- **Config:** all Expo config comes from `@oxyhq/app-preset` — the app plugin (`['@oxyhq/app-preset', {}]`), `createOxyMetroConfig`, the shared Babel/ESLint configs, `base.css`, and the tsconfig bases. Do not copy-paste that config back into the app; update the preset instead.
- **Theming:** NativeWind className-based only, via `BloomThemeProvider`. Never hardcode brand colors.
- **Session gating:** gate private API calls on `useAuth().canUsePrivateApi`; the root `Stack` is the sole authority for the `(auth)`↔`(app)` swap.{{#backend}}
- **Backend auth:** `@oxyhq/core/server` only (`createOxyAuthMiddleware`, `createOxyCors`, `createOxyRateLimit`, `authSocket`). No app-local auth middleware, bearer parsers, or CORS. App backends talk to their own API via `oxyServices.createLinkedClient({ baseURL })`.

## Database (PostgreSQL + drizzle)

- **`src/db/schema/index.ts` is the single source of truth.** It is both drizzle-kit's input and the runtime schema object; a table missing from that barrel gets neither a migration nor a typed query.
- **Never hand-write a migration.** Edit the schema, run `bun run db:generate`, then add the `-- oxy:deploy-phase=pre|post` marker to the generated `.sql`. `db:migrate` refuses an unmarked migration before running any DDL.
- **`bun run db:migrate` is the only thing that applies a migration** — dev, CI and production all run `src/db/migrate.ts`. Never `drizzle-kit migrate` (it is a devDependency and cannot reach production).
- **`--target-database=<name>` is required on every run**, dry runs included. Without it a migrator pointed at the wrong database finds an empty ledger, applies everything, and exits 0.
- **Column names come from `DATABASE_CASING`**, passed to both the runtime handle and drizzle-kit. Declare columns camelCase; never spell the snake_case SQL name by hand, and never use `column.name` in hand-written SQL (it is the TypeScript property name — use `sqlColumnName()` from `@oxyhq/db`).
- **User ids carry no foreign key.** Oxy owns identity, so every `oxyUserId` is a foreign service's primary key. No shadow `users` table.
- **Extensions are a precondition of the migrator, not a numbered migration** — add them to `REQUIRED_EXTENSIONS` in `src/db/migrate.ts`, and remember a new managed database still needs a privileged role to run `CREATE EXTENSION` once.{{/backend}}
