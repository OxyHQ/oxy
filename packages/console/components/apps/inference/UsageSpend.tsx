import { useMemo, useState } from 'react';
import { Text, View } from 'react-native';
import { Admonition } from '@oxy.so/bloom/admonition';
import { Chip } from '@oxy.so/bloom/chip';
import { DataTable, type DataTableColumn } from '@oxy.so/bloom/data-table';
import { EmptyState } from '@oxy.so/bloom/empty-state';
import {
  SegmentedControl,
  SegmentedControlItem,
  SegmentedControlItemText,
} from '@oxy.so/bloom/segmented-control';
import { RiCoinsLine } from '@oxy.so/bloom/icons/RiCoinsLine';
import * as Skeleton from '@oxy.so/bloom/skeleton';
import { StatCards } from '@oxy.so/bloom/stat-cards';
import { useReportLabels } from '@/components/billing/labels';
import { useAppDetail } from '@/components/apps/app-context';
import {
  useApplicationSpendReport,
  useApplicationUsageReport,
} from '@/hooks/use-inference-reporting';
import { useTranslation } from '@/lib/i18n';
import { compareExactDecimals, formatCount, formatMoney } from '@/lib/money';
import type {
  ReportProvenance,
  ReportRangeDays,
  SpendDimension,
  SpendRow,
  UsageDimension,
  UsageRow,
} from '@/lib/reporting';
import {
  REPORT_RANGE_DAYS,
  SPEND_DIMENSIONS,
  USAGE_DIMENSIONS,
  lastCalendarDays,
  spendDimensionValue,
  usageDimensionValue,
} from '@/lib/reporting';

/** The two questions, and the two different tables that answer them. */
type Lane = 'usage' | 'spend';

const TELEMETRY = { source: 'usage_telemetry_rollups', consistency: 'eventual' } as const;
const LEDGER = { source: 'financial_ledger', consistency: 'authoritative' } as const;

/** Where a figure came from, stated on the figure's own screen. */
function provenanceAdmonition(
  labels: ReturnType<typeof useReportLabels>,
  provenance: ReportProvenance,
) {
  return (
    <Admonition type={provenance.source === 'financial_ledger' ? 'info' : 'warning'}>
      <Text className="font-semibold">{labels.provenanceHeadline(provenance)}</Text>
      {`\n${labels.provenanceExplanation(provenance)}`}
    </Admonition>
  );
}

/**
 * One application's usage and spend.
 *
 * ## Why these are two views and not two columns of one table
 *
 * Units and money come from different tables with different consistency, and
 * `/inference/reporting` says so on every response. Putting them in one row would
 * invite exactly the reading the epic forbids — that the token count and the
 * amount beside it are two views of one record. They are not: a request counted
 * in telemetry may not be settled yet, and a settled receipt may never appear in a
 * rollup if the recorder dropped it.
 *
 * So the section has a switch, one lane at a time, each with its own banner taken
 * from its own response's stamp.
 *
 * The two lanes also take different PERMISSIONS, which is the API's own split:
 * `usage:read` for units, `billing:read` for money.
 */
export function UsageSpend() {
  const { t } = useTranslation();
  const { application, access } = useAppDetail();
  const labels = useReportLabels();
  const canReadUsage = access.can('usage:read');
  const canReadSpend = access.can('billing:read');

  const [lane, setLane] = useState<Lane>(canReadUsage ? 'usage' : 'spend');
  const [rangeDays, setRangeDays] = useState<ReportRangeDays>(30);
  const [usageGroupBy, setUsageGroupBy] = useState<ReadonlyArray<UsageDimension>>(['day']);
  const [spendGroupBy, setSpendGroupBy] = useState<ReadonlyArray<SpendDimension>>(['day']);

  const range = useMemo(() => lastCalendarDays(rangeDays), [rangeDays]);

  const usageQuery = useApplicationUsageReport(
    application._id,
    { range, groupBy: usageGroupBy },
    canReadUsage && lane === 'usage',
  );
  const spendQuery = useApplicationSpendReport(
    application._id,
    { range, groupBy: spendGroupBy },
    canReadSpend && lane === 'spend',
  );

  const spendRows = useMemo(() => {
    const rows = spendQuery.data?.rows ?? [];
    return [...rows].sort((left, right) => compareExactDecimals(right.netAmount, left.netAmount));
  }, [spendQuery.data]);

  const usageRows = usageQuery.data?.rows ?? [];

  const usageColumns = useMemo<Array<DataTableColumn<UsageRow>>>(
    () => [
      ...usageGroupBy.map(
        (dimension): DataTableColumn<UsageRow> => ({
          id: dimension,
          header: labels.dimension(dimension),
          minWidth: 120,
          cell: ({ row }) => (
            <Text className="font-mono text-xs text-foreground">
              {usageDimensionValue(row, dimension)}
            </Text>
          ),
        }),
      ),
      {
        id: 'requests',
        header: t('appsInference.reporting.requests'),
        align: 'end',
        width: 110,
        cell: ({ row }) => (
          <Text className="text-sm text-foreground">{formatCount(row.requestCount)}</Text>
        ),
      },
      {
        id: 'errors',
        header: t('appsInference.reporting.errors'),
        align: 'end',
        width: 100,
        cell: ({ row }) => (
          <Text className="text-sm text-muted-foreground">{formatCount(row.errorCount)}</Text>
        ),
      },
      {
        id: 'tokens',
        header: t('appsInference.reporting.tokens'),
        align: 'end',
        width: 180,
        cell: ({ row }) => (
          <Text className="text-sm text-muted-foreground">
            {`${formatCount(row.units.input_tokens)} / ${formatCount(row.units.output_tokens)}`}
          </Text>
        ),
      },
    ],
    [usageGroupBy, labels, t],
  );

  const spendColumns = useMemo<Array<DataTableColumn<SpendRow>>>(
    () => [
      ...spendGroupBy.map(
        (dimension): DataTableColumn<SpendRow> => ({
          id: dimension,
          header: labels.dimension(dimension),
          minWidth: 120,
          cell: ({ row }) => (
            <Text className="font-mono text-xs text-foreground">
              {spendDimensionValue(row, dimension)}
            </Text>
          ),
        }),
      ),
      {
        id: 'receipts',
        header: t('appsInference.reporting.receipts'),
        align: 'end',
        width: 110,
        cell: ({ row }) => (
          <Text className="text-sm text-muted-foreground">{formatCount(row.receiptCount)}</Text>
        ),
      },
      {
        id: 'net',
        header: t('appsInference.reporting.netCharged'),
        align: 'end',
        width: 150,
        cell: ({ row }) => (
          <Text className="text-sm text-foreground">
            {formatMoney(row.netAmount, row.currency)}
          </Text>
        ),
      },
    ],
    [spendGroupBy, labels, t],
  );

  if (!canReadUsage && !canReadSpend) {
    return <EmptyState variant="compact" title={t('appsInference.reporting.noPermission')} />;
  }

  const skeletons = (
    <View className="gap-2">
      {[1, 2, 3].map((index) => (
        <Skeleton.Box key={index} width="100%" height={44} />
      ))}
    </View>
  );

  /**
   * At least one dimension always stays selected: the API's `groupBy` has a
   * minimum of one, so an empty selection would be a 400 the customer cannot read.
   * The caller's canonical order is kept rather than click order, so the columns
   * do not rearrange themselves as dimensions are added.
   */
  const dimensionChips = <TDimension extends UsageDimension | SpendDimension>(
    dimensions: ReadonlyArray<TDimension>,
    selected: ReadonlyArray<TDimension>,
    onSelectedChange: (next: ReadonlyArray<TDimension>) => void,
  ) => (
    <View className="flex-row flex-wrap items-center gap-1.5">
      {dimensions.map((dimension) => {
        const isSelected = selected.includes(dimension);
        const isLastSelected = isSelected && selected.length === 1;
        return (
          <Chip
            key={dimension}
            role="checkbox"
            checked={isSelected}
            disabled={isLastSelected}
            onPress={() =>
              onSelectedChange(
                isSelected
                  ? selected.filter((entry) => entry !== dimension)
                  : dimensions.filter((entry) => entry === dimension || selected.includes(entry)),
              )
            }
            accessibilityLabel={
              isLastSelected
                ? `${labels.dimension(dimension)}. ${t('reportKit.groupByMinimum')}`
                : labels.dimension(dimension)
            }
          >
            {labels.dimension(dimension)}
          </Chip>
        );
      })}
    </View>
  );

  const controls = (chips: React.ReactNode) => (
    <View className="gap-3">
      <View className="flex-row flex-wrap items-center gap-3">
        <Text className="text-sm text-muted-foreground">{t('reportKit.period')}</Text>
        <SegmentedControl
          type="radio"
          size="sm"
          label={t('reportKit.period')}
          value={String(rangeDays)}
          onValueChange={(next: string) => setRangeDays(Number(next) as ReportRangeDays)}
        >
          {REPORT_RANGE_DAYS.map((days) => (
            <SegmentedControlItem key={days} value={String(days)}>
              <SegmentedControlItemText>
                {t('reportKit.days', { count: days })}
              </SegmentedControlItemText>
            </SegmentedControlItem>
          ))}
        </SegmentedControl>
      </View>
      <View className="flex-row flex-wrap items-center gap-3">
        <Text className="text-sm text-muted-foreground">{t('reportKit.groupBy')}</Text>
        {chips}
      </View>
    </View>
  );

  return (
    <>
      {canReadUsage && canReadSpend && (
        <View className="flex-row">
          <SegmentedControl
            type="radio"
            size="sm"
            label={t('appsInference.reporting.title')}
            value={lane}
            onValueChange={(next: string) => setLane(next as Lane)}
          >
            <SegmentedControlItem value="usage">
              <SegmentedControlItemText>
                {t('appsInference.reporting.lanes.usage')}
              </SegmentedControlItemText>
            </SegmentedControlItem>
            <SegmentedControlItem value="spend">
              <SegmentedControlItemText>
                {t('appsInference.reporting.lanes.spend')}
              </SegmentedControlItemText>
            </SegmentedControlItem>
          </SegmentedControl>
        </View>
      )}

      {lane === 'usage' && canReadUsage && (
        <>
          {provenanceAdmonition(labels, TELEMETRY)}
          {canReadSpend && (
            <Text className="text-xs text-muted-foreground">
              {t('reportKit.provenance.crossTelemetry')}
            </Text>
          )}
          {controls(dimensionChips(USAGE_DIMENSIONS, usageGroupBy, setUsageGroupBy))}

          {usageQuery.isLoading ? (
            skeletons
          ) : usageQuery.isError ? (
            <Admonition type="error">{t('appsInference.reporting.loadFailed')}</Admonition>
          ) : (
            <DataTable
              rows={usageRows}
              columns={usageColumns}
              getRowId={(row, index) =>
                `${usageGroupBy.map((dimension) => usageDimensionValue(row, dimension)).join('|')}-${index}`
              }
              accessibilityLabel={t('appsInference.reporting.usageTable')}
              emptyState={
                <Text className="text-sm text-muted-foreground">
                  {t('appsInference.reporting.noUsage', { from: range.from, to: range.to })}
                </Text>
              }
              size="sm"
            />
          )}
        </>
      )}

      {lane === 'spend' && canReadSpend && (
        <>
          {provenanceAdmonition(labels, LEDGER)}
          {canReadUsage && (
            <Text className="text-xs text-muted-foreground">
              {t('reportKit.provenance.crossLedger')}
            </Text>
          )}
          {controls(dimensionChips(SPEND_DIMENSIONS, spendGroupBy, setSpendGroupBy))}

          {spendQuery.isLoading ? (
            skeletons
          ) : spendQuery.isError ? (
            <Admonition type="error">{t('appsInference.reporting.loadFailed')}</Admonition>
          ) : (
            <>
              <StatCards
                stats={(spendQuery.data?.totals ?? []).map((total) => ({
                  icon: RiCoinsLine,
                  label: t('appsInference.reporting.netCharged'),
                  value: formatMoney(total.netAmount, total.currency),
                  delta: t('appsInference.reporting.netOver', {
                    count: total.receiptCount,
                  }),
                  deltaColor: 'neutral' as const,
                }))}
              />

              <DataTable
                rows={spendRows}
                columns={spendColumns}
                getRowId={(row, index) =>
                  `${spendGroupBy.map((dimension) => spendDimensionValue(row, dimension)).join('|')}-${index}`
                }
                accessibilityLabel={t('appsInference.reporting.spendTable')}
                emptyState={
                  <Text className="text-sm text-muted-foreground">
                    {t('appsInference.reporting.noSpend', { from: range.from, to: range.to })}
                  </Text>
                }
                size="sm"
              />
            </>
          )}
        </>
      )}
    </>
  );
}
