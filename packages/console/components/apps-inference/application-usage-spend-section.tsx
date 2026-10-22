import { useMemo, useState } from 'react';
import { Text, View } from 'react-native';
import { Button } from '@oxy.so/bloom/button';
import { DataTable, type DataTableColumn } from '@oxy.so/bloom/data-table';
import * as Skeleton from '@oxy.so/bloom/skeleton';
import { ProvenanceBanner, ProvenanceCrossReference } from '@/components/billing/provenance-banner';
import { useReportLabels } from '@/components/billing/labels';
import { ReportControls } from '@/components/billing/report-controls';
import type { Application, CallerAccess } from '@/hooks/use-applications';
import {
  useApplicationSpendReport,
  useApplicationUsageReport,
} from '@/hooks/use-inference-reporting';
import { useTranslation } from '@/lib/i18n';
import { compareExactDecimals, formatCount, formatMoney } from '@/lib/money';
import type {
  ReportRangeDays,
  SpendDimension,
  SpendRow,
  UsageDimension,
  UsageRow,
} from '@/lib/reporting';
import {
  SPEND_DIMENSIONS,
  USAGE_DIMENSIONS,
  lastCalendarDays,
  spendDimensionValue,
  usageDimensionValue,
} from '@/lib/reporting';
import { MutedText, NoPermission, SectionHeader } from './ui';

/** The two questions, and the two different tables that answer them. */
type Lane = 'usage' | 'spend';

const TELEMETRY = { source: 'usage_telemetry_rollups', consistency: 'eventual' } as const;
const LEDGER = { source: 'financial_ledger', consistency: 'authoritative' } as const;

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
export function ApplicationUsageSpendSection({
  application,
  access,
}: {
  application: Application;
  access: CallerAccess;
}) {
  const { t } = useTranslation();
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
    return <NoPermission>{t('appsInference.reporting.noPermission')}</NoPermission>;
  }

  const skeletons = (
    <View className="gap-2">
      {[1, 2, 3].map((index) => (
        <Skeleton.Box key={index} width="100%" height={44} />
      ))}
    </View>
  );

  return (
    <View className="gap-6">
      <SectionHeader
        title={t('appsInference.reporting.title')}
        description={t('appsInference.reporting.description')}
        action={
          <>
            {canReadUsage && (
              <Button
                appearance={lane === 'usage' ? 'solid' : 'plain'}
                size="sm"
                onPress={() => setLane('usage')}
              >
                {t('appsInference.reporting.lanes.usage')}
              </Button>
            )}
            {canReadSpend && (
              <Button
                appearance={lane === 'spend' ? 'solid' : 'plain'}
                size="sm"
                onPress={() => setLane('spend')}
              >
                {t('appsInference.reporting.lanes.spend')}
              </Button>
            )}
          </>
        }
      />

      {lane === 'usage' && canReadUsage && (
        <>
          <ProvenanceBanner provenance={TELEMETRY} />
          {canReadSpend && <ProvenanceCrossReference provenance={TELEMETRY} />}
          <ReportControls
            rangeDays={rangeDays}
            onRangeDaysChange={setRangeDays}
            dimensions={USAGE_DIMENSIONS}
            selected={usageGroupBy}
            onSelectedChange={setUsageGroupBy}
            dimensionLabel={labels.dimension}
          />

          {usageQuery.isLoading ? (
            skeletons
          ) : usageRows.length === 0 ? (
            <MutedText>
              {t('appsInference.reporting.noUsage', { from: range.from, to: range.to })}
            </MutedText>
          ) : (
            <DataTable
              rows={usageRows}
              columns={usageColumns}
              getRowId={(row, index) =>
                `${usageGroupBy.map((dimension) => usageDimensionValue(row, dimension)).join('|')}-${index}`
              }
              accessibilityLabel={t('appsInference.reporting.usageTable')}
              size="sm"
            />
          )}
        </>
      )}

      {lane === 'spend' && canReadSpend && (
        <>
          <ProvenanceBanner provenance={LEDGER} />
          {canReadUsage && <ProvenanceCrossReference provenance={LEDGER} />}
          <ReportControls
            rangeDays={rangeDays}
            onRangeDaysChange={setRangeDays}
            dimensions={SPEND_DIMENSIONS}
            selected={spendGroupBy}
            onSelectedChange={setSpendGroupBy}
            dimensionLabel={labels.dimension}
          />

          {spendQuery.isLoading ? (
            skeletons
          ) : (
            <>
              <View className="flex-row flex-wrap gap-12">
                {(spendQuery.data?.totals ?? []).map((total) => (
                  <View key={total.currency}>
                    <Text className="text-2xl font-semibold text-foreground">
                      {formatMoney(total.netAmount, total.currency)}
                    </Text>
                    <Text className="mt-0.5 text-sm text-muted-foreground">
                      {t('appsInference.reporting.netOver', {
                        count: formatCount(total.receiptCount),
                      })}
                    </Text>
                  </View>
                ))}
                {(spendQuery.data?.totals ?? []).length === 0 && (
                  <MutedText>
                    {t('appsInference.reporting.noSpend', { from: range.from, to: range.to })}
                  </MutedText>
                )}
              </View>

              {spendRows.length > 0 && (
                <DataTable
                  rows={spendRows}
                  columns={spendColumns}
                  getRowId={(row, index) =>
                    `${spendGroupBy.map((dimension) => spendDimensionValue(row, dimension)).join('|')}-${index}`
                  }
                  accessibilityLabel={t('appsInference.reporting.spendTable')}
                  size="sm"
                />
              )}
            </>
          )}
        </>
      )}
    </View>
  );
}
