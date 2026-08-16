import { createFileRoute } from '@tanstack/react-router';
import { useState } from 'react';
import * as Skeleton from '@oxyhq/bloom/skeleton';
import { toast } from '@oxyhq/bloom/toast';
import type { CreateBudgetInput } from '@/hooks/use-inference-reporting';
import type { Budget } from '@/lib/reporting';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { BillingHeader } from '@/components/billing/billing-header';
import { ProvenanceBanner } from '@/components/billing/provenance-banner';
import { BudgetFormDialog } from '@/components/billing/budget-form-dialog';
import { accountLabel, useAccount } from '@/hooks/use-account';
import {
  useBudgetAlerts,
  useBudgets,
  useCreateBudget,
  useLedgerBalance,
  useUpdateBudget,
} from '@/hooks/use-inference-reporting';
import { formatAmount, formatBasisPoints, formatMoney } from '@/lib/money';
import { getErrorMessage } from '@/lib/api-error';
import {
  budgetEnforcementLabel,
  budgetPeriodLabel,
  budgetScopeDescription,
  budgetUtilizationVariant,
} from '@/lib/reporting';

/**
 * Budgets: the ceilings that can refuse this account's traffic, and the
 * thresholds that warn before they do.
 *
 * `currentSpend`, `remaining` and `utilizationBps` come from the same query the
 * reservation path evaluates a limit with, so this screen and the refusal a
 * customer's requests actually get can never disagree — a report that disagreed
 * with the enforcement would be worse than no report.
 *
 * A budget is a CEILING ON SPEND, never a pot of money: raising, lowering or
 * disabling one moves nothing. There is no delete offered, only disable —
 * removing a budget would silently re-interpret every threshold alert already
 * recorded against it.
 */
export const Route = createFileRoute('/_layout/billing/budgets')({
  component: BillingBudgetsPage,
});

function BillingBudgetsPage() {
  const { currentAccount, canReadBilling, canManageBilling } = useAccount();
  const accountId = currentAccount?.accountId;
  const canRead = currentAccount !== null && canReadBilling(currentAccount);
  const canManage = currentAccount !== null && canManageBilling(currentAccount);

  const budgetsQuery = useBudgets(accountId, canRead);
  const alertsQuery = useBudgetAlerts(accountId, 25, canRead);
  const balanceQuery = useLedgerBalance(accountId, canRead);
  const createBudget = useCreateBudget();
  const updateBudget = useUpdateBudget();

  const [showForm, setShowForm] = useState(false);

  const budgets = budgetsQuery.data?.rows ?? [];
  const currencies = (balanceQuery.data?.balances ?? []).map((bucket) => bucket.currency);

  const handleCreate = async (input: CreateBudgetInput) => {
    if (accountId === undefined) {
      return;
    }
    try {
      await createBudget.mutateAsync({ accountId, input });
      setShowForm(false);
      toast.success('Budget created.');
    } catch (error: unknown) {
      toast.error(getErrorMessage(error, 'Could not create the budget'));
    }
  };

  const handleToggle = async (budget: Budget) => {
    if (accountId === undefined) {
      return;
    }
    const next = budget.status === 'active' ? 'disabled' : 'active';
    try {
      await updateBudget.mutateAsync({
        accountId,
        budgetId: budget.spendingLimitId,
        input: { status: next },
      });
      toast.success(next === 'active' ? 'Budget re-armed.' : 'Budget disabled.');
    } catch (error: unknown) {
      toast.error(getErrorMessage(error, 'Could not change the budget'));
    }
  };

  return (
    <ScrollArea className="flex-1 bg-background">
      <BillingHeader
        active="budgets"
        accountName={currentAccount === null ? undefined : accountLabel(currentAccount)}
      />

      {!canRead ? (
        <div className="px-6 py-12 text-center text-sm text-muted-foreground">
          You do not have permission to see this account's budgets.
        </div>
      ) : (
        <>
          <div className="px-6 py-6 border-b border-border">
            <ProvenanceBanner
              provenance={{ source: 'financial_ledger', consistency: 'authoritative' }}
            />
          </div>

          <div className="px-6 py-6 border-b border-border">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div>
                <p className="text-sm font-semibold text-foreground">Budgets</p>
                <p className="mt-0.5 text-sm text-muted-foreground max-w-2xl">
                  A ceiling on spend, evaluated before a request runs. A hard stop refuses the
                  request at the ceiling; a soft stop lets it through and records the crossing.
                </p>
              </div>
              {canManage && (
                <Button size="sm" onClick={() => setShowForm(true)}>
                  New budget
                </Button>
              )}
            </div>

            <div className="mt-6">
              {budgetsQuery.isLoading ? (
                <div className="space-y-2">
                  {[1, 2].map((index) => (
                    <Skeleton.Box key={index} width="100%" height={96} />
                  ))}
                </div>
              ) : budgets.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  No budgets. Without one, spend is bounded only by the balance and, for an invoiced
                  account, by its credit limit.
                </p>
              ) : (
                <div className="space-y-3">
                  {budgets.map((budget) => (
                    <BudgetCard
                      key={budget.spendingLimitId}
                      budget={budget}
                      canManage={canManage}
                      isPending={updateBudget.isPending}
                      onToggle={handleToggle}
                    />
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* Alerts */}
          <div className="px-6 py-6">
            <p className="text-sm font-semibold text-foreground">Threshold crossings</p>
            <p className="mt-0.5 mb-4 text-sm text-muted-foreground max-w-2xl">
              Each is recorded once per budget, period and threshold — so an alert does not re-fire
              on every request for the rest of the period.
            </p>
            {alertsQuery.isLoading ? (
              <Skeleton.Box width="100%" height={48} />
            ) : (alertsQuery.data?.rows ?? []).length === 0 ? (
              <p className="text-sm text-muted-foreground">No thresholds have been crossed.</p>
            ) : (
              <div className="divide-y divide-border rounded-lg border border-border">
                {(alertsQuery.data?.rows ?? []).map((alert) => (
                  <div
                    key={alert.alertId}
                    className="flex flex-wrap items-center justify-between gap-3 px-4 py-3"
                  >
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-foreground">
                        {formatBasisPoints(alert.thresholdBps)} of a budget reached
                      </p>
                      <p className="text-xs text-muted-foreground font-mono">
                        {alert.spendingLimitId}
                      </p>
                    </div>
                    <div className="text-right">
                      {/*
                        Formatted without a currency: the alert record carries
                        the amount and not the code, and inventing one here
                        would be the frontend asserting something the contract
                        does not say.
                      */}
                      <p className="text-sm text-foreground tabular-nums">
                        {formatAmount(alert.spendAmount)} spent at the crossing
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {new Date(alert.createdAt).toLocaleString()}
                      </p>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </>
      )}

      {accountId !== undefined && (
        <BudgetFormDialog
          open={showForm}
          onOpenChange={setShowForm}
          accountId={accountId}
          currencies={currencies}
          isPending={createBudget.isPending}
          onSubmit={handleCreate}
        />
      )}
    </ScrollArea>
  );
}

function BudgetCard({
  budget,
  canManage,
  isPending,
  onToggle,
}: {
  budget: Budget;
  canManage: boolean;
  isPending: boolean;
  onToggle: (budget: Budget) => void;
}) {
  return (
    <div className="rounded-lg border border-border p-4">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-sm font-medium text-foreground">
              {budgetPeriodLabel(budget.period)} · {formatMoney(budget.limitAmount, budget.currency)}
            </p>
            <Badge variant={budgetUtilizationVariant(budget)}>
              {budget.status === 'disabled'
                ? 'Disabled'
                : `${formatBasisPoints(budget.utilizationBps)} used`}
            </Badge>
          </div>
          <p className="mt-1 text-xs text-muted-foreground font-mono">
            {budgetScopeDescription(budget)}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            {budgetEnforcementLabel(budget.enforcement)}
          </p>
        </div>

        {canManage && (
          <Button variant="outline" size="sm" onClick={() => onToggle(budget)} disabled={isPending}>
            {budget.status === 'active' ? 'Disable' : 'Re-arm'}
          </Button>
        )}
      </div>

      <div className="mt-4 flex flex-row flex-wrap gap-10">
        <div>
          <p className="text-sm text-foreground tabular-nums">
            {formatMoney(budget.currentSpend, budget.currency)}
          </p>
          <p className="text-xs text-muted-foreground">
            spent this period, including money currently held
          </p>
        </div>
        <div>
          <p className="text-sm text-foreground tabular-nums">
            {formatMoney(budget.remaining, budget.currency)}
          </p>
          <p className="text-xs text-muted-foreground">remaining before the ceiling</p>
        </div>
        <div>
          <p className="text-sm text-foreground">
            {budget.alertThresholdBps.length === 0
              ? 'No alerts'
              : budget.alertThresholdBps.map(formatBasisPoints).join(', ')}
          </p>
          <p className="text-xs text-muted-foreground">alert thresholds</p>
        </div>
        <div>
          <p className="text-sm text-foreground">
            {new Date(budget.periodStart).toLocaleDateString()}
          </p>
          <p className="text-xs text-muted-foreground">period started</p>
        </div>
      </div>
    </div>
  );
}
