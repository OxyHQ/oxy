#!/usr/bin/env bun
/**
 * Runs check-migration-locks.mjs against a copy of the REAL migrations with one
 * appended migration per case: the 2026-10-16 shape (hot-table DDL beside a
 * backfill) must go red and name the migration, a validated foreign key on an
 * existing table must go red, and the same file carrying a lock-review waiver
 * must go green. Inbox's `messages` and `mailboxes` are hot tables too: DDL on
 * one beside a backfill, and an index on `messages` that cannot be built
 * CONCURRENTLY out of band first, must go red. Offline; fixtures live under the
 * OS temp dir.
 */

import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DRIZZLE = join('packages', 'api', 'drizzle');
const failures = [];

function runCase(name, sql, expectRed) {
  const root = mkdtempSync(join(tmpdir(), 'oxy-migration-locks-'));
  try {
    cpSync(join(repoRoot, DRIZZLE), join(root, DRIZZLE), { recursive: true });
    cpSync(join(repoRoot, 'scripts'), join(root, 'scripts'), { recursive: true });
    cpSync(join(repoRoot, 'packages', 'db', 'src'), join(root, 'packages', 'db', 'src'), {
      recursive: true,
    });
    const journalPath = join(root, DRIZZLE, 'meta', '_journal.json');
    const journal = JSON.parse(readFileSync(journalPath, 'utf8'));
    const last = journal.entries[journal.entries.length - 1];
    const tag = '9999_fixture';
    journal.entries.push({ ...last, idx: last.idx + 1, when: last.when + 1, tag });
    writeFileSync(journalPath, JSON.stringify(journal));
    writeFileSync(join(root, DRIZZLE, `${tag}.sql`), `-- oxy:deploy-phase=pre\n${sql}`);

    const result = spawnSync('bun', [join('scripts', 'check-migration-locks.mjs')], {
      cwd: root,
      encoding: 'utf8',
    });
    const red = result.status !== 0;
    if (red !== expectRed || (expectRed && !result.stderr.includes(tag))) {
      failures.push(
        `${name}: expected ${expectRed ? 'red naming 9999_fixture' : 'green'}, got exit ${result.status}\n${result.stdout}${result.stderr}`,
      );
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const incident =
  'ALTER TABLE "applications" DROP CONSTRAINT "applications_scopes_check";--> statement-breakpoint\n' +
  'UPDATE "files" SET "trashed_at" = "updated_at" WHERE "status" = \'trash\';\n';

runCase('the 0170-0172 shape', incident, true);
runCase(
  'validated foreign key on an existing table',
  'ALTER TABLE "files" ADD CONSTRAINT "x_fk" FOREIGN KEY ("a") REFERENCES "public"."applications"("id");\n',
  true,
);
runCase(
  'reviewed exception',
  `-- oxy:lock-review=empty table in every environment\n${incident}`,
  false,
);
runCase(
  'NOT VALID foreign key, new table',
  'CREATE TABLE "t" ("id" text);--> statement-breakpoint\n' +
    'ALTER TABLE "files" ADD CONSTRAINT "x_fk" FOREIGN KEY ("a") REFERENCES "public"."applications"("id") NOT VALID;\n',
  false,
);

runCase(
  'messages DDL beside a backfill',
  'ALTER TABLE "messages" ADD COLUMN "thread_id" text;--> statement-breakpoint\n' +
    'UPDATE "messages" SET "thread_id" = "id";\n',
  true,
);
runCase(
  'mailboxes DDL beside a backfill',
  'ALTER TABLE "mailboxes" ADD COLUMN "total_messages" integer;--> statement-breakpoint\n' +
    'UPDATE "mailboxes" SET "total_messages" = 0;\n',
  true,
);
runCase(
  'messages index without IF NOT EXISTS',
  'CREATE INDEX "messages_x_idx" ON "messages" USING btree ("user_id");\n',
  true,
);
runCase(
  'messages index guarded for an out-of-band build',
  'CREATE INDEX IF NOT EXISTS "messages_x_idx" ON "messages" USING btree ("user_id");\n',
  false,
);

if (failures.length > 0) {
  console.error(failures.join('\n\n'));
  process.exit(1);
}
console.log('check-migration-locks fixture tests passed (8 cases).');
