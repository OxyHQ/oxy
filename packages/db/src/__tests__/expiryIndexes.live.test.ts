/**
 * `findUnsupportedExpiryColumns` against a REAL Postgres catalogue.
 *
 * `assertGates.test.ts` drives the same function through a fake executor
 * that dispatches on rendered SQL text — proving the post-processing logic
 * (label formatting, which targets are reported) is correct given whatever
 * canned rows the fake hands back, but it cannot prove the QUERY ITSELF
 * asks Postgres the right question: the fake recognizes the query by its
 * `amname = 'btree'` clause and returns a fixed row set regardless of what
 * `pg_index`/`pg_attribute`/`indkey[0]` actually mean. A mutation that
 * breaks the JOIN semantics while leaving that clause intact — for
 * example, matching ANY column of a multi-column index rather than only
 * its LEADING one — would satisfy the fake identically and go undetected.
 * This file closes that gap by running the real query against a genuine
 * migrated schema, through the same ephemeral-database harness
 * (`createTestDatabase`) a real consumer's own migration suite is expected
 * to use.
 *
 * Skipped when `OXYDB_TEST_ADMIN_URL` is unset, same as `liveDatabase.test.ts`
 * and `schemaInvariants.live.test.ts` — this package's own CI does not yet
 * run a Postgres service.
 */

import { drizzle } from 'drizzle-orm/postgres-js';
import { pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import postgres from 'postgres';
import { findUnsupportedExpiryColumns } from '../assert/expiryIndexes';
import { createTestDatabase, dropTestDatabase } from '../testing';

const ADMIN_URL = process.env.OXYDB_TEST_ADMIN_URL;
const describeLive = ADMIN_URL ? describe : describe.skip;

/** No consumer schema is needed: this module issues a raw catalogue read,
 * never a table-builder query, so a bare `drizzle(client)` already
 * satisfies `SqlExecutor`. */
function executorFor(databaseUrl: string) {
  const client = postgres(databaseUrl, { max: 1 });
  return { db: drizzle(client), client };
}

const indexedTable = pgTable('expiry_indexed', {
  id: text().primaryKey(),
  expiresAt: timestamp({ withTimezone: true }),
});
const unindexedTable = pgTable('expiry_unindexed', {
  id: text().primaryKey(),
  expiresAt: timestamp({ withTimezone: true }),
});
const compositeTable = pgTable('expiry_composite', {
  id: text().primaryKey(),
  secondaryAt: timestamp({ withTimezone: true }),
  checkedAt: timestamp({ withTimezone: true }),
});

describeLive('findUnsupportedExpiryColumns (live Postgres)', () => {
  it('reports only the swept column with no supporting btree index', async () => {
    const url = await createTestDatabase({
      adminUrl: ADMIN_URL,
      migrate: async (databaseUrl) => {
        const admin = postgres(databaseUrl, { max: 1 });
        try {
          await admin.unsafe(`
            create table expiry_indexed (
              id text primary key,
              expires_at timestamptz
            );
            create index expiry_indexed_expires_at_idx on expiry_indexed (expires_at);

            create table expiry_unindexed (
              id text primary key,
              expires_at timestamptz
            );
          `);
        } finally {
          await admin.end({ timeout: 5 });
        }
      },
    });

    const { db, client } = executorFor(url);
    try {
      const violations = await findUnsupportedExpiryColumns(db, [
        {
          table: indexedTable,
          column: indexedTable.expiresAt,
          retentionSeconds: 60,
          reason: 'fixture: has a supporting index',
        },
        {
          table: unindexedTable,
          column: unindexedTable.expiresAt,
          retentionSeconds: 60,
          reason: 'fixture: has no index at all',
        },
      ]);
      expect(violations).toEqual([
        { check: 'expiry_column_without_index', subject: 'expiry_unindexed.expires_at' },
      ]);
    } finally {
      await client.end({ timeout: 5 });
      await dropTestDatabase(url);
    }
  });

  // The case a fake dispatching on query TEXT can never exercise: a column
  // that IS part of a real btree index, but not as its LEADING key, must
  // still be reported unsupported — the sweep's `column <= now() - N`
  // predicate cannot use the index unless `column` is first.
  it('does not count a non-leading column of a composite index as supporting', async () => {
    const url = await createTestDatabase({
      adminUrl: ADMIN_URL,
      migrate: async (databaseUrl) => {
        const admin = postgres(databaseUrl, { max: 1 });
        try {
          await admin.unsafe(`
            create table expiry_composite (
              id text primary key,
              secondary_at timestamptz,
              checked_at timestamptz
            );
            create index expiry_composite_secondary_checked_idx
              on expiry_composite (secondary_at, checked_at);
          `);
        } finally {
          await admin.end({ timeout: 5 });
        }
      },
    });

    const { db, client } = executorFor(url);
    try {
      const violations = await findUnsupportedExpiryColumns(db, [
        {
          table: compositeTable,
          column: compositeTable.checkedAt,
          retentionSeconds: 60,
          reason: 'fixture: indexed, but not as the leading column',
        },
      ]);
      expect(violations).toEqual([
        { check: 'expiry_column_without_index', subject: 'expiry_composite.checked_at' },
      ]);
    } finally {
      await client.end({ timeout: 5 });
      await dropTestDatabase(url);
    }
  });
});
