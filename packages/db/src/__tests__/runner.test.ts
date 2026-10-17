/**
 * What `runMigrations` can be checked on WITHOUT a live database: that the
 * filesystem preconditions (a readable journal, every pending migration
 * declaring a deploy phase) run and fail BEFORE any connection is opened.
 * Proven the same way `extensions.test.ts` proves its connection-avoidance
 * claim: point `databaseUrl` at a host `.invalid` guarantees can never resolve
 * (RFC 2606) and assert the rejection carries the filesystem check's own
 * message, not a network error.
 *
 * Everything else needs a real Postgres. `assertMigrationTarget` actually
 * comparing against a real `current_database()`, and the ledger read
 * (`readAppliedMillis`/`readLastAppliedMillis`), are now covered in
 * `liveDatabase.test.ts` against the ephemeral-database harness `testing.ts`
 * provides — whose `beforeAll` also applies a real migration through THIS
 * `runMigrations`, so `migrate()` itself succeeding is exercised there too
 * (indirectly: its `beforeAll` would throw otherwise). `ensureExtensions`
 * against a real server and a deliberately-broken post-apply
 * re-verification remain uncovered — closing every live-Postgres gap in this
 * package was not the harness task's scope, only the four functions Task 5
 * shipped with zero coverage.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runMigrations } from '../migrate/runner';

const noopLogger = { info: () => {}, debug: () => {} };

// Fixture folders created inside an `it()`, removed after it.
const createdFolders: string[] = [];

afterEach(() => {
  for (const folder of createdFolders.splice(0)) {
    rmSync(folder, { recursive: true, force: true });
  }
});

function migrationsFixture(entries: Array<{ tag: string; when: number; sql: string }>): string {
  const folder = mkdtempSync(join(tmpdir(), 'oxydb-runner-'));
  mkdirSync(join(folder, 'meta'), { recursive: true });
  writeFileSync(
    join(folder, 'meta', '_journal.json'),
    JSON.stringify({
      version: '7',
      dialect: 'postgresql',
      entries: entries.map(({ tag, when }) => ({ tag, when })),
    }),
  );
  for (const entry of entries) {
    writeFileSync(join(folder, `${entry.tag}.sql`), entry.sql);
  }
  return folder;
}

/**
 * `migrationsFixture`, plus tracking its return value for per-test cleanup.
 * Only call this from INSIDE an `it()` — a fixture meant to be shared across
 * multiple sibling tests (created at a `describe()` body's top level) must be
 * cleaned up in its own `afterAll` instead, or the file-level `afterEach`
 * deletes it after the first test that runs.
 */
function migrationsFixtureTracked(
  entries: Array<{ tag: string; when: number; sql: string }>,
): string {
  const folder = migrationsFixture(entries);
  createdFolders.push(folder);
  return folder;
}

describe('runMigrations — filesystem preconditions run before any connection is opened', () => {
  // `.invalid` is reserved by RFC 2606 to never resolve, so any of these
  // tests reaching an actual connection attempt would fail on a DNS lookup
  // rather than on the message asserted below — the two are not confusable.
  const unreachableUrl = 'postgres://unreachable.invalid/db';

  it('refuses a migrations folder whose journal cannot be read', async () => {
    await expect(
      runMigrations({
        databaseUrl: unreachableUrl,
        migrationsFolder: join(tmpdir(), 'oxydb-runner-does-not-exist'),
        extensions: [],
        run: 'all',
        expectedDatabase: 'irrelevant',
        dryRun: false,
        logger: noopLogger,
      }),
    ).rejects.toThrow(/Cannot read the migration journal/);
  });

  it('refuses a pending migration with no deploy-phase marker', async () => {
    const folder = migrationsFixtureTracked([{ tag: '0000_a', when: 1000, sql: 'select 1;\n' }]);

    await expect(
      runMigrations({
        databaseUrl: unreachableUrl,
        migrationsFolder: folder,
        extensions: [],
        run: 'all',
        expectedDatabase: 'irrelevant',
        dryRun: false,
        logger: noopLogger,
      }),
    ).rejects.toThrow(/do not declare which side of a deploy they belong on/);
  });

  it('names the offending tag, not just the count', async () => {
    const folder = migrationsFixtureTracked([
      { tag: '0000_a', when: 1000, sql: '-- oxy:deploy-phase=pre\nselect 1;\n' },
      { tag: '0001_bad', when: 2000, sql: 'select 2;\n' },
    ]);

    await expect(
      runMigrations({
        databaseUrl: unreachableUrl,
        migrationsFolder: folder,
        extensions: [],
        run: 'all',
        expectedDatabase: 'irrelevant',
        dryRun: false,
        logger: noopLogger,
      }),
    ).rejects.toThrow(/0001_bad/);
  });
});
