/**
 * Schema-wide invariants, asserted against a MIGRATED database.
 *
 * These are conventions a single table's own model or migration can violate
 * on its own without anything else noticing, so they are checked here
 * across every table at once — against the DDL that actually landed,
 * rather than the TypeScript that was meant to produce it.
 *
 * Every check carries, or shares, a vacuity floor: a broken catalogue query
 * would otherwise return zero rows and pass by examining nothing. Folding
 * that into the SAME violation list a consumer already asserts
 * `toEqual([])` against is what makes that single assertion safe — a
 * vacuity check a consumer could forget to also assert would not protect
 * anything.
 */

import { sql } from 'drizzle-orm';
import { executeRows, type SqlExecutor } from '../database';

const SNAKE_CASE = /^[a-z][a-z0-9_]*$/;

export interface InvariantViolation {
  /** Which rule was broken, e.g. 'snake_case_column' or 'vacuity'. */
  readonly check: string;
  /** What broke it: 'users.hashedEmail', or a table name, or a count. */
  readonly subject: string;
  readonly detail?: string;
}

export interface SchemaInvariantOptions {
  /** Traversal floor. Fewer tables than this is a broken query, not a clean schema. */
  readonly minimumTables: number;
  readonly minimumColumns: number;
}

// `type` aliases, not `interface`s: `executeRows<TRow extends Record<string,
// unknown>>` requires its type argument to satisfy an index signature, which
// TypeScript infers implicitly for an object type alias but never for a
// named interface (confirmed directly — an interface with the identical
// shape fails `TS2344`, "Index signature for type 'string' is missing").
type TableRow = {
  readonly table_name: string;
};

type ColumnRow = {
  readonly table_name: string;
  readonly column_name: string;
};

type ColumnDefaultRow = ColumnRow & {
  readonly column_default: string;
};

/** Application tables — drizzle's own bookkeeping lives in the `drizzle` schema. */
async function applicationTables(db: SqlExecutor): Promise<string[]> {
  const rows = await executeRows<TableRow>(
    db,
    sql`
    select table_name from information_schema.tables
    where table_schema = 'public' and table_type = 'BASE TABLE'
    order by table_name
  `
  );
  return rows.map((row) => row.table_name);
}

async function allColumns(db: SqlExecutor): Promise<ColumnRow[]> {
  return executeRows<ColumnRow>(
    db,
    sql`
      select table_name, column_name from information_schema.columns
      where table_schema = 'public'
    `
  );
}

async function timestampWithoutTimeZoneColumns(db: SqlExecutor): Promise<ColumnRow[]> {
  // `timestamp without time zone` reinterprets the value in the session's
  // TimeZone on read, silently changing what a stored instant meant.
  return executeRows<ColumnRow>(
    db,
    sql`
      select table_name, column_name from information_schema.columns
      where table_schema = 'public' and data_type = 'timestamp without time zone'
    `
  );
}

async function emptyStringDefaultColumns(db: SqlExecutor): Promise<ColumnDefaultRow[]> {
  // Some source models use `default: undefined` on a field to dodge a
  // sparse-unique-index collision on null. Postgres treats NULLs as
  // distinct, so that workaround must not travel — and it must NOT be
  // "fixed" by substituting `''`, which is a VALUE and therefore collides
  // for real.
  return executeRows<ColumnDefaultRow>(
    db,
    sql`
      select table_name, column_name, column_default
      from information_schema.columns
      where table_schema = 'public' and column_default ~ ${"^''::"}
    `
  );
}

async function tablesMissingPrimaryKey(db: SqlExecutor): Promise<string[]> {
  const rows = await executeRows<TableRow>(
    db,
    sql`
      select t.table_name
      from information_schema.tables t
      where t.table_schema = 'public' and t.table_type = 'BASE TABLE'
        and not exists (
          select 1 from information_schema.table_constraints c
          where c.table_schema = t.table_schema
            and c.table_name = t.table_name
            and c.constraint_type = 'PRIMARY KEY'
        )
    `
  );
  return rows.map((row) => row.table_name);
}

async function mongooseArtifactColumns(db: SqlExecutor): Promise<ColumnRow[]> {
  return executeRows<ColumnRow>(
    db,
    sql`
      select table_name, column_name from information_schema.columns
      where table_schema = 'public' and column_name in ('__v', '_id')
    `
  );
}

/**
 * Walk the migrated schema's catalogue and report every convention it
 * breaks. Returns an empty array for a clean schema, which is what makes a
 * single `expect(violations).toEqual([])` in a consumer's own suite the
 * whole gate.
 */
export async function findSchemaInvariantViolations(
  db: SqlExecutor,
  options: SchemaInvariantOptions
): Promise<InvariantViolation[]> {
  const violations: InvariantViolation[] = [];

  const tables = await applicationTables(db);
  if (tables.length < options.minimumTables) {
    violations.push({
      check: 'vacuity',
      subject: 'tables',
      detail: `found ${tables.length}, expected at least ${options.minimumTables}`,
    });
  }
  for (const name of tables) {
    if (!SNAKE_CASE.test(name)) {
      violations.push({ check: 'snake_case_table', subject: name });
    }
  }

  const columns = await allColumns(db);
  if (columns.length < options.minimumColumns) {
    violations.push({
      check: 'vacuity',
      subject: 'columns',
      detail: `found ${columns.length}, expected at least ${options.minimumColumns}`,
    });
  }
  for (const row of columns) {
    if (!SNAKE_CASE.test(row.column_name)) {
      violations.push({
        check: 'snake_case_column',
        subject: `${row.table_name}.${row.column_name}`,
      });
    }
  }

  for (const row of await timestampWithoutTimeZoneColumns(db)) {
    violations.push({
      check: 'timestamp_without_time_zone',
      subject: `${row.table_name}.${row.column_name}`,
    });
  }

  for (const row of await emptyStringDefaultColumns(db)) {
    violations.push({
      check: 'empty_string_default',
      subject: `${row.table_name}.${row.column_name}`,
      detail: row.column_default,
    });
  }

  for (const name of await tablesMissingPrimaryKey(db)) {
    violations.push({ check: 'missing_primary_key', subject: name });
  }

  for (const row of await mongooseArtifactColumns(db)) {
    violations.push({
      check: 'mongoose_artifact',
      subject: `${row.table_name}.${row.column_name}`,
    });
  }

  return violations;
}
