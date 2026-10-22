import { useMemo, useState } from 'react';
import { Text, View } from 'react-native';
import { Link } from 'expo-router';
import { Button } from '@oxy.so/bloom/button';
import * as Skeleton from '@oxy.so/bloom/skeleton';
import { toast } from '@oxy.so/bloom/toast';
import { BudgetFormDialog } from '@/components/billing/budget-form-dialog';
import { useReportLabels } from '@/components/billing/labels';
import { ProvenanceBanner } from '@/components/billing/provenance-banner';
import type { Application, CallerAccess } from '@/hooks/use-applications';
import { useApplicationCredentials } from '@/hooks/use-applications';
import type { CreateBudgetInput } from '@/hooks/use-inference-reporting';
import {
  useBudgets,
  useCreateBudget,
  useLedgerBalance,
  useUpdateBudget,
} from '@/hooks/use-inference-reporting';
import { getErrorMessage } from '@/lib/api-error';
import { useTranslation } from '@/lib/i18n';
import { formatBasisPoints, formatMoney } from '@/lib/money';
import type { Budget } from '@/lib/reporting';
import { budgetUtilizationVariant } from '@/lib/reporting';
import { MutedText, NoPermission, Panel, Pill, SectionHeader } from './ui';

const LEDGER = { source: 'financial_ledger', consistency: 'authoritative' } as const;

/**
 * The budgets that can refuse THIS application's traffic.
 *
 * ## Three kinds bind an application, not one
 *
 * A budget scoped to the application itself, a budget scoped to one of its
 * credentials, and the owning account's own budget — which bounds everything
 * underneath it — all take effect here. Showing only the first would answer "no
 * budgets" to an application that is one request away from a hard stop, which is
 * the failure this section exists to prevent.
 *
 * The account-scoped ones are marked as inherited rather than merged in, because
 * they are not this application's to raise: editing one from here would change
 * every sibling application's ceiling at the same time.
 */
export function ApplicationBudgetsSection({
  application,
  access,
}: {
  application: Application;
  access: CallerAccess;
}) {
  const { t } = useTranslation();
  const canRead = access.can('billing:read');
  const canManage = access.can('billing:manage');

  const budgetsQuery = useBudgets(application.ownerAccountId, canRead);
  const balanceQuery = useLedgerBalance(application.ownerAccountId, canRead);
  const credentialsQuery = useApplicationCredentials(
    application._id,
    canRead && access.can('credentials:read'),
  );
  const createBudget = useCreateBudget();
  const updateBudget = useUpdateBudget();

  const [showForm, setShowForm] = useState(false);

  const credentialIds = useMemo(
    () => new Set((credentialsQuery.data ?? []).map((credential) => credential._id)),
    [credentialsQuery.data],
  );

  const { own, inherited } = useMemo(() => {
    const rows = budgetsQuery.data?.rows ?? [];
    return {
      own: rows.filter(
        (budget) =>
          budget.scopeApplicationId === application._id ||
          (budget.scopeApplicationCredentialId !== undefined &&
            credentialIds.has(budget.scopeApplicationCredentialId)),
      ),
      inherited: rows.filter((budget) => budget.scope === 'account'),
    };
  }, [budgetsQuery.data, application._id, credentialIds]);

  const currencies = (balanceQuery.data?.balances ?? []).map((bucket) => bucket.currency);

  const handleCreate = async (input: CreateBudgetInput) => {
    try {
      await createBudget.mutateAsync({ accountId: application.ownerAccountId, input });
      setShowForm(false);
      toast.success(t('appsInference.budgets.created'));
    } catch (error: unknown) {
      toast.error(getErrorMessage(error, t('appsInference.budgets.createFailed')));
    }
  };

  const handleToggle = async (budget: Budget) => {
    const next = budget.status === 'active' ? 'disabled' : 'active';
    try {
      await updateBudget.mutateAsync({
        accountId: application.ownerAccountId,
        budgetId: budget.spendingLimitId,
        input: { status: next },
      });
      toast.success(
        next === 'active'
          ? t('appsInference.budgets.rearmed')
          : t('appsInference.budgets.disabled'),
      );
    } catch (error: unknown) {
      toast.error(getErrorMessage(error, t('appsInference.budgets.changeFailed')));
    }
  };

  if (!canRead) {
    return <NoPermission>{t('appsInference.budgets.noPermission')}</NoPermission>;
  }

  return (
    <View className="gap-6">
      <SectionHeader
        title={t('appsInference.budgets.title')}
        description={t('appsInference.budgets.description')}
        action={
          canManage ? (
            <Button size="sm" onPress={() => setShowForm(true)}>
              {t('appsInference.budgets.new')}
            </Button>
          ) : undefined
        }
      />

      <ProvenanceBanner provenance={LEDGER} />

      <View className="gap-3">
        <Text className="text-sm font-medium text-foreground">
          {t('appsInference.budgets.own.title')}
        </Text>
        {budgetsQuery.isLoading ? (
          <Skeleton.Box width="100%" height={96} />
        ) : own.length === 0 ? (
          <MutedText>{t('appsInference.budgets.own.empty')}</MutedText>
        ) : (
          own.map((budget) => (
            <BudgetRow
              key={budget.spendingLimitId}
              budget={budget}
              canManage={canManage}
              isPending={updateBudget.isPending}
              onToggle={handleToggle}
            />
          ))
        )}
      </View>

      <View className="gap-3">
        <Text className="text-sm font-medium text-foreground">
          {t('appsInference.budgets.inherited.title')}
        </Text>
        {budgetsQuery.isLoading ? (
          <Skeleton.Box width="100%" height={96} />
        ) : inherited.length === 0 ? (
          <MutedText>{t('appsInference.budgets.inherited.empty')}</MutedText>
        ) : (
          <>
            {inherited.map((budget) => (
              <BudgetRow
                key={budget.spendingLimitId}
                budget={budget}
                canManage={false}
                isPending={false}
                onToggle={handleToggle}
              />
            ))}
            <Text className="text-xs text-muted-foreground">
              {t('appsInference.budgets.inherited.note')}{' '}
              <Link href="/billing/budgets" className="text-foreground underline">
                {t('appsInference.budgets.inherited.link')}
              </Link>
            </Text>
          </>
        )}
      </View>

      <BudgetFormDialog
        open={showForm}
        onOpenChange={setShowForm}
        accountId={application.ownerAccountId}
        currencies={currencies}
        fixedApplicationId={application._id}
        isPending={createBudget.isPending}
        onSubmit={handleCreate}
      />
    </View>
  );
}

function BudgetRow({
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
    <Panel className="p-4">
      <View className="flex-row flex-wrap items-start justify-between gap-4">
        <View className="min-w-0 flex-1">
          <View className="flex-row flex-wrap items-center gap-2">
            <Text className="text-sm font-medium text-foreground">
              {`${labels.period(budget.period)} · ${formatMoney(budget.limitAmount, budget.currency)}`}
            </Text>
            <Pill
              label={
                budget.status === 'disabled'
                  ? t('appsInference.budgets.row.disabled')
                  : t('appsInference.budgets.row.used', {
                      percent: formatBasisPoints(budget.utilizationBps),
                    })
              }
              tone={budgetUtilizationVariant(budget)}
            />
            {budget.scope === 'credential' && (
              <Pill label={t('appsInference.budgets.row.credential')} tone="outline" />
            )}
          </View>
          <View className="mt-1">
            <MutedText small>{labels.enforcement(budget.enforcement)}</MutedText>
          </View>
          <View className="mt-1">
            <MutedText small>
              {t('appsInference.budgets.row.spent', {
                spent: formatMoney(budget.currentSpend, budget.currency),
                remaining: formatMoney(budget.remaining, budget.currency),
              })}
            </MutedText>
          </View>
        </View>
        {canManage && (
          <Button
            appearance="outline"
            size="sm"
            onPress={() => onToggle(budget)}
            disabled={isPending}
          >
            {budget.status === 'active'
              ? t('appsInference.budgets.row.disable')
              : t('appsInference.budgets.row.rearm')}
          </Button>
        )}
      </View>
    </Panel>
  );
}
