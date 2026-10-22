import { Admonition } from '@oxy.so/bloom/admonition';
import { AppShellMenuButton } from '@oxy.so/bloom/app-shell';
import { EmptyState } from '@oxy.so/bloom/empty-state';
import { RiBarChartLine } from '@oxy.so/bloom/icons/RiBarChartLine';
import { PageHeader } from '@oxy.so/bloom/page-header';
import { Screen, ScreenScrollView } from '@oxy.so/bloom/screen';
import { type Href, useRouter } from 'expo-router';
import { useCallback, useMemo, useState } from 'react';

import { ApiState } from '@/components/loading/ApiState';
import { TableSkeleton } from '@/components/loading/ContentSkeleton';
import { NoBillingAccess } from '@/components/reporting/NoBillingAccess';
import { ProvenanceBanner } from '@/components/reporting/ProvenanceBanner';
import { OverviewSkeleton } from '@/components/reporting/ReportSkeleton';
import { ReportToolbar } from '@/components/reporting/ReportToolbar';
import { UsageCharts } from '@/components/usage/UsageCharts';
import { UsageStats } from '@/components/usage/UsageStats';
import { UsageTable } from '@/components/usage/UsageTable';
import { accountLabel } from '@/hooks/use-account';
import { useApplicationNames } from '@/hooks/use-application-names';
import { useBillingAccess } from '@/hooks/use-billing-access';
import { useAccountUsageReport } from '@/hooks/use-inference-reporting';
import { useTranslation } from '@/lib/i18n';
import {
  type UsageDimension,
  type UsageRow,
  lastCalendarDays,
  usageDimensionValue,
} from '@/lib/reporting';
import { type ChartWindow, calendarDays, usageTotals } from '@/lib/reporting-charts';

const TELEMETRY = { source: 'usage_telemetry_rollups', consistency: 'eventual' } as const;

const BREAKDOWNS = [
  'application',
  'requestedModel',
  'provider',
  'environment',
] as const satisfies ReadonlyArray<UsageDimension>;

type Breakdown = (typeof BREAKDOWNS)[number];

/**
 * What the account consumed: requests, errors and tokens, from telemetry.
 *
 * There is no money on this page, and that is the point. These counts come from
 * the usage rollups, which are maintained outside the ledger transaction and can
 * lag; the banner renders the response's own stamp. What was actually charged is
 * Billing, Spend.
 */
export default function UsagePage() {
  const { t } = useTranslation();
  const router = useRouter();
  const { account, accountId, canRead } = useBillingAccess();
  const applicationName = useApplicationNames();

  const [breakdown, setBreakdown] = useState<Breakdown>('application');
  const [includeDescendants, setIncludeDescendants] = useState(false);
  const [period, setPeriod] = useState<ChartWindow>(30);

  const wide = useMemo(() => lastCalendarDays(90), []);
  const days = useMemo(() => calendarDays(wide), [wide]);

  const usage = useAccountUsageReport(
    accountId,
    { range: wide, groupBy: ['day', breakdown], includeDescendants },
    canRead,
  );
  const report = usage.data;

  const keyOf = useCallback((row: UsageRow) => usageDimensionValue(row, breakdown), [breakdown]);
  const labelOf = useCallback(
    (key: string) => (breakdown === 'application' && key !== '—' ? applicationName(key) : key),
    [breakdown, applicationName],
  );

  const periodRows = useMemo(() => {
    const inPeriod = new Set(days.slice(-period));
    return (report?.rows ?? []).filter((row) => row.day !== undefined && inPeriod.has(row.day));
  }, [report, days, period]);
  const totals = useMemo(() => usageTotals(periodRows, keyOf), [periodRows, keyOf]);

  const dimensions = BREAKDOWNS.map((value) => ({
    value,
    label: t(`reporting.dimensions.${value}`),
  }));

  return (
    <Screen
      scroll="auto"
      header={
        <PageHeader
          title={t('usagePage.title')}
          subtitle={
            account === null
              ? t('usagePage.subtitleNone')
              : t('usagePage.subtitle', { name: accountLabel(account) })
          }
          leading={<AppShellMenuButton />}
          safeArea={false}
        />
      }
    >
      <ScreenScrollView contentContainerClassName="gap-4 p-4 pb-12">
        {!canRead ? (
          <NoBillingAccess />
        ) : (
          <>
            <ProvenanceBanner provenance={TELEMETRY} />
            <ReportToolbar
              dimensions={dimensions}
              dimension={breakdown}
              onDimensionChange={setBreakdown}
              includeDescendants={includeDescendants}
              onIncludeDescendantsChange={setIncludeDescendants}
            />

            {usage.isLoading ? (
              <>
                <OverviewSkeleton />
                <TableSkeleton />
              </>
            ) : usage.isError ? (
              <ApiState error={usage.error} onRetry={() => void usage.refetch()} />
            ) : report === undefined || report.rows.length === 0 ? (
              <EmptyState
                icon={RiBarChartLine}
                title={t('usagePage.empty.title')}
                description={t('usagePage.empty.body')}
                action={{
                  label: t('usagePage.empty.action'),
                  onPress: () => router.push('/apps' as Href),
                }}
              />
            ) : (
              <>
                {report.truncated ? (
                  <Admonition type="warning">{t('usagePage.truncated')}</Admonition>
                ) : null}
                <UsageStats usage={report} days={days} period={period} />
                <UsageCharts
                  usage={report}
                  days={days}
                  period={period}
                  onPeriodChange={setPeriod}
                  keyOf={keyOf}
                  labelOf={labelOf}
                  title={{
                    requests: t('usagePage.requestsBy', {
                      dimension: t(`reporting.dimensions.${breakdown}`).toLowerCase(),
                    }),
                    breakdown: t(`reporting.dimensions.${breakdown}`),
                  }}
                />
                <UsageTable
                  totals={totals}
                  labelOf={labelOf}
                  dimensionLabel={t(`reporting.dimensions.${breakdown}`)}
                  linksToApplication={breakdown === 'application'}
                />
              </>
            )}
          </>
        )}
      </ScreenScrollView>
    </Screen>
  );
}
