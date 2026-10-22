import { DataTable, type DataTableColumn } from '@oxy.so/bloom/data-table';
import { EmptyState } from '@oxy.so/bloom/empty-state';
import { RiLockLine } from '@oxy.so/bloom/icons/RiLockLine';
import { StatCards } from '@oxy.so/bloom/stat-cards';
import { Muted, Text } from '@oxy.so/bloom/typography';
import { useMemo } from 'react';
import { View } from 'react-native';

import { useApplicationNames } from '@/hooks/use-application-names';
import { useTranslation } from '@/lib/i18n';
import { formatMoney } from '@/lib/money';
import type { PendingReservation, PendingReservationsResponse } from '@/lib/reporting';
import { plotNumber } from '@/lib/reporting-charts';

/**
 * Money HELD against requests in flight, with what is held per currency above it.
 *
 * A reservation is an authorisation taken before a request runs, sized on its
 * maximum possible cost. Nothing here has been charged: when the request ends it
 * settles for the exact amount and the rest is released.
 */
export function HoldsTable({ held }: { held: PendingReservationsResponse }) {
  const { t } = useTranslation();
  const applicationName = useApplicationNames();

  const columns = useMemo<DataTableColumn<PendingReservation>[]>(
    () => [
      {
        id: 'request',
        header: t('billingPage.charges.request'),
        flex: 1.4,
        cell: ({ row }) => (
          <Text className="font-mono text-xs" numberOfLines={1}>
            {row.requestId}
          </Text>
        ),
      },
      {
        id: 'application',
        header: t('billingPage.charges.application'),
        accessor: (row) => applicationName(row.applicationId),
        sortDescFirst: false,
        cell: ({ row }) => <Muted numberOfLines={1}>{applicationName(row.applicationId)}</Muted>,
      },
      {
        id: 'environment',
        header: t('billingPage.charges.environment'),
        accessor: (row) => row.environment,
        cell: ({ row }) => <Muted>{row.environment}</Muted>,
      },
      {
        id: 'expires',
        header: t('billingPage.charges.expires'),
        accessor: (row) => Date.parse(row.expiresAt),
        sortDescFirst: false,
        cell: ({ row }) => <Muted>{new Date(row.expiresAt).toLocaleTimeString()}</Muted>,
      },
      {
        id: 'held',
        header: t('billingPage.charges.held'),
        align: 'end',
        accessor: (row) => plotNumber(row.reservedAmount),
        cell: ({ row }) => (
          <Text className="tabular-nums">{formatMoney(row.reservedAmount, row.currency)}</Text>
        ),
      },
    ],
    [applicationName, t],
  );

  return (
    <View className="gap-4">
      {held.totals.length > 0 ? (
        <StatCards
          stats={held.totals.map((total) => ({
            icon: RiLockLine,
            label: t('billingPage.charges.heldTitle'),
            value: formatMoney(total.heldAmount, total.currency),
            delta: t('billingPage.charges.heldAcross', { count: total.reservationCount }),
            deltaColor: 'neutral' as const,
          }))}
        />
      ) : null}
      <DataTable
        layout="inset"
        accessibilityLabel={t('billingPage.charges.heldTable')}
        rows={held.rows}
        columns={columns}
        getRowId={(row) => row.reservationId}
        title={t('billingPage.charges.heldTitle')}
        summary={
          held.truncated
            ? t('billingPage.charges.heldTruncated')
            : t('billingPage.charges.heldSummary', { count: held.rows.length })
        }
        pageSize={8}
        minWidth={680}
        emptyState={
          <EmptyState
            variant="compact"
            icon={RiLockLine}
            title={t('billingPage.charges.nothingHeld')}
          />
        }
      />
    </View>
  );
}
