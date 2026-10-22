import { useMemo, useState } from 'react';
import { Text, View } from 'react-native';
import { Link } from 'expo-router';
import { Admonition } from '@oxy.so/bloom/admonition';
import { Badge } from '@oxy.so/bloom/badge';
import { Button } from '@oxy.so/bloom/button';
import {
  DataTable,
  DataTableRowActions,
  type DataTableColumn,
  type DataTableRowActionItem,
} from '@oxy.so/bloom/data-table';
import { EmptyState } from '@oxy.so/bloom/empty-state';
import { Item } from '@oxy.so/bloom/item';
import { RiAddLine } from '@oxy.so/bloom/icons/RiAddLine';
import { RiEditLine } from '@oxy.so/bloom/icons/RiEditLine';
import { RiForbidLine } from '@oxy.so/bloom/icons/RiForbidLine';
import { RiPlayCircleLine } from '@oxy.so/bloom/icons/RiPlayCircleLine';
import * as Skeleton from '@oxy.so/bloom/skeleton';
import { toast } from '@oxy.so/bloom/toast';
import { useAppDetail } from '@/components/apps/app-context';
import { useReportLabels } from '@/components/billing/labels';
import { useApplicationCredentials } from '@/hooks/use-applications';
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
import { BudgetDialog, type BudgetFormValues } from './BudgetDialog';

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
export function ApplicationBudgets() {
  const { t } = useTranslation();
  const { application, access } = useAppDetail();
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

  // `null` is closed, `'new'` creates, a budget edits that one.
  const [dialog, setDialog] = useState<Budget | 'new' | null>(null);

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

  const handleSubmit = async (values: BudgetFormValues) => {
    if (dialog === null) return;
    try {
      if (dialog === 'new') {
        await createBudget.mutateAsync({
          accountId: application.ownerAccountId,
          input: { ...values, scope: 'application', scopeApplicationId: application._id },
        });
        toast.success(t('appsInference.budgets.created'));
      } else {
        await updateBudget.mutateAsync({
          accountId: application.ownerAccountId,
          budgetId: dialog.spendingLimitId,
          input: {
            limitAmount: values.limitAmount,
            enforcement: values.enforcement,
            alertThresholdBps: values.alertThresholdBps,
          },
        });
        toast.success(t('appsInference.budgets.updated'));
      }
      setDialog(null);
    } catch (error: unknown) {
      toast.error(
        getErrorMessage(
          error,
          dialog === 'new'
            ? t('appsInference.budgets.createFailed')
            : t('appsInference.budgets.changeFailed'),
        ),
      );
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
        minWidth: 150,
        cell: ({ row }) => (
          <Text className="text-sm font-medium text-foreground">
            {`${labels.period(row.period)} · ${formatMoney(row.limitAmount, row.currency)}`}
          </Text>
        ),
      },
      {
        id: 'status',
        header: t('appsInference.budgets.columns.status'),
        minWidth: 140,
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
        minWidth: 190,
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
              width: 56,
              cell: ({ row }) => {
                const menu: Array<DataTableRowActionItem> = [
                  {
                    icon: RiEditLine,
                    label: t('common.edit'),
                    onPress: () => setDialog(row),
                  },
                  row.status === 'active'
                    ? {
                        icon: RiForbidLine,
                        label: t('appsInference.budgets.row.disable'),
                        onPress: () => handleToggle(row),
                      }
                    : {
                        icon: RiPlayCircleLine,
                        label: t('appsInference.budgets.row.rearm'),
                        onPress: () => handleToggle(row),
                      },
                ];
                return (
                  <DataTableRowActions
                    name={`${labels.period(row.period)} ${formatMoney(row.limitAmount, row.currency)}`}
                    menuLabel={t('appsInference.budgets.columns.actions')}
                    menu={menu}
                  />
                );
              },
            },
          ]
        : baseColumns,
    // `handleToggle` closes over the stable mutation and the application id.
    [baseColumns, canManage, labels, t],
  );

  if (!canRead) {
    return <EmptyState variant="compact" title={t('appsInference.budgets.noPermission')} />;
  }

  return (
    <>
      <Admonition type="info">
        <Text className="font-semibold">{labels.provenanceHeadline(LEDGER)}</Text>
        {`\n${labels.provenanceExplanation(LEDGER)}`}
      </Admonition>

      {budgetsQuery.isLoading ? (
        <Skeleton.Box width="100%" height={160} borderRadius={14} />
      ) : budgetsQuery.isError ? (
        <Admonition type="error">{t('appsInference.budgets.loadFailed')}</Admonition>
      ) : (
        <>
          <Item
            title={t('appsInference.budgets.own.title')}
            trailing={
              canManage ? (
                <Button size="sm" icon={RiAddLine} onPress={() => setDialog('new')}>
                  {t('appsInference.budgets.new')}
                </Button>
              ) : undefined
            }
          />
          <Text className="-mt-3 px-4 text-xs text-muted-foreground">
            {t('appsInference.budgets.description')}
          </Text>
          {own.length === 0 ? (
            <EmptyState variant="compact" title={t('appsInference.budgets.own.empty')} />
          ) : (
            <DataTable
              rows={own}
              columns={columns}
              getRowId={(budget) => budget.spendingLimitId}
              accessibilityLabel={t('appsInference.budgets.own.title')}
              minWidth={640}
              size="sm"
            />
          )}

          <Item
            title={t('appsInference.budgets.inherited.title')}
            subtitle={
              inherited.length > 0 ? (
                <Text className="text-xs text-muted-foreground">
                  {t('appsInference.budgets.inherited.note')}{' '}
                  <Link href="/billing/budgets" className="text-foreground underline">
                    {t('appsInference.budgets.inherited.link')}
                  </Link>
                </Text>
              ) : undefined
            }
          />
          {inherited.length === 0 ? (
            <EmptyState variant="compact" title={t('appsInference.budgets.inherited.empty')} />
          ) : (
            <DataTable
              rows={inherited}
              columns={baseColumns}
              getRowId={(budget) => budget.spendingLimitId}
              accessibilityLabel={t('appsInference.budgets.inherited.title')}
              minWidth={640}
              size="sm"
            />
          )}
        </>
      )}

      <BudgetDialog
        key={dialog === null || dialog === 'new' ? 'new' : dialog.spendingLimitId}
        open={dialog !== null}
        onOpenChange={(open) => !open && setDialog(null)}
        budget={dialog === null || dialog === 'new' ? undefined : dialog}
        currencies={currencies}
        isPending={createBudget.isPending || updateBudget.isPending}
        onSubmit={handleSubmit}
      />
    </>
  );
}
