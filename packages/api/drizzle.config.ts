import { defineConfig } from 'drizzle-kit';
import { DATABASE_CASING } from '@oxyhq/db';

/**
 * drizzle-kit configuration.
 *
 * - `bun run db:generate` diffs `schema` against `out/` and writes a new SQL
 *   migration. It never opens a database. This is the ONLY drizzle-kit command
 *   this package runs, and it only ever runs on a developer's machine.
 * - Migrations are APPLIED by `bun run db:migrate` (`src/db/migrate.ts`), which
 *   uses drizzle-orm's own migrator over the files in `out/` — not
 *   `drizzle-kit migrate`. drizzle-kit depends on esbuild, whose arm64/alpine
 *   postinstall breaks the production image (PR #261), so the CLI cannot ship
 *   and could never apply a migration in production. Dev, CI, the jest harness
 *   and production all run that one migrator; see its docblock.
 *
 * `casing` decides what the DDL CREATES; the same value passed to `drizzle()` in
 * `src/config/postgres.ts` decides what queries REFERENCE. Both read it from
 * `@oxyhq/db` so they cannot drift apart.
 */

const url = process.env.DATABASE_URL;
if (!url) {
  throw new Error(
    'DATABASE_URL is required by drizzle-kit. Start a local Postgres with:\n' +
    '  docker compose -f ../../docker-compose.dev.yml up -d postgres\n' +
    'then set DATABASE_URL in packages/api/.env (see .env.example).'
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
