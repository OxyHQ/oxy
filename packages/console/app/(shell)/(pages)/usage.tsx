import { AppShellMenuButton } from '@oxy.so/bloom/app-shell';
import { Card, CardBody, CardHeader, CardTitle } from '@oxy.so/bloom/card';
import { Checkbox } from '@oxy.so/bloom/checkbox';
import { DataTable, type DataTableColumn } from '@oxy.so/bloom/data-table';
import { EmptyState } from '@oxy.so/bloom/empty-state';
import { GroupedSection, GroupedSectionItem } from '@oxy.so/bloom/grouped-section';
import { RiLockLine } from '@oxy.so/bloom/icons/RiLockLine';
import { PageHeader } from '@oxy.so/bloom/page-header';
import { Screen, ScreenScrollView } from '@oxy.so/bloom/screen';
import * as Skeleton from '@oxy.so/bloom/skeleton';
import { Muted, Text } from '@oxy.so/bloom/typography';
import { type Href, useRouter } from 'expo-router';
import { useMemo, useState } from 'react';
import { useReportLabels } from '@/components/billing/labels';
import { ProvenanceBanner, ProvenanceCrossReference } from '@/components/billing/provenance-banner';
import { ReportControls } from '@/components/billing/report-controls';
import { accountLabel, useAccount } from '@/hooks/use-account';
import { useApplications } from '@/hooks/use-applications';
import { useAccountUsageReport } from '@/hooks/use-inference-reporting';
import { useTranslation } from '@/lib/i18n';
import { formatCount } from '@/lib/money';
import {
  type ReportRangeDays,
  USAGE_DIMENSIONS,
  type UsageDimension,
  type UsageRow,
  lastCalendarDays,
  usageDimensionValue,
} from '@/lib/reporting';

/**
 * What the account CONSUMED — requests, tokens, images — over a period.
 *
 * ## There is no money on this page, and that is the point
 *
 * These figures come from `inference_usage_daily_rollups`, which is telemetry
 * maintained outside the ledger transaction: a recent request may not be counted
 * yet, and a dropped recorder may never count one. The API stamps every response
 * here `{ source: 'usage_telemetry_rollups', consistency: 'eventual' }`, the
 * banner renders that stamp, and the response type carries the two values as
 * literals so a component cannot show these rows under a ledger heading.
 *
 * The exact billed amount is a different table and a different page — Billing →
 * Spend — and the cross-reference at the top says so rather than leaving a
 * customer to assume the two agree. They will not always.
 */
const TELEMETRY = { source: 'usage_telemetry_rollups', consistency: 'eventual' } as const;

export default function UsagePage() {
  const { t } = useTranslation();
  const labels = useReportLabels();
  const router = useRouter();
  const { currentAccount, canReadBilling } = useAccount();
  const accountId = currentAccount?.accountId;
  const canRead = currentAccount !== null && canReadBilling(currentAccount);

  const [rangeDays, setRangeDays] = useState<ReportRangeDays>(30);
  const [groupBy, setGroupBy] = useState<ReadonlyArray<UsageDimension>>(['day']);
  const [includeDescendants, setIncludeDescendants] = useState(false);

  const range = useMemo(() => lastCalendarDays(rangeDays), [rangeDays]);
  const usageQuery = useAccountUsageReport(
    accountId,
    { range, groupBy, includeDescendants },
    canRead,
  );
  const report = usageQuery.data;

  const applicationsQuery = useApplications();
  const applications = applicationsQuery.data ?? [];

  /**
   * Whole counts, so ordinary arithmetic is exact — these are integers from the
   * rollups, not amounts of money. The same sum over a spend report would be the
   * float bug the ledger exists to avoid, which is why no such sum exists there.
   */
  const totals = useMemo(() => summariseUsage(report?.rows ?? []), [report]);

  const columns = useMemo<ReadonlyArray<DataTableColumn<UsageRow>>>(
    () => [
      ...groupBy.map(
        (dimension): DataTableColumn<UsageRow> => ({
          id: dimension,
          header: labels.dimension(dimension),
          minWidth: 140,
          cell: ({ row }) => (
            <Text className="font-mono text-xs">{usageDimensionValue(row, dimension)}</Text>
          ),
        }),
      ),
      {
        id: 'requests',
        header: t('usagePage.requests'),
        align: 'end',
        width: 120,
        cell: ({ row }) => <Text className="tabular-nums">{formatCount(row.requestCount)}</Text>,
      },
      {
        id: 'errors',
        header: t('usagePage.errors'),
        align: 'end',
        width: 100,
        cell: ({ row }) => <Muted className="tabular-nums">{formatCount(row.errorCount)}</Muted>,
      },
      {
        id: 'tokens',
        header: t('usagePage.tokensInOut'),
        align: 'end',
        width: 170,
        cell: ({ row }) => (
          <Muted className="tabular-nums">
            {formatCount(row.units.input_tokens)} / {formatCount(row.units.output_tokens)}
          </Muted>
        ),
      },
    ],
    [groupBy, labels, t],
  );

  const subtitle =
    currentAccount === null
      ? t('usagePage.subtitleNone')
      : t('usagePage.subtitle', { name: accountLabel(currentAccount) });
  const groupedBy = t('reportKit.by', {
    dimensions: groupBy.map(labels.dimension).join(', ').toLowerCase(),
  });

  return (
    <Screen
      header={
        <PageHeader
          title={t('usagePage.title')}
          subtitle={subtitle}
          leading={<AppShellMenuButton />}
          presentation="bar"
          titleAlign="start"
          safeArea={false}
        />
      }
    >
      <ScreenScrollView contentContainerClassName="gap-6 px-4 py-6 pb-12">
        {!canRead ? (
          <EmptyState icon={RiLockLine} title={t('usagePage.denied')} />
        ) : (
          <>
            <ProvenanceBanner provenance={TELEMETRY} />
            <ProvenanceCrossReference provenance={TELEMETRY} />

            <ReportControls
              rangeDays={rangeDays}
              onRangeDaysChange={setRangeDays}
              dimensions={USAGE_DIMENSIONS}
              selected={groupBy}
              onSelectedChange={setGroupBy}
              dimensionLabel={labels.dimension}
            />
            <Checkbox
              checked={includeDescendants}
              onCheckedChange={setIncludeDescendants}
              label={t('reportKit.includeDescendants')}
            />

            {usageQuery.isLoading ? (
              <Skeleton.Box width="100%" height={176} />
            ) : (
              <GroupedSection
                title={t('usagePage.consumed', { from: range.from, to: range.to })}
                footer={report?.truncated === true ? t('usagePage.totalsTruncated') : undefined}
              >
                <GroupedSectionItem
                  title={t('usagePage.requests')}
                  value={formatCount(totals.requestCount)}
                />
                <GroupedSectionItem
                  title={t('usagePage.errors')}
                  value={formatCount(totals.errorCount)}
                />
                <GroupedSectionItem
                  title={t('usagePage.inputTokens')}
                  value={formatCount(totals.inputTokens)}
                />
                <GroupedSectionItem
                  title={t('usagePage.outputTokens')}
                  value={formatCount(totals.outputTokens)}
                />
                <GroupedSectionItem
                  title={t('usagePage.reasoningTokens')}
                  value={formatCount(totals.reasoningTokens)}
                />
              </GroupedSection>
            )}

            <Card>
              <CardHeader>
                <CardTitle>{groupedBy}</CardTitle>
              </CardHeader>
              <CardBody>
                {usageQuery.isLoading ? (
                  <Skeleton.Box width="100%" height={132} />
                ) : (
                  <DataTable
                    rows={report?.rows ?? []}
                    columns={columns}
                    getRowId={(row, index) =>
                      `${groupBy.map((dimension) => usageDimensionValue(row, dimension)).join('|')}-${index}`
                    }
                    accessibilityLabel={t('usagePage.tableLabel')}
                    minWidth={520}
                    emptyState={<EmptyState variant="compact" title={t('usagePage.empty')} />}
                  />
                )}
                {report?.truncated === true && <Muted>{t('usagePage.rowsTruncated')}</Muted>}
              </CardBody>
            </Card>

            {applications.length === 0 ? (
              <Muted>{t('usagePage.noApplications')}</Muted>
            ) : (
              <GroupedSection title={t('usagePage.perApplication')}>
                {applications.map((application) => (
                  <GroupedSectionItem
                    key={application._id}
                    title={application.name}
                    description={t('usagePage.applicationHint')}
                    accessibilityRole="link"
                    onPress={() => router.push(`/apps/${application._id}/inference` as Href)}
                  />
                ))}
              </GroupedSection>
            )}
          </>
        )}
      </ScreenScrollView>
    </Screen>
  );
}

interface UsageTotals {
  requestCount: number;
  errorCount: number;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
}

function summariseUsage(rows: ReadonlyArray<UsageRow>): UsageTotals {
  return rows.reduce<UsageTotals>(
    (totals, row) => ({
      requestCount: totals.requestCount + row.requestCount,
      errorCount: totals.errorCount + row.errorCount,
      inputTokens: totals.inputTokens + row.units.input_tokens,
      outputTokens: totals.outputTokens + row.units.output_tokens,
      reasoningTokens: totals.reasoningTokens + row.units.reasoning_tokens,
    }),
    { requestCount: 0, errorCount: 0, inputTokens: 0, outputTokens: 0, reasoningTokens: 0 },
  );
}
