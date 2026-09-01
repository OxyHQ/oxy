import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '@oxyhq/services';
import type {
  Budget,
  BudgetAlertsResponse,
  BudgetEnforcement,
  BudgetPeriod,
  BudgetScope,
  BudgetStatus,
  BudgetsResponse,
  DayRange,
  LedgerBalanceResponse,
  PendingReservationsResponse,
  SettledChargesResponse,
  SpendDimension,
  SpendReportResponse,
  UsageDimension,
  UsageReportResponse,
} from '@/lib/reporting';
import {
  toBudget,
  toBudgetAlert,
  toLedgerBalanceBucket,
  toPendingReservation,
  toSettledCharge,
  toSpendRow,
  toUsageRow,
} from '@/lib/reporting';

// ===========================================================================
// The customer's own usage, spend, balance and budgets
// (`/inference/reporting`, issue #972 workstream 8).
//
// Every read here passes `{ cache: false }`. That is not caution — the SDK's
// HTTP layer keeps its own GET cache, which React Query invalidation cannot
// reach, and a balance served from it after a top-up is a customer looking at
// money they no longer have. React Query's `staleTime` is the one cache these
// screens have, so there is exactly one cache authority per resource.
//
// Every read also runs its response through a projection from `lib/reporting`.
// The projections drop anything the Console's own types do not name, which is
// what keeps an upstream wholesale cost, an internal route id or a deployment
// id out of the query cache rather than merely off the screen.
// ===========================================================================

const queryKeys = {
  balance: (accountId: string) => ['reporting-balance', accountId] as const,
  accountUsage: (accountId: string, range: DayRange, groupBy: ReadonlyArray<string>) =>
    ['reporting-account-usage', accountId, range.from, range.to, groupBy.join(',')] as const,
  accountSpend: (accountId: string, range: DayRange, groupBy: ReadonlyArray<string>) =>
    ['reporting-account-spend', accountId, range.from, range.to, groupBy.join(',')] as const,
  reservations: (accountId: string) => ['reporting-reservations', accountId] as const,
  charges: (accountId: string, range: DayRange) =>
    ['reporting-charges', accountId, range.from, range.to] as const,
  budgets: (accountId: string) => ['reporting-budgets', accountId] as const,
  budgetAlerts: (accountId: string) => ['reporting-budget-alerts', accountId] as const,
  applicationUsage: (applicationId: string, range: DayRange, groupBy: ReadonlyArray<string>) =>
    ['reporting-app-usage', applicationId, range.from, range.to, groupBy.join(',')] as const,
  applicationSpend: (applicationId: string, range: DayRange, groupBy: ReadonlyArray<string>) =>
    ['reporting-app-spend', applicationId, range.from, range.to, groupBy.join(',')] as const,
};

/**
 * A comma-joined dimension list, which is the form the API's query schema
 * parses. Sent as one parameter rather than a repeated one because the schema
 * is `.strict()` and splits on commas itself.
 */
function groupByParam(dimensions: ReadonlyArray<string>): string {
  return dimensions.join(',');
}

/* -------------------------------------------------------------------------- */
/*  Balance                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Purchased, promotional and reserved money, as three distinct amounts.
 *
 * `provisioned: false` is a real and different answer from a zero balance: it
 * means nobody has decided who pays for this account yet, and the page renders a
 * provisioning prompt rather than "0.00".
 */
export function useLedgerBalance(accountId: string | undefined, enabled: boolean = true) {
  const { oxyServices, isAuthenticated, isReady } = useAuth();

  return useQuery({
    queryKey: queryKeys.balance(accountId ?? ''),
    queryFn: () =>
      oxyServices.makeRequest<LedgerBalanceResponse>(
        'GET',
        `/inference/reporting/accounts/${accountId ?? ''}/balance`,
        undefined,
        { cache: false }
      ),
    select: (balance): LedgerBalanceResponse => ({
      schemaVersion: balance.schemaVersion,
      consistency: balance.consistency,
      source: balance.source,
      note: balance.note,
      accountId: balance.accountId,
      provisioned: balance.provisioned,
      billingAccountId: balance.billingAccountId,
      billingMode: balance.billingMode,
      creditLimit: balance.creditLimit,
      balances: balance.balances.map(toLedgerBalanceBucket),
    }),
    enabled: isReady && isAuthenticated && !!accountId && enabled,
    staleTime: 1000 * 15,
    retry: 1,
  });
}

/* -------------------------------------------------------------------------- */
/*  Usage — units, eventually consistent                                      */
/* -------------------------------------------------------------------------- */

export interface UsageReportOptions {
  readonly range: DayRange;
  readonly groupBy: ReadonlyArray<UsageDimension>;
  readonly includeDescendants?: boolean;
}

export function useAccountUsageReport(
  accountId: string | undefined,
  options: UsageReportOptions,
  enabled: boolean = true
) {
  const { oxyServices, isAuthenticated, isReady } = useAuth();

  return useQuery({
    queryKey: queryKeys.accountUsage(accountId ?? '', options.range, options.groupBy),
    queryFn: () =>
      oxyServices.makeRequest<UsageReportResponse>(
        'GET',
        `/inference/reporting/accounts/${accountId ?? ''}/usage`,
        {
          from: options.range.from,
          to: options.range.to,
          groupBy: groupByParam(options.groupBy),
          includeDescendants: options.includeDescendants,
        },
        { cache: false }
      ),
    select: selectUsageReport,
    enabled: isReady && isAuthenticated && !!accountId && enabled,
    staleTime: 1000 * 60,
    retry: 1,
  });
}

export function useApplicationUsageReport(
  applicationId: string | undefined,
  options: UsageReportOptions,
  enabled: boolean = true
) {
  const { oxyServices, isAuthenticated, isReady } = useAuth();

  return useQuery({
    queryKey: queryKeys.applicationUsage(applicationId ?? '', options.range, options.groupBy),
    queryFn: () =>
      oxyServices.makeRequest<UsageReportResponse>(
        'GET',
        `/inference/reporting/applications/${applicationId ?? ''}/usage`,
        {
          from: options.range.from,
          to: options.range.to,
          groupBy: groupByParam(options.groupBy),
        },
        { cache: false }
      ),
    select: selectUsageReport,
    enabled: isReady && isAuthenticated && !!applicationId && enabled,
    staleTime: 1000 * 60,
    retry: 1,
  });
}

function selectUsageReport(report: UsageReportResponse): UsageReportResponse {
  return {
    schemaVersion: report.schemaVersion,
    consistency: report.consistency,
    source: report.source,
    note: report.note,
    range: { from: report.range.from, to: report.range.to },
    groupBy: [...report.groupBy],
    rows: report.rows.map(toUsageRow),
    truncated: report.truncated,
  };
}

/* -------------------------------------------------------------------------- */
/*  Spend — money, authoritative                                              */
/* -------------------------------------------------------------------------- */

export interface SpendReportOptions {
  readonly range: DayRange;
  readonly groupBy: ReadonlyArray<SpendDimension>;
  readonly includeDescendants?: boolean;
}

export function useAccountSpendReport(
  accountId: string | undefined,
  options: SpendReportOptions,
  enabled: boolean = true
) {
  const { oxyServices, isAuthenticated, isReady } = useAuth();

  return useQuery({
    queryKey: queryKeys.accountSpend(accountId ?? '', options.range, options.groupBy),
    queryFn: () =>
      oxyServices.makeRequest<SpendReportResponse>(
        'GET',
        `/inference/reporting/accounts/${accountId ?? ''}/spend`,
        {
          from: options.range.from,
          to: options.range.to,
          groupBy: groupByParam(options.groupBy),
          includeDescendants: options.includeDescendants,
        },
        { cache: false }
      ),
    select: selectSpendReport,
    enabled: isReady && isAuthenticated && !!accountId && enabled,
    staleTime: 1000 * 30,
    retry: 1,
  });
}

export function useApplicationSpendReport(
  applicationId: string | undefined,
  options: SpendReportOptions,
  enabled: boolean = true
) {
  const { oxyServices, isAuthenticated, isReady } = useAuth();

  return useQuery({
    queryKey: queryKeys.applicationSpend(applicationId ?? '', options.range, options.groupBy),
    queryFn: () =>
      oxyServices.makeRequest<SpendReportResponse>(
        'GET',
        `/inference/reporting/applications/${applicationId ?? ''}/spend`,
        {
          from: options.range.from,
          to: options.range.to,
          groupBy: groupByParam(options.groupBy),
        },
        { cache: false }
      ),
    select: selectSpendReport,
    enabled: isReady && isAuthenticated && !!applicationId && enabled,
    staleTime: 1000 * 30,
    retry: 1,
  });
}

function selectSpendReport(report: SpendReportResponse): SpendReportResponse {
  return {
    schemaVersion: report.schemaVersion,
    consistency: report.consistency,
    source: report.source,
    note: report.note,
    range: { from: report.range.from, to: report.range.to },
    groupBy: [...report.groupBy],
    rows: report.rows.map(toSpendRow),
    totals: report.totals.map((total) => ({
      currency: total.currency,
      receiptCount: total.receiptCount,
      billedAmount: total.billedAmount,
      refundedAmount: total.refundedAmount,
      netAmount: total.netAmount,
    })),
    truncated: report.truncated,
  };
}

/* -------------------------------------------------------------------------- */
/*  Reservations and charges                                                  */
/* -------------------------------------------------------------------------- */

/** Money held against in-flight requests. Nothing on this list has been charged. */
export function usePendingReservations(
  accountId: string | undefined,
  limit: number = 100,
  enabled: boolean = true
) {
  const { oxyServices, isAuthenticated, isReady } = useAuth();

  return useQuery({
    queryKey: queryKeys.reservations(accountId ?? ''),
    queryFn: () =>
      oxyServices.makeRequest<PendingReservationsResponse>(
        'GET',
        `/inference/reporting/accounts/${accountId ?? ''}/reservations`,
        { limit },
        { cache: false }
      ),
    select: (held): PendingReservationsResponse => ({
      schemaVersion: held.schemaVersion,
      consistency: held.consistency,
      source: held.source,
      note: held.note,
      rows: held.rows.map(toPendingReservation),
      totals: held.totals.map((total) => ({
        currency: total.currency,
        reservationCount: total.reservationCount,
        heldAmount: total.heldAmount,
      })),
      truncated: held.truncated,
    }),
    // A hold is short-lived by construction, so this is the one reporting read
    // where a stale answer is misleading within seconds rather than minutes.
    enabled: isReady && isAuthenticated && !!accountId && enabled,
    staleTime: 1000 * 10,
    retry: 1,
  });
}

/** Individual settled charges — the per-request detail behind the spend totals. */
export function useSettledCharges(
  accountId: string | undefined,
  range: DayRange,
  limit: number = 100,
  enabled: boolean = true
) {
  const { oxyServices, isAuthenticated, isReady } = useAuth();

  return useQuery({
    queryKey: queryKeys.charges(accountId ?? '', range),
    queryFn: () =>
      oxyServices.makeRequest<SettledChargesResponse>(
        'GET',
        `/inference/reporting/accounts/${accountId ?? ''}/charges`,
        { from: range.from, to: range.to, limit },
        { cache: false }
      ),
    select: (charges): SettledChargesResponse => ({
      schemaVersion: charges.schemaVersion,
      consistency: charges.consistency,
      source: charges.source,
      note: charges.note,
      range: { from: charges.range.from, to: charges.range.to },
      rows: charges.rows.map(toSettledCharge),
      truncated: charges.truncated,
    }),
    enabled: isReady && isAuthenticated && !!accountId && enabled,
    staleTime: 1000 * 30,
    retry: 1,
  });
}

/* -------------------------------------------------------------------------- */
/*  Budgets                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Every budget the account owns, with what has been spent against each.
 *
 * `currentSpend` comes from the same query the reservation path enforces with,
 * so this screen and the refusal a customer's traffic gets can never disagree.
 */
export function useBudgets(accountId: string | undefined, enabled: boolean = true) {
  const { oxyServices, isAuthenticated, isReady } = useAuth();

  return useQuery({
    queryKey: queryKeys.budgets(accountId ?? ''),
    queryFn: () =>
      oxyServices.makeRequest<BudgetsResponse>(
        'GET',
        `/inference/reporting/accounts/${accountId ?? ''}/spending-limits`,
        undefined,
        { cache: false }
      ),
    select: (budgets): BudgetsResponse => ({
      schemaVersion: budgets.schemaVersion,
      consistency: budgets.consistency,
      source: budgets.source,
      note: budgets.note,
      rows: budgets.rows.map(toBudget),
    }),
    enabled: isReady && isAuthenticated && !!accountId && enabled,
    staleTime: 1000 * 30,
    retry: 1,
  });
}

/**
 * Budget thresholds that were crossed, newest first.
 *
 * Served beside the budgets rather than on the billing router, and with the same
 * `{source, consistency}` stamp: a crossing records the spend at the instant it
 * happened, taken from the query the reservation path enforces with, so it is a
 * ledger figure like the budget it refers to.
 */
export function useBudgetAlerts(
  accountId: string | undefined,
  limit: number = 50,
  enabled: boolean = true
) {
  const { oxyServices, isAuthenticated, isReady } = useAuth();

  return useQuery({
    queryKey: queryKeys.budgetAlerts(accountId ?? ''),
    queryFn: () =>
      oxyServices.makeRequest<BudgetAlertsResponse>(
        'GET',
        `/inference/reporting/accounts/${accountId ?? ''}/spending-limits/alerts`,
        { limit },
        { cache: false }
      ),
    select: (alerts): BudgetAlertsResponse => ({
      schemaVersion: alerts.schemaVersion,
      consistency: alerts.consistency,
      source: alerts.source,
      note: alerts.note,
      rows: alerts.rows.map(toBudgetAlert),
    }),
    enabled: isReady && isAuthenticated && !!accountId && enabled,
    staleTime: 1000 * 30,
    retry: 1,
  });
}

/**
 * What a create form collects.
 *
 * A discriminated union, matching the API's own body schema, so "scope says
 * account, form names an application" cannot be built — rather than being caught
 * by a 400 after the customer has filled the form in.
 */
export type CreateBudgetInput = {
  readonly period: BudgetPeriod;
  readonly limitAmount: string;
  readonly currency?: string;
  readonly enforcement: BudgetEnforcement;
  readonly alertThresholdBps: ReadonlyArray<number>;
} & (
  | { readonly scope: Extract<BudgetScope, 'account'>; readonly scopeAccountId: string }
  | { readonly scope: Extract<BudgetScope, 'application'>; readonly scopeApplicationId: string }
  | {
      readonly scope: Extract<BudgetScope, 'credential'>;
      readonly scopeApplicationCredentialId: string;
    }
);

export function useCreateBudget() {
  const { oxyServices } = useAuth();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({
      accountId,
      input,
    }: {
      accountId: string;
      input: CreateBudgetInput;
    }): Promise<Budget> =>
      oxyServices
        .makeRequest<Budget>(
          'POST',
          `/inference/reporting/accounts/${accountId}/spending-limits`,
          input,
          { retry: false }
        )
        .then(toBudget),
    onSuccess: (_budget, { accountId }) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.budgets(accountId) });
    },
  });
}

/**
 * Raise, lower, re-arm or disable a budget. The SCOPE is not editable.
 *
 * There is no delete on this surface, and disabling is offered instead:
 * re-pointing or removing a budget would silently re-interpret every threshold
 * alert already recorded against it.
 */
export interface UpdateBudgetInput {
  readonly limitAmount?: string;
  readonly enforcement?: BudgetEnforcement;
  readonly alertThresholdBps?: ReadonlyArray<number>;
  readonly status?: BudgetStatus;
}

export function useUpdateBudget() {
  const { oxyServices } = useAuth();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({
      budgetId,
      input,
    }: {
      accountId: string;
      budgetId: string;
      input: UpdateBudgetInput;
    }): Promise<Budget> =>
      oxyServices
        .makeRequest<Budget>(
          'PATCH',
          `/inference/reporting/spending-limits/${budgetId}`,
          input,
          { retry: false }
        )
        .then(toBudget),
    onSuccess: (_budget, { accountId }) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.budgets(accountId) });
    },
  });
}
