/**
 * Expiry Index Coverage Gate
 *
 * `expiry.ts`'s sweep deletes with `column <= now() - retentionSeconds`.
 * Without a leading btree on `column`, that predicate is a full table scan
 * every time the sweep runs — the exact cost a Mongo TTL index hid, now
 * paid on a schedule instead of never. A convention ("index the column you
 * register") is not enough on its own, because nothing else notices when a
 * migration drops the index or a new target is registered without one; this
 * gate reads the real Postgres catalogue and reports every registered
 * target that has none.
 */

import { getTableName, sql } from 'drizzle-orm';
import { executeRows, type SqlExecutor } from '../database';
import { sqlColumnName } from '../casing';
import type { ExpirySweepTarget } from '../expiry';
import type { InvariantViolation } from './schemaInvariants';

// `type`, not `interface`: `executeRows<TRow extends Record<string,
// unknown>>` requires its type argument to satisfy an index signature,
// which TypeScript infers implicitly for an object type alias but never for
// a named interface (an interface of the identical shape fails `TS2344`).
type IndexedColumnRow = {
  readonly table_name: string;
  readonly column_name: string;
};

/**
 * Every `table.column` backed by a leading btree column of SOME index —
 * `pg_index.indkey[0]` is the first column of the index's key, and joining
 * on it (rather than every column of a multi-column index) is deliberate: a
 * btree can only serve the sweep's `column <= …` predicate efficiently when
 * `column` is the LEADING key, exactly as a Mongo TTL index required.
 */
async function btreeIndexedColumns(db: SqlExecutor): Promise<Set<string>> {
  const rows = await executeRows<IndexedColumnRow>(
    db,
    sql`
      select t.relname as table_name, a.attname as column_name
      from pg_index x
      join pg_class i on i.oid = x.indexrelid
      join pg_class t on t.oid = x.indrelid
      join pg_am am on am.oid = i.relam
      join pg_attribute a on a.attrelid = t.oid and a.attnum = x.indkey[0]
      where am.amname = 'btree'
    `
  );
  return new Set(rows.map((row) => `${row.table_name}.${row.column_name}`));
}

/**
 * Report every {@link ExpirySweepTarget} whose swept column has no
 * supporting leading btree index, against the REAL Postgres catalogue on a
 * migrated database. Returns an empty array when every target is covered.
 */
export async function findUnsupportedExpiryColumns(
  db: SqlExecutor,
  targets: readonly ExpirySweepTarget[]
): Promise<InvariantViolation[]> {
  const indexed = await btreeIndexedColumns(db);

  const violations: InvariantViolation[] = [];
  for (const target of targets) {
    const label = `${getTableName(target.table)}.${sqlColumnName(target.column)}`;
    if (!indexed.has(label)) {
      violations.push({ check: 'expiry_column_without_index', subject: label });
    }
  }
  return violations;
}
