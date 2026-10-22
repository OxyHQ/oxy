import { Button } from '@oxy.so/bloom/button';
import { toast } from '@oxy.so/bloom/toast';
import { useState } from 'react';
import { Text, View } from 'react-native';
import { PageBody } from '@/components/account-pages/PageFrame';
import { Denied, Muted, Panel, Row, RowList, Section } from '@/components/account-pages/Section';
import { SkeletonRows } from '@/components/account-pages/Skeletons';
import { StatusBadge } from '@/components/account-pages/StatusBadge';
import { BudgetFormDialog } from '@/components/billing/budget-form-dialog';
import { useReportLabels } from '@/components/billing/labels';
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
    <PageBody>
      {!canRead ? (
        <Denied>{t('billingPage.budgets.denied')}</Denied>
      ) : (
        <>
          <Section>
            <ProvenanceBanner provenance={LEDGER} />
          </Section>

          <Section
            title={t('billingPage.budgets.title')}
            description={t('billingPage.budgets.body')}
            action={
              canManage ? (
                <Button size="sm" onPress={() => setShowForm(true)}>
                  {t('billingPage.budgets.new')}
                </Button>
              ) : undefined
            }
          >
            {budgetsQuery.isLoading ? (
              <SkeletonRows count={2} height={96} />
            ) : budgets.length === 0 ? (
              <Muted>{t('billingPage.budgets.none')}</Muted>
            ) : (
              <View className="gap-3">
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
          </Section>

          <Section
            title={t('billingPage.budgets.alertsTitle')}
            description={t('billingPage.budgets.alertsBody')}
            last
          >
            {alertsQuery.isLoading ? (
              <SkeletonRows count={1} height={48} />
            ) : alerts.length === 0 ? (
              <Muted>{t('billingPage.budgets.noAlerts')}</Muted>
            ) : (
              <RowList>
                {alerts.map((alert, index) => (
                  <Row key={alert.alertId} first={index === 0}>
                    <View className="min-w-0 gap-0.5">
                      <Text className="text-sm font-medium text-foreground">
                        {t('billingPage.budgets.reached', {
                          threshold: formatBasisPoints(alert.thresholdBps),
                        })}
                      </Text>
                      <Text className="font-mono text-xs text-muted-foreground">
                        {alert.spendingLimitId}
                      </Text>
                    </View>
                    <View className="items-end gap-0.5">
                      {/*
                        Formatted without a currency: the alert record carries
                        the amount and not the code, and inventing one here
                        would be the frontend asserting something the contract
                        does not say.
                      */}
                      <Text
                        className="text-sm text-foreground"
                        style={{ fontVariant: ['tabular-nums'] }}
                      >
                        {t('billingPage.budgets.spentAtCrossing', {
                          amount: formatAmount(alert.spendAmount),
                        })}
                      </Text>
                      <Text className="text-xs text-muted-foreground">
                        {new Date(alert.createdAt).toLocaleString()}
                      </Text>
                    </View>
                  </Row>
                ))}
              </RowList>
            )}
          </Section>
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
    </PageBody>
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

  return (
    <Panel>
      <View className="flex-row flex-wrap items-start justify-between gap-4">
        <View className="min-w-0 flex-1 gap-1">
          <View className="flex-row flex-wrap items-center gap-2">
            <Text className="text-sm font-medium text-foreground">
              {labels.period(budget.period)} · {formatMoney(budget.limitAmount, budget.currency)}
            </Text>
            <StatusBadge
              variant={budgetUtilizationVariant(budget)}
              label={
                budget.status === 'disabled'
                  ? t('billingPage.budgets.statusDisabled')
                  : t('billingPage.budgets.used', {
                      percent: formatBasisPoints(budget.utilizationBps),
                    })
              }
            />
          </View>
          <Text className="font-mono text-xs text-muted-foreground">{labels.scope(budget)}</Text>
          <Text className="text-xs text-muted-foreground">
            {labels.enforcement(budget.enforcement)}
          </Text>
        </View>

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

      <View className="mt-4 flex-row flex-wrap gap-x-10 gap-y-4">
        <Stat
          value={formatMoney(budget.currentSpend, budget.currency)}
          caption={t('billingPage.budgets.spentThisPeriod')}
        />
        <Stat
          value={formatMoney(budget.remaining, budget.currency)}
          caption={t('billingPage.budgets.remaining')}
        />
        <Stat
          value={
            budget.alertThresholdBps.length === 0
              ? t('billingPage.budgets.noAlertsSet')
              : budget.alertThresholdBps.map(formatBasisPoints).join(', ')
          }
          caption={t('billingPage.budgets.thresholds')}
        />
        <Stat
          value={new Date(budget.periodStart).toLocaleDateString()}
          caption={t('billingPage.budgets.periodStarted')}
        />
      </View>
    </Panel>
  );
}

function Stat({ value, caption }: { value: string; caption: string }) {
  return (
    <View className="gap-0.5">
      <Text className="text-sm text-foreground" style={{ fontVariant: ['tabular-nums'] }}>
        {value}
      </Text>
      <Text className="text-xs text-muted-foreground">{caption}</Text>
    </View>
  );
}
