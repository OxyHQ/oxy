import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SQL } from 'drizzle-orm';
import { PgDialect, pgTable, text } from 'drizzle-orm/pg-core';
import {
  findIdColumnViolations,
  findImplicitWholeRowReads,
  findUnsupportedExpiryColumns,
  publicColumns,
} from '../assert';
import type { SqlExecutor } from '../database';

const users = pgTable('users', { id: text().primaryKey(), phone: text() });
const posts = pgTable('posts', { id: text().primaryKey(), authorId: text() });
const tables = [users, posts];

describe('findIdColumnViolations', () => {
  it('reports an id-shaped column that is classified nowhere', () => {
    const violations = findIdColumnViolations({
      tables,
      deferred: [],
      withoutForeignKey: [],
      minimumTables: 2,
    });
    expect(violations).toContainEqual(
      expect.objectContaining({ check: 'unclassified_id_column', subject: 'posts.author_id' })
    );
  });

  it('accepts a column declared as never carrying a constraint', () => {
    const violations = findIdColumnViolations({
      tables,
      deferred: [],
      withoutForeignKey: [{ column: 'posts.author_id', reason: 'cross-service id' }],
      minimumTables: 2,
    });
    expect(violations).toEqual([]);
  });

  it('demands a real FK once the parent table is present', () => {
    const violations = findIdColumnViolations({
      tables,
      deferred: [
        {
          table: posts,
          column: posts.authorId,
          parentTable: 'users',
          parentColumn: 'id',
          onDelete: 'cascade',
          reason: 'users landed later',
        },
      ],
      withoutForeignKey: [],
      minimumTables: 2,
    });
    expect(violations).toContainEqual(
      expect.objectContaining({ check: 'deferred_foreign_key_now_owed' })
    );
  });

  it('reports vacuity rather than passing on a broken traversal', () => {
    const violations = findIdColumnViolations({
      tables: [],
      deferred: [],
      withoutForeignKey: [],
      minimumTables: 2,
    });
    expect(violations.map((v) => v.check)).toContain('vacuity');
  });

  // Beyond the brief's mandated four: the two remaining checks the source
  // test file (`foreignKeys.test.ts`) also asserted — "states an ON DELETE
  // and a reason for every deferred foreign key" and "does not carry a
  // stale ledger entry" — ported as part of converting the source rather
  // than only the illustrative subset above.
  it('reports a deferred foreign key with a blank reason or parent column', () => {
    const violations = findIdColumnViolations({
      tables,
      deferred: [
        {
          table: posts,
          column: posts.authorId,
          // Not present in `tables`, so this is isolated from the
          // "now owed" check above and only exercises the completeness one.
          parentTable: 'applications',
          parentColumn: '',
          onDelete: 'restrict',
          reason: '',
        },
      ],
      withoutForeignKey: [],
      minimumTables: 2,
    });
    expect(violations).toContainEqual(
      expect.objectContaining({
        check: 'incomplete_deferred_foreign_key',
        subject: 'posts.author_id',
      })
    );
  });

  it('reports a ledger entry naming a column that no longer exists', () => {
    const violations = findIdColumnViolations({
      tables,
      deferred: [],
      withoutForeignKey: [{ column: 'posts.deleted_column_id', reason: 'stale' }],
      minimumTables: 2,
    });
    expect(violations).toContainEqual(
      expect.objectContaining({ check: 'stale_ledger_entry', subject: 'posts.deleted_column_id' })
    );
  });
});

describe('publicColumns', () => {
  it('omits every registered column', () => {
    const selected = publicColumns(users, { users: ['phone'] });
    expect(Object.keys(selected)).toEqual(['id']);
  });

  it('returns every column for a table with no entry', () => {
    expect(Object.keys(publicColumns(posts, { users: ['phone'] }))).toEqual(['id', 'authorId']);
  });
});

describe('findImplicitWholeRowReads', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'oxydb-implicit-read-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const registry = { users: ['phone'], auth_sessions: ['sessionToken'] };

  it('reports a bare select() against a registered table, with file:line', async () => {
    writeFileSync(join(dir, 'repo.ts'), 'export const rows = db.select().from(users);\n');

    const violations = await findImplicitWholeRowReads({ sourceDir: dir, registry });

    expect(violations).toContainEqual(
      expect.objectContaining({ check: 'implicit_select_all', subject: 'repo.ts:1' })
    );
  });

  it('does not report a named select against the same table', async () => {
    writeFileSync(
      join(dir, 'repo.ts'),
      'export const rows = db.select({ id: users.id }).from(users);\n'
    );

    const violations = await findImplicitWholeRowReads({ sourceDir: dir, registry });

    expect(violations).toEqual([]);
  });

  it('reports the relational query API against a registered table', async () => {
    writeFileSync(join(dir, 'repo.ts'), 'const row = await db.query.users.findFirst();\n');

    const violations = await findImplicitWholeRowReads({ sourceDir: dir, registry });

    expect(violations).toContainEqual(
      expect.objectContaining({ check: 'implicit_relational_query', subject: 'repo.ts:1' })
    );
  });

  // The regression this case guards: the registry is keyed by SQL table
  // name (`auth_sessions`), but call sites reference the table by its
  // TypeScript identifier (`authSessions`). A scanner built only from the
  // literal registry key never matches this and silently misses every
  // multi-word table.
  it('matches the camelCase call-site identifier for a multi-word table name', async () => {
    writeFileSync(join(dir, 'repo.ts'), 'export const rows = db.select().from(authSessions);\n');

    const violations = await findImplicitWholeRowReads({ sourceDir: dir, registry });

    expect(violations).toContainEqual(
      expect.objectContaining({ check: 'implicit_select_all', subject: 'repo.ts:1' })
    );
  });

  it('ignores a bare select() that only appears inside a comment', async () => {
    writeFileSync(
      join(dir, 'repo.ts'),
      '// db.select().from(users) is exactly what this rule forbids\nexport const x = 1;\n'
    );

    const violations = await findImplicitWholeRowReads({ sourceDir: dir, registry });

    expect(violations).toEqual([]);
  });

  it('does not scan a __tests__ directory', async () => {
    // A clean file OUTSIDE `__tests__` too, so this case cannot pass simply
    // because the traversal found nothing at all (that would be caught by
    // the vacuity case below, not this one).
    writeFileSync(join(dir, 'clean.ts'), 'export const x = 1;\n');
    const testsDir = join(dir, '__tests__');
    mkdirSync(testsDir);
    // Named `helpers.ts`, NOT `*.test.ts`: a violation inside a file that
    // does not itself end in `.test.ts` isolates the DIRECTORY-level
    // exclusion from the separate filename-based one. A first version of
    // this test used `repo.test.ts` here, which meant the filename filter
    // alone hid the violation regardless of whether `__tests__` itself was
    // excluded — confirmed by mutation: removing the `__tests__` branch
    // from `sourceFiles` left that version green, 18 of 18, because nothing
    // in the fixture depended on the directory check specifically.
    writeFileSync(join(testsDir, 'helpers.ts'), 'db.select().from(users);\n');

    const violations = await findImplicitWholeRowReads({ sourceDir: dir, registry });

    expect(violations).toEqual([]);
  });

  it('reports vacuity rather than passing on an empty tree', async () => {
    const violations = await findImplicitWholeRowReads({ sourceDir: dir, registry });

    expect(violations).toEqual([
      { check: 'vacuity', subject: 'files', detail: `found 0 .ts source files under ${dir}` },
    ]);
  });
});

describe('findUnsupportedExpiryColumns', () => {
  /**
   * Dispatches the ONE query this module issues, rendered through drizzle's
   * own `PgDialect#sqlToQuery` (never `String(chunk)` on a raw `sql`
   * template chunk -- every chunk is a `StringChunk` wrapper with no
   * `toString` override, so that always renders `"[object Object]"` and
   * matches nothing, which would make every case below pass vacuously
   * rather than for the right reason).
   *
   * Throwing on an unrecognised query, rather than defaulting to `[]`, is
   * what makes this fixture trustworthy: a silent `[]` is exactly the
   * vacuous pass a mutated or misdirected query would otherwise hide.
   */
  function catalogue(indexedRows: readonly { table_name: string; column_name: string }[]): SqlExecutor {
    const dialect = new PgDialect();
    return {
      execute: async (query: SQL): Promise<Record<string, unknown>[]> => {
        const renderedText = dialect.sqlToQuery(query).sql;
        if (!renderedText.includes("amname = 'btree'")) {
          throw new Error(`expiry-index fixture has no matcher for query: ${renderedText}`);
        }
        return indexedRows as unknown as Record<string, unknown>[];
      },
    };
  }

  it('reports a swept column with no supporting btree index', async () => {
    const violations = await findUnsupportedExpiryColumns(catalogue([]), [
      { table: posts, column: posts.id, retentionSeconds: 60, reason: 'fixture' },
    ]);
    expect(violations).toContainEqual(
      expect.objectContaining({ check: 'expiry_column_without_index', subject: 'posts.id' })
    );
  });

  // The brief's own mandated test above drives a fake that returns `[]` for
  // any query at all, which cannot distinguish a correct implementation
  // from one that never queries the catalogue in the first place. This case
  // and the "reports nothing" one below add the other half: a genuinely
  // indexed column must NOT be reported, which only holds if the
  // post-processing actually reads the fixture's rows rather than reporting
  // every target unconditionally.
  it('reports nothing when the swept column already has a supporting btree index', async () => {
    const violations = await findUnsupportedExpiryColumns(
      catalogue([{ table_name: 'posts', column_name: 'id' }]),
      [{ table: posts, column: posts.id, retentionSeconds: 60, reason: 'fixture' }]
    );
    expect(violations).toEqual([]);
  });

  it('reports only the targets that are actually unindexed, not the whole list', async () => {
    const violations = await findUnsupportedExpiryColumns(
      catalogue([{ table_name: 'users', column_name: 'id' }]),
      [
        { table: users, column: users.id, retentionSeconds: 60, reason: 'fixture: indexed' },
        { table: posts, column: posts.id, retentionSeconds: 60, reason: 'fixture: unindexed' },
      ]
    );
    expect(violations).toEqual([
      { check: 'expiry_column_without_index', subject: 'posts.id' },
    ]);
  });
});
