import { AppShellMenuButton } from '@oxy.so/bloom/app-shell';
import { PageHeader } from '@oxy.so/bloom/page-header';
import { Screen, ScreenScrollView } from '@oxy.so/bloom/screen';
import { useMemo } from 'react';

import { OnboardingChecklist } from '@/components/dashboard/OnboardingChecklist';
import { OverviewCharts } from '@/components/dashboard/OverviewCharts';
import { OverviewStats } from '@/components/dashboard/OverviewStats';
import { ApiState } from '@/components/loading/ApiState';
import { NoBillingAccess } from '@/components/reporting/NoBillingAccess';
import { OverviewSkeleton } from '@/components/reporting/ReportSkeleton';
import { useApplicationNames } from '@/hooks/use-application-names';
import { useApplications } from '@/hooks/use-applications';
import { useBillingAccess } from '@/hooks/use-billing-access';
import { useCredits } from '@/hooks/use-billing';
import {
  useAccountSpendReport,
  useAccountUsageReport,
  useLedgerBalance,
} from '@/hooks/use-inference-reporting';
import { useTranslation } from '@/lib/i18n';
import { lastCalendarDays } from '@/lib/reporting';
import { calendarDays } from '@/lib/reporting-charts';

/**
 * First run: the checklist. Once the account has traffic: the checklist shrinks to
 * a section and the 30-day overview (KPIs, requests by application, tokens) takes
 * the page.
 */
export default function DashboardPage() {
  const { t } = useTranslation();
  const { accountId, canRead } = useBillingAccess();
  const applicationName = useApplicationNames();
  const { data: applications = [] } = useApplications();
  const { data: credits } = useCredits();

  const wide = useMemo(() => lastCalendarDays(90), []);
  const month = useMemo(() => lastCalendarDays(30), []);
  const wideDays = useMemo(() => calendarDays(wide), [wide]);
  const monthDays = useMemo(() => calendarDays(month), [month]);

  const usage = useAccountUsageReport(
    accountId,
    { range: wide, groupBy: ['day', 'application'] },
    canRead,
  );
  const spend = useAccountSpendReport(accountId, { range: month, groupBy: ['day'] }, canRead);
  const balance = useLedgerBalance(accountId, canRead);

  const hasRequest = usage.data?.rows.some((row) => row.requestCount > 0) ?? false;
  const hasCredits = (credits?.credits ?? 0) > 0;
  const hasApplication = applications.length > 0;
  const onboarded = hasCredits && hasApplication && hasRequest;

  return (
    <Screen
      scroll="auto"
      header={
        <PageHeader
          title={t('dashboard.title')}
          subtitle={t('dashboard.subtitle')}
          leading={<AppShellMenuButton />}
          safeArea={false}
        />
      }
    >
      <ScreenScrollView contentContainerClassName="gap-4 p-4 pb-12">
        {onboarded ? null : (
          <OnboardingChecklist
            hasCredits={hasCredits}
            hasApplication={hasApplication}
            hasRequest={hasRequest}
            compact={hasRequest}
          />
        )}

        {!canRead ? (
          <NoBillingAccess />
        ) : usage.isLoading ? (
          <OverviewSkeleton />
        ) : usage.isError ? (
          <ApiState error={usage.error} onRetry={() => void usage.refetch()} />
        ) : hasRequest && accountId !== undefined && usage.data !== undefined ? (
          <>
            <OverviewStats
              usage={usage.data}
              days={monthDays}
              spend={spend.data}
              balance={balance.data}
            />
            <OverviewCharts
              accountId={accountId}
              usage={usage.data}
              days={wideDays}
              applicationName={applicationName}
            />
          </>
        ) : null}
      </ScreenScrollView>
    </Screen>
  );
}
