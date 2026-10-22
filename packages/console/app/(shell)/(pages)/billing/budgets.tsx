import { Button } from '@oxy.so/bloom/button';
import { RiAddLine } from '@oxy.so/bloom/icons/RiAddLine';
import { ScreenScrollView } from '@oxy.so/bloom/screen';
import { toast } from '@oxy.so/bloom/toast';
import { useCallback, useMemo, useState } from 'react';
import { View } from 'react-native';

import { BudgetAlertsTable } from '@/components/billing/BudgetAlertsTable';
import { BudgetFormDialog } from '@/components/billing/BudgetFormDialog';
import { BudgetsTable } from '@/components/billing/BudgetsTable';
import { ApiState } from '@/components/loading/ApiState';
import { TableSkeleton } from '@/components/loading/ContentSkeleton';
import { NoBillingAccess } from '@/components/reporting/NoBillingAccess';
import { ProvenanceBanner } from '@/components/reporting/ProvenanceBanner';
import { useBillingAccess } from '@/hooks/use-billing-access';
import { useBudgetScopeLabel } from '@/hooks/use-budget-scope-label';
import {
  useBudgetAlerts,
  useBudgets,
  useLedgerBalance,
  useUpdateBudget,
} from '@/hooks/use-inference-reporting';
import { getErrorMessage } from '@/lib/api-error';
import { useTranslation } from '@/lib/i18n';
import type { Budget } from '@/lib/reporting';

const LEDGER = { source: 'financial_ledger', consistency: 'authoritative' } as const;

/**
 * Budgets: the ceilings that can refuse this account's traffic, and the thresholds
 * that warn before they do. A budget is a ceiling on spend, never a pot of money:
 * creating, raising, lowering or disabling one moves nothing.
 */
export default function BillingBudgetsPage() {
  const { t } = useTranslation();
  const { accountId, canRead, canManage } = useBillingAccess();
  const scopeLabel = useBudgetScopeLabel();

  const budgets = useBudgets(accountId, canRead);
  const alerts = useBudgetAlerts(accountId, 25, canRead);
  const balance = useLedgerBalance(accountId, canRead);
  const updateBudget = useUpdateBudget();

  const [form, setForm] = useState<{ open: boolean; budget?: Budget }>({ open: false });
  const currencies = useMemo(
    () => (balance.data?.balances ?? []).map((bucket) => bucket.currency),
    [balance.data],
  );

  const handleToggle = useCallback(
    async (budget: Budget) => {
      if (accountId === undefined) return;
      const next = budget.status === 'active' ? 'disabled' : 'active';
      try {
        await updateBudget.mutateAsync({
          accountId,
          budgetId: budget.spendingLimitId,
          input: { status: next },
        });
        toast.success(
          t(next === 'active' ? 'billingPage.budgets.rearmed' : 'billingPage.budgets.disabled'),
        );
      } catch (error: unknown) {
        toast.error(getErrorMessage(error, t('billingPage.budgets.changeFailed')));
      }
    },
    [accountId, t, updateBudget],
  );

  const handleEdit = useCallback((budget: Budget) => setForm({ open: true, budget }), []);

  const budgetName = useCallback(
    (spendingLimitId: string) => {
      const budget = budgets.data?.rows.find((row) => row.spendingLimitId === spendingLimitId);
      return budget === undefined ? spendingLimitId : scopeLabel(budget);
    },
    [budgets.data, scopeLabel],
  );

  const budgetCurrency = useCallback(
    (spendingLimitId: string) =>
      budgets.data?.rows.find((row) => row.spendingLimitId === spendingLimitId)?.currency,
    [budgets.data],
  );

  return (
    <ScreenScrollView contentContainerClassName="gap-4 p-4 pb-12">
      {!canRead ? (
        <NoBillingAccess />
      ) : (
        <>
          <ProvenanceBanner provenance={LEDGER} />

          {canManage ? (
            <View className="flex-row">
              <Button leadingIcon={RiAddLine} onPress={() => setForm({ open: true })}>
                {t('billingPage.budgets.new')}
              </Button>
            </View>
          ) : null}

          {budgets.isLoading ? (
            <TableSkeleton rows={4} columns={6} />
          ) : budgets.isError ? (
            <ApiState error={budgets.error} onRetry={() => void budgets.refetch()} />
          ) : (
            <BudgetsTable
              budgets={budgets.data?.rows ?? []}
              canManage={canManage}
              onEdit={handleEdit}
              onToggle={(budget) => void handleToggle(budget)}
            />
          )}

          {alerts.isLoading ? (
            <TableSkeleton rows={3} />
          ) : alerts.isError ? (
            <ApiState error={alerts.error} onRetry={() => void alerts.refetch()} />
          ) : (
            <BudgetAlertsTable
              alerts={alerts.data?.rows ?? []}
              budgetName={budgetName}
              budgetCurrency={budgetCurrency}
            />
          )}

          {accountId !== undefined ? (
            <BudgetFormDialog
              open={form.open}
              onClose={() => setForm((current) => ({ ...current, open: false }))}
              accountId={accountId}
              currencies={currencies}
              budget={form.budget}
            />
          ) : null}
        </>
      )}
    </ScreenScrollView>
  );
}
