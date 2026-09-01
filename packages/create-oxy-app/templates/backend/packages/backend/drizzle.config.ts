import { DATABASE_CASING } from '@oxyhq/db';
import { defineConfig } from 'drizzle-kit';

/**
 * drizzle-kit configuration.
 *
 * - `bun run db:generate` diffs `schema` against `out/` and writes a new SQL
 *   migration. It never opens a database for that, and it only ever runs on a
 *   developer's machine.
 * - Migrations are APPLIED by `bun run db:migrate` (`src/db/migrate.ts`), which
 *   uses drizzle-orm's own migrator over the files in `out/` — never
 *   `drizzle-kit migrate`. drizzle-kit is a devDependency and the shipped image
 *   installs production dependencies only, so the CLI could never apply a
 *   migration in production. Dev, CI and production all run that one migrator;
 *   see its docblock.
 *
 * `casing` decides what the DDL CREATES; the same constant passed to
 * `createDatabase()` in `src/db/postgres.ts` decides what queries REFERENCE.
 * Both read `DATABASE_CASING` from `@oxyhq/db`, so there is one setting rather
 * than two copies to keep in lockstep — disagreement means queries reference
 * columns the migrations never created.
 *
 * ## Every generated migration needs a deploy-phase marker
 *
 * drizzle-kit cannot add it, so after each `db:generate` open the new
 * `drizzle/<tag>.sql` and add exactly one line:
 *
 *     -- oxy:deploy-phase=pre      additive; safe while the previous image serves
 *     -- oxy:deploy-phase=post     drops/renames/narrows; only once the new image is live
 *
 * `db:migrate` refuses to apply an unmarked migration, before any DDL runs.
 */

const url = process.env.DATABASE_URL;
if (!url) {
  throw new Error(
    'DATABASE_URL is required by drizzle-kit. Start a local Postgres with:\n' +
      '  docker compose -f ../../docker-compose.postgres.yml up -d postgres\n' +
      'then set DATABASE_URL in packages/backend/.env.',
  );
}

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema/index.ts',
  out: './drizzle',
  casing: DATABASE_CASING,
  strict: true,
  verbose: true,
  dbCredentials: { url },
});
