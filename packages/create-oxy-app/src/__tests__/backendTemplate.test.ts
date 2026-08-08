import { describe, expect, test } from 'bun:test';
// `existsSync` from `node:fs`, not `fs.exists` from `node:fs/promises` — the
// latter is a Bun extension rather than standard Node, so it type-errors and
// would break the moment this suite ran under anything but bun.
import { existsSync, promises as fs } from 'node:fs';
import path from 'node:path';
import { buildRenderContext, deriveDefaults } from '../context';
import { renderString } from '../render';
import { VERSIONS } from '../versions';

/**
 * Guards on the generated backend's Postgres layer.
 *
 * Everything here fails at a point where it is cheap to notice. The
 * alternatives all fail late and quietly: a missing deploy-phase marker only
 * surfaces when someone runs a migration, an unknown `{{v.…}}` token only when
 * someone scaffolds an app, and a journal tag that names a file nobody shipped
 * only inside a container.
 */

const TEMPLATES = path.join(__dirname, '..', '..', 'templates');
const BACKEND = path.join(TEMPLATES, 'backend');
const BACKEND_PKG = path.join(BACKEND, 'packages', 'backend');
const DRIZZLE = path.join(BACKEND_PKG, 'drizzle');

/** Every file under `dir`, recursively, as absolute paths. */
async function filesUnder(dir: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...(await filesUnder(full)));
      continue;
    }
    found.push(full);
  }
  return found;
}

interface Journal {
  entries: { idx: number; tag: string }[];
}

async function readJournal(): Promise<Journal> {
  return JSON.parse(await fs.readFile(path.join(DRIZZLE, 'meta', '_journal.json'), 'utf8')) as Journal;
}

describe('backend template — no Mongo residue', () => {
  test('nothing under templates/backend mentions mongo or MONGODB_URI', async () => {
    const files = await filesUnder(BACKEND);
    // Vacuity floor: a broken traversal would find nothing and pass by
    // examining nothing. The template has well over this many files.
    expect(files.length).toBeGreaterThanOrEqual(10);

    const offenders: string[] = [];
    for (const file of files) {
      const content = await fs.readFile(file, 'utf8');
      // Report the FULL matching line, not a capture group — truncated evidence
      // is how a scanner stops being readable and then gets trusted anyway.
      for (const [index, line] of content.split('\n').entries()) {
        if (/mongo/i.test(line)) {
          offenders.push(`${path.relative(BACKEND, file)}:${index + 1}: ${line.trim()}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  test('the Mongoose connector is gone and the Postgres one replaces it', () => {
    expect(existsSync(path.join(BACKEND_PKG, 'src', 'config', 'database.ts'))).toBe(false);
    expect(existsSync(path.join(BACKEND_PKG, 'src', 'db', 'postgres.ts'))).toBe(true);
    expect(existsSync(path.join(BACKEND_PKG, 'src', 'db', 'migrate.ts'))).toBe(true);
    expect(existsSync(path.join(BACKEND_PKG, 'src', 'db', 'migrationsFolder.ts'))).toBe(true);
    expect(existsSync(path.join(BACKEND_PKG, 'drizzle.config.ts'))).toBe(true);
    expect(existsSync(path.join(BACKEND, 'docker-compose.postgres.yml'))).toBe(true);
  });
});

describe('backend template — drizzle migrations', () => {
  test('every migration declares exactly one deploy phase', async () => {
    const journal = await readJournal();
    // Vacuity floor: an empty journal would make the loop below examine nothing.
    expect(journal.entries.length).toBeGreaterThanOrEqual(1);

    // Collected rather than asserted in the loop, so one run names EVERY
    // offending migration instead of stopping at the first.
    const problems: string[] = [];

    for (const entry of journal.entries) {
      const sql = await fs.readFile(path.join(DRIZZLE, `${entry.tag}.sql`), 'utf8');
      // The value is captured loosely and validated after, deliberately:
      // matching `(pre|post)` in the regex would make `=later` indistinguishable
      // from no marker at all, and "you wrote a phase I do not recognise" is a
      // far more useful failure than "you wrote no phase".
      const markers = sql
        .split('\n')
        .map((line) => /^-- oxy:deploy-phase=(.*)$/.exec(line.replace(/\r$/, '')))
        .filter((match): match is RegExpExecArray => match !== null)
        .map((match) => match[1]);

      if (markers.length !== 1) {
        problems.push(`${entry.tag}: expected exactly one marker, found ${markers.length}`);
        continue;
      }
      if (markers[0] !== 'pre' && markers[0] !== 'post') {
        problems.push(`${entry.tag}: unrecognised deploy phase "${markers[0]}"`);
      }
    }

    expect(problems).toEqual([]);
  });

  test('every journal entry has its .sql file, and no .sql file is orphaned', async () => {
    const journal = await readJournal();
    const tags = journal.entries.map((entry) => entry.tag).sort();

    const onDisk = (await fs.readdir(DRIZZLE))
      .filter((name) => name.endsWith('.sql'))
      .map((name) => name.slice(0, -'.sql'.length))
      .sort();

    // Both directions. A journal entry with no file makes the migrator fail on a
    // database it has already started changing; a file with no entry never runs
    // at all, which is the silent half.
    expect(onDisk).toEqual(tags);
  });
});

describe('backend template — version tokens', () => {
  test('every {{v.*}} token used by any template exists in VERSIONS', async () => {
    const files = await filesUnder(TEMPLATES);
    expect(files.length).toBeGreaterThanOrEqual(30);

    const used = new Set<string>();
    for (const file of files) {
      const content = await fs.readFile(file, 'utf8');
      for (const match of content.matchAll(/\{\{\s*v\.([A-Za-z0-9_]+)\s*\}\}/g)) {
        used.add(match[1]);
      }
    }

    // Vacuity floor: zero tokens found would pass the subset check trivially.
    expect(used.size).toBeGreaterThanOrEqual(20);

    const known = new Set(Object.keys(VERSIONS));
    expect([...used].filter((key) => !known.has(key)).sort()).toEqual([]);
  });

  test('the backend manifest pins the Postgres stack and no longer pins mongoose', async () => {
    const raw = await fs.readFile(path.join(BACKEND_PKG, 'package.json.tpl'), 'utf8');
    const config = { ...deriveDefaults('Demo App'), name: 'Demo App', targetDir: '.', backend: true, deploy: true, demo: true, install: false, git: false, register: false };
    const manifest = JSON.parse(renderString(raw, buildRenderContext(config), 'package.json.tpl')) as {
      dependencies: Record<string, string>;
      devDependencies: Record<string, string>;
      scripts: Record<string, string>;
    };

    expect(manifest.dependencies).toMatchObject({
      '@oxyhq/db': VERSIONS.oxyDb,
      'drizzle-orm': VERSIONS.drizzleOrm,
      postgres: VERSIONS.postgres,
    });
    expect(manifest.dependencies.mongoose).toBeUndefined();
    expect(manifest.devDependencies['drizzle-kit']).toBe(VERSIONS.drizzleKit);
    expect(manifest.scripts['db:generate']).toBeDefined();
    expect(manifest.scripts['db:migrate']).toBeDefined();
  });
});
