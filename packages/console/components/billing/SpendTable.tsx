import { Muted, Text } from '@oxy.so/bloom/typography';
import {
  DataTable,
  type DataTableColumn,
  DataTableRowActions,
  DataTableSearch,
} from '@oxy.so/bloom/data-table';
import { EmptyState } from '@oxy.so/bloom/empty-state';
import { RiExternalLinkLine } from '@oxy.so/bloom/icons/RiExternalLinkLine';
import { type Href, useRouter } from 'expo-router';
import { useMemo, useState } from 'react';

import { useTranslation } from '@/lib/i18n';
import { formatCount, formatMoney } from '@/lib/money';
import type { SpendRow } from '@/lib/reporting';
import { plotNumber } from '@/lib/reporting-charts';

/** What `spendDimensionValue` returns for a row that was not grouped by the dimension. */
const NO_VALUE = '—';

/**
 * The period's charges per breakdown key, as the ledger totalled them. Every cell
 * is the server's exact string; the sort accessors only order the rows.
 */
export function SpendTable({
  rows,
  keyOf,
  labelOf,
  dimensionLabel,
  linksToApplication,
  truncated,
}: {
  rows: ReadonlyArray<SpendRow>;
  keyOf: (row: SpendRow) => string;
  labelOf: (key: string) => string;
  dimensionLabel: string;
  linksToApplication: boolean;
  truncated: boolean;
}) {
  const { t } = useTranslation();
  const router = useRouter();
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(1);

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return needle === ''
      ? rows
      : rows.filter((row) => labelOf(keyOf(row)).toLowerCase().includes(needle));
  }, [rows, query, keyOf, labelOf]);

  const columns = useMemo<DataTableColumn<SpendRow>[]>(
    () => [
      {
        id: 'key',
        header: dimensionLabel,
        flex: 1.5,
        accessor: (row) => labelOf(keyOf(row)),
        sortDescFirst: false,
        cell: ({ row }) => (
          <Text className="text-sm text-foreground" numberOfLines={1}>
            {labelOf(keyOf(row))}
          </Text>
        ),
      },
      {
        id: 'receipts',
        header: t('billingPage.spend.receipts'),
        accessor: (row) => row.receiptCount,
        cell: ({ row }) => (
          <Muted className="text-sm tabular-nums text-muted-foreground">
            {formatCount(row.receiptCount)}
          </Muted>
        ),
      },
      {
        id: 'refunded',
        header: t('billingPage.spend.refunded'),
        accessor: (row) => plotNumber(row.refundedAmount),
        cell: ({ row }) => (
          <Muted className="text-sm tabular-nums text-muted-foreground">
            {formatMoney(row.refundedAmount, row.currency)}
          </Muted>
        ),
      },
      {
        id: 'net',
        header: t('billingPage.spend.net'),
        accessor: (row) => plotNumber(row.netAmount),
        cell: ({ row }) => (
          <Text className="text-sm tabular-nums text-foreground">
            {formatMoney(row.netAmount, row.currency)}
          </Text>
        ),
      },
      ...(linksToApplication
        ? [
            {
              id: 'actions',
              header: t('billingPage.spend.actions'),
              width: 100,
              cell: ({ row }) =>
                keyOf(row) === NO_VALUE ? null : (
                  <DataTableRowActions
                    name={labelOf(keyOf(row))}
                    actions={[
                      {
                        icon: RiExternalLinkLine,
                        label: t('billingPage.spend.openApplication'),
                        onPress: () => router.push(`/apps/${keyOf(row)}/inference` as Href),
                      },
                    ]}
                  />
                ),
            } satisfies DataTableColumn<SpendRow>,
          ]
        : []),
    ],
    [dimensionLabel, keyOf, labelOf, linksToApplication, router, t],
  );

  return (
    <DataTable
      layout="inset"
      accessibilityLabel={t('billingPage.spend.tableLabel')}
      rows={visible}
      columns={columns}
      getRowId={(row, index) => `${keyOf(row)}-${row.currency}-${index}`}
      title={t('billingPage.spend.tableTitle')}
      summary={
        truncated
          ? t('billingPage.spend.truncated')
          : t('billingPage.spend.summary', { count: visible.length })
      }
      toolbar={
        <DataTableSearch
          label={t('billingPage.spend.search')}
          value={query}
          onValueChange={(next) => {
            setQuery(next);
            setPage(1);
          }}
        />
      }
      defaultSort={{ columnId: 'net', direction: 'descending' }}
      page={page}
      onPageChange={setPage}
      pageSize={10}
      minWidth={680}
      emptyState={<EmptyState variant="compact" title={t('billingPage.spend.noCharges')} />}
    />
  );
}
