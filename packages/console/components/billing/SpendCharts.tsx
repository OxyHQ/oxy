import { AreaChartCard, BarListCard } from '@oxy.so/bloom/chart-cards';
import { useMemo } from 'react';
import { View } from 'react-native';

import { useTranslation } from '@/lib/i18n';
import type { SpendRow } from '@/lib/reporting';
import {
  type ChartWindow,
  formatChartMoney,
  formatChartNumber,
  groupTotals,
  plotNumber,
  stackedRanges,
  windowFromId,
  windowId,
} from '@/lib/reporting-charts';

const SERIES_LIMIT = 4;

/**
 * Net charged over time stacked by a dimension, beside the period's ranking by the
 * same dimension. One currency at a time: the ledger never adds one to another.
 *
 * Positions and bar lengths are drawn from the amounts; every exact figure is in
 * the tiles above and the table below.
 */
export function SpendCharts({
  currency,
  daily,
  days,
  period,
  onPeriodChange,
  ranking,
  keyOf,
  labelOf,
  title,
}: {
  currency: string;
  /** Daily rows of this currency over `days`. */
  daily: ReadonlyArray<SpendRow>;
  days: ReadonlyArray<string>;
  period: ChartWindow;
  onPeriodChange: (period: ChartWindow) => void;
  /** The period's rows grouped by the dimension alone (no day), this currency only. */
  ranking: ReadonlyArray<SpendRow>;
  keyOf: (row: SpendRow) => string;
  labelOf: (key: string) => string;
  title: { overTime: string; breakdown: string };
}) {
  const { t } = useTranslation();
  const money = (value: number) => formatChartMoney(value, currency);

  const ranges = useMemo(
    () =>
      stackedRanges(
        daily,
        days,
        {
          keyOf,
          valueOf: (row) => plotNumber(row.netAmount),
          labelOf,
          limit: SERIES_LIMIT,
          otherLabel: t('reporting.other'),
        },
        (count) => t('reporting.lastDays', { count }),
      ),
    [daily, days, keyOf, labelOf, t],
  );

  const items = useMemo(
    () =>
      groupTotals(ranking, keyOf, (row) => plotNumber(row.netAmount)).map((entry) => ({
        label: labelOf(entry.key),
        value: entry.value,
      })),
    [ranking, keyOf, labelOf],
  );

  return (
    <View className="gap-4 xl:flex-row xl:items-start">
      <View className="min-w-0 xl:flex-1">
        <AreaChartCard
          title={title.overTime}
          ranges={ranges}
          defaultRange={windowId(period)}
          onRangeChange={(id) => onPeriodChange(windowFromId(id))}
          format={money}
          formatAxisValue={formatChartNumber}
          accessibilityLabel={title.overTime}
        />
      </View>
      <View className="min-w-0 xl:flex-1">
        <BarListCard
          items={items}
          title={title.breakdown}
          metric="value"
          metricLabel={currency}
          format={money}
          showShares
          limit={5}
        />
      </View>
    </View>
  );
}
