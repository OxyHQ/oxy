import {
  AreaChartCard,
  BarListCard,
  type BarListTab,
  TokensChartCard,
} from '@oxy.so/bloom/chart-cards';
import { useMemo } from 'react';
import { View } from 'react-native';

import { useTranslation } from '@/lib/i18n';
import { formatCount } from '@/lib/money';
import type { UsageReportResponse, UsageRow } from '@/lib/reporting';
import {
  type ChartWindow,
  dailyTotals,
  dayLabel,
  groupTotals,
  stackedRanges,
  windowFromId,
  windowId,
} from '@/lib/reporting-charts';

const SERIES_LIMIT = 4;

const tokensOf = (row: UsageRow) => row.units.input_tokens + row.units.output_tokens;

/**
 * Requests over time stacked by a dimension, the same period ranked by that
 * dimension, and tokens per day. The area chart's period pill is the one control:
 * the ranking and the token line follow whatever it selects.
 *
 * Telemetry only, counts only: nothing here is money. `extraTabs` lets a caller
 * rank the same keys by something else it already holds (the dashboard adds spend).
 */
export function UsageCharts({
  usage,
  days,
  period,
  onPeriodChange,
  keyOf,
  labelOf,
  title,
  extraTabs = [],
}: {
  usage: UsageReportResponse;
  /** Every day of the fetched window, oldest first. */
  days: ReadonlyArray<string>;
  period: ChartWindow;
  onPeriodChange: (period: ChartWindow) => void;
  keyOf: (row: UsageRow) => string;
  labelOf: (key: string) => string;
  /** The area chart's heading, and the ranking card's. */
  title: { requests: string; breakdown: string };
  extraTabs?: ReadonlyArray<BarListTab>;
}) {
  const { t } = useTranslation();

  const ranges = useMemo(
    () =>
      stackedRanges(
        usage.rows,
        days,
        {
          keyOf,
          valueOf: (row) => row.requestCount,
          labelOf,
          limit: SERIES_LIMIT,
          otherLabel: t('reporting.other'),
        },
        (count) => t('reporting.lastDays', { count }),
      ),
    [usage, days, keyOf, labelOf, t],
  );

  const windowDays = useMemo(() => days.slice(-period), [days, period]);
  const inWindow = useMemo(
    () => usage.rows.filter((row) => row.day !== undefined && windowDays.includes(row.day)),
    [usage, windowDays],
  );

  const tabs = useMemo<BarListTab[]>(() => {
    const items = (pick: (row: UsageRow) => number) =>
      groupTotals(inWindow, keyOf, pick).map((entry) => ({
        label: labelOf(entry.key),
        value: entry.value,
      }));
    return [
      { id: 'requests', label: t('usageCharts.requests'), items: items((row) => row.requestCount) },
      { id: 'tokens', label: t('usageCharts.tokens'), items: items(tokensOf) },
      { id: 'errors', label: t('usageCharts.errors'), items: items((row) => row.errorCount) },
      ...extraTabs,
    ];
  }, [inWindow, keyOf, labelOf, extraTabs, t]);

  const tokensPerDay = useMemo(() => {
    const values = dailyTotals(usage.rows, windowDays, tokensOf);
    return windowDays.map((day, index) => ({ label: dayLabel(day), value: values[index] ?? 0 }));
  }, [usage, windowDays]);

  return (
    <View className="gap-4">
      <View className="gap-4 xl:flex-row xl:items-start">
        <View className="min-w-0 xl:flex-1">
          <AreaChartCard
            title={title.requests}
            ranges={ranges}
            defaultRange={windowId(period)}
            onRangeChange={(id) => onPeriodChange(windowFromId(id))}
            format={formatCount}
            accessibilityLabel={title.requests}
          />
        </View>
        <View className="min-w-0 xl:flex-1">
          <BarListCard
            tabs={tabs}
            title={title.breakdown}
            metricLabel={t('usageCharts.share')}
            limit={5}
          />
        </View>
      </View>
      <TokensChartCard
        title={t('usageCharts.tokensPerDay')}
        data={tokensPerDay}
        format={formatCount}
        startLabel={tokensPerDay[0]?.label}
        endLabel={t('usageCharts.today')}
        accessibilityLabel={t('usageCharts.tokensPerDay')}
      />
    </View>
  );
}
