import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SqlExecutor } from '../database';
import { findSchemaInvariantViolations } from '../assert/schemaInvariants';

const OPTIONS = { minimumTables: 27, minimumColumns: 356 };

const HEALTHY_TABLES = Array.from({ length: 30 }, (_, i) => ({ table_name: `t_${i}` }));
const HEALTHY_COLUMNS = Array.from({ length: 400 }, (_, i) => ({
  table_name: 't_0',
  column_name: `c_${i}`,
}));

/**
 * One predicate per query `findSchemaInvariantViolations` issues, each
 * keyed to the ONE clause unique to that query — not a bare substring like
 * `'information_schema.columns'`, which every one of the four
 * columns-based queries below contains. A generic substring match answers
 * more than one query at once: the unfiltered "every column" query would
 * also serve as the canned answer for the timestamp/default/mongoose
 * checks, so their "no violations" fixtures would instead hand back 400
 * rows shaped like ordinary columns and get reported as 400 violations —
 * breaking the "healthy schema" case outright, not passing it vacuously.
 * Each predicate here tests for the one fragment that appears in exactly
 * one of the six queries and none of the others (verified by inspection of
 * the literal query text in `schemaInvariants.ts`).
 */
const MATCHERS = {
  tables: (text: string) => text.includes('order by table_name'),
  allColumns: (text: string) => text.trimEnd().endsWith("table_schema = 'public'"),
  timestamp: (text: string) => text.includes('timestamp without time zone'),
  emptyDefault: (text: string) => text.includes('column_default ~'),
  missingPrimaryKey: (text: string) => text.includes('not exists'),
  mongooseArtifact: (text: string) => text.includes("'__v'"),
} as const;

type CheckName = keyof typeof MATCHERS;

/**
 * Answers each catalogue query dispatched against a fake schema, rendering
 * the query through drizzle's own `PgDialect#sqlToQuery` — the same
 * renderer `expiry.test.ts` uses to assert on rendered SQL — rather than
 * `String(chunk)` on the raw `queryChunks`: every chunk of a `sql` template
 * literal is a `StringChunk` wrapper object with no `toString` override, so
 * `String(chunk)` on it is always the literal string `"[object Object]"`
 * and never matches anything. Verified directly against a real `sql`
 * template before writing this fake; a version built on `String(chunk)`
 * would make EVERY query below return `[]`, and the "healthy schema" case
 * would then fail on the vacuity floor instead of passing.
 *
 * Throws when no matcher answers a query, rather than defaulting to `[]`:
 * a silent `[]` is exactly the vacuous pass this suite exists to catch, so
 * a fixture gap here must fail loudly, not read as "no violations found".
 */
function catalogue(overrides: Partial<Record<CheckName, readonly unknown[]>> = {}): SqlExecutor {
  const dialect = new PgDialect();
  const rows: Record<CheckName, readonly unknown[]> = {
    tables: HEALTHY_TABLES,
    allColumns: HEALTHY_COLUMNS,
    timestamp: [],
    emptyDefault: [],
    missingPrimaryKey: [],
    mongooseArtifact: [],
    ...overrides,
  };

  return {
    execute: async (query: SQL): Promise<Record<string, unknown>[]> => {
      const text = dialect.sqlToQuery(query).sql;
      const name = (Object.keys(MATCHERS) as CheckName[]).find((key) => MATCHERS[key](text));
      if (!name) {
        throw new Error(`catalogue fixture has no matcher for query: ${text}`);
      }
      return rows[name] as Record<string, unknown>[];
    },
  };
}

describe('findSchemaInvariantViolations', () => {
  it('returns nothing for a healthy schema', async () => {
    const violations = await findSchemaInvariantViolations(catalogue(), OPTIONS);
    expect(violations).toEqual([]);
  });

  it('reports a vacuity violation when the traversal finds too few tables', async () => {
    const violations = await findSchemaInvariantViolations(
      catalogue({ tables: [{ table_name: 'only_one' }] }),
      OPTIONS
    );
    expect(violations).toEqual([
      { check: 'vacuity', subject: 'tables', detail: 'found 1, expected at least 27' },
    ]);
  });

  it('reports a vacuity violation when the traversal finds too few columns', async () => {
    const violations = await findSchemaInvariantViolations(
      catalogue({ allColumns: [{ table_name: 't_0', column_name: 'c_0' }] }),
      OPTIONS
    );
    expect(violations).toEqual([
      { check: 'vacuity', subject: 'columns', detail: 'found 1, expected at least 356' },
    ]);
  });

  it('reports a table name that is not snake_case', async () => {
    const violations = await findSchemaInvariantViolations(
      catalogue({ tables: [...HEALTHY_TABLES, { table_name: 'CamelCase' }] }),
      OPTIONS
    );
    expect(violations).toEqual([{ check: 'snake_case_table', subject: 'CamelCase' }]);
  });

  it('reports a column name that is not snake_case', async () => {
    const violations = await findSchemaInvariantViolations(
      catalogue({
        allColumns: [...HEALTHY_COLUMNS, { table_name: 't_0', column_name: 'camelCase' }],
      }),
      OPTIONS
    );
    expect(violations).toEqual([{ check: 'snake_case_column', subject: 't_0.camelCase' }]);
  });

  it('reports a timestamp column stored without a time zone', async () => {
    const violations = await findSchemaInvariantViolations(
      catalogue({ timestamp: [{ table_name: 'posts', column_name: 'created_at' }] }),
      OPTIONS
    );
    expect(violations).toEqual([
      { check: 'timestamp_without_time_zone', subject: 'posts.created_at' },
    ]);
  });

  it('reports a column defaulted to the empty string', async () => {
    const violations = await findSchemaInvariantViolations(
      catalogue({
        emptyDefault: [{ table_name: 'posts', column_name: 'slug', column_default: "''::text" }],
      }),
      OPTIONS
    );
    expect(violations).toEqual([
      { check: 'empty_string_default', subject: 'posts.slug', detail: "''::text" },
    ]);
  });

  it('reports a table with no primary key', async () => {
    const violations = await findSchemaInvariantViolations(
      catalogue({ missingPrimaryKey: [{ table_name: 'posts' }] }),
      OPTIONS
    );
    expect(violations).toEqual([{ check: 'missing_primary_key', subject: 'posts' }]);
  });

  it('names the offending table and column, not just the rule', async () => {
    const violations = await findSchemaInvariantViolations(
      catalogue({ mongooseArtifact: [{ table_name: 'posts', column_name: '_id' }] }),
      OPTIONS
    );
    expect(violations).toContainEqual(
      expect.objectContaining({ check: 'mongoose_artifact', subject: 'posts._id' })
    );
  });

  // The six mandated checks above each break ONE fixture entry in isolation,
  // so an implementation that only ever reports the FIRST violation it finds
  // (returns early, or overwrites a single-slot result instead of pushing to
  // an array) would still pass every one of them. This drives three
  // unrelated checks at once and asserts on the exact set, so a short-circuit
  // regression shows up as a missing entry rather than an unrelated green.
  it('collects violations from every check at once, not just the first one found', async () => {
    const violations = await findSchemaInvariantViolations(
      catalogue({
        tables: [...HEALTHY_TABLES, { table_name: 'BadTable' }],
        missingPrimaryKey: [{ table_name: 'posts' }],
        mongooseArtifact: [{ table_name: 'posts', column_name: '__v' }],
      }),
      OPTIONS
    );
    expect(violations).toEqual(
      expect.arrayContaining([
        { check: 'snake_case_table', subject: 'BadTable' },
        { check: 'missing_primary_key', subject: 'posts' },
        { check: 'mongoose_artifact', subject: 'posts.__v' },
      ])
    );
    expect(violations).toHaveLength(3);
  });
});
