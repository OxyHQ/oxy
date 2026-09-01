#!/usr/bin/env bun
/**
 * Create the Postgres extensions `src/db/extensions.ts` declares, then exit.
 *
 * This runs as the FIRST half of `bun run db:migrate`, ahead of
 * `drizzle-kit migrate`, because a migration that creates a
 * `geography(Point,4326)` column cannot be the thing that installs PostGIS.
 * See `src/db/extensions.ts` for why the ordering lives here rather than in a
 * numbered migration.
 *
 * Idempotent: every statement is `CREATE EXTENSION IF NOT EXISTS`, so this is a
 * no-op on an already-prepared database — including for a role that would not
 * be allowed to create the extension itself.
 *
 * Run:
 *   bun run db:migrate                      # normal path — this, then migrate
 *   bun run scripts/ensure-extensions.ts    # just the extensions
 *
 * Env:
 *   DATABASE_URL  required — the database to prepare (same variable
 *                 drizzle-kit migrates against).
 */

import { ensureExtensions } from '@oxyhq/db/migrate';
import { REQUIRED_EXTENSIONS } from '../src/db/extensions';
import { ConfigurationError } from '../src/config/env';

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new ConfigurationError(
      'DATABASE_URL is required to create extensions. Start a local Postgres ' +
      'with:\n  docker compose -f ../../docker-compose.dev.yml up -d postgres\n' +
      'then set DATABASE_URL in packages/api/.env (see .env.example).'
    );
  }
  await ensureExtensions(url, REQUIRED_EXTENSIONS);
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
