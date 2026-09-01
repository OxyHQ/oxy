/**
 * Foreign-key coverage gate.
 *
 * The migration lands table by table, so some foreign keys cannot be declared
 * yet — their parent table does not exist. `deferredForeignKeys.ts` records each
 * one as data; `findIdColumnViolations` (`@oxyhq/db/assert`) turns that record
 * into a gate with two properties:
 *
 *   1. A deferred foreign key becomes MANDATORY the moment its parent table
 *      appears in the schema barrel. Whoever lands `users` gets a red test
 *      naming every column that must now reference it — the FK cannot be
 *      quietly forgotten, and the ledger empties itself as the port completes.
 *   2. A NEW id-shaped column cannot arrive unclassified. It must have a real
 *      constraint, or be in one of the two ledgers with a reason.
 *
 * This reads the drizzle schema objects, not the database, so it holds even
 * before a migration is applied. The floors and the registries stay here —
 * they are this schema's own data, not the package's.
 */

import { is, type Column } from 'drizzle-orm';
import { PgTable, getTableConfig } from 'drizzle-orm/pg-core';
import { findIdColumnViolations } from '@oxyhq/db/assert';
import { sqlColumnName } from '@oxyhq/db';
import * as schema from '../index';
import {
  DEFERRED_FOREIGN_KEYS,
  ID_COLUMNS_WITHOUT_FOREIGN_KEY,
} from '../deferredForeignKeys';

/**
 * Vacuity floor. If the barrel traversal below ever breaks, it would find zero
 * tables and every assertion in this file would pass by examining nothing.
 */
const MINIMUM_TABLES = 27;

/**
 * Vacuity floor on the CONSTRAINTS, which is a different measurement from the
 * one above.
 *
 * `findIdColumnViolations` decides "this column is classified" from
 * `getTableConfig(table).foreignKeys`. `minimumTables` cannot see that walk fail:
 * a schema barrel that loads every table while `foreignKeys` returns nothing for
 * each of them is over the table floor and reports a clean run, because the
 * consequence would be a flood of `unclassified_id_column` violations — which is
 * loud, but only for columns that are not ALSO in one of the two ledgers.
 *
 * So the count is asserted directly, and deliberately set well below the real
 * total — measured at 282 after #972 workstream 2.3 retired `developer_api_keys`
 * (which took away three: the table's own two, plus the one
 * `api_key_usage_events` pointed into it). This is a floor against a broken
 * traversal, not a census of the schema's size, so ordinary growth never touches
 * it. Mutation-tested: raised to 100000 it fails with `Received: 282`.
 */
const MINIMUM_FOREIGN_KEYS = 200;

const tables = Object.values(schema).filter((value): value is PgTable =>
  is(value, PgTable)
);

/**
 * `blocks.user_id` — the identity used in every failure message here.
 *
 * The SQL name via `sqlColumnName`, never `column.name`: the latter is the
 * TypeScript property (`userId`), so an `endsWith('_id')` test against it
 * matches nothing and passes vacuously.
 */
function describeColumn(table: PgTable, column: Column): string {
  return `${getTableConfig(table).name}.${sqlColumnName(column)}`;
}

describe('schema foreign keys', () => {
  it('classifies every id-shaped column, with no deferred FK left un-owed and no unresolved gap', () => {
    const violations = findIdColumnViolations({
      tables,
      deferred: DEFERRED_FOREIGN_KEYS,
      withoutForeignKey: ID_COLUMNS_WITHOUT_FOREIGN_KEY.map((entry) => ({
        column: describeColumn(entry.table, entry.column),
        reason: entry.reason,
      })),
      minimumTables: MINIMUM_TABLES,
    });

    // Reads as: a `deferred_foreign_key_now_owed` violation means "the parent
    // table has landed — declare .references() and delete the deferred entry";
    // `unclassified_id_column` means "nobody decided about this one"; the rest
    // are ledger hygiene (`stale_ledger_entry`, `incomplete_deferred_foreign_key`).
    expect(violations).toEqual([]);
  });

  it('inspects a non-trivial number of declared foreign keys', () => {
    const declared = tables.reduce(
      (total, table) => total + getTableConfig(table).foreignKeys.length,
      0
    );

    expect(declared).toBeGreaterThanOrEqual(MINIMUM_FOREIGN_KEYS);
  });

  it('keeps at least one permanent id-without-foreign-key exemption', () => {
    // Vacuity floor on the PERMANENT list, not on `DEFERRED_FOREIGN_KEYS` being
    // non-empty: an empty deferred ledger is the finish line the module's own
    // doc comment describes, so asserting it stays populated would turn the
    // goal into a failure.
    expect(ID_COLUMNS_WITHOUT_FOREIGN_KEY.length).toBeGreaterThan(0);
  });
});
