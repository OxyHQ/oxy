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
import { formatCount } from '@/lib/money';
import type { UsageTotals } from '@/lib/reporting-charts';

/** What `usageDimensionValue` returns for a row that was not grouped by the dimension. */
const NO_VALUE = '—';

/**
 * The period's counts per breakdown key. For applications each row opens that
 * application's inference page, where its own usage and budgets live.
 */
export function UsageTable({
  totals,
  labelOf,
  dimensionLabel,
  linksToApplication,
}: {
  totals: ReadonlyArray<UsageTotals>;
  labelOf: (key: string) => string;
  dimensionLabel: string;
  linksToApplication: boolean;
}) {
  const { t } = useTranslation();
  const router = useRouter();
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(1);

  const rows = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return needle === ''
      ? totals
      : totals.filter((row) => labelOf(row.key).toLowerCase().includes(needle));
  }, [totals, query, labelOf]);

  const columns = useMemo<DataTableColumn<UsageTotals>[]>(
    () => [
      {
        id: 'key',
        header: dimensionLabel,
        flex: 1.5,
        accessor: (row) => labelOf(row.key),
        sortDescFirst: false,
        cell: ({ row }) => (
          <Text className="text-sm text-foreground" numberOfLines={1}>
            {labelOf(row.key)}
          </Text>
        ),
      },
      {
        id: 'requests',
        header: t('usagePage.table.requests'),
        accessor: (row) => row.requests,
        cell: ({ row }) => (
          <Text className="text-sm tabular-nums text-foreground">{formatCount(row.requests)}</Text>
        ),
      },
      {
        id: 'errors',
        header: t('usagePage.table.errors'),
        accessor: (row) => row.errors,
        cell: ({ row }) => (
          <Muted className="text-sm tabular-nums text-muted-foreground">
            {formatCount(row.errors)}
          </Muted>
        ),
      },
      {
        id: 'input',
        header: t('usagePage.table.inputTokens'),
        accessor: (row) => row.inputTokens,
        cell: ({ row }) => (
          <Muted className="text-sm tabular-nums text-muted-foreground">
            {formatCount(row.inputTokens)}
          </Muted>
        ),
      },
      {
        id: 'output',
        header: t('usagePage.table.outputTokens'),
        accessor: (row) => row.outputTokens,
        cell: ({ row }) => (
          <Muted className="text-sm tabular-nums text-muted-foreground">
            {formatCount(row.outputTokens)}
          </Muted>
        ),
      },
      ...(linksToApplication
        ? [
            {
              id: 'actions',
              header: t('usagePage.table.actions'),
              width: 100,
              cell: ({ row }) =>
                row.key === NO_VALUE ? null : (
                  <DataTableRowActions
                    name={labelOf(row.key)}
                    actions={[
                      {
                        icon: RiExternalLinkLine,
                        label: t('usagePage.table.openApplication'),
                        onPress: () => router.push(`/apps/${row.key}/inference` as Href),
                      },
                    ]}
                  />
                ),
            } satisfies DataTableColumn<UsageTotals>,
          ]
        : []),
    ],
    [dimensionLabel, labelOf, linksToApplication, router, t],
  );

  return (
    <DataTable
      layout="inset"
      accessibilityLabel={t('usagePage.table.label')}
      rows={rows}
      columns={columns}
      getRowId={(row) => row.key}
      title={t('usagePage.table.title')}
      summary={t('usagePage.table.summary', { count: rows.length })}
      toolbar={
        <DataTableSearch
          label={t('usagePage.table.search')}
          value={query}
          onValueChange={(next) => {
            setQuery(next);
            setPage(1);
          }}
        />
      }
      page={page}
      onPageChange={setPage}
      pageSize={10}
      minWidth={760}
      emptyState={<EmptyState variant="compact" title={t('usagePage.table.empty')} />}
    />
  );
}
