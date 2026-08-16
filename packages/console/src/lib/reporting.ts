/**
 * The customer's usage and spend surface, as Console is allowed to render it
 * (issue #972, workstreams 8 and 9).
 *
 * ## The one distinction this file exists to keep visible
 *
 * `/inference/reporting` answers two different questions from two different
 * tables, and every response says which:
 *
 *  - **money** — `/spend`, `/balance`, `/reservations`, `/charges`,
 *    `/spending-limits` — is stamped `{ source: 'financial_ledger', consistency:
 *    'authoritative' }`. It is the record of what was charged, held or refunded.
 *  - **usage** — `/usage` — is stamped `{ source: 'usage_telemetry_rollups',
 *    consistency: 'eventual' }`. It counts requests and tokens, is maintained
 *    outside the ledger transaction, and can lag or miss a request entirely.
 *
 * Both stamps are required literals on the server's projections, so a response
 * cannot arrive without one. {@link UsageReportResponse} and
 * {@link SpendReportResponse} below repeat them as literal types rather than as
 * a shared `string`, which is what makes "render the usage total as the amount
 * billed" a type error in a component instead of a judgement call. The rule the
 * epic states — a usage figure never appears under a heading implying it is what
 * the customer was charged — is enforced in the UI by
 * `components/billing/provenance-banner.tsx`, which takes the stamp off the
 * response itself rather than a prop somebody sets by hand.
 *
 * ## Why the wire types are declared here rather than imported
 *
 * The reporting projections live in `packages/api/src/schemas/`, not in
 * `@oxyhq/contracts`, so there is nothing to import. The consequence is
 * deliberate and worth naming: the interfaces below are an ALLOWLIST. A field
 * the API adds — an upstream wholesale cost, an internal route id, a deployment
 * id — does not exist in these types, is dropped by the projections, and cannot
 * reach a React tree without somebody editing this file. That is the same
 * property `lib/provider-connection.ts` gives the BYOK surface, reached a
 * different way because the source of truth is a different package.
 * `__tests__/reporting.test.ts` mutation-tests it by feeding a polluted row in.
 */

/* -------------------------------------------------------------------------- */
/*  Provenance                                                                */
/* -------------------------------------------------------------------------- */

/** A response read from the financial ledger. */
export interface LedgerProvenance {
  readonly source: 'financial_ledger';
  readonly consistency: 'authoritative';
}

/** A response read from the usage telemetry rollups. */
export interface TelemetryProvenance {
  readonly source: 'usage_telemetry_rollups';
  readonly consistency: 'eventual';
}

export type ReportProvenance = LedgerProvenance | TelemetryProvenance;

/** The two words a customer needs, taken from the response's own stamp. */
export function provenanceHeadline(provenance: ReportProvenance): string {
  return provenance.source === 'financial_ledger'
    ? 'Billed amounts, from the financial ledger'
    : 'Usage counts, from telemetry';
}

/**
 * The sentence under the headline.
 *
 * Written here once rather than at each call site, because five paraphrases of
 * "this is not a bill" is how the distinction stops being reliable.
 */
export function provenanceExplanation(provenance: ReportProvenance): string {
  return provenance.source === 'financial_ledger'
    ? 'This is the authoritative record of what was charged, held or refunded. It is never derived from usage telemetry, and it is what an invoice reconciles against.'
    : 'These are request and token counts, maintained outside the ledger transaction. A recent request may not be counted yet. Do not reconcile a bill against these figures — the Spend and Charges pages read the ledger.';
}

/* -------------------------------------------------------------------------- */
/*  Usage (units, eventual)                                                   */
/* -------------------------------------------------------------------------- */

/** The dimensions a usage aggregate may be grouped by. Mirrors the API's list. */
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
 * `resolvedModel`, where usage has `requestedModel`: a receipt records the route
 * that actually served and was priced, which a fallback can make different from
 * the one asked for. The two lists are named differently on purpose — one shared
 * `model` key would claim the two reports grouped by the same thing.
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

/** The eleven metered quantities. Counts, never money. */
export interface UsageUnitTotals {
  readonly input_tokens: number;
  readonly cached_input_tokens: number;
  readonly output_tokens: number;
  readonly reasoning_tokens: number;
  readonly requests: number;
  readonly images: number;
  readonly audio_input_milliseconds: number;
  readonly audio_output_milliseconds: number;
  readonly video_milliseconds: number;
  readonly characters: number;
  readonly embeddings: number;
}

export interface UsageRow {
  readonly day?: string;
  readonly accountId?: string;
  readonly applicationId?: string;
  readonly applicationCredentialId?: string;
  readonly environment?: string;
  readonly requestedModelReference?: string;
  readonly servingProvider?: string;
  readonly outcome?: string;
  readonly requestCount: number;
  readonly errorCount: number;
  readonly units: UsageUnitTotals;
}

export interface UsageReportResponse {
  readonly schemaVersion: number;
  readonly consistency: 'eventual';
  readonly source: 'usage_telemetry_rollups';
  readonly note: string;
  readonly range: { readonly from: string; readonly to: string };
  readonly groupBy: ReadonlyArray<UsageDimension>;
  readonly rows: ReadonlyArray<UsageRow>;
  readonly truncated: boolean;
}

/* -------------------------------------------------------------------------- */
/*  Spend (money, authoritative)                                              */
/* -------------------------------------------------------------------------- */

export interface SpendRow {
  readonly day?: string;
  readonly accountId?: string;
  readonly applicationId?: string;
  readonly applicationCredentialId?: string;
  readonly environment?: string;
  readonly resolvedModelReference?: string;
  readonly servingProvider?: string;
  readonly outcome?: string;
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

export interface SpendReportResponse {
  readonly schemaVersion: number;
  readonly consistency: 'authoritative';
  readonly source: 'financial_ledger';
  readonly note: string;
  readonly range: { readonly from: string; readonly to: string };
  readonly groupBy: ReadonlyArray<SpendDimension>;
  readonly rows: ReadonlyArray<SpendRow>;
  /** One entry per currency. Never one number — see `formatMoney`'s module. */
  readonly totals: ReadonlyArray<SpendTotal>;
  readonly truncated: boolean;
}

/* -------------------------------------------------------------------------- */
/*  Balance                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * One currency's position, with the buckets kept apart.
 *
 * There is no total, and adding one here would defeat the point: promotional
 * credit may expire and is never refundable, and `reserved` is money HELD
 * against in-flight requests rather than money spent. `availableToSpend` is the
 * server's own derived headroom, offered beside the three rather than instead
 * of them.
 */
export interface LedgerBalanceBucket {
  readonly currency: string;
  readonly purchased: string;
  readonly promotional: string;
  readonly reserved: string;
  readonly invoicedOutstanding: string;
  readonly availableToSpend: string;
}

export interface LedgerBalanceResponse {
  readonly schemaVersion: number;
  readonly consistency: 'authoritative';
  readonly source: 'financial_ledger';
  readonly note: string;
  readonly accountId: string;
  /** `false` means nobody has decided who pays yet — NOT a balance of zero. */
  readonly provisioned: boolean;
  readonly billingAccountId?: string;
  readonly billingMode?: 'prepaid' | 'invoiced';
  readonly creditLimit?: string;
  readonly balances: ReadonlyArray<LedgerBalanceBucket>;
}

/* -------------------------------------------------------------------------- */
/*  Reservations and charges                                                  */
/* -------------------------------------------------------------------------- */

/** Money HELD against an in-flight request. Nothing here has been charged. */
export interface PendingReservation {
  readonly reservationId: string;
  readonly requestId: string;
  readonly applicationId: string;
  readonly applicationCredentialId: string;
  readonly environment: string;
  readonly reservedAmount: string;
  readonly currency: string;
  readonly createdAt: string;
  readonly expiresAt: string;
}

export interface PendingReservationsResponse {
  readonly schemaVersion: number;
  readonly consistency: 'authoritative';
  readonly source: 'financial_ledger';
  readonly note: string;
  readonly rows: ReadonlyArray<PendingReservation>;
  readonly totals: ReadonlyArray<{
    readonly currency: string;
    readonly reservationCount: number;
    readonly heldAmount: string;
  }>;
  readonly truncated: boolean;
}

/** One settled charge, exactly as the ledger recorded it. */
export interface SettledCharge {
  readonly receiptId: string;
  readonly requestId: string;
  readonly generationId?: string;
  readonly reservationId?: string;
  readonly correctsReceiptId?: string;
  readonly applicationId: string;
  readonly applicationCredentialId: string;
  readonly environment: string;
  readonly outcome: string;
  readonly usageSource: string;
  readonly resolvedModelReference: string;
  readonly servingProvider: string;
  /** A BYOK request: `billedAmount` is Oxy's fee, not the cost of the tokens. */
  readonly platformFeeOnly: boolean;
  readonly billedAmount: string;
  readonly refundedAmount: string;
  readonly netAmount: string;
  readonly currency: string;
  readonly settledAt: string;
  readonly units: UsageUnitTotals;
}

export interface SettledChargesResponse {
  readonly schemaVersion: number;
  readonly consistency: 'authoritative';
  readonly source: 'financial_ledger';
  readonly note: string;
  readonly range: { readonly from: string; readonly to: string };
  readonly rows: ReadonlyArray<SettledCharge>;
  readonly truncated: boolean;
}

/* -------------------------------------------------------------------------- */
/*  Budgets                                                                   */
/* -------------------------------------------------------------------------- */

export const BUDGET_SCOPES = ['account', 'application', 'credential'] as const;
export type BudgetScope = (typeof BUDGET_SCOPES)[number];

export const BUDGET_PERIODS = ['daily', 'weekly', 'monthly', 'total'] as const;
export type BudgetPeriod = (typeof BUDGET_PERIODS)[number];

export const BUDGET_ENFORCEMENTS = ['hard_stop', 'soft_stop'] as const;
export type BudgetEnforcement = (typeof BUDGET_ENFORCEMENTS)[number];

export const BUDGET_STATUSES = ['active', 'disabled'] as const;
export type BudgetStatus = (typeof BUDGET_STATUSES)[number];

/** The closed threshold set the column's own CHECK admits. 10000 = 100%. */
export const BUDGET_ALERT_THRESHOLDS_BPS = [2500, 5000, 7500, 9000, 10000] as const;

export interface Budget {
  readonly spendingLimitId: string;
  readonly accountId: string;
  readonly scope: BudgetScope;
  readonly scopeAccountId?: string;
  readonly scopeApplicationId?: string;
  readonly scopeApplicationCredentialId?: string;
  readonly period: BudgetPeriod;
  readonly limitAmount: string;
  readonly currency: string;
  readonly enforcement: BudgetEnforcement;
  readonly alertThresholdBps: ReadonlyArray<number>;
  readonly status: BudgetStatus;
  readonly periodStart: string;
  /** Settled spend plus money currently held, less reversals. */
  readonly currentSpend: string;
  readonly remaining: string;
  readonly utilizationBps: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface BudgetsResponse {
  readonly schemaVersion: number;
  readonly consistency: 'authoritative';
  readonly source: 'financial_ledger';
  readonly note: string;
  readonly rows: ReadonlyArray<Budget>;
}

/**
 * A threshold that was crossed, once, in one period.
 *
 * An EVENT, not a state: without the record, "you have used 75% of your budget"
 * would re-fire on every subsequent request for the rest of the period.
 *
 * `spendAmount` carries no currency, and this file does not invent one — the
 * alert record does not have it, and a frontend that supplied a code would be
 * asserting something the contract does not say.
 */
export interface BudgetAlert {
  readonly alertId: string;
  readonly spendingLimitId: string;
  readonly periodStart: string;
  readonly thresholdBps: number;
  readonly spendAmount: string;
  readonly createdAt: string;
}

export interface BudgetAlertsResponse {
  readonly schemaVersion: number;
  readonly consistency: 'authoritative';
  readonly source: 'financial_ledger';
  readonly note: string;
  readonly rows: ReadonlyArray<BudgetAlert>;
}

/* -------------------------------------------------------------------------- */
/*  Projections                                                               */
/* -------------------------------------------------------------------------- */

/*
 * Each projection below is written FIELD BY FIELD against a declared return
 * type — never a spread. That is the mechanism, not a style: a spread would
 * carry an unlisted field straight through, and the whole reason these exist is
 * that the API's row may one day carry something a customer must not see. With
 * an explicit list, an added field is invisible until somebody adds it here.
 */

export function toUsageRow(row: UsageRow): UsageRow {
  return {
    day: row.day,
    accountId: row.accountId,
    applicationId: row.applicationId,
    applicationCredentialId: row.applicationCredentialId,
    environment: row.environment,
    requestedModelReference: row.requestedModelReference,
    servingProvider: row.servingProvider,
    outcome: row.outcome,
    requestCount: row.requestCount,
    errorCount: row.errorCount,
    units: toUsageUnits(row.units),
  };
}

export function toUsageUnits(units: UsageUnitTotals): UsageUnitTotals {
  return {
    input_tokens: units.input_tokens,
    cached_input_tokens: units.cached_input_tokens,
    output_tokens: units.output_tokens,
    reasoning_tokens: units.reasoning_tokens,
    requests: units.requests,
    images: units.images,
    audio_input_milliseconds: units.audio_input_milliseconds,
    audio_output_milliseconds: units.audio_output_milliseconds,
    video_milliseconds: units.video_milliseconds,
    characters: units.characters,
    embeddings: units.embeddings,
  };
}

export function toSpendRow(row: SpendRow): SpendRow {
  return {
    day: row.day,
    accountId: row.accountId,
    applicationId: row.applicationId,
    applicationCredentialId: row.applicationCredentialId,
    environment: row.environment,
    resolvedModelReference: row.resolvedModelReference,
    servingProvider: row.servingProvider,
    outcome: row.outcome,
    currency: row.currency,
    receiptCount: row.receiptCount,
    billedAmount: row.billedAmount,
    refundedAmount: row.refundedAmount,
    netAmount: row.netAmount,
  };
}

export function toSettledCharge(charge: SettledCharge): SettledCharge {
  return {
    receiptId: charge.receiptId,
    requestId: charge.requestId,
    generationId: charge.generationId,
    reservationId: charge.reservationId,
    correctsReceiptId: charge.correctsReceiptId,
    applicationId: charge.applicationId,
    applicationCredentialId: charge.applicationCredentialId,
    environment: charge.environment,
    outcome: charge.outcome,
    usageSource: charge.usageSource,
    resolvedModelReference: charge.resolvedModelReference,
    servingProvider: charge.servingProvider,
    platformFeeOnly: charge.platformFeeOnly,
    billedAmount: charge.billedAmount,
    refundedAmount: charge.refundedAmount,
    netAmount: charge.netAmount,
    currency: charge.currency,
    settledAt: charge.settledAt,
    units: toUsageUnits(charge.units),
  };
}

export function toPendingReservation(reservation: PendingReservation): PendingReservation {
  return {
    reservationId: reservation.reservationId,
    requestId: reservation.requestId,
    applicationId: reservation.applicationId,
    applicationCredentialId: reservation.applicationCredentialId,
    environment: reservation.environment,
    reservedAmount: reservation.reservedAmount,
    currency: reservation.currency,
    createdAt: reservation.createdAt,
    expiresAt: reservation.expiresAt,
  };
}

export function toBudget(budget: Budget): Budget {
  return {
    spendingLimitId: budget.spendingLimitId,
    accountId: budget.accountId,
    scope: budget.scope,
    scopeAccountId: budget.scopeAccountId,
    scopeApplicationId: budget.scopeApplicationId,
    scopeApplicationCredentialId: budget.scopeApplicationCredentialId,
    period: budget.period,
    limitAmount: budget.limitAmount,
    currency: budget.currency,
    enforcement: budget.enforcement,
    alertThresholdBps: [...budget.alertThresholdBps],
    status: budget.status,
    periodStart: budget.periodStart,
    currentSpend: budget.currentSpend,
    remaining: budget.remaining,
    utilizationBps: budget.utilizationBps,
    createdAt: budget.createdAt,
    updatedAt: budget.updatedAt,
  };
}

export function toBudgetAlert(alert: BudgetAlert): BudgetAlert {
  return {
    alertId: alert.alertId,
    spendingLimitId: alert.spendingLimitId,
    periodStart: alert.periodStart,
    thresholdBps: alert.thresholdBps,
    spendAmount: alert.spendAmount,
    createdAt: alert.createdAt,
  };
}

export function toLedgerBalanceBucket(bucket: LedgerBalanceBucket): LedgerBalanceBucket {
  return {
    currency: bucket.currency,
    purchased: bucket.purchased,
    promotional: bucket.promotional,
    reserved: bucket.reserved,
    invoicedOutstanding: bucket.invoicedOutstanding,
    availableToSpend: bucket.availableToSpend,
  };
}

/* -------------------------------------------------------------------------- */
/*  Presentation                                                              */
/* -------------------------------------------------------------------------- */

const USAGE_DIMENSION_LABELS: Record<UsageDimension, string> = {
  day: 'Day',
  account: 'Account',
  application: 'Application',
  credential: 'Credential',
  environment: 'Environment',
  requestedModel: 'Requested model',
  provider: 'Provider',
  outcome: 'Outcome',
};

const SPEND_DIMENSION_LABELS: Record<SpendDimension, string> = {
  day: 'Day',
  account: 'Account',
  application: 'Application',
  credential: 'Credential',
  environment: 'Environment',
  resolvedModel: 'Served model',
  provider: 'Provider',
  outcome: 'Outcome',
};

export function usageDimensionLabel(dimension: UsageDimension): string {
  return USAGE_DIMENSION_LABELS[dimension];
}

export function spendDimensionLabel(dimension: SpendDimension): string {
  return SPEND_DIMENSION_LABELS[dimension];
}

/** The cell a grouped row shows for one dimension, or `—` when it was not grouped. */
export function usageDimensionValue(row: UsageRow, dimension: UsageDimension): string {
  switch (dimension) {
    case 'day':
      return row.day ?? '—';
    case 'account':
      return row.accountId ?? '—';
    case 'application':
      return row.applicationId ?? '—';
    case 'credential':
      return row.applicationCredentialId ?? '—';
    case 'environment':
      return row.environment ?? '—';
    case 'requestedModel':
      return row.requestedModelReference ?? '—';
    case 'provider':
      return row.servingProvider ?? '—';
    case 'outcome':
      return row.outcome ?? '—';
  }
}

export function spendDimensionValue(row: SpendRow, dimension: SpendDimension): string {
  switch (dimension) {
    case 'day':
      return row.day ?? '—';
    case 'account':
      return row.accountId ?? '—';
    case 'application':
      return row.applicationId ?? '—';
    case 'credential':
      return row.applicationCredentialId ?? '—';
    case 'environment':
      return row.environment ?? '—';
    case 'resolvedModel':
      return row.resolvedModelReference ?? '—';
    case 'provider':
      return row.servingProvider ?? '—';
    case 'outcome':
      return row.outcome ?? '—';
  }
}

const BUDGET_PERIOD_LABELS: Record<BudgetPeriod, string> = {
  daily: 'Daily',
  weekly: 'Weekly',
  monthly: 'Monthly',
  total: 'Lifetime',
};

export function budgetPeriodLabel(period: BudgetPeriod): string {
  return BUDGET_PERIOD_LABELS[period];
}

/**
 * What a budget does at its ceiling, in the customer's terms.
 *
 * The difference is the whole reason both exist: `hard_stop` refuses the
 * request, `soft_stop` lets it through and reports the crossing.
 */
export function budgetEnforcementLabel(enforcement: BudgetEnforcement): string {
  return enforcement === 'hard_stop'
    ? 'Hard stop — requests are refused at the ceiling'
    : 'Soft stop — requests continue, and the crossing is recorded';
}

/** What a budget applies to, named by its target rather than by its discriminant. */
export function budgetScopeDescription(budget: Budget): string {
  switch (budget.scope) {
    case 'account':
      return `Account ${budget.scopeAccountId ?? budget.accountId}`;
    case 'application':
      return `Application ${budget.scopeApplicationId ?? ''}`.trim();
    case 'credential':
      return `Credential ${budget.scopeApplicationCredentialId ?? ''}`.trim();
  }
}

/**
 * Badge tone for how close a budget is to refusing traffic.
 *
 * Reads `utilizationBps`, the server's own figure, so the badge and the
 * enforcement can never disagree about how full a budget is.
 */
export function budgetUtilizationVariant(
  budget: Budget
): 'default' | 'secondary' | 'destructive' {
  if (budget.status === 'disabled') {
    return 'secondary';
  }
  if (budget.utilizationBps >= 10000) {
    return 'destructive';
  }
  return 'default';
}

/* -------------------------------------------------------------------------- */
/*  Ranges                                                                    */
/* -------------------------------------------------------------------------- */

/** The windows the reporting pages offer. The API caps a report at 400 days. */
export const REPORT_RANGE_DAYS = [7, 30, 90] as const;

export type ReportRangeDays = (typeof REPORT_RANGE_DAYS)[number];

export interface DayRange {
  readonly from: string;
  readonly to: string;
}

/** `YYYY-MM-DD` in UTC — the calendar date the rollups are keyed on. */
export function toCalendarDate(instant: Date): string {
  return instant.toISOString().slice(0, 10);
}

/**
 * The last `days` calendar days, inclusive of today.
 *
 * UTC on both ends, because the daily rollups are bucketed in UTC: deriving the
 * range from the browser's timezone would silently ask for a window whose edges
 * do not line up with any row, and the missing traffic would look like a quiet
 * day rather than a boundary.
 */
export function lastCalendarDays(days: number, now: Date = new Date()): DayRange {
  const to = toCalendarDate(now);
  const start = new Date(now.getTime());
  start.setUTCDate(start.getUTCDate() - (days - 1));
  return { from: toCalendarDate(start), to };
}
