#!/usr/bin/env bun
/**
 * The TypeScript schema and the migration snapshots must describe the same
 * database.
 *
 * ## The failure this exists for, which happened
 *
 * `0018_follow_namespaces` and `0019_follow_enum_checks` were hand-written SQL
 * with hand-appended journal entries and NO `meta/*_snapshot.json`. Both change
 * schema drizzle models — a table, a foreign key, five CHECK constraints — so
 * the snapshot chain stopped describing the database two migrations early.
 *
 * Nothing failed at the time. It failed for the NEXT person: `drizzle-kit
 * generate` diffs the TypeScript schema against the last snapshot, so their
 * migration was emitted containing `CREATE TABLE follow_namespaces` and all
 * five constraints — DDL already applied in production. Shipped, that is a
 * failed migration on the pre-deploy one-shot, which is the one place a failure
 * stops a release rather than degrading it.
 *
 * It was caught by hand, by somebody who happened to read the generated file
 * instead of trusting it. That is not a control.
 *
 * ## Why this checks behaviour and not the presence of a file
 *
 * "Every journal entry has a snapshot" is the obvious check and it is the wrong
 * one: `0005_transparency_immutability` creates only functions and triggers,
 * which drizzle does not model, so it correctly has no snapshot. A
 * presence-check either fails on it forever or needs an allowlist that a future
 * hand-written migration silently joins.
 *
 * Asking `drizzle-kit generate` whether it has anything to say is the same
 * question asked of the thing that actually breaks. A migration that needed a
 * snapshot and lacks one makes it speak; one that never needed one leaves it
 * silent.
 */

import { spawnSync } from 'node:child_process';
import { readdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const apiDir = path.join(repoRoot, 'packages', 'api');
const drizzleDir = path.join(apiDir, 'drizzle');

/**
 * A floor, so a drizzle-kit that read nothing cannot pass by saying nothing.
 * It prints one line per table it loaded; a schema this size loading fewer than
 * this means the run is broken, not clean.
 */
const MIN_TABLES_READ = 50;

function listMigrations() {
  return new Set(readdirSync(drizzleDir).filter((f) => f.endsWith('.sql')));
}

function fail(message, detail) {
  console.error(`\n✗ ${message}\n`);
  if (detail) console.error(detail.trim().split('\n').slice(-40).join('\n'));
  process.exit(1);
}

const before = listMigrations();

// drizzle-kit reads the config, which requires DATABASE_URL to be set even for
// a generate that never connects. CI has Postgres; locally, any URL will do.
const result = spawnSync('bunx', ['drizzle-kit', 'generate'], {
  cwd: apiDir,
  encoding: 'utf8',
  env: {
    ...process.env,
    DATABASE_URL:
      process.env.DATABASE_URL ??
      process.env.TEST_DATABASE_URL ??
      'postgres://postgres:postgres@127.0.0.1:5432/postgres',
  },
});

const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;

if (result.status !== 0) {
  fail('drizzle-kit generate failed, so nothing about the snapshots was proven', output);
}

// Whatever the verdict, do not leave a generated migration behind.
//
// This is not tidiness. A generate that emitted `0021` also wrote
// `meta/0021_snapshot.json` and appended to `_journal.json`, and the NEXT run
// then fails with a snapshot-collision error rather than the honest message
// below — so an uncleaned failure makes its own diagnosis unreadable. (Written
// after exactly that happened while mutation-testing this file: the comment
// claiming cleanup was here before the cleanup was.)
const after = listMigrations();
const emitted = [...after].filter((f) => !before.has(f));

if (emitted.length > 0) {
  for (const file of emitted) {
    rmSync(path.join(drizzleDir, file), { force: true });
    const snapshot = path.join(drizzleDir, 'meta', `${file.slice(0, 4)}_snapshot.json`);
    rmSync(snapshot, { force: true });
  }
  // The journal is tracked, so git is the reliable way to undo an append —
  // rewriting it by hand would be a second parser of a file drizzle owns.
  const restore = spawnSync('git', ['checkout', '--', 'drizzle/meta/_journal.json'], {
    cwd: apiDir,
    encoding: 'utf8',
  });
  if (restore.status !== 0) {
    console.error(
      'WARNING: could not restore drizzle/meta/_journal.json — check `git status`.'
    );
  }
}

const tablesRead = (output.match(/^\S+ \d+ columns/gm) ?? []).length;
if (tablesRead < MIN_TABLES_READ) {
  fail(
    `drizzle-kit reported only ${tablesRead} tables (floor ${MIN_TABLES_READ}). ` +
      'It did not read the schema, so its silence means nothing.',
    output
  );
}

if (emitted.length > 0 || !output.includes('No schema changes')) {
  fail(
    'The TypeScript schema and the migration snapshots disagree.\n\n' +
      'drizzle-kit wants to emit a migration, which means the last snapshot does not\n' +
      'describe the database the applied migrations produced. Almost always: a\n' +
      'hand-written migration changed schema drizzle models and shipped without its\n' +
      `meta/*_snapshot.json.\n\n${
        emitted.length > 0 ? `It emitted: ${emitted.join(', ')}\n\n` : ''
      }` +
      'Fix by generating that migration instead of hand-writing it, or — if the SQL\n' +
      'must stay hand-written — by generating it, keeping the SNAPSHOT, and trimming\n' +
      'the SQL to only what has not been applied (see 0020_follow_events_claim).',
    output
  );
}

console.log(
  `✓ Schema and snapshots agree: drizzle-kit read ${tablesRead} tables and has nothing to emit.`
);
