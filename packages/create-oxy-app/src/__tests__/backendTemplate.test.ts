/**
 * Fast tripwires on the backend template's PostgreSQL pieces.
 *
 * These read the template files off disk and render them the way the CLI does,
 * so a token typo or a deleted file fails here in milliseconds. They are not the
 * real gate — `scaffold-smoke.yml` scaffolds from the packed tarball, installs
 * it, and applies migration 0000 to a real Postgres server, which is the only
 * thing that can prove the generated app actually works. What these add is a
 * failure that names the file, before that job spends ten minutes finding out.
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { renderString, type RenderContext } from '../render';
import { BUN_VERSION, VERSIONS } from '../versions';

const BACKEND_TEMPLATE = path.join(__dirname, '..', '..', 'templates', 'backend');

const ctx: RenderContext = {
  tokens: {
    APP_NAME: 'My App',
    APP_SLUG: 'my-app',
    APP_SCHEME: 'myapp',
    BUNDLE_ID: 'com.example.myapp',
    API_DOMAIN: 'api.example.com',
    BUN_VERSION,
    ...Object.fromEntries(Object.entries(VERSIONS).map(([key, value]) => [`v.${key}`, value])),
  },
  flags: { backend: true, deploy: true, demo: true },
};

/** Reads a backend-template file and renders it exactly as the CLI would. */
function render(...segments: string[]): string {
  const file = path.join(BACKEND_TEMPLATE, ...segments);
  return renderString(readFileSync(file, 'utf8'), ctx, segments.join('/'));
}

describe('backend package.json', () => {
  const manifest = JSON.parse(render('packages', 'backend', 'package.json.tpl')) as {
    scripts: Record<string, string>;
    dependencies: Record<string, string>;
    devDependencies: Record<string, string>;
  };

  test('depends on the Postgres stack and not on mongoose', () => {
    expect(Object.keys(manifest.dependencies)).toContain('@oxyhq/db');
    expect(Object.keys(manifest.dependencies)).toContain('drizzle-orm');
    expect(Object.keys(manifest.dependencies)).toContain('postgres');
    expect(Object.keys(manifest.dependencies)).not.toContain('mongoose');
  });

  test('drizzle-kit is a devDependency — it generates migrations, never applies them', () => {
    // The production image installs dependencies only, so a template that put
    // drizzle-kit in `dependencies` would suggest `drizzle-kit migrate` is a
    // deploy-time option. It is not: `db:migrate` runs drizzle-orm's own
    // migrator, which is a runtime dependency and compiles into the image.
    expect(Object.keys(manifest.devDependencies)).toContain('drizzle-kit');
    expect(Object.keys(manifest.dependencies)).not.toContain('drizzle-kit');
  });

  test('drizzle-orm and postgres are pinned exactly, matching @oxyhq/db peers', () => {
    expect(manifest.dependencies['drizzle-orm']).toMatch(/^\d+\.\d+\.\d+$/);
    expect(manifest.dependencies.postgres).toMatch(/^\d+\.\d+\.\d+$/);
  });

  test('ships the db:generate / db:migrate scripts', () => {
    expect(manifest.scripts['db:generate']).toBe('drizzle-kit generate');
    expect(manifest.scripts['db:migrate']).toBe('bun run src/db/migrate.ts');
  });
});

describe('generated .env.example', () => {
  const env = render('packages', 'backend', 'DOT_env.example');

  test('carries DATABASE_URL and no MONGODB_URI', () => {
    expect(env).toContain('DATABASE_URL=postgres://');
    expect(env).not.toContain('MONGODB_URI');
  });

  test('its DATABASE_URL matches the port and database docker-compose creates', () => {
    // These two files are edited by different people at different times, and a
    // mismatch does not fail loudly — it produces "database does not exist" or a
    // connection refused, hours after the change that caused it.
    const compose = render('docker-compose.postgres.yml');
    const url = /DATABASE_URL=(\S+)/.exec(env)?.[1];
    expect(url).toBeDefined();
    const { port, pathname } = new URL(url as string);
    expect(compose).toContain(`127.0.0.1:${port}:5432`);
    expect(compose).toContain(`POSTGRES_DB: ${pathname.slice(1)}`);
  });
});

describe('docker-compose.postgres.yml', () => {
  const compose = render('docker-compose.postgres.yml');

  test('pins a Postgres major rather than floating', () => {
    expect(compose).toMatch(/image: postgres:\d+-alpine/);
  });

  test('does not bind 5432 — an Oxy machine already has databases there', () => {
    expect(compose).not.toContain('127.0.0.1:5432:5432');
  });
});

describe('shipped migration 0000', () => {
  const migrationsDir = path.join(BACKEND_TEMPLATE, 'packages', 'backend', 'drizzle');
  const journal = JSON.parse(
    readFileSync(path.join(migrationsDir, 'meta', '_journal.json'), 'utf8'),
  ) as { entries: { tag: string }[] };

  test('the journal holds exactly the one migration the scaffold ships', () => {
    expect(journal.entries).toHaveLength(1);
  });

  test('every journal tag has its .sql and the schema snapshot beside it', () => {
    // A tag with no `<tag>.sql` is not a silent omission — `readJournal` throws
    // at server start, so this renaming mistake takes the app down rather than
    // skipping a migration. The snapshot is what stops the next `db:generate`
    // from re-emitting a migration for a table that already exists.
    for (const [index, entry] of journal.entries.entries()) {
      expect(readFileSync(path.join(migrationsDir, `${entry.tag}.sql`), 'utf8').length).toBeGreaterThan(0);
      const snapshot = path.join(migrationsDir, 'meta', `${String(index).padStart(4, '0')}_snapshot.json`);
      expect(readFileSync(snapshot, 'utf8').length).toBeGreaterThan(0);
    }
  });

  test('every migration declares exactly one deploy phase', () => {
    // `db:migrate` refuses an unmarked migration before running any DDL, so a
    // scaffold shipping one would be dead on arrival. The authority is
    // @oxyhq/db's `readMigrationPhases`, which this package does not depend on;
    // the spelling below is that module's, and CI proves the real reader agrees
    // by applying this migration to a real server.
    const marker = /^-- oxy:deploy-phase=(pre|post)$/gm;
    for (const entry of journal.entries) {
      const sql = readFileSync(path.join(migrationsDir, `${entry.tag}.sql`), 'utf8');
      expect(sql.match(marker)).toHaveLength(1);
    }
  });

  test('the marker pattern rejects the near-misses it has to reject', () => {
    // Guards the assertion above from passing vacuously on a looser regex: a
    // marker with an unrecognised value, or one buried mid-line, is a hard
    // failure in the migrator and must be one here too.
    const marker = /^-- oxy:deploy-phase=(pre|post)$/m;
    expect(marker.test('-- oxy:deploy-phase=pre')).toBe(true);
    expect(marker.test('-- oxy:deploy-phase=predeploy')).toBe(false);
    expect(marker.test('-- oxy:deploy-phase=')).toBe(false);
    expect(marker.test('CREATE TABLE x; -- oxy:deploy-phase=pre')).toBe(false);
  });
});

describe('schema barrel', () => {
  test('re-exports the example table', () => {
    // drizzle-kit generates from this file and the runtime handle is built from
    // it, so a table missing here gets neither a migration nor a typed query.
    const barrel = render('packages', 'backend', 'src', 'db', 'schema', 'index.ts');
    expect(barrel).toContain("export * from './notes'");
  });

  test('the mongoose connector is gone', () => {
    expect(() => render('packages', 'backend', 'src', 'config', 'database.ts')).toThrow();
  });
});
