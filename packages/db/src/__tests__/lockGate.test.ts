import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkMigrationLocks } from '../migrate/lockGate';

describe('checkMigrationLocks', () => {
  it('checks only migrations after the baseline, treats every table as hot by default, and honours the waiver', () => {
    const folder = mkdtempSync(join(tmpdir(), 'oxydb-lockgate-'));
    try {
      mkdirSync(join(folder, 'meta'), { recursive: true });
      const backfillBesideDdl =
        'ALTER TABLE "orders" DROP CONSTRAINT "orders_status_check";--> statement-breakpoint\n' +
        'UPDATE "orders" SET "status" = \'open\';\n';
      const migrations: Record<string, string> = {
        '0000_old': backfillBesideDdl,
        '0001_incident': backfillBesideDdl,
        '0002_validated_fk':
          'ALTER TABLE "orders" ADD CONSTRAINT "o_fk" FOREIGN KEY ("a") REFERENCES "public"."users"("id");\n',
        '0003_reviewed': `-- oxy:lock-review=empty in every environment\n${backfillBesideDdl}`,
        '0004_clean':
          'CREATE TABLE "t" ("id" text);--> statement-breakpoint\n' +
          'CREATE INDEX "t_idx" ON "t" ("id");\n',
      };
      for (const [tag, sql] of Object.entries(migrations)) {
        writeFileSync(join(folder, `${tag}.sql`), sql);
      }
      writeFileSync(
        join(folder, 'meta', '_journal.json'),
        JSON.stringify({ entries: Object.keys(migrations).map((tag) => ({ tag })) }),
      );

      const everyTable = checkMigrationLocks({ folder, baseline: 0 });
      expect(everyTable.checked).toBe(4);
      expect(everyTable.problems.map((problem) => problem.split(':')[0])).toEqual([
        '0001_incident',
        '0002_validated_fk',
      ]);

      // A curated hot list leaves DDL on other tables alone; a validated FK is
      // still a problem on any existing table.
      const curated = checkMigrationLocks({ folder, baseline: 0, hotTables: new Set(['users']) });
      expect(curated.problems.map((problem) => problem.split(':')[0])).toEqual([
        '0002_validated_fk',
      ]);
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  });
});
