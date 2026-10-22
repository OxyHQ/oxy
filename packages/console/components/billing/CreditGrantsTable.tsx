import { DataTable, type DataTableColumn } from '@oxy.so/bloom/data-table';
import { EmptyState } from '@oxy.so/bloom/empty-state';
import { RiGiftLine } from '@oxy.so/bloom/icons/RiGiftLine';
import { Muted, Text } from '@oxy.so/bloom/typography';
import { useMemo } from 'react';
import { View } from 'react-native';

import type { useCreditGrants } from '@/hooks/use-billing';
import { useDateFormat } from '@/hooks/use-date-format';
import { useTranslation } from '@/lib/i18n';
import { formatCount } from '@/lib/money';

type Grant = NonNullable<ReturnType<typeof useCreditGrants>['data']>[number];

/**
 * Where credits came from and how much of each is left. Spending uses tracked
 * grants in FIFO order, then historical paid credits, then free credits;
 * historical mixed credits are shown without an origin they never had.
 */
export function CreditGrantsTable({ grants }: { grants: ReadonlyArray<Grant> }) {
  const { t } = useTranslation();
  const dates = useDateFormat();

  const columns = useMemo<DataTableColumn<Grant>[]>(
    () => [
      {
        id: 'origin',
        header: t('billingPage.plans.grants.origin'),
        flex: 1.5,
        accessor: (row) => row.origin,
        sortDescFirst: false,
        cell: ({ row }) => (
          <View className="w-full min-w-0">
            <Text className="text-sm text-foreground" numberOfLines={1}>
              {row.origin.replaceAll('_', ' ')}
            </Text>
            <Muted className="text-xs text-muted-foreground" numberOfLines={1}>
              {t('billingPage.plans.grantInvoice', {
                invoice: row.invoiceId,
                start: dates.date(row.period.start),
                end: dates.date(row.period.end),
              })}
            </Muted>
          </View>
        ),
      },
      {
        id: 'granted',
        header: t('billingPage.plans.grants.granted'),
        accessor: (row) => row.granted,
        cell: ({ row }) => (
          <Muted className="text-sm tabular-nums text-muted-foreground">
            {formatCount(row.granted)}
          </Muted>
        ),
      },
      {
        id: 'consumed',
        header: t('billingPage.plans.grants.consumed'),
        accessor: (row) => row.consumed,
        cell: ({ row }) => (
          <Muted className="text-sm tabular-nums text-muted-foreground">
            {formatCount(row.consumed)}
          </Muted>
        ),
      },
      {
        id: 'refunded',
        header: t('billingPage.plans.grants.refunded'),
        accessor: (row) => row.clawed,
        cell: ({ row }) => (
          <Muted className="text-sm tabular-nums text-muted-foreground">
            {formatCount(row.clawed)}
          </Muted>
        ),
      },
      {
        id: 'remaining',
        header: t('billingPage.plans.grants.remaining'),
        align: 'end',
        accessor: (row) => row.remaining,
        cell: ({ row }) => (
          <Text className="text-sm tabular-nums text-foreground">{formatCount(row.remaining)}</Text>
        ),
      },
    ],
    [dates, t],
  );

  return (
    <DataTable
      layout="inset"
      accessibilityLabel={t('billingPage.plans.grants.label')}
      rows={grants}
      columns={columns}
      getRowId={(row) => row.id}
      title={t('billingPage.plans.grantsTitle')}
      summary={t('billingPage.plans.grantsBody')}
      pageSize={6}
      minWidth={680}
      emptyState={
        <EmptyState variant="compact" icon={RiGiftLine} title={t('billingPage.plans.noGrants')} />
      }
    />
  );
}
