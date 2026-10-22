import { Badge } from '@oxy.so/bloom/badge';
import { Button } from '@oxy.so/bloom/button';
import { Card, CardBody, CardDescription, CardHeader, CardTitle } from '@oxy.so/bloom/card';
import { EmptyState } from '@oxy.so/bloom/empty-state';
import { GroupedSection, GroupedSectionItem } from '@oxy.so/bloom/grouped-section';
import { RiLockLine } from '@oxy.so/bloom/icons/RiLockLine';
import { ScreenScrollView } from '@oxy.so/bloom/screen';
import * as Skeleton from '@oxy.so/bloom/skeleton';
import { StatBar } from '@oxy.so/bloom/stat-bar';
import { toast } from '@oxy.so/bloom/toast';
import { Muted } from '@oxy.so/bloom/typography';
import { useState } from 'react';
import { View } from 'react-native';
import { BudgetFormDialog } from '@/components/billing/budget-form-dialog';
import { statusBadge, useReportLabels } from '@/components/billing/labels';
import { ProvenanceBanner } from '@/components/billing/provenance-banner';
import { useAccount } from '@/hooks/use-account';
import {
  type CreateBudgetInput,
  useBudgetAlerts,
  useBudgets,
  useCreateBudget,
  useLedgerBalance,
  useUpdateBudget,
} from '@/hooks/use-inference-reporting';
import { getErrorMessage } from '@/lib/api-error';
import { useTranslation } from '@/lib/i18n';
import { formatAmount, formatBasisPoints, formatMoney } from '@/lib/money';
import { type Budget, budgetUtilizationVariant } from '@/lib/reporting';

const LEDGER = { source: 'financial_ledger', consistency: 'authoritative' } as const;

/**
 * Budgets: the ceilings that can refuse this account's traffic, and the
 * thresholds that warn before they do.
 *
 * `currentSpend`, `remaining` and `utilizationBps` come from the same query the
 * reservation path evaluates a limit with, so this screen and the refusal a
 * customer's requests actually get can never disagree.
 *
 * A budget is a CEILING ON SPEND, never a pot of money. There is no delete,
 * only disable — removing a budget would silently re-interpret every threshold
 * alert already recorded against it.
 */
export default function BillingBudgetsPage() {
  const { t } = useTranslation();
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
  const alerts = alertsQuery.data?.rows ?? [];
  const currencies = (balanceQuery.data?.balances ?? []).map((bucket) => bucket.currency);

  const handleCreate = async (input: CreateBudgetInput) => {
    if (accountId === undefined) {
      return;
    }
    try {
      await createBudget.mutateAsync({ accountId, input });
      setShowForm(false);
      toast.success(t('billingPage.budgets.created'));
    } catch (error: unknown) {
      toast.error(getErrorMessage(error, t('billingPage.budgets.createFailed')));
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
      toast.success(
        t(next === 'active' ? 'billingPage.budgets.rearmed' : 'billingPage.budgets.disabled'),
      );
    } catch (error: unknown) {
      toast.error(getErrorMessage(error, t('billingPage.budgets.changeFailed')));
    }
  };

  return (
    <ScreenScrollView contentContainerClassName="gap-6 px-4 py-6 pb-12">
      {!canRead ? (
        <EmptyState icon={RiLockLine} title={t('billingPage.budgets.denied')} />
      ) : (
        <>
          <ProvenanceBanner provenance={LEDGER} />

          <Card>
            <CardHeader>
              <View className="flex-row flex-wrap items-start justify-between gap-4">
                <View className="min-w-0 flex-1">
                  <CardTitle>{t('billingPage.budgets.title')}</CardTitle>
                  <CardDescription>{t('billingPage.budgets.body')}</CardDescription>
                </View>
                {canManage ? (
                  <Button size="sm" onPress={() => setShowForm(true)}>
                    {t('billingPage.budgets.new')}
                  </Button>
                ) : null}
              </View>
            </CardHeader>
            <CardBody>
              {budgetsQuery.isLoading ? (
                <Skeleton.Box width="100%" height={96} />
              ) : budgets.length === 0 ? (
                <Muted>{t('billingPage.budgets.none')}</Muted>
              ) : (
                <View className="gap-6">
                  {budgets.map((budget) => (
                    <BudgetCard
                      key={budget.spendingLimitId}
                      budget={budget}
                      canManage={canManage}
                      isPending={updateBudget.isPending}
                      onToggle={handleToggle}
                    />
                  ))}
                </View>
              )}
            </CardBody>
          </Card>

          {alertsQuery.isLoading ? (
            <Skeleton.Box width="100%" height={96} />
          ) : alerts.length === 0 ? (
            <Muted>{t('billingPage.budgets.noAlerts')}</Muted>
          ) : (
            <GroupedSection
              title={t('billingPage.budgets.alertsTitle')}
              footer={t('billingPage.budgets.alertsBody')}
            >
              {alerts.map((alert) => (
                <GroupedSectionItem
                  key={alert.alertId}
                  title={t('billingPage.budgets.reached', {
                    threshold: formatBasisPoints(alert.thresholdBps),
                  })}
                  description={`${alert.spendingLimitId} · ${new Date(alert.createdAt).toLocaleString()}`}
                  // Formatted without a currency: the alert record carries the
                  // amount and not the code, and inventing one here would be the
                  // frontend asserting something the contract does not say.
                  value={t('billingPage.budgets.spentAtCrossing', {
                    amount: formatAmount(alert.spendAmount),
                  })}
                />
              ))}
            </GroupedSection>
          )}
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
    </ScreenScrollView>
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
  const { t } = useTranslation();
  const labels = useReportLabels();
  const used = t('billingPage.budgets.used', { percent: formatBasisPoints(budget.utilizationBps) });

  return (
    <View className="gap-3">
      <StatBar
        label={`${labels.period(budget.period)} · ${formatMoney(budget.limitAmount, budget.currency)}`}
        value={Math.min(budget.utilizationBps, 10000)}
        max={10000}
      />
      <GroupedSection>
        <GroupedSectionItem
          title={labels.scope(budget)}
          description={labels.enforcement(budget.enforcement)}
          rightElement={
            <View className="flex-row items-center gap-2">
              <Badge
                content={
                  budget.status === 'disabled' ? t('billingPage.budgets.statusDisabled') : used
                }
                {...statusBadge(budgetUtilizationVariant(budget))}
              />
              {canManage && (
                <Button
                  appearance="outline"
                  size="sm"
                  onPress={() => onToggle(budget)}
                  disabled={isPending}
                >
                  {t(
                    budget.status === 'active'
                      ? 'billingPage.budgets.disable'
                      : 'billingPage.budgets.rearm',
                  )}
                </Button>
              )}
            </View>
          }
        />
        <GroupedSectionItem
          title={t('billingPage.budgets.spentThisPeriod')}
          value={formatMoney(budget.currentSpend, budget.currency)}
        />
        <GroupedSectionItem
          title={t('billingPage.budgets.remaining')}
          value={formatMoney(budget.remaining, budget.currency)}
        />
        <GroupedSectionItem
          title={t('billingPage.budgets.thresholds')}
          value={
            budget.alertThresholdBps.length === 0
              ? t('billingPage.budgets.noAlertsSet')
              : budget.alertThresholdBps.map(formatBasisPoints).join(', ')
          }
        />
        <GroupedSectionItem
          title={t('billingPage.budgets.periodStarted')}
          value={new Date(budget.periodStart).toLocaleDateString()}
        />
      </GroupedSection>
    </View>
  );
}
