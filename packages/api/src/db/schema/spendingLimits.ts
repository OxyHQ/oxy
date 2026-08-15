/**
 * `spending_limits` + `spending_limit_notifications` — budgets, alert thresholds
 * and the hard/soft stop.
 *
 * A limit is a CEILING ON SPEND, never a store of value. That distinction is the
 * whole reason child projects share their nearest ancestor's balance rather than
 * receiving allocated funds (argued in `billingProfiles.ts`): a budget can be
 * raised, lowered or removed without a financial transaction, and it can never
 * strand money the way a sub-balance can.
 *
 * ## Four levels, three columns
 *
 * #972 asks for limits at account, project, application and credential level.
 * That is three scope columns, not four, because a PROJECT IS AN ACCOUNT —
 * `users.kind` is one of personal / organization / project / bot / channel — so
 * an account-scoped limit on a project account is the project-level limit.
 * Inventing a fourth column for it would create two ways to express one thing.
 *
 * Three nullable FOREIGN KEYS plus a discriminant, rather than one polymorphic
 * `scope_id`: every scope names a table in this database, so a polymorphic
 * column would discard three real relational links to save two columns. A CHECK
 * pins exactly the matching one, so a row cannot claim one scope and point at
 * another.
 *
 * ## Enforcement
 *
 * `hard_stop` refuses the reservation — nothing is forwarded and nothing is
 * spent. `soft_stop` allows it and reports that the limit was passed, for a
 * customer who would rather be warned than interrupted. Both are evaluated
 * BEFORE execution, in the same transaction as the balance check, because a
 * limit consulted after the provider has been billed is not a limit.
 *
 * ## Alert thresholds are a closed set
 *
 * `alert_threshold_bps` is a `smallint[]` constrained by containment to
 * {@link SPENDING_ALERT_THRESHOLDS_BPS}. Basis points of the limit, so 7500 is
 * 75%. A closed set rather than any integer, for the reason `CONVENTIONS.md`
 * gives for every other closed value set here — a CHECK against an enumerated
 * literal is reviewable in the generated SQL and symmetric for add and remove,
 * where "any integer in 1..10000" cannot be expressed as a CHECK over an array
 * at all without a subquery Postgres will not accept.
 *
 * Note `cardinality`, not `array_length`: `array_length(col, 1)` is NULL on an
 * empty array and a CHECK rejects only FALSE, so the obvious spelling would
 * ADMIT what it means to bound.
 *
 * ## Notifications exist so an alert fires ONCE
 *
 * Without a record of which threshold was crossed in which period, a threshold
 * alert re-fires on every subsequent request — the unique key
 * `(limit, period_start, threshold)` is what makes crossing a threshold an
 * event rather than a state.
 */

import { sql } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  pgTable,
  smallint,
  text,
  unique,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { createdAt, generatedId, inList, numericInList, timestamptz, updatedAt } from '@oxyhq/db';
import { applicationCredentials } from './applicationCredentials';
import { applications } from './applications';
import { currencyCode, currencyCodeCheck, exactAmount } from './ledgerColumns';
import { users } from './users';

/** What a limit applies to. `account` covers organization AND project accounts. */
export const SPENDING_LIMIT_SCOPES = ['account', 'application', 'credential'] as const;

export type SpendingLimitScope = (typeof SPENDING_LIMIT_SCOPES)[number];

/**
 * The window a limit is measured over. `total` is a lifetime cap — the shape a
 * prepaid trial or a fixed project budget needs, where a rolling window would
 * quietly re-arm it.
 */
export const SPENDING_LIMIT_PERIODS = ['daily', 'weekly', 'monthly', 'total'] as const;

export type SpendingLimitPeriod = (typeof SPENDING_LIMIT_PERIODS)[number];

/** What happens when the ceiling is reached. */
export const SPENDING_LIMIT_ENFORCEMENTS = ['hard_stop', 'soft_stop'] as const;

export type SpendingLimitEnforcement = (typeof SPENDING_LIMIT_ENFORCEMENTS)[number];

export const SPENDING_LIMIT_STATUSES = ['active', 'disabled'] as const;

export type SpendingLimitStatus = (typeof SPENDING_LIMIT_STATUSES)[number];

/** Basis points of the limit at which a customer is told. 10000 = 100%. */
export const SPENDING_ALERT_THRESHOLDS_BPS = [2500, 5000, 7500, 9000, 10000] as const;

/** More than one alert per configured threshold is noise, not information. */
export const MAX_SPENDING_ALERT_THRESHOLDS = SPENDING_ALERT_THRESHOLDS_BPS.length;

export const spendingLimits = pgTable(
  'spending_limits',
  {
    id: generatedId(),

    /**
     * The account whose money this limit protects — the one that pays, resolved
     * through `billing_profiles`. Distinct from the SCOPE, which may be an
     * application or credential belonging to it.
     */
    accountId: text()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),

    scope: text({ enum: SPENDING_LIMIT_SCOPES }).notNull(),
    /** Set when `scope = 'account'`. An organization or project account. */
    scopeAccountId: text().references(() => users.id, { onDelete: 'cascade' }),
    /** Set when `scope = 'application'`. */
    scopeApplicationId: text().references(() => applications.id, { onDelete: 'cascade' }),
    /** Set when `scope = 'credential'`. */
    scopeApplicationCredentialId: text().references(() => applicationCredentials.id, {
      onDelete: 'cascade',
    }),

    period: text({ enum: SPENDING_LIMIT_PERIODS }).notNull(),
    limitAmount: exactAmount().notNull(),
    currency: currencyCode(),
    enforcement: text({ enum: SPENDING_LIMIT_ENFORCEMENTS }).notNull().default('hard_stop'),
    alertThresholdBps: smallint().array().notNull().default([]),
    status: text({ enum: SPENDING_LIMIT_STATUSES }).notNull().default('active'),

    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    // Every reservation reads the limits that apply to it, by all three scopes.
    index('spending_limits_account_id_status_idx').on(t.accountId, t.status),
    // One limit per scope target and period. Three PARTIAL uniques rather than
    // one compound: Postgres treats NULLs as DISTINCT, so a compound unique over
    // the nullable scope columns would admit unlimited duplicates.
    uniqueIndex('spending_limits_account_scope_key')
      .on(t.scopeAccountId, t.period)
      .where(sql`${t.scopeAccountId} is not null`),
    uniqueIndex('spending_limits_application_scope_key')
      .on(t.scopeApplicationId, t.period)
      .where(sql`${t.scopeApplicationId} is not null`),
    uniqueIndex('spending_limits_credential_scope_key')
      .on(t.scopeApplicationCredentialId, t.period)
      .where(sql`${t.scopeApplicationCredentialId} is not null`),

    check(
      'spending_limits_scope_check',
      sql`${t.scope} in (${sql.raw(inList(SPENDING_LIMIT_SCOPES))})`
    ),
    check(
      'spending_limits_period_check',
      sql`${t.period} in (${sql.raw(inList(SPENDING_LIMIT_PERIODS))})`
    ),
    check(
      'spending_limits_enforcement_check',
      sql`${t.enforcement} in (${sql.raw(inList(SPENDING_LIMIT_ENFORCEMENTS))})`
    ),
    check(
      'spending_limits_status_check',
      sql`${t.status} in (${sql.raw(inList(SPENDING_LIMIT_STATUSES))})`
    ),
    check('spending_limits_currency_check', currencyCodeCheck(t.currency)),
    // A ceiling of zero would refuse every request while reading like "no
    // limit configured" in a list. Disabling is what `status` is for.
    check('spending_limits_limit_amount_check', sql`${t.limitAmount} > 0`),
    // Exactly the scope target the discriminant names.
    check(
      'spending_limits_scope_target_check',
      sql`(${t.scope} = 'account'
             and ${t.scopeAccountId} is not null
             and ${t.scopeApplicationId} is null
             and ${t.scopeApplicationCredentialId} is null)
        or (${t.scope} = 'application'
             and ${t.scopeApplicationId} is not null
             and ${t.scopeAccountId} is null
             and ${t.scopeApplicationCredentialId} is null)
        or (${t.scope} = 'credential'
             and ${t.scopeApplicationCredentialId} is not null
             and ${t.scopeAccountId} is null
             and ${t.scopeApplicationId} is null)`
    ),
    // `cardinality`, not `array_length` — see the header. Both constants go
    // through `sql.raw`: a JS value interpolated into a `check()` is emitted as
    // the literal `$1` in the generated migration and fails at APPLY time.
    check(
      'spending_limits_alert_thresholds_check',
      sql`${t.alertThresholdBps} <@ array[${sql.raw(numericInList(SPENDING_ALERT_THRESHOLDS_BPS))}]::smallint[]
        and cardinality(${t.alertThresholdBps}) <= ${sql.raw(String(MAX_SPENDING_ALERT_THRESHOLDS))}`
    ),
  ]
);

export const spendingLimitNotifications = pgTable(
  'spending_limit_notifications',
  {
    id: generatedId(),

    spendingLimitId: text()
      .notNull()
      .references(() => spendingLimits.id, { onDelete: 'cascade' }),
    /** Start of the window the crossing happened in. `total` uses the epoch. */
    periodStart: timestamptz().notNull(),
    thresholdBps: integer().notNull(),
    /** Spend at the moment the threshold was crossed. */
    spendAmount: exactAmount().notNull(),

    createdAt: createdAt(),
  },
  (t) => [
    // The whole point: one notification per threshold per period.
    unique('spending_limit_notifications_threshold_key').on(
      t.spendingLimitId,
      t.periodStart,
      t.thresholdBps
    ),

    check(
      'spending_limit_notifications_threshold_bps_check',
      sql`${t.thresholdBps} in (${sql.raw(numericInList(SPENDING_ALERT_THRESHOLDS_BPS))})`
    ),
    check('spending_limit_notifications_spend_amount_check', sql`${t.spendAmount} >= 0`),
  ]
);
