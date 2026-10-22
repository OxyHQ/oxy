import { Sparkline } from '@oxy.so/bloom/chart-cards';
import { RiBankCardLine } from '@oxy.so/bloom/icons/RiBankCardLine';
import { RiFlashlightLine } from '@oxy.so/bloom/icons/RiFlashlightLine';
import { RiMoneyDollarCircleLine } from '@oxy.so/bloom/icons/RiMoneyDollarCircleLine';
import { RiPulseLine } from '@oxy.so/bloom/icons/RiPulseLine';
import { StatCards, type StatCardsItem } from '@oxy.so/bloom/stat-cards';
import { useMemo } from 'react';

import { useTranslation } from '@/lib/i18n';
import { formatCount, formatMoney } from '@/lib/money';
import type {
  LedgerBalanceResponse,
  SpendReportResponse,
  UsageReportResponse,
} from '@/lib/reporting';
import { dailyTotals, deltaChip, plotNumber, trendRatio } from '@/lib/reporting-charts';

/** The 30-day headline figures: requests, tokens, spend and what is left to spend. */
export function OverviewStats({
  usage,
  days,
  spend,
  balance,
}: {
  usage: UsageReportResponse;
  /** The 30 days the tiles cover, oldest first. */
  days: ReadonlyArray<string>;
  /** Net spend by day over the same 30 days. Absent while loading or on error. */
  spend: SpendReportResponse | undefined;
  balance: LedgerBalanceResponse | undefined;
}) {
  const { t } = useTranslation();

  const stats = useMemo<StatCardsItem[]>(() => {
    const requests = dailyTotals(usage.rows, days, (row) => row.requestCount);
    const tokens = dailyTotals(
      usage.rows,
      days,
      (row) => row.units.input_tokens + row.units.output_tokens,
    );
    const sum = (values: ReadonlyArray<number>) => values.reduce((a, b) => a + b, 0);

    // The first currency's exact total, straight from the ledger; a second
    // currency is on the Spend page rather than added in here.
    const total = spend?.totals[0];
    const spendDaily =
      total === undefined
        ? []
        : dailyTotals(
            spend?.rows.filter((row) => row.currency === total.currency) ?? [],
            days,
            (row) => plotNumber(row.netAmount),
          );
    const bucket = balance?.balances[0];

    return [
      {
        icon: RiPulseLine,
        label: t('dashboardPage.stats.requests'),
        value: formatCount(sum(requests)),
        ...deltaChip(trendRatio(requests, 7), 'up'),
        accessory: <Sparkline data={requests} />,
      },
      {
        icon: RiFlashlightLine,
        label: t('dashboardPage.stats.tokens'),
        value: formatCount(sum(tokens)),
        ...deltaChip(trendRatio(tokens, 7), 'up'),
        accessory: <Sparkline data={tokens} />,
      },
      {
        icon: RiMoneyDollarCircleLine,
        label: t('dashboardPage.stats.spend'),
        value: total === undefined ? '—' : formatMoney(total.netAmount, total.currency),
        ...deltaChip(trendRatio(spendDaily, 7), 'neutral'),
        accessory: <Sparkline data={spendDaily} />,
      },
      {
        icon: RiBankCardLine,
        label: t('dashboardPage.stats.available'),
        value: bucket === undefined ? '—' : formatMoney(bucket.availableToSpend, bucket.currency),
        delta:
          bucket === undefined
            ? '—'
            : t('dashboardPage.stats.held', {
                amount: formatMoney(bucket.reserved, bucket.currency),
              }),
        deltaColor: 'neutral',
      },
    ];
  }, [usage, days, spend, balance, t]);

  return <StatCards stats={stats} />;
}
