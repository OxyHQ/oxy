/**
 * Schema-wide invariants, asserted against the MIGRATED database.
 *
 * These are the conventions in `CONVENTIONS.md` that a single table can violate
 * on its own without anything else noticing — so they are checked here across
 * every table at once, on the DDL that actually landed rather than on the
 * TypeScript that was meant to produce it. The gate itself (`findSchemaInvariantViolations`)
 * lives in `@oxyhq/db/assert`; the floors below are this schema's own data.
 */

import { findSchemaInvariantViolations } from '@oxyhq/db/assert';
import { Table, getTableColumns, getTableName, is, sql } from 'drizzle-orm';
import { closePostgres, connectPostgres, getDb } from '../../../config/postgres';
import * as schema from '../index';

/**
 * The floors are DERIVED from the schema barrel, not written down — but the
 * assertion that can actually fail is the membership test below, not these.
 *
 * They were hardcoded at 27 tables / 356 columns while the barrel declared 106
 * tables, so the census would have passed with eighty tables missing, and
 * "I found less" and "there is less" look identical from inside the query.
 *
 * Deriving them stops the number going stale, and that is ALL it does. Measured
 * before trusting it: raising this floor to `declared + 1` still passed, because
 * the migrated database holds more `public` tables than the barrel declares (the
 * migration ledger lives there too). So no count set below the real total can
 * fail — 27 and 106 are vacuous in exactly the same way, and a tidier number is
 * not a gate. They stay because `findSchemaInvariantViolations` takes them and a
 * derived number beats a rotting one, not because they catch anything.
 *
 * Derived from the barrel's exported table OBJECTS via drizzle's `is(…, Table)`
 * — never from export NAMES, which are arbitrary and would produce a count that
 * cannot disagree with reality.
 */
const declaredTables = Object.values(schema).filter((value): value is Table => is(value, Table));

const MINIMUM_TABLES = declaredTables.length;
const MINIMUM_COLUMNS = declaredTables.reduce(
  (total, table) => total + Object.keys(getTableColumns(table)).length,
  0
);

beforeAll(async () => {
  await connectPostgres();
});

afterAll(async () => {
  await closePostgres();
});

it('derives floors from the declared schema rather than a stale constant', () => {
  // A positive control for the derivation itself: if the filter ever stopped
  // recognising drizzle tables it would silently yield 0, and a floor of 0
  // passes against an empty database. These bounds are deliberately loose —
  // they assert the derivation WORKS, not how big the schema is, so ordinary
  // growth never touches this file.
  expect(MINIMUM_TABLES).toBeGreaterThan(50);
  expect(MINIMUM_COLUMNS).toBeGreaterThan(MINIMUM_TABLES);
});

/**
 * The census counts; this names names, and it is the assertion that can
 * actually fail.
 *
 * A count floor cannot catch a missing table while the database holds more
 * tables than the schema declares — and it does, because the migration ledger
 * lives in `public` too. Measured: raising the floor to `declared + 1` still
 * passed, so every count below the real total is equally vacuous, 27 and 106
 * alike. Set membership has no such slack: one declared table absent from the
 * database is one failure, and it says which.
 *
 * Direction matters. This asserts declared ⊆ actual, never equality — the
 * ledger and any extension's own tables are legitimately present and
 * undeclared. Deleting a declaration therefore cannot make this pass by
 * lowering the bar, which is exactly how the derived count fails as a gate.
 */
it('has every declared table present in the migrated database', async () => {
  const rows = await getDb().execute<{ table_name: string }>(sql`
    select table_name from information_schema.tables
    where table_schema = 'public' and table_type = 'BASE TABLE'
  `);
  const actual = new Set(rows.map((row) => row.table_name));

  // Vacuity floor: the query really did read this database's tables.
  expect(actual.has('users')).toBe(true);

  const missing = declaredTables.map((table) => getTableName(table)).filter((name) => !actual.has(name));
  expect(missing).toEqual([]);
});

it('holds every schema invariant', async () => {
  const violations = await findSchemaInvariantViolations(getDb(), {
    minimumTables: MINIMUM_TABLES,
    minimumColumns: MINIMUM_COLUMNS,
  });

  expect(violations).toEqual([]);
});
