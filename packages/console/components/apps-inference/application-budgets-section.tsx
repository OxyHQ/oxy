import { useMemo, useState } from 'react';
import { Text, View } from 'react-native';
import { Link } from 'expo-router';
import { Admonition } from '@oxy.so/bloom/admonition';
import { Badge } from '@oxy.so/bloom/badge';
import { Button } from '@oxy.so/bloom/button';
import { CardDescription, CardTitle } from '@oxy.so/bloom/card';
import { DataTable, type DataTableColumn } from '@oxy.so/bloom/data-table';
import { EmptyState } from '@oxy.so/bloom/empty-state';
import * as Skeleton from '@oxy.so/bloom/skeleton';
import { toast } from '@oxy.so/bloom/toast';
import { useReportLabels } from '@/components/billing/labels';
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
import { BudgetCreateDialog } from './budget-create-dialog';

/** The tone a budget's utilisation badge takes: a hard-stopped one is an error. */
function budgetColor(budget: Budget): 'default' | 'info' | 'error' {
  const variant = budgetUtilizationVariant(budget);
  return variant === 'destructive' ? 'error' : variant === 'secondary' ? 'default' : 'info';
}

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

  const labels = useReportLabels();

  const baseColumns = useMemo<Array<DataTableColumn<Budget>>>(
    () => [
      {
        id: 'limit',
        header: t('appsInference.budgets.columns.limit'),
        minWidth: 180,
        cell: ({ row }) => (
          <Text className="text-sm font-medium text-foreground">
            {`${labels.period(row.period)} · ${formatMoney(row.limitAmount, row.currency)}`}
          </Text>
        ),
      },
      {
        id: 'status',
        header: t('appsInference.budgets.columns.status'),
        minWidth: 170,
        cell: ({ row }) => (
          <View className="flex-row flex-wrap items-center gap-1.5">
            <Badge
              content={
                row.status === 'disabled'
                  ? t('appsInference.budgets.row.disabled')
                  : t('appsInference.budgets.row.used', {
                      percent: formatBasisPoints(row.utilizationBps),
                    })
              }
              variant="subtle"
              color={budgetColor(row)}
              size="label-small"
            />
            {row.scope === 'credential' && (
              <Badge
                content={t('appsInference.budgets.row.credential')}
                variant="outlined"
                size="label-small"
              />
            )}
          </View>
        ),
      },
      {
        id: 'enforcement',
        header: t('appsInference.budgets.columns.enforcement'),
        minWidth: 150,
        cell: ({ row }) => (
          <Text className="text-xs text-muted-foreground">
            {labels.enforcement(row.enforcement)}
          </Text>
        ),
      },
      {
        id: 'spent',
        header: t('appsInference.budgets.columns.spent'),
        minWidth: 220,
        cell: ({ row }) => (
          <Text className="text-xs text-muted-foreground">
            {t('appsInference.budgets.row.spent', {
              spent: formatMoney(row.currentSpend, row.currency),
              remaining: formatMoney(row.remaining, row.currency),
            })}
          </Text>
        ),
      },
    ],
    [t, labels],
  );

  const inheritedColumns = baseColumns;
  const columns = useMemo<Array<DataTableColumn<Budget>>>(
    () =>
      canManage
        ? [
            ...baseColumns,
            {
              id: 'actions',
              header: '',
              headerAccessibilityLabel: t('appsInference.budgets.columns.actions'),
              align: 'end',
              width: 120,
              cell: ({ row }) => (
                <Button
                  appearance="outline"
                  size="sm"
                  onPress={() => handleToggle(row)}
                  disabled={updateBudget.isPending}
                >
                  {row.status === 'active'
                    ? t('appsInference.budgets.row.disable')
                    : t('appsInference.budgets.row.rearm')}
                </Button>
              ),
            },
          ]
        : baseColumns,
    // `handleToggle` closes over the stable mutation and the application id.
    [baseColumns, canManage, t, updateBudget.isPending],
  );

  if (!canRead) {
    return <EmptyState variant="compact" title={t('appsInference.budgets.noPermission')} />;
  }

  return (
    <View className="gap-6">
      <View>
        <CardTitle>{t('appsInference.budgets.title')}</CardTitle>
        <CardDescription>{t('appsInference.budgets.description')}</CardDescription>
      </View>

      <Admonition type="info">
        <Text className="font-semibold">{labels.provenanceHeadline(LEDGER)}</Text>
        {`\n${labels.provenanceExplanation(LEDGER)}`}
      </Admonition>

      {budgetsQuery.isLoading ? (
        <Skeleton.Box width="100%" height={160} />
      ) : (
        <>
          <DataTable
            rows={own}
            columns={columns}
            getRowId={(budget) => budget.spendingLimitId}
            accessibilityLabel={t('appsInference.budgets.own.title')}
            title={t('appsInference.budgets.own.title')}
            toolbar={
              canManage ? (
                <Button size="sm" onPress={() => setShowForm(true)}>
                  {t('appsInference.budgets.new')}
                </Button>
              ) : undefined
            }
            emptyState={
              <Text className="text-sm text-muted-foreground">
                {t('appsInference.budgets.own.empty')}
              </Text>
            }
            minWidth={720}
            size="sm"
          />

          <DataTable
            rows={inherited}
            columns={inheritedColumns}
            getRowId={(budget) => budget.spendingLimitId}
            accessibilityLabel={t('appsInference.budgets.inherited.title')}
            title={t('appsInference.budgets.inherited.title')}
            summary={
              inherited.length > 0 ? (
                <Text className="text-xs text-muted-foreground">
                  {t('appsInference.budgets.inherited.note')}{' '}
                  <Link href="/billing/budgets" className="text-foreground underline">
                    {t('appsInference.budgets.inherited.link')}
                  </Link>
                </Text>
              ) : undefined
            }
            emptyState={
              <Text className="text-sm text-muted-foreground">
                {t('appsInference.budgets.inherited.empty')}
              </Text>
            }
            minWidth={720}
            size="sm"
          />
        </>
      )}

      <BudgetCreateDialog
        open={showForm}
        onOpenChange={setShowForm}
        applicationId={application._id}
        currencies={currencies}
        isPending={createBudget.isPending}
        onSubmit={handleCreate}
      />
    </View>
  );
}
