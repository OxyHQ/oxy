import { Chip } from '@oxy.so/bloom/chip';
import { DataTable, type DataTableColumn } from '@oxy.so/bloom/data-table';
import { EmptyState } from '@oxy.so/bloom/empty-state';
import { RiNotification3Line } from '@oxy.so/bloom/icons/RiNotification3Line';
import { Muted, Text } from '@oxy.so/bloom/typography';
import { useMemo } from 'react';

import { useDateFormat } from '@/hooks/use-date-format';
import { useTranslation } from '@/lib/i18n';
import { formatAmount, formatBasisPoints, formatMoney } from '@/lib/money';
import type { BudgetAlert } from '@/lib/reporting';

/**
 * Threshold crossings, newest first. Each is recorded once per budget, period and
 * threshold, so an alert does not re-fire on every request for the rest of the
 * period. The alert record carries an amount and not a currency code, and none is
 * invented here: the budget it belongs to says which one it was.
 */
export function BudgetAlertsTable({
  alerts,
  budgetName,
  budgetCurrency,
}: {
  alerts: ReadonlyArray<BudgetAlert>;
  /** The budget's scope in words, from its id. */
  budgetName: (spendingLimitId: string) => string;
  /** The budget's currency, if the budget is still listed. */
  budgetCurrency: (spendingLimitId: string) => string | undefined;
}) {
  const { t } = useTranslation();
  const dates = useDateFormat();

  const columns = useMemo<DataTableColumn<BudgetAlert>[]>(
    () => [
      {
        id: 'when',
        header: t('billingPage.budgets.alerts.when'),
        flex: 1.2,
        accessor: (row) => Date.parse(row.createdAt),
        cell: ({ row }) => <Muted>{dates.dateTime(row.createdAt)}</Muted>,
      },
      {
        id: 'budget',
        header: t('billingPage.budgets.alerts.budget'),
        flex: 1.4,
        accessor: (row) => budgetName(row.spendingLimitId),
        sortDescFirst: false,
        cell: ({ row }) => (
          <Text className="text-sm text-foreground" numberOfLines={1}>
            {budgetName(row.spendingLimitId)}
          </Text>
        ),
      },
      {
        id: 'threshold',
        header: t('billingPage.budgets.alerts.threshold'),
        accessor: (row) => row.thresholdBps,
        cell: ({ row }) => (
          <Chip size="md" hue={row.thresholdBps >= 10000 ? 'rose' : 'yellow'}>
            {formatBasisPoints(row.thresholdBps)}
          </Chip>
        ),
      },
      {
        id: 'spend',
        header: t('billingPage.budgets.alerts.spend'),
        align: 'end',
        cell: ({ row }) => {
          const currency = budgetCurrency(row.spendingLimitId);
          return (
            <Text className="text-sm tabular-nums text-foreground">
              {currency === undefined
                ? formatAmount(row.spendAmount)
                : formatMoney(row.spendAmount, currency)}
            </Text>
          );
        },
      },
    ],
    [budgetName, budgetCurrency, dates, t],
  );

  return (
    <DataTable
      layout="inset"
      accessibilityLabel={t('billingPage.budgets.alerts.label')}
      rows={alerts}
      columns={columns}
      getRowId={(row) => row.alertId}
      title={t('billingPage.budgets.alertsTitle')}
      summary={t('billingPage.budgets.alertsBody')}
      defaultSort={{ columnId: 'when', direction: 'descending' }}
      pageSize={6}
      minWidth={560}
      emptyState={
        <EmptyState
          variant="compact"
          icon={RiNotification3Line}
          title={t('billingPage.budgets.noAlerts')}
        />
      }
    />
  );
}
