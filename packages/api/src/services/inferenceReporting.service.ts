/**
 * Inference Reporting Service — the customer's own view of what they used and
 * what they were charged (issue #972, workstream 8).
 *
 * Before this existed the ledger and telemetry tables had no HTTP reader at all:
 * `spending_limits`, `inference_usage_daily_rollups`, `account_balances`,
 * `usage_reservations`, `usage_receipts` and `billing_ledger_entries` were
 * written by the edge and the ledger and read back by nothing. Console could not
 * show usage, spend, balance, reservations or budgets.
 *
 * ## Which table answers which question — stated, not implied
 *
 *  - **Usage aggregates** come from `inference_usage_daily_rollups` and from
 *    nowhere else. That table's primary key IS the epic's dimension list — day,
 *    account, application, credential, environment, requested model, serving
 *    provider, outcome — so there is no workstream 8 aggregate it cannot answer.
 *    `inference_usage_events` is deliberately never scanned here: it is the
 *    highest-volume table in the schema, it self-deletes at ninety days, and an
 *    aggregate built on it would silently lose an account's older history the
 *    first time the sweep ran. Its per-request detail (latency,
 *    time-to-first-token, the individual request row) is a different surface
 *    with a different retention story.
 *  - **Money** comes from `usage_receipts` — the immutable settlement — with
 *    reversals from `usage_refunds`, holds from `usage_reservations` and
 *    balances from `account_balances`. **No money figure anywhere in this module
 *    is derived from a telemetry sum**, and that is structural rather than
 *    remembered: neither telemetry table has a money column at all.
 *
 * ## Arithmetic happens in SQL
 *
 * The rule `inferenceLedger.service.ts` holds itself to. Every amount crosses
 * this module as an exact decimal STRING and every sum, difference and ratio is
 * computed by Postgres with an explicit cast — because `postgres.js` decodes
 * `numeric` AND `bigint` as strings while drizzle types the latter `number`, so
 * `a + b` in JavaScript is string concatenation for a token total and lossy
 * float arithmetic for a price. `executeRows` bypasses drizzle's result mapper
 * entirely, so every numeric column read here is cast to `text` in the query and
 * converted once, deliberately, by {@link toCount}.
 *
 * ## Grouping keys are a CLOSED map, never caller text
 *
 * `groupBy` names are validated against a closed enum by the request schema and
 * then translated through {@link USAGE_DIMENSION_SQL} / {@link SPEND_DIMENSION_SQL}
 * before they reach `sql.raw`. A dimension added to the enum without an
 * expression here is a TypeScript error, not a string that reaches the database.
 */

import { asc, eq, sql } from 'drizzle-orm';
import { executeRows } from '@oxyhq/db';
import {
  INFERENCE_MONEY_SCALE,
  inferenceEnvironmentSchema,
  inferenceRequestOutcomeSchema,
  usageSourceSchema,
} from '@oxyhq/contracts';
import { getDb, type DatabaseOrTransaction } from '../config/postgres';
import { accountBalances } from '../db/schema/accountBalances';
import { applicationCredentials } from '../db/schema/applicationCredentials';
import { applications } from '../db/schema/applications';
import { billingProfiles } from '../db/schema/billingProfiles';
import { inferenceUsageDailyRollups } from '../db/schema/inferenceUsageDailyRollups';
import {
  spendingLimits,
  type SpendingLimitEnforcement,
  type SpendingLimitPeriod,
  type SpendingLimitScope,
  type SpendingLimitStatus,
} from '../db/schema/spendingLimits';
import { usageReceipts } from '../db/schema/usageReceipts';
import { usageRefunds } from '../db/schema/usageRefunds';
import { usageReservations } from '../db/schema/usageReservations';
import { userAncestors } from '../db/schema/userAncestors';
import type {
  SpendDimension,
  SpendingLimitCreateBody,
  SpendingLimitUpdateBody,
  UsageDimension,
  UsageUnitTotals,
} from '../schemas/inferenceReporting.schemas';
import { resolveBillingAccount } from './inferenceLedger.service';
import { readSpendingLimitUtilization } from './spendingLimit.service';

/** The rounding scale every computed amount is reported at, as a SQL literal. */
const MONEY_SCALE = sql.raw(String(INFERENCE_MONEY_SCALE));

/**
 * `to_char` mask producing exactly the ISO-8601 instant the projections require.
 *
 * Bound as a PARAMETER, not `sql.raw`: it is a value the function takes, and a
 * format string is the one place a raw interpolation buys nothing at all.
 */
const ISO_INSTANT = 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"';

/* -------------------------------------------------------------------------- */
/*  Conversions                                                               */
/* -------------------------------------------------------------------------- */

/**
 * A count that was cast to `text` in SQL, as a number.
 *
 * Throws rather than coercing: a `NaN` reaching a customer's usage chart is a
 * silent wrong answer, while a throw is a 500 somebody fixes. Every quantity in
 * the unit contract is inside `Number.MAX_SAFE_INTEGER` by construction
 * (`z.number().int().nonnegative().safe()`), so a value outside it means the
 * column, not the conversion, is wrong.
 */
function toCount(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`expected a non-negative safe integer from SQL, received ${String(value)}`);
  }
  return parsed;
}

/**
 * A closed-vocabulary column, narrowed.
 *
 * `executeRows` hands back whatever the driver decoded, so a column the database
 * constrains with a CHECK still arrives as `unknown` here. Rather than widening
 * the projections to `string` — which would let a future value reach a customer
 * unremarked — a value outside the vocabulary THROWS. Every one of these columns
 * has a CHECK behind it, so a throw means the CHECK and this list disagree,
 * which is a bug to see rather than a string to pass along.
 */
function asEnum<T extends string>(values: readonly T[], value: unknown, column: string): T {
  const candidate = String(value);
  const found = values.find((option) => option === candidate);
  if (found === undefined) {
    throw new Error(`unexpected ${column} '${candidate}' from SQL`);
  }
  return found;
}

/*
 * The three closed vocabularies, taken from the CONTRACT rather than restated.
 * The columns these are read from carry CHECKs against the same tuples, so a
 * local copy here would be a fourth place for one value set to live.
 */
const ENVIRONMENTS = inferenceEnvironmentSchema.options;
const OUTCOMES = inferenceRequestOutcomeSchema.options;
const USAGE_SOURCES = usageSourceSchema.options;

export type ReportingEnvironment = (typeof ENVIRONMENTS)[number];
export type ReportingOutcome = (typeof OUTCOMES)[number];
export type ReportingUsageSource = (typeof USAGE_SOURCES)[number];

/** The eleven unit columns, in the order every projection reports them. */
const UNIT_COLUMNS = [
  'input_tokens',
  'cached_input_tokens',
  'output_tokens',
  'reasoning_tokens',
  'requests',
  'images',
  'audio_input_milliseconds',
  'audio_output_milliseconds',
  'video_milliseconds',
  'characters',
  'embeddings',
] as const;

/** The eleven unit quantities of one row, read from their `::text` casts. */
function unitsOf(row: Record<string, unknown>): UsageUnitTotals {
  return {
    input_tokens: toCount(row.input_tokens),
    cached_input_tokens: toCount(row.cached_input_tokens),
    output_tokens: toCount(row.output_tokens),
    reasoning_tokens: toCount(row.reasoning_tokens),
    requests: toCount(row.requests),
    images: toCount(row.images),
    audio_input_milliseconds: toCount(row.audio_input_milliseconds),
    audio_output_milliseconds: toCount(row.audio_output_milliseconds),
    video_milliseconds: toCount(row.video_milliseconds),
    characters: toCount(row.characters),
    embeddings: toCount(row.embeddings),
  };
}

/* -------------------------------------------------------------------------- */
/*  Account scope                                                             */
/* -------------------------------------------------------------------------- */

/**
 * The accounts a report covers: the account itself, and its descendants when
 * asked for.
 *
 * Descendants come from the materialised `user_ancestors` path — the same tree
 * `resolveEffectiveMembership` walks and the same one an account-scoped spending
 * limit covers, so a budget, a permission and a report cannot come to different
 * answers about the shape of an organization.
 *
 * OFF by default. An organization's own figures and its whole subtree's figures
 * are different numbers, and silently returning the larger one would overstate
 * every chart built on it.
 */
export async function resolveReportingAccounts(
  accountId: string,
  includeDescendants: boolean
): Promise<string[]> {
  if (!includeDescendants) return [accountId];

  const rows = await getDb()
    .select({ userId: userAncestors.userId })
    .from(userAncestors)
    .where(eq(userAncestors.ancestorId, accountId));

  return Array.from(new Set([accountId, ...rows.map((row) => row.userId)]));
}

/**
 * Refuse a report that names no scope at all.
 *
 * The one direction that matters: an account filter and an application filter
 * both absent is a report over every tenant on the platform. Unreachable from
 * the routes, which always establish one or the other before calling — which is
 * exactly why it throws rather than returning an empty result a caller could
 * mistake for "this customer has no usage".
 */
function assertScoped(query: {
  readonly accountIds?: readonly string[];
  readonly applicationId?: string;
}): void {
  if (query.accountIds === undefined && query.applicationId === undefined) {
    throw new Error('a report must be scoped to an account set or to an application');
  }
}

/* -------------------------------------------------------------------------- */
/*  Usage aggregates — `inference_usage_daily_rollups`                        */
/* -------------------------------------------------------------------------- */

/**
 * Dimension → the SQL that produces it.
 *
 * `day` is rendered with `to_char` rather than read as a `date`: how the driver
 * decodes a bare `date` is the driver's business, and a report naming a
 * different day than the rollup keyed on is the worst bug available here.
 */
const USAGE_DIMENSION_SQL: Readonly<Record<UsageDimension, string>> = {
  day: `to_char(r.day, 'YYYY-MM-DD')`,
  account: 'r.account_id',
  application: 'r.application_id',
  credential: 'r.application_credential_id',
  environment: 'r.environment',
  requestedModel: 'r.requested_model_reference',
  provider: 'r.serving_provider',
  outcome: 'r.outcome',
};

export interface UsageQuery {
  /** Absent for an application-scoped report, which is scoped by the app. */
  readonly accountIds?: readonly string[];
  readonly from: string;
  readonly to: string;
  readonly groupBy: readonly UsageDimension[];
  readonly applicationId?: string;
  readonly applicationCredentialId?: string;
  readonly environment?: string;
  readonly limit: number;
}

/**
 * One aggregated usage row, with each dimension in its own NAMED field.
 *
 * Deliberately not a `Record<string, string>` bag: the route builds its response
 * from these fields as an object literal with a declared type, and an index
 * signature would switch off TypeScript's excess-property check at exactly the
 * boundary where "this projection cannot carry a wholesale cost" is enforced.
 */
export interface UsageAggregate extends UsageDimensionFields {
  readonly requestCount: number;
  readonly errorCount: number;
  readonly units: UsageUnitTotals;
}

/** The dimension half of a {@link UsageAggregate}, mutable while it is filled. */
interface UsageDimensionFields {
  day?: string;
  accountId?: string;
  applicationId?: string;
  applicationCredentialId?: string;
  environment?: ReportingEnvironment;
  requestedModelReference?: string;
  servingProvider?: string;
  outcome?: ReportingOutcome;
}

/**
 * Place one grouped column into its named field.
 *
 * An exhaustive `switch` over the closed dimension union, so a dimension added
 * to the enum without a case here is a TypeScript error rather than a silently
 * dropped column.
 */
function placeUsageDimension(
  into: UsageDimensionFields,
  dimension: UsageDimension,
  value: string
): void {
  switch (dimension) {
    case 'day':
      into.day = value;
      return;
    case 'account':
      into.accountId = value;
      return;
    case 'application':
      into.applicationId = value;
      return;
    case 'credential':
      into.applicationCredentialId = value;
      return;
    case 'environment':
      into.environment = asEnum(ENVIRONMENTS, value, 'environment');
      return;
    case 'requestedModel':
      into.requestedModelReference = value;
      return;
    case 'provider':
      into.servingProvider = value;
      return;
    case 'outcome':
      into.outcome = asEnum(OUTCOMES, value, 'outcome');
  }
}

export interface UsageAggregateResult {
  readonly rows: UsageAggregate[];
  readonly truncated: boolean;
}

/**
 * Aggregate one account set's usage over a date range.
 *
 * EVENTUALLY CONSISTENT — the rollup is maintained outside the ledger
 * transaction. Every caller says so in its response; it is a required literal on
 * `usageReportSchema`, so it cannot be dropped by accident.
 *
 * Fetches `limit + 1` rows to distinguish "this is everything" from "this is the
 * first page": a result of exactly `limit` rows is otherwise ambiguous, and the
 * ambiguity always resolves the reassuring way.
 */
export async function aggregateUsage(query: UsageQuery): Promise<UsageAggregateResult> {
  assertScoped(query);

  const selections = query.groupBy.map(
    (dimension, index) => `${USAGE_DIMENSION_SQL[dimension]} as dim_${index}`
  );
  const grouping = query.groupBy.map((dimension) => USAGE_DIMENSION_SQL[dimension]);
  const unitSums = UNIT_COLUMNS.map((column) => `sum(r.${column})::bigint::text as ${column}`);

  const rows = await executeRows<Record<string, unknown>>(
    getDb(),
    sql`
      select
        ${sql.raw(selections.join(', '))},
        sum(r.request_count)::bigint::text as request_count,
        sum(r.error_count)::bigint::text as error_count,
        ${sql.raw(unitSums.join(', '))}
      from ${inferenceUsageDailyRollups} r
      where r.day >= ${query.from}::date
        and r.day <= ${query.to}::date
        ${
          query.accountIds === undefined
            ? sql``
            : sql`and r.account_id = any(${sql.param([...query.accountIds])}::text[])`
        }
        ${
          query.applicationId === undefined
            ? sql``
            : sql`and r.application_id = ${query.applicationId}`
        }
        ${
          query.applicationCredentialId === undefined
            ? sql``
            : sql`and r.application_credential_id = ${query.applicationCredentialId}`
        }
        ${query.environment === undefined ? sql`` : sql`and r.environment = ${query.environment}`}
      group by ${sql.raw(grouping.join(', '))}
      order by ${sql.raw(grouping.join(', '))}
      limit ${query.limit + 1}
    `
  );

  return {
    truncated: rows.length > query.limit,
    rows: rows.slice(0, query.limit).map((row): UsageAggregate => {
      const dimensions: UsageDimensionFields = {};
      query.groupBy.forEach((dimension, index) => {
        placeUsageDimension(dimensions, dimension, String(row[`dim_${index}`]));
      });
      return {
        ...dimensions,
        requestCount: toCount(row.request_count),
        errorCount: toCount(row.error_count),
        units: unitsOf(row),
      };
    }),
  };
}

/* -------------------------------------------------------------------------- */
/*  Spend aggregates — `usage_receipts`                                       */
/* -------------------------------------------------------------------------- */

const SPEND_DIMENSION_SQL: Readonly<Record<SpendDimension, string>> = {
  // The receipt's own UTC settlement day, so a spend chart and a usage chart
  // agree about which side of midnight a request fell on.
  day: `to_char(r.settled_at at time zone 'UTC', 'YYYY-MM-DD')`,
  account: 'r.account_id',
  application: 'r.application_id',
  credential: 'r.application_credential_id',
  environment: 'r.environment',
  resolvedModel: 'r.resolved_model_reference',
  provider: 'r.serving_provider',
  outcome: 'r.outcome',
};

/** The dimension half of a {@link SpendAggregate}, mutable while it is filled. */
interface SpendDimensionFields {
  day?: string;
  accountId?: string;
  applicationId?: string;
  applicationCredentialId?: string;
  environment?: ReportingEnvironment;
  resolvedModelReference?: string;
  servingProvider?: string;
  outcome?: ReportingOutcome;
}

/** Exhaustive over the closed union, for the reason `placeUsageDimension` is. */
function placeSpendDimension(
  into: SpendDimensionFields,
  dimension: SpendDimension,
  value: string
): void {
  switch (dimension) {
    case 'day':
      into.day = value;
      return;
    case 'account':
      into.accountId = value;
      return;
    case 'application':
      into.applicationId = value;
      return;
    case 'credential':
      into.applicationCredentialId = value;
      return;
    case 'environment':
      into.environment = asEnum(ENVIRONMENTS, value, 'environment');
      return;
    case 'resolvedModel':
      into.resolvedModelReference = value;
      return;
    case 'provider':
      into.servingProvider = value;
      return;
    case 'outcome':
      into.outcome = asEnum(OUTCOMES, value, 'outcome');
  }
}

export interface SpendQuery {
  /** Absent for an application-scoped report, which is scoped by the app. */
  readonly accountIds?: readonly string[];
  readonly from: string;
  readonly to: string;
  readonly groupBy: readonly SpendDimension[];
  readonly applicationId?: string;
  readonly applicationCredentialId?: string;
  readonly environment?: string;
  readonly limit: number;
}

export interface SpendAggregate extends SpendDimensionFields {
  readonly currency: string;
  readonly receiptCount: number;
  readonly billedAmount: string;
  readonly refundedAmount: string;
  readonly netAmount: string;
}

export interface SpendTotal {
  readonly currency: string;
  readonly receiptCount: number;
  readonly billedAmount: string;
  readonly refundedAmount: string;
  readonly netAmount: string;
}

export interface SpendAggregateResult {
  readonly rows: SpendAggregate[];
  readonly totals: SpendTotal[];
  readonly truncated: boolean;
}

/**
 * The receipts a spend report is computed over, with each receipt's reversals
 * already folded in.
 *
 * A LATERAL rather than a join onto the refund rows, because a receipt with two
 * partial reversals must contribute ONE refunded figure: joining the rows
 * directly would multiply that receipt's `billed_amount` by the number of
 * refunds against it, inflating spend in exactly the accounts that had a
 * correction.
 */
function chargedReceipts(query: {
  readonly accountIds?: readonly string[];
  readonly from: string;
  readonly to: string;
  readonly applicationId?: string;
  readonly applicationCredentialId?: string;
  readonly environment?: string;
}) {
  return sql`
    select
      rc.id,
      rc.account_id,
      rc.application_id,
      rc.application_credential_id,
      rc.environment,
      rc.resolved_model_reference,
      rc.serving_provider,
      rc.outcome,
      rc.currency,
      rc.settled_at,
      rc.billed_amount,
      coalesce(refund.amount, 0) as refunded_amount
    from ${usageReceipts} rc
    left join lateral (
      select sum(f.amount) as amount
      from ${usageRefunds} f
      where f.subject_kind = 'receipt' and f.receipt_id = rc.id
    ) refund on true
    where rc.settled_at >= ${query.from}::date
      and rc.settled_at < (${query.to}::date + interval '1 day')
      ${
        query.accountIds === undefined
          ? sql``
          : sql`and rc.account_id = any(${sql.param([...query.accountIds])}::text[])`
      }
      ${
        query.applicationId === undefined
          ? sql``
          : sql`and rc.application_id = ${query.applicationId}`
      }
      ${
        query.applicationCredentialId === undefined
          ? sql``
          : sql`and rc.application_credential_id = ${query.applicationCredentialId}`
      }
      ${query.environment === undefined ? sql`` : sql`and rc.environment = ${query.environment}`}
  `;
}

/**
 * Aggregate settled spend over a date range.
 *
 * `currency` is ALWAYS a grouping key, whether or not the caller asked for it: a
 * sum across two currencies is arithmetic on incomparable quantities, and the
 * only honest way to present it is as two rows.
 */
export async function aggregateSpend(query: SpendQuery): Promise<SpendAggregateResult> {
  assertScoped(query);

  const selections = query.groupBy.map(
    (dimension, index) => `${SPEND_DIMENSION_SQL[dimension]} as dim_${index}`
  );
  const grouping = [
    ...query.groupBy.map((dimension) => SPEND_DIMENSION_SQL[dimension]),
    'r.currency',
  ];

  const db = getDb();
  const charged = chargedReceipts(query);

  const rows = await executeRows<Record<string, unknown>>(
    db,
    sql`
      with r as (${charged})
      select
        ${sql.raw(selections.join(', '))},
        r.currency,
        count(*)::bigint::text as receipt_count,
        round(sum(r.billed_amount), ${MONEY_SCALE})::text as billed_amount,
        round(sum(r.refunded_amount), ${MONEY_SCALE})::text as refunded_amount,
        round(sum(r.billed_amount) - sum(r.refunded_amount), ${MONEY_SCALE})::text as net_amount
      from r
      group by ${sql.raw(grouping.join(', '))}
      order by ${sql.raw(grouping.join(', '))}
      limit ${query.limit + 1}
    `
  );

  const totals = await executeRows<Record<string, unknown>>(
    db,
    sql`
      with r as (${charged})
      select
        r.currency,
        count(*)::bigint::text as receipt_count,
        round(sum(r.billed_amount), ${MONEY_SCALE})::text as billed_amount,
        round(sum(r.refunded_amount), ${MONEY_SCALE})::text as refunded_amount,
        round(sum(r.billed_amount) - sum(r.refunded_amount), ${MONEY_SCALE})::text as net_amount
      from r
      group by r.currency
      order by r.currency
    `
  );

  return {
    truncated: rows.length > query.limit,
    rows: rows.slice(0, query.limit).map((row): SpendAggregate => {
      const dimensions: SpendDimensionFields = {};
      query.groupBy.forEach((dimension, index) => {
        placeSpendDimension(dimensions, dimension, String(row[`dim_${index}`]));
      });
      return {
        ...dimensions,
        currency: String(row.currency),
        receiptCount: toCount(row.receipt_count),
        billedAmount: String(row.billed_amount),
        refundedAmount: String(row.refunded_amount),
        netAmount: String(row.net_amount),
      };
    }),
    totals: totals.map((row) => ({
      currency: String(row.currency),
      receiptCount: toCount(row.receipt_count),
      billedAmount: String(row.billed_amount),
      refundedAmount: String(row.refunded_amount),
      netAmount: String(row.net_amount),
    })),
  };
}

/* -------------------------------------------------------------------------- */
/*  Balance — `account_balances` + `billing_profiles`                         */
/* -------------------------------------------------------------------------- */

export interface BalanceBucket {
  readonly currency: string;
  readonly purchased: string;
  readonly promotional: string;
  readonly reserved: string;
  readonly invoicedOutstanding: string;
  readonly availableToSpend: string;
}

export type AccountBalanceResult =
  | { readonly status: 'not-provisioned' }
  | {
      readonly status: 'resolved';
      readonly billingAccountId: string;
      readonly billingMode: 'prepaid' | 'invoiced';
      readonly creditLimit: string;
      readonly buckets: BalanceBucket[];
    };

/**
 * An account's balance, with purchased, promotional and reserved money kept
 * apart.
 *
 * The paying account is resolved through the SAME nearest-ancestor walk the
 * ledger reserves against (`resolveBillingAccount`), so a customer is shown the
 * balance a request would actually draw on — not a per-account row that happens
 * to exist beside it.
 *
 * `not-provisioned` rather than a zeroed balance: zero means "spent everything",
 * absent means "nobody has decided who pays for this account yet", and the two
 * need different things done about them.
 */
export async function readAccountBalance(accountId: string): Promise<AccountBalanceResult> {
  const db = getDb();

  /*
   * An account's OWN profile is read at ANY status; only the INHERITED case goes
   * through the active-filtered walk.
   *
   * `resolveBillingAccount` filters on `status = 'active'`, correctly for
   * SPENDING: a suspended profile may not be drawn from, and an account must not
   * silently start drawing on a suspended ancestor either. But this is a READ,
   * and applying that filter to it reports a suspended account as
   * `not-provisioned` — which collapses "you are suspended" into "nobody has
   * decided who pays for you". Those are different facts with different fixes,
   * and the entitlement interface hands the second one to Alia as "this account
   * cannot be charged at all" (#972 section 7.5).
   */
  const [own] = await db
    .select()
    .from(billingProfiles)
    .where(eq(billingProfiles.accountId, accountId))
    .limit(1);

  const billing =
    own === undefined
      ? await (async () => {
          const resolution = await resolveBillingAccount(db, accountId);
          return resolution.status === 'not-provisioned' ? undefined : resolution.billingAccount;
        })()
      : {
          accountId: own.accountId,
          currency: own.currency,
          billingMode: own.billingMode,
          creditLimit: own.creditLimit,
        };

  if (billing === undefined) {
    return { status: 'not-provisioned' };
  }

  const rows = await executeRows<Record<string, unknown>>(
    db,
    sql`
      select
        ab.currency,
        ab.purchased_balance::text as purchased,
        ab.promotional_balance::text as promotional,
        ab.reserved_balance::text as reserved,
        ab.invoiced_outstanding::text as invoiced_outstanding,
        -- Derived HEADROOM, offered beside the buckets rather than instead of
        -- them: an invoiced account can also spend its unused credit line.
        round(
          ab.promotional_balance + ab.purchased_balance
          + case when bp.billing_mode = 'invoiced'
                 then greatest(0::numeric, bp.credit_limit - ab.invoiced_outstanding)
                 else 0::numeric
            end,
          ${MONEY_SCALE}
        )::text as available_to_spend
      from ${accountBalances} ab
      join ${billingProfiles} bp on bp.account_id = ab.account_id
      where ab.account_id = ${billing.accountId}
      order by ab.currency
    `
  );

  return {
    status: 'resolved',
    billingAccountId: billing.accountId,
    billingMode: billing.billingMode,
    creditLimit: billing.creditLimit,
    buckets: rows.map((row) => ({
      currency: String(row.currency),
      purchased: String(row.purchased),
      promotional: String(row.promotional),
      reserved: String(row.reserved),
      invoicedOutstanding: String(row.invoiced_outstanding),
      availableToSpend: String(row.available_to_spend),
    })),
  };
}

/* -------------------------------------------------------------------------- */
/*  Pending reservations — `usage_reservations`                               */
/* -------------------------------------------------------------------------- */

export interface PendingReservation {
  readonly reservationId: string;
  readonly requestId: string;
  readonly applicationId: string;
  readonly applicationCredentialId: string;
  readonly environment: ReportingEnvironment;
  readonly reservedAmount: string;
  readonly currency: string;
  readonly createdAt: string;
  readonly expiresAt: string;
}

export interface PendingReservationsResult {
  readonly rows: PendingReservation[];
  readonly totals: { currency: string; reservationCount: number; heldAmount: string }[];
  readonly truncated: boolean;
}

/**
 * Money currently HELD against the account — never money spent.
 *
 * `status = 'held'` only. A settled reservation is not pending and its money has
 * become a charge; an expired one was already released by a refund with a
 * reason. Listing either here would present released money as though it were
 * still held.
 */
export async function listPendingReservations(query: {
  readonly accountIds: readonly string[];
  readonly limit: number;
}): Promise<PendingReservationsResult> {
  const db = getDb();
  const accounts = sql.param([...query.accountIds]);

  const rows = await executeRows<Record<string, unknown>>(
    db,
    sql`
      select
        res.id,
        res.request_id,
        res.application_id,
        res.application_credential_id,
        res.environment,
        res.reserved_amount::text as reserved_amount,
        res.currency,
        to_char(res.created_at at time zone 'UTC', ${ISO_INSTANT}::text) as created_at,
        to_char(res.expires_at at time zone 'UTC', ${ISO_INSTANT}::text) as expires_at
      from ${usageReservations} res
      where res.account_id = any(${accounts}::text[])
        and res.status = 'held'
      order by res.created_at desc, res.id
      limit ${query.limit + 1}
    `
  );

  const totals = await executeRows<Record<string, unknown>>(
    db,
    sql`
      select
        res.currency,
        count(*)::bigint::text as reservation_count,
        round(sum(res.reserved_amount), ${MONEY_SCALE})::text as held_amount
      from ${usageReservations} res
      where res.account_id = any(${accounts}::text[])
        and res.status = 'held'
      group by res.currency
      order by res.currency
    `
  );

  return {
    truncated: rows.length > query.limit,
    rows: rows.slice(0, query.limit).map((row): PendingReservation => ({
      reservationId: String(row.id),
      requestId: String(row.request_id),
      applicationId: String(row.application_id),
      applicationCredentialId: String(row.application_credential_id),
      environment: asEnum(ENVIRONMENTS, row.environment, 'environment'),
      reservedAmount: String(row.reserved_amount),
      currency: String(row.currency),
      createdAt: String(row.created_at),
      expiresAt: String(row.expires_at),
    })),
    totals: totals.map((row) => ({
      currency: String(row.currency),
      reservationCount: toCount(row.reservation_count),
      heldAmount: String(row.held_amount),
    })),
  };
}

/* -------------------------------------------------------------------------- */
/*  Settled charges — `usage_receipts`                                        */
/* -------------------------------------------------------------------------- */

export interface SettledChargeRow {
  readonly receiptId: string;
  readonly requestId: string;
  readonly generationId?: string;
  readonly reservationId?: string;
  readonly correctsReceiptId?: string;
  readonly applicationId: string;
  readonly applicationCredentialId: string;
  readonly environment: ReportingEnvironment;
  readonly outcome: ReportingOutcome;
  readonly usageSource: ReportingUsageSource;
  readonly resolvedModelReference: string;
  readonly servingProvider: string;
  readonly platformFeeOnly: boolean;
  readonly billedAmount: string;
  readonly refundedAmount: string;
  readonly netAmount: string;
  readonly currency: string;
  readonly settledAt: string;
  readonly units: UsageUnitTotals;
}

export interface SettledChargesResult {
  readonly rows: SettledChargeRow[];
  readonly truncated: boolean;
}

/**
 * Individual settled charges, newest first.
 *
 * The counterpart of {@link listPendingReservations}: everything here has been
 * charged, for the exact amount, and everything there has not been charged at
 * all. Two endpoints rather than one list with a status column, because a hold
 * read as a bill is the confusion this whole separation exists to prevent.
 */
export async function listSettledCharges(query: {
  /** Absent for an application-scoped list, which is scoped by the app. */
  readonly accountIds?: readonly string[];
  readonly from: string;
  readonly to: string;
  readonly applicationId?: string;
  readonly applicationCredentialId?: string;
  readonly limit: number;
}): Promise<SettledChargesResult> {
  assertScoped(query);

  const unitSelections = UNIT_COLUMNS.map((column) => `r.${column}::text as ${column}`);

  const rows = await executeRows<Record<string, unknown>>(
    getDb(),
    sql`
      select
        r.id,
        r.request_id,
        r.generation_id,
        r.reservation_id,
        r.corrects_receipt_id,
        r.application_id,
        r.application_credential_id,
        r.environment,
        r.outcome,
        r.usage_source,
        r.resolved_model_reference,
        r.serving_provider,
        r.platform_fee_only,
        r.billed_amount::text as billed_amount,
        round(coalesce(refund.amount, 0), ${MONEY_SCALE})::text as refunded_amount,
        round(r.billed_amount - coalesce(refund.amount, 0), ${MONEY_SCALE})::text as net_amount,
        r.currency,
        to_char(r.settled_at at time zone 'UTC', ${ISO_INSTANT}::text) as settled_at,
        ${sql.raw(unitSelections.join(', '))}
      from ${usageReceipts} r
      left join lateral (
        select sum(f.amount) as amount
        from ${usageRefunds} f
        where f.subject_kind = 'receipt' and f.receipt_id = r.id
      ) refund on true
      where r.settled_at >= ${query.from}::date
        and r.settled_at < (${query.to}::date + interval '1 day')
        ${
          query.accountIds === undefined
            ? sql``
            : sql`and r.account_id = any(${sql.param([...query.accountIds])}::text[])`
        }
        ${
          query.applicationId === undefined
            ? sql``
            : sql`and r.application_id = ${query.applicationId}`
        }
        ${
          query.applicationCredentialId === undefined
            ? sql``
            : sql`and r.application_credential_id = ${query.applicationCredentialId}`
        }
      order by r.settled_at desc, r.id
      limit ${query.limit + 1}
    `
  );

  return {
    truncated: rows.length > query.limit,
    rows: rows.slice(0, query.limit).map((row): SettledChargeRow => ({
      receiptId: String(row.id),
      requestId: String(row.request_id),
      ...(row.generation_id === null ? {} : { generationId: String(row.generation_id) }),
      ...(row.reservation_id === null ? {} : { reservationId: String(row.reservation_id) }),
      ...(row.corrects_receipt_id === null
        ? {}
        : { correctsReceiptId: String(row.corrects_receipt_id) }),
      applicationId: String(row.application_id),
      applicationCredentialId: String(row.application_credential_id),
      environment: asEnum(ENVIRONMENTS, row.environment, 'environment'),
      outcome: asEnum(OUTCOMES, row.outcome, 'outcome'),
      usageSource: asEnum(USAGE_SOURCES, row.usage_source, 'usage_source'),
      resolvedModelReference: String(row.resolved_model_reference),
      servingProvider: String(row.serving_provider),
      platformFeeOnly: row.platform_fee_only === true,
      billedAmount: String(row.billed_amount),
      refundedAmount: String(row.refunded_amount),
      netAmount: String(row.net_amount),
      currency: String(row.currency),
      settledAt: String(row.settled_at),
      units: unitsOf(row),
    })),
  };
}

/* -------------------------------------------------------------------------- */
/*  Budgets — `spending_limits`                                               */
/* -------------------------------------------------------------------------- */

export interface SpendingLimitReport {
  readonly spendingLimitId: string;
  readonly accountId: string;
  readonly scope: SpendingLimitScope;
  readonly scopeAccountId?: string;
  readonly scopeApplicationId?: string;
  readonly scopeApplicationCredentialId?: string;
  readonly period: SpendingLimitPeriod;
  readonly limitAmount: string;
  readonly currency: string;
  readonly enforcement: SpendingLimitEnforcement;
  readonly alertThresholdBps: number[];
  readonly status: SpendingLimitStatus;
  readonly periodStart: string;
  readonly currentSpend: string;
  readonly remaining: string;
  readonly utilizationBps: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/**
 * Every budget an account owns, with what has been spent against each.
 *
 * Utilization comes from {@link readSpendingLimitUtilization} — the SAME query
 * the reservation path enforces with — called once per CURRENCY, because that
 * query scopes its receipt, refund and reservation sums to one currency and a
 * single mixed call would silently omit every limit denominated in the currency
 * it did not ask about.
 */
export async function listSpendingLimits(accountId: string): Promise<SpendingLimitReport[]> {
  const db = getDb();

  const configured = await db
    .select()
    .from(spendingLimits)
    .where(eq(spendingLimits.accountId, accountId))
    .orderBy(asc(spendingLimits.createdAt), asc(spendingLimits.id));

  if (configured.length === 0) return [];

  const byCurrency = new Map<string, string[]>();
  for (const limit of configured) {
    const ids = byCurrency.get(limit.currency);
    if (ids === undefined) byCurrency.set(limit.currency, [limit.id]);
    else ids.push(limit.id);
  }

  const spendByLimit = new Map<string, { periodStartMs: string; currentSpend: string }>();
  for (const [currency, ids] of byCurrency) {
    for (const row of await readSpendingLimitUtilization(db, ids, currency, '0')) {
      spendByLimit.set(row.id, {
        periodStartMs: row.period_start_ms,
        currentSpend: row.current_spend,
      });
    }
  }

  const ratios = await deriveLimitUtilization(
    db,
    configured.map((limit) => ({
      id: limit.id,
      limitAmount: limit.limitAmount,
      currentSpend: spendByLimit.get(limit.id)?.currentSpend ?? '0',
    }))
  );

  return configured.map((limit) => {
    const spend = spendByLimit.get(limit.id);
    const ratio = ratios.get(limit.id);
    if (spend === undefined || ratio === undefined) {
      // Both maps are built from `configured` itself, and the utilization query
      // returns one row per id it is given. A gap means one of those two facts
      // stopped being true, which is a bug to see rather than a zero to report.
      throw new Error(`spending limit ${limit.id} has no utilization row`);
    }
    return {
      spendingLimitId: limit.id,
      accountId: limit.accountId,
      scope: limit.scope,
      ...(limit.scopeAccountId === null ? {} : { scopeAccountId: limit.scopeAccountId }),
      ...(limit.scopeApplicationId === null
        ? {}
        : { scopeApplicationId: limit.scopeApplicationId }),
      ...(limit.scopeApplicationCredentialId === null
        ? {}
        : { scopeApplicationCredentialId: limit.scopeApplicationCredentialId }),
      period: limit.period,
      limitAmount: limit.limitAmount,
      currency: limit.currency,
      enforcement: limit.enforcement,
      alertThresholdBps: [...limit.alertThresholdBps],
      status: limit.status,
      periodStart: new Date(Number(spend.periodStartMs)).toISOString(),
      currentSpend: ratio.currentSpend,
      remaining: ratio.remaining,
      utilizationBps: ratio.utilizationBps,
      createdAt: limit.createdAt.toISOString(),
      updatedAt: limit.updatedAt.toISOString(),
    };
  });
}

/**
 * `remaining` and `utilizationBps` for a set of limits, computed by Postgres.
 *
 * `utilizationBps` is CLAMPED at 10000 rather than allowed past it: a soft-stop
 * budget legitimately goes over, and an unclamped ratio renders a progress bar
 * past its own end. Nothing is hidden by the clamp — the amount actually spent
 * is still reported exactly, in `currentSpend`.
 */
async function deriveLimitUtilization(
  db: DatabaseOrTransaction,
  limits: readonly { id: string; limitAmount: string; currentSpend: string }[]
): Promise<Map<string, { currentSpend: string; remaining: string; utilizationBps: number }>> {
  if (limits.length === 0) return new Map();

  const values = sql.join(
    limits.map(
      (limit) =>
        sql`(${limit.id}::text, ${limit.limitAmount}::numeric, ${limit.currentSpend}::numeric)`
    ),
    sql`, `
  );

  const rows = await executeRows<Record<string, unknown>>(
    db,
    sql`
      select
        l.id,
        round(l.spend, ${MONEY_SCALE})::text as current_spend,
        round(greatest(0::numeric, l.cap - l.spend), ${MONEY_SCALE})::text as remaining,
        -- limit_amount > 0 is a CHECK on the column, so this cannot divide by zero.
        least(10000, floor(l.spend * 10000 / l.cap))::int as utilization_bps
      from (values ${values}) as l(id, cap, spend)
    `
  );

  return new Map(
    rows.map((row) => [
      String(row.id),
      {
        currentSpend: String(row.current_spend),
        remaining: String(row.remaining),
        utilizationBps: toCount(row.utilization_bps),
      },
    ])
  );
}

/** Where a budget's scope target sits in the account graph. */
export type SpendingLimitScopeOwner =
  | { readonly status: 'resolved'; readonly ownerAccountId: string }
  | { readonly status: 'unknown-target' };

/**
 * The account that owns whatever a proposed budget is scoped to.
 *
 * Resolved SERVER-side and then checked against the caller's own account, so a
 * budget can never be attached to another tenant's application or credential by
 * naming its id in a request body. An unresolvable target is `unknown-target`
 * rather than an exception, because the route answers it as a 404 — the same
 * answer an unauthorised target gets, so the id space is not an existence
 * oracle.
 */
export async function resolveSpendingLimitScopeOwner(
  body: SpendingLimitCreateBody
): Promise<SpendingLimitScopeOwner> {
  const db = getDb();

  if (body.scope === 'account') {
    return { status: 'resolved', ownerAccountId: body.scopeAccountId };
  }

  if (body.scope === 'application') {
    const [row] = await db
      .select({ ownerAccountId: applications.ownerAccountId })
      .from(applications)
      .where(eq(applications.id, body.scopeApplicationId))
      .limit(1);
    return row === undefined
      ? { status: 'unknown-target' }
      : { status: 'resolved', ownerAccountId: row.ownerAccountId };
  }

  const [row] = await db
    .select({ ownerAccountId: applications.ownerAccountId })
    .from(applicationCredentials)
    .innerJoin(applications, eq(applications.id, applicationCredentials.applicationId))
    .where(eq(applicationCredentials.id, body.scopeApplicationCredentialId))
    .limit(1);
  return row === undefined
    ? { status: 'unknown-target' }
    : { status: 'resolved', ownerAccountId: row.ownerAccountId };
}

export type CreateSpendingLimitResult =
  | { readonly status: 'created'; readonly spendingLimitId: string }
  | { readonly status: 'scope-taken' };

/**
 * Create a budget.
 *
 * `ON CONFLICT DO NOTHING RETURNING`, never a caught duplicate-key error: a
 * duplicate key and a dropped connection are indistinguishable inside a `catch`,
 * so an exception handler would answer "already configured" to an infrastructure
 * failure. The conflict is one of the three partial uniques on
 * `(scope target, period)` — one budget per target per window.
 */
export async function createSpendingLimit(
  accountId: string,
  body: SpendingLimitCreateBody
): Promise<CreateSpendingLimitResult> {
  const [row] = await getDb()
    .insert(spendingLimits)
    .values({
      accountId,
      scope: body.scope,
      ...(body.scope === 'account' ? { scopeAccountId: body.scopeAccountId } : {}),
      ...(body.scope === 'application' ? { scopeApplicationId: body.scopeApplicationId } : {}),
      ...(body.scope === 'credential'
        ? { scopeApplicationCredentialId: body.scopeApplicationCredentialId }
        : {}),
      period: body.period,
      limitAmount: body.limitAmount,
      ...(body.currency === undefined ? {} : { currency: body.currency }),
      enforcement: body.enforcement,
      alertThresholdBps: [...body.alertThresholdBps],
    })
    .onConflictDoNothing()
    .returning({ id: spendingLimits.id });

  return row === undefined
    ? { status: 'scope-taken' }
    : { status: 'created', spendingLimitId: row.id };
}

export type UpdateSpendingLimitResult =
  | { readonly status: 'updated' }
  | { readonly status: 'unknown-limit' };

/** Edit a budget's ceiling, enforcement, alerts or status. Never its scope. */
export async function updateSpendingLimit(
  spendingLimitId: string,
  body: SpendingLimitUpdateBody
): Promise<UpdateSpendingLimitResult> {
  const [row] = await getDb()
    .update(spendingLimits)
    .set({
      ...(body.limitAmount === undefined ? {} : { limitAmount: body.limitAmount }),
      ...(body.enforcement === undefined ? {} : { enforcement: body.enforcement }),
      ...(body.alertThresholdBps === undefined
        ? {}
        : { alertThresholdBps: [...body.alertThresholdBps] }),
      ...(body.status === undefined ? {} : { status: body.status }),
      updatedAt: new Date(),
    })
    .where(eq(spendingLimits.id, spendingLimitId))
    .returning({ id: spendingLimits.id });

  return row === undefined ? { status: 'unknown-limit' } : { status: 'updated' };
}

/** One budget's owning account, for authorising a read or an edit of it. */
export async function readSpendingLimitOwner(
  spendingLimitId: string
): Promise<string | undefined> {
  const [row] = await getDb()
    .select({ accountId: spendingLimits.accountId })
    .from(spendingLimits)
    .where(eq(spendingLimits.id, spendingLimitId))
    .limit(1);
  return row?.accountId;
}
