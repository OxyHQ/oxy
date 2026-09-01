import { sql, type SQL } from 'drizzle-orm';
import { PgDialect, pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import { DATABASE_CASING } from '../casing';
import type { SqlExecutor } from '../database';
import { sweepAllExpiredRows, sweepExpiredRows } from '../expiry';

const events = pgTable('events', {
  id: text().primaryKey(),
  playedAt: timestamp({ withTimezone: true, mode: 'date' }),
});

const target = {
  table: events,
  column: events.playedAt,
  retentionSeconds: 60,
  reason: 'test fixture',
};

/** Returns `perBatch` rows for `batches` calls, then a short batch. */
function executor(perBatch: number, batches: number): SqlExecutor & { statements: SQL[] } {
  const statements: SQL[] = [];
  let remaining = batches;
  return {
    statements,
    execute: async (query: SQL): Promise<Record<string, unknown>[]> => {
      statements.push(query);
      const rows = remaining > 0 ? perBatch : 0;
      remaining -= 1;
      return Array.from({ length: rows }, () => ({ ctid: '(0,1)' }));
    },
  };
}

describe('expiry sweep', () => {
  it('stops as soon as a batch comes back short', async () => {
    const db = executor(10, 2);
    const result = await sweepExpiredRows(db, target, { batchSize: 10, maxBatches: 50 });

    expect(result).toEqual({ table: 'events', deleted: 20, truncated: false });
    expect(db.statements).toHaveLength(3);
  });

  it('reports truncated when the batch ceiling is hit, so a backlog is visible', async () => {
    const db = executor(10, 100);
    const result = await sweepExpiredRows(db, target, { batchSize: 10, maxBatches: 3 });

    expect(result).toEqual({ table: 'events', deleted: 30, truncated: true });
  });

  // The brief's original version of this test called `sweepAllExpiredRows(db, [])`
  // only — an empty loop returns `[]` and issues no statements under ANY
  // implementation, including one that silently ignores the `targets` parameter
  // altogether (e.g. a leftover internal registry, or a hardcoded `[]`). That
  // shape cannot tell "sweeps what the caller passed" apart from "always sweeps
  // nothing", which is precisely the distinction this test's own name claims to
  // make. Strengthened below with a non-empty, two-target call so an
  // implementation that ignores its `targets` argument (returns `[]` regardless
  // of input, or never calls `db.execute`) fails it, and mis-ordered or
  // dropped results are visible in the returned table names.
  it('sweeps the targets the CALLER supplies, not a registry of its own', async () => {
    const emptyDb = executor(0, 0);
    expect(await sweepAllExpiredRows(emptyDb, [])).toEqual([]);
    expect(emptyDb.statements).toHaveLength(0);

    const plays = pgTable('plays', {
      id: text().primaryKey(),
      seenAt: timestamp({ withTimezone: true, mode: 'date' }),
    });
    const secondTarget = {
      table: plays,
      column: plays.seenAt,
      retentionSeconds: 30,
      reason: 'test fixture',
    };

    // One full batch then a short batch, shared across BOTH targets in
    // sequence: `events` consumes the full batch and the short batch that
    // follows it, leaving nothing for `plays`, whose own call comes back
    // empty. An implementation that skips a target, swaps their order, or
    // returns a registry of its own instead of these two produces a
    // different pair of table names or a different statement count.
    const db = executor(5, 1);

    const results = await sweepAllExpiredRows(db, [target, secondTarget], { batchSize: 5 });

    expect(results).toEqual([
      { table: 'events', deleted: 5, truncated: false },
      { table: 'plays', deleted: 0, truncated: false },
    ]);
    expect(db.statements).toHaveLength(3);
  });

  // The mandated tests never inspect the SQL text the fake executor receives,
  // so a column-name regression — interpolating `target.column.name` (the
  // TypeScript property `playedAt`) instead of the drizzle Column itself —
  // would satisfy all three tests above unchanged: the fake returns canned
  // rows regardless of what query it was handed. That is exactly the failure
  // mode `expiredPredicate`'s doc comment warns about ("column \"playedAt\"
  // does not exist", or a catalogue query that silently matches nothing), so
  // it needs its own check against drizzle's real renderer rather than a mock.
  it('renders the retention column in snake_case and batches through ctid', async () => {
    const db = executor(0, 1);
    await sweepExpiredRows(db, target, { batchSize: 25 });

    const dialect = new PgDialect({ casing: DATABASE_CASING });
    // Collapsed to single-space runs so the assertion tracks the SQL shape,
    // not the source template's indentation.
    const rendered = dialect.sqlToQuery(db.statements[0]).sql.replace(/\s+/g, ' ').trim();

    expect(rendered).toContain('"played_at"');
    expect(rendered).not.toContain('playedAt');
    expect(rendered).toBe(
      'delete from "events" ' +
        'where ctid in ( ' +
        'select ctid from "events" where "events"."played_at" <= now() - make_interval(secs => $1) limit $2 ' +
        ') returning ctid'
    );
  });

  it('defaults batchSize and maxBatches when the caller omits them', async () => {
    // A short batch on the very first call proves the default batch size was
    // used to decide "short", not merely that some finite loop terminated —
    // with the real default (1000) a fake returning 5 rows is short on call
    // one; a fake wrongly defaulted to a tiny batch size (e.g. 5) would
    // instead read as a FULL batch and keep looping.
    const db = executor(5, 1);
    const result = await sweepExpiredRows(db, target);

    expect(result).toEqual({ table: 'events', deleted: 5, truncated: false });
    expect(db.statements).toHaveLength(1);
  });
});
