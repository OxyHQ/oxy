import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkMigrationLocks } from '../migrate/lockGate';

const INCIDENT =
  'ALTER TABLE "applications" DROP CONSTRAINT "applications_scopes_check";--> statement-breakpoint\n' +
  'UPDATE "files" SET "trashed_at" = "updated_at";\n';

describe('checkMigrationLocks', () => {
  it('flags hot-table DDL beside a backfill and a validated FK, honours the baseline and the waiver', () => {
    const folder = mkdtempSync(join(tmpdir(), 'oxydb-lockgate-'));
    try {
      mkdirSync(join(folder, 'meta'), { recursive: true });
      const files: Record<string, string> = {
        '0000_old': INCIDENT,
        '0001_incident': INCIDENT,
        '0002_fk':
          'ALTER TABLE "files" ADD CONSTRAINT "x_fk" FOREIGN KEY ("a") REFERENCES "public"."applications"("id");\n',
        '0003_waived': `-- oxy:lock-review=empty table everywhere\n${INCIDENT}`,
        '0004_clean':
          'CREATE TABLE "t" ("id" text);--> statement-breakpoint\n' +
          'ALTER TABLE "files" ADD CONSTRAINT "y_fk" FOREIGN KEY ("a") REFERENCES "public"."t"("id") NOT VALID;\n',
      };
      for (const [tag, sql] of Object.entries(files)) {
        writeFileSync(join(folder, `${tag}.sql`), `-- oxy:deploy-phase=pre\n${sql}`);
      }
      writeFileSync(
        join(folder, 'meta', '_journal.json'),
        JSON.stringify({ entries: Object.keys(files).map((tag) => ({ tag })) }),
      );

      const result = checkMigrationLocks({
        migrationsFolder: folder,
        after: 0,
        hotTables: ['applications'],
      });
      expect(result.checked).toBe(4);
      expect(result.problems.map((problem) => problem.split(':')[0])).toEqual([
        '0001_incident',
        '0002_fk',
      ]);
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  });
});
