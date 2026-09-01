/**
 * `findSchemaInvariantViolations` against a REAL Postgres catalogue.
 *
 * `schemaInvariants.test.ts` drives the same function through a fake
 * executor that dispatches on rendered SQL text — proving the
 * violation-COLLECTION logic (thresholds, snake_case matching, subject
 * formatting) is correct, but it cannot prove the QUERIES themselves select
 * the right rows: the fake answers a query by recognizing which literal
 * clause it contains, so a mutation that leaves that clause intact but
 * breaks the semantics behind it returns the SAME canned rows regardless.
 * Confirmed directly while mutation-testing this module: changing the
 * empty-string-default check's regex parameter from `^''::` to a pattern
 * that can never match a real column default left every test in that file
 * green, 10 of 10 — the fake still recognised the query by its `column_default
 * ~` clause and handed back the same canned violation row. This file closes
 * that gap by running the real queries this package ships against genuine
 * `information_schema` catalogues, created through the same ephemeral test
 * database harness (`createTestDatabase`) a real consumer's own migration
 * suite is expected to use.
 *
 * Skipped when `OXYDB_TEST_ADMIN_URL` is unset, same as `liveDatabase.test.ts`
 * — this package's own CI does not yet run a Postgres service.
 */

import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { findSchemaInvariantViolations } from '../assert/schemaInvariants';
import { createTestDatabase, dropTestDatabase } from '../testing';

const ADMIN_URL = process.env.OXYDB_TEST_ADMIN_URL;
const describeLive = ADMIN_URL ? describe : describe.skip;

/** No consumer schema is needed: every query this module issues is a raw
 * catalogue read, never a table-builder query, so a bare `drizzle(client)`
 * (no schema, no casing) already satisfies `SqlExecutor`. */
function executorFor(databaseUrl: string) {
  const client = postgres(databaseUrl, { max: 1 });
  return { db: drizzle(client), client };
}

describeLive('findSchemaInvariantViolations (live Postgres)', () => {
  it('reports nothing against a schema with no violations', async () => {
    const url = await createTestDatabase({
      adminUrl: ADMIN_URL,
      migrate: async (databaseUrl) => {
        const admin = postgres(databaseUrl, { max: 1 });
        try {
          await admin.unsafe(`
            create table healthy_widgets (
              id uuid primary key,
              name text not null,
              created_at timestamptz not null default now()
            )
          `);
        } finally {
          await admin.end({ timeout: 5 });
        }
      },
    });

    const { db, client } = executorFor(url);
    try {
      const violations = await findSchemaInvariantViolations(db, {
        minimumTables: 1,
        minimumColumns: 1,
      });
      expect(violations).toEqual([]);
    } finally {
      await client.end({ timeout: 5 });
      await dropTestDatabase(url);
    }
  });

  // One instance of each of the seven checks, in a single real schema — the
  // exact rows and rendered `column_default`/`data_type` text below were
  // read back from a real Postgres 17 instance before being pasted here,
  // not guessed: `information_schema` renders a bare `timestamp` column as
  // `timestamp without time zone`, and a `default ''::text` column's
  // `column_default` as the literal string `''::text`.
  it('reports every real violation, against genuine information_schema catalogues', async () => {
    const url = await createTestDatabase({
      adminUrl: ADMIN_URL,
      migrate: async (databaseUrl) => {
        const admin = postgres(databaseUrl, { max: 1 });
        try {
          await admin.unsafe(`
            create table posts (
              id uuid primary key,
              title text not null,
              slug text default ''::text,
              created_at timestamp,
              "createdBy" text,
              "_id" text,
              "__v" integer
            );

            create table "BadTable" (
              id uuid primary key
            );

            create table orphans (
              id uuid
            );
          `);
        } finally {
          await admin.end({ timeout: 5 });
        }
      },
    });

    const { db, client } = executorFor(url);
    try {
      const violations = await findSchemaInvariantViolations(db, {
        minimumTables: 1,
        minimumColumns: 1,
      });

      // `_id` and `__v` both start with `_`, not `[a-z]`, so each is
      // simultaneously a `snake_case_column` AND a `mongoose_artifact`
      // violation — the two checks are not mutually exclusive, and a
      // fixture that only asserted one of them per column would leave that
      // overlap unverified.
      expect(violations).toEqual(
        expect.arrayContaining([
          { check: 'snake_case_table', subject: 'BadTable' },
          { check: 'snake_case_column', subject: 'posts.createdBy' },
          { check: 'snake_case_column', subject: 'posts._id' },
          { check: 'snake_case_column', subject: 'posts.__v' },
          { check: 'timestamp_without_time_zone', subject: 'posts.created_at' },
          { check: 'empty_string_default', subject: 'posts.slug', detail: "''::text" },
          { check: 'missing_primary_key', subject: 'orphans' },
          { check: 'mongoose_artifact', subject: 'posts._id' },
          { check: 'mongoose_artifact', subject: 'posts.__v' },
        ])
      );
      // Nothing else: nine columns and three tables, no vacuity noise
      // (the floors above are met), no unrelated snake_case/timestamp/etc.
      // false positives from the surrounding healthy columns.
      expect(violations).toHaveLength(9);
    } finally {
      await client.end({ timeout: 5 });
      await dropTestDatabase(url);
    }
  });
});
