import { Admonition } from '@oxy.so/bloom/admonition';
import { EmptyState } from '@oxy.so/bloom/empty-state';
import { RiMoneyDollarCircleLine } from '@oxy.so/bloom/icons/RiMoneyDollarCircleLine';
import { ScreenScrollView } from '@oxy.so/bloom/screen';
import { useCallback, useMemo, useState } from 'react';

import { SpendCharts } from '@/components/billing/SpendCharts';
import { SpendStats } from '@/components/billing/SpendStats';
import { SpendTable } from '@/components/billing/SpendTable';
import { ApiState } from '@/components/loading/ApiState';
import { TableSkeleton } from '@/components/loading/ContentSkeleton';
import { NoBillingAccess } from '@/components/reporting/NoBillingAccess';
import { ProvenanceBanner } from '@/components/reporting/ProvenanceBanner';
import { OverviewSkeleton } from '@/components/reporting/ReportSkeleton';
import { ReportToolbar } from '@/components/reporting/ReportToolbar';
import { useApplicationNames } from '@/hooks/use-application-names';
import { useBillingAccess } from '@/hooks/use-billing-access';
import { useAccountSpendReport } from '@/hooks/use-inference-reporting';
import { useTranslation } from '@/lib/i18n';
import {
  type SpendDimension,
  type SpendRow,
  lastCalendarDays,
  spendDimensionValue,
} from '@/lib/reporting';
import { type ChartWindow, calendarDays } from '@/lib/reporting-charts';

const LEDGER = { source: 'financial_ledger', consistency: 'authoritative' } as const;

const BREAKDOWNS = [
  'application',
  'resolvedModel',
  'provider',
  'environment',
] as const satisfies ReadonlyArray<SpendDimension>;

type Breakdown = (typeof BREAKDOWNS)[number];

/**
 * What the account was actually charged: net of reversals, per currency, by
 * application, served model, provider or environment.
 *
 * Money, and only money: every figure is read from the financial ledger. Totals
 * are the server's, one per currency, and nothing on this page adds one currency
 * to another or sums amounts into a headline. The request and token counts for
 * the same period are on Usage, and may not agree with a bill.
 */
export default function BillingSpendPage() {
  const { t } = useTranslation();
  const { accountId, canRead } = useBillingAccess();
  const applicationName = useApplicationNames();

  const [breakdown, setBreakdown] = useState<Breakdown>('application');
  const [includeDescendants, setIncludeDescendants] = useState(false);
  const [period, setPeriod] = useState<ChartWindow>(30);
  const [chosenCurrency, setChosenCurrency] = useState<string | undefined>();

  const wide = useMemo(() => lastCalendarDays(90), []);
  const days = useMemo(() => calendarDays(wide), [wide]);
  const periodRange = useMemo(() => lastCalendarDays(period), [period]);

  // The chart needs a row per day; the table, bars and tiles need what the
  // ledger totals over the period, which only the server may add up.
  const daily = useAccountSpendReport(
    accountId,
    { range: wide, groupBy: ['day', breakdown], includeDescendants },
    canRead,
  );
  const totals = useAccountSpendReport(
    accountId,
    { range: periodRange, groupBy: [breakdown], includeDescendants },
    canRead,
  );

  const currencies = useMemo(
    () => (totals.data?.totals ?? []).map((total) => total.currency),
    [totals.data],
  );
  const currency =
    chosenCurrency !== undefined && currencies.includes(chosenCurrency)
      ? chosenCurrency
      : currencies[0];
  const total = totals.data?.totals.find((entry) => entry.currency === currency);

  const dailyRows = useMemo(
    () => (daily.data?.rows ?? []).filter((row) => row.currency === currency),
    [daily.data, currency],
  );
  const rankingRows = useMemo(
    () => (totals.data?.rows ?? []).filter((row) => row.currency === currency),
    [totals.data, currency],
  );

  const keyOf = useCallback((row: SpendRow) => spendDimensionValue(row, breakdown), [breakdown]);
  const labelOf = useCallback(
    (key: string) => (breakdown === 'application' && key !== '—' ? applicationName(key) : key),
    [breakdown, applicationName],
  );

  const dimensionLabel = t(`reporting.dimensions.${breakdown}`);
  const dimensions = BREAKDOWNS.map((value) => ({
    value,
    label: t(`reporting.dimensions.${value}`),
  }));
  const isLoading = daily.isLoading || totals.isLoading;
  const error = totals.error ?? daily.error;

  return (
    <ScreenScrollView contentContainerClassName="gap-4 p-4 pb-12">
      {!canRead ? (
        <NoBillingAccess />
      ) : (
        <>
          <ProvenanceBanner provenance={LEDGER} />
          <ReportToolbar
            dimensions={dimensions}
            dimension={breakdown}
            onDimensionChange={setBreakdown}
            includeDescendants={includeDescendants}
            onIncludeDescendantsChange={setIncludeDescendants}
            currencies={currencies}
            currency={currency}
            onCurrencyChange={setChosenCurrency}
          />

          {isLoading ? (
            <>
              <OverviewSkeleton />
              <TableSkeleton />
            </>
          ) : error !== null ? (
            <ApiState
              error={error}
              onRetry={() => {
                void totals.refetch();
                void daily.refetch();
              }}
            />
          ) : total === undefined || currency === undefined ? (
            <EmptyState
              icon={RiMoneyDollarCircleLine}
              title={t('billingPage.spend.emptyTitle')}
              description={t('billingPage.spend.nothing')}
            />
          ) : (
            <>
              {daily.data?.truncated ? (
                <Admonition type="warning">{t('billingPage.spend.chartTruncated')}</Admonition>
              ) : null}
              <SpendStats total={total} daily={dailyRows} days={days} period={period} />
              <SpendCharts
                currency={currency}
                daily={dailyRows}
                days={days}
                period={period}
                onPeriodChange={setPeriod}
                ranking={rankingRows}
                keyOf={keyOf}
                labelOf={labelOf}
                title={{
                  overTime: t('billingPage.spend.overTime', {
                    dimension: dimensionLabel.toLowerCase(),
                  }),
                  breakdown: dimensionLabel,
                }}
              />
              <SpendTable
                rows={rankingRows}
                keyOf={keyOf}
                labelOf={labelOf}
                dimensionLabel={dimensionLabel}
                linksToApplication={breakdown === 'application'}
                truncated={totals.data?.truncated === true}
              />
            </>
          )}
        </>
      )}
    </ScreenScrollView>
  );
}
