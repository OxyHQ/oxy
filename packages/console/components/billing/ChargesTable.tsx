import { Chip } from '@oxy.so/bloom/chip';
import {
  DataTable,
  type DataTableColumn,
  DataTableFilter,
  DataTableSearch,
} from '@oxy.so/bloom/data-table';
import { EmptyState } from '@oxy.so/bloom/empty-state';
import { Muted, Text } from '@oxy.so/bloom/typography';
import { useMemo, useState } from 'react';
import { View } from 'react-native';

import { useTranslation } from '@/lib/i18n';
import { formatCount, formatMoney } from '@/lib/money';
import { REPORT_RANGE_DAYS, type ReportRangeDays, type SettledCharge } from '@/lib/reporting';
import { plotNumber } from '@/lib/reporting-charts';

/**
 * Settled receipts for the exact amount served: the per-request detail behind the
 * Spend totals. The token counts are the receipt's own units (what the charge was
 * computed from), which is why they may sit beside an amount here and nowhere else.
 */
export function ChargesTable({
  charges,
  rangeDays,
  onRangeDaysChange,
  truncated,
}: {
  charges: ReadonlyArray<SettledCharge>;
  rangeDays: ReportRangeDays;
  onRangeDaysChange: (days: ReportRangeDays) => void;
  truncated: boolean;
}) {
  const { t } = useTranslation();
  const [outcome, setOutcome] = useState('all');
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(1);

  const outcomes = useMemo(() => [...new Set(charges.map((charge) => charge.outcome))], [charges]);

  const rows = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return charges.filter(
      (charge) =>
        (outcome === 'all' || charge.outcome === outcome) &&
        (needle === '' ||
          charge.resolvedModelReference.toLowerCase().includes(needle) ||
          charge.requestId.toLowerCase().includes(needle) ||
          charge.servingProvider.toLowerCase().includes(needle)),
    );
  }, [charges, outcome, query]);

  const columns = useMemo<DataTableColumn<SettledCharge>[]>(
    () => [
      {
        id: 'settled',
        header: t('billingPage.charges.settled'),
        flex: 1.2,
        accessor: (row) => Date.parse(row.settledAt),
        cell: ({ row }) => <Muted>{new Date(row.settledAt).toLocaleString()}</Muted>,
      },
      {
        id: 'model',
        header: t('billingPage.charges.servedModel'),
        flex: 1.4,
        accessor: (row) => row.resolvedModelReference,
        sortDescFirst: false,
        cell: ({ row }) => (
          <Text className="font-mono text-xs" numberOfLines={1}>
            {row.resolvedModelReference}
          </Text>
        ),
      },
      {
        id: 'provider',
        header: t('billingPage.charges.provider'),
        accessor: (row) => row.servingProvider,
        sortDescFirst: false,
        cell: ({ row }) => <Muted>{row.servingProvider}</Muted>,
      },
      {
        id: 'outcome',
        header: t('billingPage.charges.outcome'),
        accessor: (row) => row.outcome,
        cell: ({ row }) => (
          <View className="flex-row flex-wrap items-center gap-1.5">
            <Chip size="md" hue={row.outcome === 'completed' ? 'lime' : 'gray'}>
              {row.outcome}
            </Chip>
            {row.platformFeeOnly ? (
              <Chip size="md" hue="neutral">
                {t('billingPage.charges.feeOnly')}
              </Chip>
            ) : null}
          </View>
        ),
      },
      {
        id: 'tokens',
        header: t('billingPage.charges.tokens'),
        accessor: (row) => row.units.input_tokens + row.units.output_tokens,
        cell: ({ row }) => (
          <Muted className="tabular-nums">
            {formatCount(row.units.input_tokens)} / {formatCount(row.units.output_tokens)}
          </Muted>
        ),
      },
      {
        id: 'net',
        header: t('billingPage.charges.net'),
        align: 'end',
        accessor: (row) => plotNumber(row.netAmount),
        cell: ({ row }) => (
          <Text className="tabular-nums">{formatMoney(row.netAmount, row.currency)}</Text>
        ),
      },
    ],
    [t],
  );

  const reset = (set: (value: string) => void) => (value: string) => {
    set(value);
    setPage(1);
  };

  return (
    <DataTable
      layout="inset"
      accessibilityLabel={t('billingPage.charges.chargedTable')}
      rows={rows}
      columns={columns}
      getRowId={(row) => row.receiptId}
      title={t('billingPage.charges.chargedTitle')}
      summary={
        truncated
          ? t('billingPage.charges.truncated')
          : t('billingPage.charges.chargedSummary', { count: rows.length })
      }
      toolbar={
        <>
          <DataTableFilter
            label={t('reporting.period')}
            value={String(rangeDays)}
            onValueChange={(next) => onRangeDaysChange(Number(next) as ReportRangeDays)}
            options={REPORT_RANGE_DAYS.map((days) => ({
              value: String(days),
              label: t('reporting.lastDays', { count: days }),
            }))}
          />
          <DataTableFilter
            label={t('billingPage.charges.outcome')}
            value={outcome}
            onValueChange={reset(setOutcome)}
            options={[
              { value: 'all', label: t('billingPage.charges.allOutcomes') },
              ...outcomes.map((value) => ({ value, label: value })),
            ]}
          />
          <DataTableSearch
            label={t('billingPage.charges.search')}
            value={query}
            onValueChange={reset(setQuery)}
          />
        </>
      }
      defaultSort={{ columnId: 'settled', direction: 'descending' }}
      page={page}
      onPageChange={setPage}
      pageSize={10}
      minWidth={860}
      emptyState={<EmptyState variant="compact" title={t('billingPage.charges.nothingCharged')} />}
    />
  );
}
