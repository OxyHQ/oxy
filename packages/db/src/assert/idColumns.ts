/**
 * Id-Column Classification Gate
 *
 * A schema built table by table lets an id-shaped column arrive with no
 * foreign key and nobody having decided that on purpose — the parent table
 * might not exist yet, or the id might legitimately point outside this
 * database entirely (a Stripe id, a cross-service id, a value in another
 * store's id space). Left unchecked, "no constraint" and "nobody has looked
 * at this yet" are indistinguishable.
 *
 * This gate closes that gap with two caller-supplied ledgers, converted into
 * `InvariantViolation`s rather than asserted directly, so three different
 * test runners can drive the same traversal:
 *
 *   - `deferred`: a foreign key that IS decided but not yet expressible,
 *     because its parent table has not landed. The moment a table with that
 *     name appears in `tables`, the entry is no longer deferrable — it must
 *     become a real `.references()` and be deleted from the list.
 *   - `withoutForeignKey`: the PERMANENT list. An id-shaped column that will
 *     never carry a constraint, named as `table.column` (its SQL name — see
 *     `sqlColumnName`'s own doc comment for why `column.name`, the
 *     TypeScript property, must never be used for this), with the reason.
 *
 * Between a real `.references()`, these two ledgers, and the primary key
 * itself, every `*_id`-shaped column in `tables` is expected to be
 * classified. One that is not — a new column nobody has decided about — is
 * `unclassified_id_column`. The ledgers themselves are checked too: an
 * entry naming a column that no longer exists is `stale_ledger_entry`, and
 * a deferred entry with a blank reason or parent column is
 * `incomplete_deferred_foreign_key` — TypeScript's closed union already
 * refuses an unset `onDelete`, so that field needs no runtime check.
 */

import {
  getTableConfig,
  type PgColumn,
  type PgTable,
  type UpdateDeleteAction,
} from 'drizzle-orm/pg-core';
import { sqlColumnName } from '../casing';
import type { InvariantViolation } from './schemaInvariants';

/** A foreign key that is decided but not yet expressible. */
export interface DeferredForeignKey {
  readonly table: PgTable;
  readonly column: PgColumn;
  /** SQL name of the parent table, e.g. `users`. */
  readonly parentTable: string;
  /** Column on the parent, e.g. `id`. */
  readonly parentColumn: string;
  /** Decided per relation — never left to default. */
  readonly onDelete: UpdateDeleteAction;
  /** Why that `ON DELETE`, in one line. */
  readonly reason: string;
}

export interface IdColumnOptions {
  readonly tables: readonly PgTable[];
  readonly deferred: readonly DeferredForeignKey[];
  /** `*_id` columns that will never carry a constraint, with the reason. */
  readonly withoutForeignKey: readonly { column: string; reason: string }[];
  /** Traversal floor. Fewer tables than this is a broken query, not a clean schema. */
  readonly minimumTables: number;
}

/**
 * `posts.author_id` — the identity used throughout this module's violations.
 *
 * The SQL name via `sqlColumnName`, never `column.name`: the latter is the
 * TypeScript property (`authorId`), so an `endsWith('_id')` test against it
 * would match nothing and pass vacuously.
 */
function describeColumn(table: PgTable, column: PgColumn): string {
  return `${getTableConfig(table).name}.${sqlColumnName(column)}`;
}

/**
 * Walk `options.tables` and report every id-column-classification violation
 * at once. Returns an empty array when every id-shaped column is accounted
 * for, which is what makes a single `expect(violations).toEqual([])` in a
 * consumer's own suite the whole gate.
 */
export function findIdColumnViolations(options: IdColumnOptions): InvariantViolation[] {
  const violations: InvariantViolation[] = [];

  if (options.tables.length < options.minimumTables) {
    violations.push({
      check: 'vacuity',
      subject: 'tables',
      detail: `found ${options.tables.length}, expected at least ${options.minimumTables}`,
    });
  }

  const present = new Set(options.tables.map((table) => getTableConfig(table).name));

  for (const fk of options.deferred) {
    // The parent table has landed, so this entry is no longer deferrable —
    // it owes a real `.references()` and deletion from the deferred list.
    if (present.has(fk.parentTable)) {
      violations.push({
        check: 'deferred_foreign_key_now_owed',
        subject: describeColumn(fk.table, fk.column),
        detail: `${fk.parentTable}.${fk.parentColumn} (on delete ${fk.onDelete})`,
      });
    }
    if (fk.reason.trim() === '' || fk.parentColumn.trim() === '') {
      violations.push({
        check: 'incomplete_deferred_foreign_key',
        subject: describeColumn(fk.table, fk.column),
      });
    }
  }

  // Columns that already carry a real, declared foreign key — the
  // referencing (child) side, which is what `ForeignKey#reference().columns`
  // returns, not the parent side.
  const declared = new Set<string>();
  for (const table of options.tables) {
    for (const foreignKey of getTableConfig(table).foreignKeys) {
      for (const column of foreignKey.reference().columns) {
        declared.add(describeColumn(table, column));
      }
    }
  }

  const deferredIds = new Set(options.deferred.map((fk) => describeColumn(fk.table, fk.column)));
  const exempt = new Set(options.withoutForeignKey.map((entry) => entry.column));

  const allColumns = new Set<string>();
  for (const table of options.tables) {
    for (const column of getTableConfig(table).columns) {
      allColumns.add(describeColumn(table, column));

      if (column.primary || !sqlColumnName(column).endsWith('_id')) continue;
      const id = describeColumn(table, column);
      if (declared.has(id) || deferredIds.has(id) || exempt.has(id)) continue;
      violations.push({ check: 'unclassified_id_column', subject: id });
    }
  }

  // A ledger entry naming a column that no longer exists — renamed, dropped,
  // or a typo that was never caught because the column it MEANT to name
  // happened to still classify as unclassified rather than raising an error.
  for (const id of new Set([...deferredIds, ...exempt])) {
    if (!allColumns.has(id)) {
      violations.push({ check: 'stale_ledger_entry', subject: id });
    }
  }

  return violations;
}
