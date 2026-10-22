import type { BarListTab } from '@oxy.so/bloom/chart-cards';
import { useCallback, useMemo, useState } from 'react';

import { UsageCharts } from '@/components/usage/UsageCharts';
import { useAccountSpendReport } from '@/hooks/use-inference-reporting';
import { useTranslation } from '@/lib/i18n';
import { type UsageReportResponse, type UsageRow, lastCalendarDays } from '@/lib/reporting';
import { type ChartWindow, groupTotals, plotNumber } from '@/lib/reporting-charts';

/** The dashboard's charts: usage by application, plus a spend ranking for the same period. */
export function OverviewCharts({
  accountId,
  usage,
  days,
  applicationName,
}: {
  accountId: string;
  usage: UsageReportResponse;
  days: ReadonlyArray<string>;
  applicationName: (applicationId: string) => string;
}) {
  const { t } = useTranslation();
  const [period, setPeriod] = useState<ChartWindow>(30);

  // Spend per application for the period on screen. The ledger rolls it up
  // itself; only the bar lengths are drawn from it.
  const range = useMemo(() => lastCalendarDays(period), [period]);
  const spend = useAccountSpendReport(accountId, { range, groupBy: ['application'] });

  const keyOf = useCallback((row: UsageRow) => row.applicationId ?? '', []);
  const labelOf = useCallback(
    (key: string) => (key === '' ? t('dashboardPage.noApplication') : applicationName(key)),
    [applicationName, t],
  );

  const extraTabs = useMemo<BarListTab[]>(() => {
    const currency = spend.data?.totals[0]?.currency;
    if (spend.data === undefined || currency === undefined) {
      return [];
    }
    return [
      {
        id: 'spend',
        label: t('dashboardPage.spendTab', { currency }),
        items: groupTotals(
          spend.data.rows.filter((row) => row.currency === currency),
          (row) => row.applicationId ?? '',
          (row) => plotNumber(row.netAmount),
        ).map((entry) => ({ label: labelOf(entry.key), value: entry.value })),
      },
    ];
  }, [spend.data, labelOf, t]);

  return (
    <UsageCharts
      usage={usage}
      days={days}
      period={period}
      onPeriodChange={setPeriod}
      keyOf={keyOf}
      labelOf={labelOf}
      title={{
        requests: t('dashboardPage.requestsByApplication'),
        breakdown: t('dashboardPage.byApplication'),
      }}
      extraTabs={extraTabs}
    />
  );
}
