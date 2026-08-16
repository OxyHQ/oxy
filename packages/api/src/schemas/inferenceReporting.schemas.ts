/**
 * The customer-visible usage and spend read surface (issue #972, workstream 8).
 *
 * Request shapes and, more importantly, the RESPONSE PROJECTIONS — the types a
 * customer's numbers are allowed to travel in. Two properties are carried by the
 * types themselves rather than by anything a future reader has to remember:
 *
 * ## 1. Provenance is a required literal, not prose
 *
 * Every response says where its numbers came from and how fresh they are, as
 * fields that cannot be omitted: `source` and `consistency` are `z.literal`s, so
 * a serializer that forgets them fails to parse.
 *
 *  - a USAGE aggregate is `{ source: 'usage_telemetry_rollups', consistency:
 *    'eventual' }`. Telemetry is written outside the ledger transaction and can
 *    lag or, on a recorder failure, miss a request entirely.
 *  - a SPEND, BALANCE, RESERVATION or CHARGE figure is `{ source:
 *    'financial_ledger', consistency: 'authoritative' }`.
 *
 * The pair is why a customer can never mistake one for the other, and the reason
 * the two are never mixed into one row: **the exact billed amount comes from the
 * financial ledger, never from a telemetry sum**. The telemetry tables carry no
 * money column at all, so that is structural upstream of here too.
 *
 * ## 2. Upstream wholesale cost is UNREACHABLE, not merely unlisted
 *
 * Oxy's own cost of buying inference (`inference_deployments`'
 * `upstream_wholesale_cost_*`) must never appear in an ordinary customer
 * response. Every projection below is `.strict()` and every serializer annotates
 * its `const dto: <…>Dto` before parsing, so adding such a field fails TWICE —
 * `tsc` rejects the excess property, and `.parse` rejects the unrecognised key
 * at runtime. A field LIST someone has to keep in their head would fail neither.
 * `routes/__tests__/inferenceReporting.test.ts` mutation-tests exactly that.
 *
 * ## Query schemas are IDEMPOTENT under re-parse
 *
 * `middleware/validate` replaces `req.query` with the parsed value and the
 * handler parses it again to recover its type — the house pattern. That is only
 * sound if `parse(parse(x))` equals `parse(x)`, which is why every transform
 * here also accepts its own OUTPUT (a `groupBy` array as well as a comma-joined
 * string, a boolean as well as `'true'`). `inferenceReporting.schemas.test.ts`
 * asserts it rather than assuming it.
 */

import { z } from 'zod';
import {
  currencyCodeSchema,
  exactDecimalSchema,
  inferenceDateSchema,
  inferenceEnvironmentSchema,
  inferenceRequestOutcomeSchema,
  usageSourceSchema,
  USAGE_UNITS,
} from '@oxyhq/contracts';
import {
  MAX_SPENDING_ALERT_THRESHOLDS,
  SPENDING_ALERT_THRESHOLDS_BPS,
  SPENDING_LIMIT_ENFORCEMENTS,
  SPENDING_LIMIT_PERIODS,
  SPENDING_LIMIT_SCOPES,
  SPENDING_LIMIT_STATUSES,
} from '../db/schema/spendingLimits';

/*
 * The three closed vocabularies a report echoes back —
 * `development | staging | production`, `completed | partial | cancelled |
 * failed` (the epic's "status" dimension) and `provider_reported | oxy_measured
 * | estimated` — are the CONTRACT's own schemas, reused rather than restated.
 * A fourth copy beside `usage_receipts`' and `usage_reservations`' CHECKs is a
 * fourth thing to keep in step, and nothing would notice if it drifted.
 */

/**
 * The sentence a usage response carries about its own freshness.
 *
 * A `z.literal`, so it is part of the CONTRACT rather than a comment: a
 * serializer cannot ship a usage aggregate without stating this, and it cannot
 * state something else.
 */
export const USAGE_EVENTUAL_CONSISTENCY_NOTE =
  'Usage aggregates are eventually consistent. They are maintained outside the ledger transaction, so a recent request may not be counted yet and a dropped recorder may never count one. Do not reconcile a bill against these figures — use the spend endpoints, which read the financial ledger.' as const;

/** The counterpart a ledger-backed response carries. */
export const LEDGER_AUTHORITATIVE_NOTE =
  'Read from the financial ledger. This is the authoritative record of what was charged, held or refunded, and it is never derived from usage telemetry.' as const;

/* -------------------------------------------------------------------------- */
/*  Shared leaves                                                             */
/* -------------------------------------------------------------------------- */

const identifier = z.string().min(1).max(128);

/**
 * The eleven metered quantities, spelled out.
 *
 * Written by hand rather than generated from `USAGE_UNITS`, so the inferred type
 * names each unit instead of degrading to an index signature. That makes it a
 * hand-maintained map, so it gets a completeness gate rather than trust:
 * `inferenceReporting.schemas.test.ts` asserts this shape's key set EQUALS
 * `USAGE_UNITS` in both directions.
 */
export const usageUnitTotalsSchema = z
  .object({
    input_tokens: z.number().int().nonnegative(),
    cached_input_tokens: z.number().int().nonnegative(),
    output_tokens: z.number().int().nonnegative(),
    reasoning_tokens: z.number().int().nonnegative(),
    requests: z.number().int().nonnegative(),
    images: z.number().int().nonnegative(),
    audio_input_milliseconds: z.number().int().nonnegative(),
    audio_output_milliseconds: z.number().int().nonnegative(),
    video_milliseconds: z.number().int().nonnegative(),
    characters: z.number().int().nonnegative(),
    embeddings: z.number().int().nonnegative(),
  })
  .strict();

export type UsageUnitTotals = z.infer<typeof usageUnitTotalsSchema>;

/** The unit vocabulary this module claims to cover — the gate's other side. */
export const REPORTED_USAGE_UNITS: readonly string[] = USAGE_UNITS;

const dayRangeSchema = z.object({ from: inferenceDateSchema, to: inferenceDateSchema }).strict();

/* -------------------------------------------------------------------------- */
/*  Request params                                                            */
/* -------------------------------------------------------------------------- */

export const reportingAccountParams = z.object({ accountId: identifier }).strict();

export const reportingApplicationParams = z.object({ applicationId: identifier }).strict();

export const spendingLimitParams = z.object({ spendingLimitId: identifier }).strict();

/**
 * The widest window a single report may span.
 *
 * A bound rather than a preference: without one, a `from` of 1970 scans an
 * account's whole history. A year and a bit covers every calendar reporting
 * period a customer asks for; a longer span is a paged sequence of requests.
 */
export const MAX_REPORTING_WINDOW_DAYS = 400;

/** Rows a single report returns before it reports itself truncated. */
export const MAX_REPORTING_ROWS = 1000;

/** Rows a reconciliation export returns before it reports itself truncated. */
export const MAX_EXPORT_ROWS = 50_000;

/**
 * The dimensions a USAGE aggregate may be grouped by — exactly the epic's list.
 *
 * `project` is absent because a project IS an account (`users.kind`), so
 * `account` addresses it: the same reasoning `spending_limits` gives for having
 * three scope columns rather than four. An organization sees its projects by
 * asking for `includeDescendants` and grouping by `account`.
 */
export const USAGE_DIMENSIONS = [
  'day',
  'account',
  'application',
  'credential',
  'environment',
  'requestedModel',
  'provider',
  'outcome',
] as const;

export type UsageDimension = (typeof USAGE_DIMENSIONS)[number];

/**
 * The dimensions a SPEND aggregate may be grouped by.
 *
 * `resolvedModel`, not `requestedModel`: a receipt records the route that
 * actually served and was priced. Naming them differently is deliberate — one
 * shared `model` key across both surfaces would quietly claim the two reports
 * grouped by the same thing, which a route switch makes false.
 */
export const SPEND_DIMENSIONS = [
  'day',
  'account',
  'application',
  'credential',
  'environment',
  'resolvedModel',
  'provider',
  'outcome',
] as const;

export type SpendDimension = (typeof SPEND_DIMENSIONS)[number];

/**
 * A comma-separated dimension list — or the parsed array it becomes.
 *
 * Accepting its own output is what makes `parse(parse(x)) === parse(x)`, which
 * the validate-then-re-read pattern in the routes depends on.
 */
const usageGroupBy = z
  .union([z.string(), z.array(z.enum(USAGE_DIMENSIONS))])
  .optional()
  .transform(splitDimensions)
  .pipe(z.array(z.enum(USAGE_DIMENSIONS)).min(1).max(USAGE_DIMENSIONS.length));

const spendGroupBy = z
  .union([z.string(), z.array(z.enum(SPEND_DIMENSIONS))])
  .optional()
  .transform(splitDimensions)
  .pipe(z.array(z.enum(SPEND_DIMENSIONS)).min(1).max(SPEND_DIMENSIONS.length));

/** `undefined` → the default grouping; a string → its comma-separated parts. */
function splitDimensions(raw: string | readonly string[] | undefined): string[] {
  if (raw === undefined) return ['day'];
  const parts = typeof raw === 'string' ? raw.split(',') : raw;
  return Array.from(new Set(parts.map((part) => part.trim()).filter((part) => part.length > 0)));
}

/**
 * A flag that is true only when it says so.
 *
 * A closed union rather than a truthiness test: with `z.coerce.boolean()`,
 * `?includeDescendants=false` widens the query to an organization's whole
 * subtree — the exact opposite of what it asks for. Accepts a real boolean too,
 * so re-parsing its own output is stable.
 */
const booleanFlag = z
  .union([z.boolean(), z.literal('true'), z.literal('false')])
  .optional()
  .transform((value) => value === true || value === 'true');

const rangeFields = { from: inferenceDateSchema, to: inferenceDateSchema };

function refineRange(range: { from: string; to: string }, ctx: z.RefinementCtx): void {
  const from = Date.parse(`${range.from}T00:00:00.000Z`);
  const to = Date.parse(`${range.to}T00:00:00.000Z`);
  if (Number.isNaN(from) || Number.isNaN(to)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['from'],
      message: 'from and to must be real calendar dates',
    });
    return;
  }
  if (to < from) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['to'],
      message: 'to must not be before from',
    });
    return;
  }
  if ((to - from) / 86_400_000 + 1 > MAX_REPORTING_WINDOW_DAYS) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['to'],
      message: `a report spans at most ${MAX_REPORTING_WINDOW_DAYS} days`,
    });
  }
}

export const usageReportQuery = z
  .object({
    ...rangeFields,
    groupBy: usageGroupBy,
    applicationId: identifier.optional(),
    applicationCredentialId: identifier.optional(),
    environment: inferenceEnvironmentSchema.optional(),
    /** Include the account's descendant projects. Off unless asked for. */
    includeDescendants: booleanFlag,
  })
  .strict()
  .superRefine(refineRange);

export type UsageReportQuery = z.infer<typeof usageReportQuery>;

export const spendReportQuery = z
  .object({
    ...rangeFields,
    groupBy: spendGroupBy,
    applicationId: identifier.optional(),
    applicationCredentialId: identifier.optional(),
    environment: inferenceEnvironmentSchema.optional(),
    includeDescendants: booleanFlag,
  })
  .strict()
  .superRefine(refineRange);

export type SpendReportQuery = z.infer<typeof spendReportQuery>;

/** An application-scoped report carries no application filter of its own. */
export const applicationUsageReportQuery = z
  .object({
    ...rangeFields,
    groupBy: usageGroupBy,
    applicationCredentialId: identifier.optional(),
    environment: inferenceEnvironmentSchema.optional(),
  })
  .strict()
  .superRefine(refineRange);

export const applicationSpendReportQuery = z
  .object({
    ...rangeFields,
    groupBy: spendGroupBy,
    applicationCredentialId: identifier.optional(),
    environment: inferenceEnvironmentSchema.optional(),
  })
  .strict()
  .superRefine(refineRange);

export const reservationListQuery = z
  .object({
    limit: z.coerce.number().int().min(1).max(MAX_REPORTING_ROWS).default(100),
    includeDescendants: booleanFlag,
  })
  .strict();

export const chargeListQuery = z
  .object({
    ...rangeFields,
    limit: z.coerce.number().int().min(1).max(MAX_REPORTING_ROWS).default(100),
    applicationId: identifier.optional(),
    applicationCredentialId: identifier.optional(),
    includeDescendants: booleanFlag,
  })
  .strict()
  .superRefine(refineRange);

/** The reconciliation export: the charge list, rendered as CSV. */
export const chargeExportQuery = z
  .object({
    ...rangeFields,
    limit: z.coerce.number().int().min(1).max(MAX_EXPORT_ROWS).default(10_000),
    applicationId: identifier.optional(),
    includeDescendants: booleanFlag,
  })
  .strict()
  .superRefine(refineRange);

/* -------------------------------------------------------------------------- */
/*  Budget write bodies                                                       */
/* -------------------------------------------------------------------------- */

/** One of the closed threshold set the column's own CHECK admits. */
const alertThresholdBps = z.number().int().refine(
  (bps) => (SPENDING_ALERT_THRESHOLDS_BPS as readonly number[]).includes(bps),
  { message: `must be one of ${SPENDING_ALERT_THRESHOLDS_BPS.join(', ')}` }
);

const alertThresholdList = z
  .array(alertThresholdBps)
  .max(MAX_SPENDING_ALERT_THRESHOLDS)
  .transform((values) => Array.from(new Set(values)).sort((left, right) => left - right));

/**
 * A budget amount.
 *
 * `exactDecimalSchema` already refuses a float, an exponent and a negative. What
 * it admits and a budget must not is ZERO: a ceiling of zero refuses every
 * request while reading like "no limit configured" in a list. Disabling is what
 * `status` is for, and the column carries the same CHECK.
 */
const budgetAmount = exactDecimalSchema.refine((amount) => Number(amount) > 0, {
  message: 'a budget of zero refuses every request; disable it with status instead',
});

const budgetFields = {
  period: z.enum(SPENDING_LIMIT_PERIODS),
  limitAmount: budgetAmount,
  currency: currencyCodeSchema.optional(),
  enforcement: z.enum(SPENDING_LIMIT_ENFORCEMENTS).default('hard_stop'),
  alertThresholdBps: alertThresholdList.default([]),
};

/**
 * Create a budget.
 *
 * The scope target is a DISCRIMINATED union rather than three optional columns,
 * so "scope says account, body names an application" is unrepresentable instead
 * of caught by a CHECK after a round trip. The database has that CHECK anyway;
 * this is the half that produces a readable 400.
 */
export const spendingLimitCreateBody = z.discriminatedUnion('scope', [
  z.object({ scope: z.literal('account'), scopeAccountId: identifier, ...budgetFields }).strict(),
  z
    .object({ scope: z.literal('application'), scopeApplicationId: identifier, ...budgetFields })
    .strict(),
  z
    .object({
      scope: z.literal('credential'),
      scopeApplicationCredentialId: identifier,
      ...budgetFields,
    })
    .strict(),
]);

export type SpendingLimitCreateBody = z.infer<typeof spendingLimitCreateBody>;

/**
 * Edit a budget.
 *
 * The SCOPE is not editable. Re-pointing a budget at a different application
 * would silently re-interpret every threshold alert already recorded against it;
 * a new budget is the honest expression of that intent.
 */
export const spendingLimitUpdateBody = z
  .object({
    limitAmount: budgetAmount.optional(),
    enforcement: z.enum(SPENDING_LIMIT_ENFORCEMENTS).optional(),
    alertThresholdBps: alertThresholdList.optional(),
    status: z.enum(SPENDING_LIMIT_STATUSES).optional(),
  })
  .strict()
  .superRefine((body, ctx) => {
    if (Object.values(body).every((value) => value === undefined)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [],
        message: 'name at least one field to change',
      });
    }
  });

export type SpendingLimitUpdateBody = z.infer<typeof spendingLimitUpdateBody>;

/* -------------------------------------------------------------------------- */
/*  Response projections                                                      */
/* -------------------------------------------------------------------------- */

/**
 * One aggregated usage row.
 *
 * Every dimension is optional because a row carries only the dimensions it was
 * grouped by; an absent field was not a grouping key, never "unknown".
 *
 * There is no money field, and there cannot be one: `.strict()` refuses an
 * unrecognised key at runtime and the serializer's `const dto:` annotation
 * refuses it at compile time. A usage row and a billed amount come from
 * different tables, and this type is where that stops being a convention.
 */
export const usageAggregateRowSchema = z
  .object({
    day: inferenceDateSchema.optional(),
    accountId: identifier.optional(),
    applicationId: identifier.optional(),
    applicationCredentialId: identifier.optional(),
    environment: inferenceEnvironmentSchema.optional(),
    requestedModelReference: z.string().min(1).optional(),
    servingProvider: z.string().min(1).optional(),
    outcome: inferenceRequestOutcomeSchema.optional(),
    requestCount: z.number().int().nonnegative(),
    /** Requests whose HTTP status was >= 400. A subset of `requestCount`. */
    errorCount: z.number().int().nonnegative(),
    units: usageUnitTotalsSchema,
  })
  .strict();

export type UsageAggregateRow = z.infer<typeof usageAggregateRowSchema>;
export type UsageAggregateRowDto = z.input<typeof usageAggregateRowSchema>;

export const usageReportSchema = z
  .object({
    schemaVersion: z.literal(1),
    /** Not a bill. See {@link USAGE_EVENTUAL_CONSISTENCY_NOTE}. */
    consistency: z.literal('eventual'),
    source: z.literal('usage_telemetry_rollups'),
    note: z.literal(USAGE_EVENTUAL_CONSISTENCY_NOTE),
    range: dayRangeSchema,
    groupBy: z.array(z.enum(USAGE_DIMENSIONS)).min(1),
    rows: z.array(usageAggregateRowSchema),
    /** More rows matched than were returned. Narrow the range or the grouping. */
    truncated: z.boolean(),
  })
  .strict();

export type UsageReport = z.infer<typeof usageReportSchema>;
export type UsageReportDto = z.input<typeof usageReportSchema>;

/** One aggregated spend row. Money only; units live on the usage report. */
export const spendAggregateRowSchema = z
  .object({
    day: inferenceDateSchema.optional(),
    accountId: identifier.optional(),
    applicationId: identifier.optional(),
    applicationCredentialId: identifier.optional(),
    environment: inferenceEnvironmentSchema.optional(),
    resolvedModelReference: z.string().min(1).optional(),
    servingProvider: z.string().min(1).optional(),
    outcome: inferenceRequestOutcomeSchema.optional(),
    currency: currencyCodeSchema,
    receiptCount: z.number().int().nonnegative(),
    /** Settled, before reversals. */
    billedAmount: exactDecimalSchema,
    /** Reversed by a compensating refund. Settled history is never edited. */
    refundedAmount: exactDecimalSchema,
    netAmount: exactDecimalSchema,
  })
  .strict();

export type SpendAggregateRow = z.infer<typeof spendAggregateRowSchema>;
export type SpendAggregateRowDto = z.input<typeof spendAggregateRowSchema>;

export const spendTotalSchema = z
  .object({
    currency: currencyCodeSchema,
    receiptCount: z.number().int().nonnegative(),
    billedAmount: exactDecimalSchema,
    refundedAmount: exactDecimalSchema,
    netAmount: exactDecimalSchema,
  })
  .strict();

export type SpendTotalDto = z.input<typeof spendTotalSchema>;

export const spendReportSchema = z
  .object({
    schemaVersion: z.literal(1),
    consistency: z.literal('authoritative'),
    source: z.literal('financial_ledger'),
    note: z.literal(LEDGER_AUTHORITATIVE_NOTE),
    range: dayRangeSchema,
    groupBy: z.array(z.enum(SPEND_DIMENSIONS)).min(1),
    rows: z.array(spendAggregateRowSchema),
    /**
     * One entry per currency. Never one number: an account holding charges in
     * two currencies has two totals, and adding them is arithmetic on
     * incomparable quantities.
     */
    totals: z.array(spendTotalSchema),
    truncated: z.boolean(),
  })
  .strict();

/**
 * One threshold crossing on one budget — an EVENT, not a state.
 *
 * Without a record of which threshold was crossed in which period, "you have
 * used 75% of your budget" re-fires on every subsequent request for the rest of
 * the period; the unique key on `(limit, period_start, threshold)` is what makes
 * a crossing something that happened once. This is the read side of that record
 * (#972 section 7.1's alert thresholds), served here because the budgets it
 * refers to are served here.
 *
 * `financial_ledger` / `authoritative`, like every other money figure on this
 * router: `spend_amount` is the spend at the instant the threshold was crossed,
 * taken from the same query the reservation path enforces with.
 */
/** How many crossings one page returns. */
export const spendingLimitAlertsQuery = z
  .object({ limit: z.coerce.number().int().min(1).max(200).default(50) })
  .strict();

export const spendingLimitAlertRowSchema = z
  .object({
    alertId: identifier,
    spendingLimitId: identifier,
    periodStart: z.string().datetime(),
    thresholdBps: z.number().int().positive(),
    spendAmount: exactDecimalSchema,
    createdAt: z.string().datetime(),
  })
  .strict();

export const spendingLimitAlertsSchema = z
  .object({
    schemaVersion: z.literal(1),
    consistency: z.literal('authoritative'),
    source: z.literal('financial_ledger'),
    note: z.literal(LEDGER_AUTHORITATIVE_NOTE),
    rows: z.array(spendingLimitAlertRowSchema),
  })
  .strict();

export type SpendingLimitAlerts = z.infer<typeof spendingLimitAlertsSchema>;
export type SpendingLimitAlertsDto = z.input<typeof spendingLimitAlertsSchema>;

export type SpendReport = z.infer<typeof spendReportSchema>;
export type SpendReportDto = z.input<typeof spendReportSchema>;

/**
 * One currency's balance, with the buckets kept APART.
 *
 * `purchased`, `promotional` and `reserved` are three different things and the
 * epic requires them shown distinctly: promotional money may expire and is never
 * refundable, and a reservation is not money spent — collapsing the three into
 * one "balance" makes a customer's balance appear to drop and recover on every
 * request with no way to tell why.
 *
 * `availableToSpend` is derived HEADROOM offered BESIDE the three rather than
 * instead of them: promotional plus purchased, plus the unused credit line of an
 * invoiced account.
 */
export const accountBalanceBucketSchema = z
  .object({
    currency: currencyCodeSchema,
    purchased: exactDecimalSchema,
    promotional: exactDecimalSchema,
    reserved: exactDecimalSchema,
    invoicedOutstanding: exactDecimalSchema,
    availableToSpend: exactDecimalSchema,
  })
  .strict();

export const accountBalanceSchema = z
  .object({
    schemaVersion: z.literal(1),
    consistency: z.literal('authoritative'),
    source: z.literal('financial_ledger'),
    note: z.literal(LEDGER_AUTHORITATIVE_NOTE),
    accountId: identifier,
    /**
     * `false` when neither this account nor any ancestor has a billing profile.
     * NOT the same as a zero balance: zero means "spent everything", absent
     * means "nobody has decided who pays for this account yet".
     */
    provisioned: z.boolean(),
    /** The account that actually pays — the nearest ancestor with a profile. */
    billingAccountId: identifier.optional(),
    billingMode: z.enum(['prepaid', 'invoiced']).optional(),
    creditLimit: exactDecimalSchema.optional(),
    balances: z.array(accountBalanceBucketSchema),
  })
  .strict()
  .superRefine((balance, ctx) => {
    if (balance.provisioned && balance.billingAccountId === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['billingAccountId'],
        message: 'a provisioned account names the account that pays for it',
      });
    }
    if (!balance.provisioned && balance.balances.length > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['balances'],
        message: 'an unprovisioned account has no balance',
      });
    }
  });

export type AccountBalance = z.infer<typeof accountBalanceSchema>;
export type AccountBalanceDto = z.input<typeof accountBalanceSchema>;

/** One hold currently against the account. Not a charge. */
export const pendingReservationSchema = z
  .object({
    reservationId: identifier,
    requestId: z.string().min(1),
    applicationId: identifier,
    applicationCredentialId: identifier,
    environment: inferenceEnvironmentSchema,
    reservedAmount: exactDecimalSchema,
    currency: currencyCodeSchema,
    createdAt: z.string().datetime(),
    expiresAt: z.string().datetime(),
  })
  .strict();

export type PendingReservationDto = z.input<typeof pendingReservationSchema>;

export const pendingReservationsSchema = z
  .object({
    schemaVersion: z.literal(1),
    consistency: z.literal('authoritative'),
    source: z.literal('financial_ledger'),
    note: z.literal(LEDGER_AUTHORITATIVE_NOTE),
    /**
     * Held, never settled. A reservation on this list has NOT been charged; when
     * it settles it leaves this list and appears under charges, for the exact
     * amount — which is usually less.
     */
    rows: z.array(pendingReservationSchema),
    totals: z.array(
      z
        .object({
          currency: currencyCodeSchema,
          reservationCount: z.number().int().nonnegative(),
          heldAmount: exactDecimalSchema,
        })
        .strict()
    ),
    truncated: z.boolean(),
  })
  .strict();

export type PendingReservations = z.infer<typeof pendingReservationsSchema>;
export type PendingReservationsDto = z.input<typeof pendingReservationsSchema>;

/** One settled charge, as the ledger recorded it. */
export const settledChargeSchema = z
  .object({
    receiptId: identifier,
    requestId: z.string().min(1),
    generationId: z.string().min(1).optional(),
    /** The hold this settled against, when there was one. */
    reservationId: identifier.optional(),
    /** A supplementary receipt correcting an earlier one upward. */
    correctsReceiptId: identifier.optional(),
    applicationId: identifier,
    applicationCredentialId: identifier,
    environment: inferenceEnvironmentSchema,
    outcome: inferenceRequestOutcomeSchema,
    usageSource: usageSourceSchema,
    resolvedModelReference: z.string().min(1),
    servingProvider: z.string().min(1),
    /** A BYOK request: `billedAmount` is Oxy's fee, not the cost of the tokens. */
    platformFeeOnly: z.boolean(),
    billedAmount: exactDecimalSchema,
    refundedAmount: exactDecimalSchema,
    netAmount: exactDecimalSchema,
    currency: currencyCodeSchema,
    settledAt: z.string().datetime(),
    units: usageUnitTotalsSchema,
  })
  .strict();

export type SettledCharge = z.infer<typeof settledChargeSchema>;
export type SettledChargeDto = z.input<typeof settledChargeSchema>;

export const settledChargesSchema = z
  .object({
    schemaVersion: z.literal(1),
    consistency: z.literal('authoritative'),
    source: z.literal('financial_ledger'),
    note: z.literal(LEDGER_AUTHORITATIVE_NOTE),
    range: dayRangeSchema,
    rows: z.array(settledChargeSchema),
    truncated: z.boolean(),
  })
  .strict();

export type SettledCharges = z.infer<typeof settledChargesSchema>;
export type SettledChargesDto = z.input<typeof settledChargesSchema>;

/**
 * A budget, with what has been spent against it.
 *
 * `currentSpend` comes from the SAME query the reservation path evaluates a
 * limit with (`readSpendingLimitUtilization`), not from a second implementation
 * of "what counts toward a limit" — a report that disagreed with the enforcement
 * would be worse than no report.
 */
export const spendingLimitViewSchema = z
  .object({
    spendingLimitId: identifier,
    accountId: identifier,
    scope: z.enum(SPENDING_LIMIT_SCOPES),
    scopeAccountId: identifier.optional(),
    scopeApplicationId: identifier.optional(),
    scopeApplicationCredentialId: identifier.optional(),
    period: z.enum(SPENDING_LIMIT_PERIODS),
    limitAmount: exactDecimalSchema,
    currency: currencyCodeSchema,
    enforcement: z.enum(SPENDING_LIMIT_ENFORCEMENTS),
    alertThresholdBps: z.array(z.number().int().positive()),
    status: z.enum(SPENDING_LIMIT_STATUSES),
    /** Start of the window `currentSpend` is measured over. */
    periodStart: z.string().datetime(),
    /** Settled spend plus money currently held, less reversals. */
    currentSpend: exactDecimalSchema,
    remaining: exactDecimalSchema,
    /** Basis points of the limit consumed, clamped at 10000. */
    utilizationBps: z.number().int().nonnegative().max(10_000),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict();

export type SpendingLimitView = z.infer<typeof spendingLimitViewSchema>;
export type SpendingLimitViewDto = z.input<typeof spendingLimitViewSchema>;

export const spendingLimitsSchema = z
  .object({
    schemaVersion: z.literal(1),
    consistency: z.literal('authoritative'),
    source: z.literal('financial_ledger'),
    note: z.literal(LEDGER_AUTHORITATIVE_NOTE),
    rows: z.array(spendingLimitViewSchema),
  })
  .strict();

export type SpendingLimits = z.infer<typeof spendingLimitsSchema>;
export type SpendingLimitsDto = z.input<typeof spendingLimitsSchema>;
