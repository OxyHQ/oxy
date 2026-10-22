import { Checkbox } from '@oxy.so/bloom/checkbox';
import { DataTable, type DataTableColumn } from '@oxy.so/bloom/data-table';
import { RiArrowRightSLine } from '@oxy.so/bloom/icons/RiArrowRightSLine';
import { useTheme } from '@oxy.so/bloom/theme';
import { type Href, useRouter } from 'expo-router';
import { useMemo, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { PageFrame } from '@/components/account-pages/PageFrame';
import { MonoCell, NumberCell } from '@/components/account-pages/cells';
import {
  Denied,
  Figure,
  FigureRow,
  Muted,
  Note,
  Section,
} from '@/components/account-pages/Section';
import { SkeletonFigures, SkeletonRows } from '@/components/account-pages/Skeletons';
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
  const theme = useTheme();
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
          cell: ({ row }) => <MonoCell>{usageDimensionValue(row, dimension)}</MonoCell>,
        }),
      ),
      {
        id: 'requests',
        header: t('usagePage.requests'),
        align: 'end',
        width: 120,
        cell: ({ row }) => <NumberCell>{formatCount(row.requestCount)}</NumberCell>,
      },
      {
        id: 'errors',
        header: t('usagePage.errors'),
        align: 'end',
        width: 100,
        cell: ({ row }) => <NumberCell muted>{formatCount(row.errorCount)}</NumberCell>,
      },
      {
        id: 'tokens',
        header: t('usagePage.tokensInOut'),
        align: 'end',
        width: 170,
        cell: ({ row }) => (
          <NumberCell muted>
            {formatCount(row.units.input_tokens)} / {formatCount(row.units.output_tokens)}
          </NumberCell>
        ),
      },
    ],
    [groupBy, labels, t],
  );

  return (
    <PageFrame
      title={t('usagePage.title')}
      subtitle={
        currentAccount === null
          ? t('usagePage.subtitleNone')
          : t('usagePage.subtitle', { name: accountLabel(currentAccount) })
      }
    >
      {!canRead ? (
        <Denied>{t('usagePage.denied')}</Denied>
      ) : (
        <>
          <Section>
            <ProvenanceBanner provenance={TELEMETRY} />
            <ProvenanceCrossReference provenance={TELEMETRY} />
          </Section>

          <Section>
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
          </Section>

          <Section title={t('usagePage.consumed', { from: range.from, to: range.to })}>
            {usageQuery.isLoading ? (
              <SkeletonFigures width={112} />
            ) : (
              <FigureRow>
                <Figure label={t('usagePage.requests')} value={formatCount(totals.requestCount)} />
                <Figure label={t('usagePage.errors')} value={formatCount(totals.errorCount)} />
                <Figure
                  label={t('usagePage.inputTokens')}
                  value={formatCount(totals.inputTokens)}
                />
                <Figure
                  label={t('usagePage.outputTokens')}
                  value={formatCount(totals.outputTokens)}
                />
                <Figure
                  label={t('usagePage.reasoningTokens')}
                  value={formatCount(totals.reasoningTokens)}
                />
              </FigureRow>
            )}
            {report?.truncated === true && <Note>{t('usagePage.totalsTruncated')}</Note>}
          </Section>

          <Section
            title={t('reportKit.by', {
              dimensions: groupBy.map(labels.dimension).join(', ').toLowerCase(),
            })}
          >
            {usageQuery.isLoading ? (
              <SkeletonRows />
            ) : (
              <DataTable
                rows={report?.rows ?? []}
                columns={columns}
                getRowId={(row, index) =>
                  `${groupBy.map((dimension) => usageDimensionValue(row, dimension)).join('|')}-${index}`
                }
                accessibilityLabel={t('usagePage.tableLabel')}
                minWidth={520}
                emptyState={<Muted>{t('usagePage.empty')}</Muted>}
              />
            )}
            {report?.truncated === true && <Note>{t('usagePage.rowsTruncated')}</Note>}
          </Section>

          <Section title={t('usagePage.perApplication')} last>
            {applications.length === 0 ? (
              <Muted>{t('usagePage.noApplications')}</Muted>
            ) : (
              <View className="overflow-hidden rounded-lg border border-border">
                {applications.map((application, index) => (
                  <Pressable
                    key={application._id}
                    accessibilityRole="link"
                    onPress={() => router.push(`/apps/${application._id}/inference` as Href)}
                    className={`flex-row items-center justify-between gap-4 px-4 py-4 ${
                      index === 0 ? '' : 'border-t border-border'
                    }`}
                  >
                    <View className="min-w-0 flex-1 gap-0.5">
                      <Text className="text-sm font-medium text-foreground" numberOfLines={1}>
                        {application.name}
                      </Text>
                      <Text className="text-sm text-muted-foreground">
                        {t('usagePage.applicationHint')}
                      </Text>
                    </View>
                    <RiArrowRightSLine size="sm" fill={theme.colors.textSecondary} />
                  </Pressable>
                ))}
              </View>
            )}
          </Section>
        </>
      )}
    </PageFrame>
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
