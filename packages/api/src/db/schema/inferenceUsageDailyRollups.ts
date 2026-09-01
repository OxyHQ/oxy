/**
 * `inference_usage_daily_rollups` — the customer-visible usage aggregate.
 *
 * #972's workstream 8 asks for aggregates "by account, project, application,
 * credential, model, provider, status and day". This is that, as a table keyed
 * on exactly those dimensions and maintained incrementally by the same call that
 * records a telemetry event.
 *
 * **Project is not a dimension of its own**, for the same reason it is not a
 * separate spending-limit scope: `users.kind` is one of personal / organization
 * / project / bot / channel, so a project IS an account and `account_id`
 * addresses it. An organization's total is the sum over the accounts in its
 * subtree, which the existing `user_ancestors` path already answers.
 *
 * ## Why a rollup rather than a query over the events
 *
 * The event table is the highest-volume table in the schema and self-deletes at
 * ninety days. A usage dashboard that scans it pays for every request the
 * account has ever made in the window, and loses all history the moment the
 * sweep runs. The rollup is cheap to read, cheap to maintain (one
 * `ON CONFLICT … DO UPDATE` adding each column to itself) and is NOT swept — so
 * usage history outlives telemetry detail.
 *
 * It carries no money, exactly as `inference_usage_events` carries none. A spend
 * figure comes from `usage_receipts`.
 *
 * ## `excluded.<column>` must be spelled out
 *
 * The upsert that maintains this table interpolates `sqlColumnName(column)`, not
 * the column object: interpolating the object emits the JS PROPERTY name, so
 * `excluded.inputTokens` becomes `excluded.inputtokens` and Postgres answers
 * `42703` at runtime. `services/inferenceTelemetry.service.ts` builds it that
 * way and `services/__tests__/inferenceTelemetry.service.test.ts` runs the
 * upsert twice against a real database, which is what catches it.
 *
 * ## Eventually consistent, and documented as such
 *
 * A rollup row is written outside any ledger transaction and can lag or, on a
 * recorder failure, miss a request entirely. That is the accepted contract for a
 * usage dashboard. It is NOT the contract for a bill.
 */

import { sql } from 'drizzle-orm';
import { bigint, check, date, index, pgTable, primaryKey, text } from 'drizzle-orm/pg-core';
import { createdAt, inList, updatedAt } from '@oxyhq/db';
import { applicationCredentials } from './applicationCredentials';
import { applications } from './applications';
import { usageUnitColumns, usageUnitsNonNegativeCheck } from './ledgerColumns';
import { INFERENCE_REQUEST_OUTCOMES } from './usageReceipts';
import { INFERENCE_ENVIRONMENTS } from './usageReservations';
import { users } from './users';

export const inferenceUsageDailyRollups = pgTable(
  'inference_usage_daily_rollups',
  {
    /**
     * The UTC calendar day. A DATE with no instant attached: a usage day is a
     * day, and inventing a timezone for it is what makes two dashboards
     * disagree about which side of midnight a request fell on.
     */
    day: date().notNull(),

    accountId: text()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    applicationId: text()
      .notNull()
      .references(() => applications.id, { onDelete: 'cascade' }),
    applicationCredentialId: text()
      .notNull()
      .references(() => applicationCredentials.id, { onDelete: 'cascade' }),
    environment: text({ enum: INFERENCE_ENVIRONMENTS }).notNull(),
    requestedModelReference: text().notNull(),
    /** `UNROUTED_PROVIDER` when the request never reached a route. */
    servingProvider: text().notNull(),
    outcome: text({ enum: INFERENCE_REQUEST_OUTCOMES }).notNull(),

    requestCount: bigint({ mode: 'number' }).notNull().default(0),
    /** Requests whose HTTP status was >= 400. A subset of `request_count`. */
    errorCount: bigint({ mode: 'number' }).notNull().default(0),
    ...usageUnitColumns(),

    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    primaryKey({
      columns: [
        t.day,
        t.accountId,
        t.applicationId,
        t.applicationCredentialId,
        t.environment,
        t.requestedModelReference,
        t.servingProvider,
        t.outcome,
      ],
    }),

    // The account's usage chart over a date range — the primary key leads with
    // `day`, so a per-account range scan needs its own index.
    index('inference_usage_daily_rollups_account_id_day_idx').on(t.accountId, t.day.desc()),
    index('inference_usage_daily_rollups_application_id_day_idx').on(
      t.applicationId,
      t.day.desc()
    ),

    check(
      'inference_usage_daily_rollups_environment_check',
      sql`${t.environment} in (${sql.raw(inList(INFERENCE_ENVIRONMENTS))})`
    ),
    check(
      'inference_usage_daily_rollups_outcome_check',
      sql`${t.outcome} in (${sql.raw(inList(INFERENCE_REQUEST_OUTCOMES))})`
    ),
    // An error count above the request count would make the success/error split
    // a negative number in every chart built on it.
    check(
      'inference_usage_daily_rollups_counts_check',
      sql`${t.requestCount} >= 0 and ${t.errorCount} >= 0 and ${t.errorCount} <= ${t.requestCount}`
    ),
    usageUnitsNonNegativeCheck('inference_usage_daily_rollups_units_check', t),
  ]
);
