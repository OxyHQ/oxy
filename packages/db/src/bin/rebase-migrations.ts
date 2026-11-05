#!/usr/bin/env node
/**
 * `oxy-db-rebase-migrations` — move a branch's drizzle migrations after the
 * ones `main` gained, the fix `oxy-db-check-migration-locks` points at.
 *
 *   git merge origin/main            # resolve the code conflicts
 *   oxy-db-rebase-migrations --migrations=drizzle --onto=origin/main \
 *     --generate="bun run db:generate"
 *
 * `--migrations` is the drizzle folder (default `drizzle`). `--onto` is the ref
 * to go after (default `origin/main`). `--branch` holds the branch's migrations
 * (default `HEAD`, the branch tip during a merge). `--generate` runs
 * `drizzle-kit generate` for this folder (default `npx --no-install drizzle-kit
 * generate`); `--no-generate` leaves the last snapshot as it was. See
 * `migrate/rebaseMigrations.ts`.
 */

import { rebaseMigrations } from '../migrate/rebaseMigrations';

function flag(argv: readonly string[], name: string): string | undefined {
  const prefix = `--${name}=`;
  const found = argv.find((arg) => arg.startsWith(prefix));
  return found === undefined ? undefined : found.slice(prefix.length).trim();
}

function main(argv: readonly string[]): number {
  try {
    const result = rebaseMigrations({
      migrationsFolder: flag(argv, 'migrations') ?? 'drizzle',
      onto: flag(argv, 'onto') ?? 'origin/main',
      branch: flag(argv, 'branch'),
      generateCommand: argv.includes('--no-generate')
        ? null
        : (flag(argv, 'generate') ?? 'npx --no-install drizzle-kit generate'),
    });
    if (result.generated === 'differs') {
      console.error('\nRebased, staged — but review the SQL difference above before committing.');
      return 1;
    }
    if (result.moved.length > 0)
      console.log('\nRebased and staged. Run the migration check, then commit.');
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

process.exitCode = main(process.argv.slice(2));
