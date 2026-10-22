import { Sparkline } from '@oxy.so/bloom/chart-cards';
import { RiArrowGoBackLine } from '@oxy.so/bloom/icons/RiArrowGoBackLine';
import { RiFileList3Line } from '@oxy.so/bloom/icons/RiFileList3Line';
import { RiMoneyDollarCircleLine } from '@oxy.so/bloom/icons/RiMoneyDollarCircleLine';
import { RiReceiptLine } from '@oxy.so/bloom/icons/RiReceiptLine';
import { StatCards, type StatCardsItem } from '@oxy.so/bloom/stat-cards';
import { useMemo } from 'react';

import { useTranslation } from '@/lib/i18n';
import { formatCount, formatMoney } from '@/lib/money';
import type { SpendRow, SpendTotal } from '@/lib/reporting';
import {
  type ChartWindow,
  dailyTotals,
  deltaChip,
  plotNumber,
  trendRatio,
} from '@/lib/reporting-charts';

/**
 * Net charged, billed, refunded and receipts for one currency over the period.
 *
 * The figures are the ledger's own per-currency totals, exact strings; the daily
 * rows only draw the sparklines and the change against the period before.
 */
export function SpendStats({
  total,
  daily,
  days,
  period,
}: {
  total: SpendTotal;
  /** Daily rows of this currency over `days`, oldest first. */
  daily: ReadonlyArray<SpendRow>;
  days: ReadonlyArray<string>;
  period: ChartWindow;
}) {
  const { t } = useTranslation();

  const stats = useMemo<StatCardsItem[]>(() => {
    const tile = (
      icon: StatCardsItem['icon'],
      label: string,
      value: string,
      pick: (row: SpendRow) => number,
    ): StatCardsItem => {
      const values = dailyTotals(daily, days, pick);
      return {
        icon,
        label,
        value,
        ...deltaChip(trendRatio(values, period), 'neutral'),
        accessory: <Sparkline data={values.slice(-period)} />,
      };
    };
    return [
      tile(
        RiMoneyDollarCircleLine,
        t('billingPage.spend.netCharged'),
        formatMoney(total.netAmount, total.currency),
        (row) => plotNumber(row.netAmount),
      ),
      tile(
        RiFileList3Line,
        t('billingPage.spend.beforeReversals'),
        formatMoney(total.billedAmount, total.currency),
        (row) => plotNumber(row.billedAmount),
      ),
      tile(
        RiArrowGoBackLine,
        t('billingPage.spend.refundedTotal'),
        formatMoney(total.refundedAmount, total.currency),
        (row) => plotNumber(row.refundedAmount),
      ),
      tile(
        RiReceiptLine,
        t('billingPage.spend.receiptsTotal'),
        formatCount(total.receiptCount),
        (row) => row.receiptCount,
      ),
    ];
  }, [total, daily, days, period, t]);

  return <StatCards stats={stats} />;
}
