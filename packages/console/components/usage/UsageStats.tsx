import { Sparkline } from '@oxy.so/bloom/chart-cards';
import { RiErrorWarningLine } from '@oxy.so/bloom/icons/RiErrorWarningLine';
import { RiFlashlightLine } from '@oxy.so/bloom/icons/RiFlashlightLine';
import { RiPulseLine } from '@oxy.so/bloom/icons/RiPulseLine';
import { RiRobot2Line } from '@oxy.so/bloom/icons/RiRobot2Line';
import { StatCards, type StatCardsItem } from '@oxy.so/bloom/stat-cards';
import { useMemo } from 'react';

import { useTranslation } from '@/lib/i18n';
import { formatCount } from '@/lib/money';
import type { UsageReportResponse, UsageRow } from '@/lib/reporting';
import { type ChartWindow, dailyTotals, deltaChip, trendRatio } from '@/lib/reporting-charts';

/** Requests, errors and tokens over the chosen period, each against the period before it. */
export function UsageStats({
  usage,
  days,
  period,
}: {
  usage: UsageReportResponse;
  /** Every day of the fetched window, oldest first. */
  days: ReadonlyArray<string>;
  period: ChartWindow;
}) {
  const { t } = useTranslation();

  const stats = useMemo<StatCardsItem[]>(() => {
    const tile = (
      icon: StatCardsItem['icon'],
      label: string,
      pick: (row: UsageRow) => number,
      better: 'up' | 'down',
    ): StatCardsItem => {
      const values = dailyTotals(usage.rows, days, pick);
      const latest = values.slice(-period);
      return {
        icon,
        label,
        value: formatCount(latest.reduce((total, value) => total + value, 0)),
        ...deltaChip(trendRatio(values, period), better),
        accessory: <Sparkline data={latest} />,
      };
    };
    return [
      tile(RiPulseLine, t('usagePage.stats.requests'), (row) => row.requestCount, 'up'),
      tile(RiErrorWarningLine, t('usagePage.stats.errors'), (row) => row.errorCount, 'down'),
      tile(
        RiFlashlightLine,
        t('usagePage.stats.inputTokens'),
        (row) => row.units.input_tokens,
        'up',
      ),
      tile(RiRobot2Line, t('usagePage.stats.outputTokens'), (row) => row.units.output_tokens, 'up'),
    ];
  }, [usage, days, period, t]);

  return <StatCards stats={stats} />;
}
