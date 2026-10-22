import { useMemo } from 'react';
import { Admonition } from '@oxy.so/bloom/admonition';
import { Badge } from '@oxy.so/bloom/badge';
import { AreaChartCard, BarListCard } from '@oxy.so/bloom/chart-cards';
import { GroupedSection, GroupedSectionItem } from '@oxy.so/bloom/grouped-section';
import { RiBarChartLine } from '@oxy.so/bloom/icons/RiBarChartLine';
import { RiCoinsLine } from '@oxy.so/bloom/icons/RiCoinsLine';
import { RiCpuLine } from '@oxy.so/bloom/icons/RiCpuLine';
import { RiErrorWarningLine } from '@oxy.so/bloom/icons/RiErrorWarningLine';
import * as Skeleton from '@oxy.so/bloom/skeleton';
import { StatCards } from '@oxy.so/bloom/stat-cards';
import { useAppDetail } from '@/components/apps/app-context';
import { InferenceAvailabilityNotice } from '@/components/inference-availability-notice';
import { useAccount } from '@/hooks/use-account';
import {
  useApplicationSpendReport,
  useApplicationUsageReport,
} from '@/hooks/use-inference-reporting';
import { useModelCatalogue } from '@/hooks/use-models';
import { useAccountProviderConnections } from '@/hooks/use-provider-connections';
import { useEffectiveRoutingPolicy } from '@/hooks/use-routing-policy';
import { useTranslation } from '@/lib/i18n';
import { formatCompactCount, formatCount, formatMoney } from '@/lib/money';
import { connectionAppliesToApplication } from '@/lib/provider-connection';
import { lastCalendarDays } from '@/lib/reporting';
import { effectivePolicyOrigin } from '@/lib/routing-policy';

const RANGE_DAYS = 30;

/**
 * Inference at a glance: what the application consumed over the last 30 days
 * (telemetry counts, and net spend from the ledger where the caller may read it),
 * then the configuration those requests ran under.
 *
 * Counts and money stay separate on purpose: the stat cards say which record each
 * comes from, and no chart plots an amount (amounts are exact decimals, never floats).
 */
export function InferenceOverview() {
  const { t } = useTranslation();
  const { application, access } = useAppDetail();
  const { accounts, canReadAccount } = useAccount();
  const canReadUsage = access.can('usage:read');
  const canReadSpend = access.can('billing:read');
  const ownerAccountId = application.ownerAccountId;
  const ownerAccount = accounts.find((account) => account.accountId === ownerAccountId);
  const canReadOwnerAccount = ownerAccount !== undefined && canReadAccount(ownerAccount);

  const range = useMemo(() => lastCalendarDays(RANGE_DAYS), []);
  const byDay = useApplicationUsageReport(
    application._id,
    { range, groupBy: ['day'] },
    canReadUsage,
  );
  const byModel = useApplicationUsageReport(
    application._id,
    { range, groupBy: ['requestedModel'] },
    canReadUsage,
  );
  const byProvider = useApplicationUsageReport(
    application._id,
    { range, groupBy: ['provider'] },
    canReadUsage,
  );
  const spend = useApplicationSpendReport(
    application._id,
    { range, groupBy: ['day'] },
    canReadSpend,
  );

  const { data: catalogue = [] } = useModelCatalogue();
  const { data: policy, isLoading: isPolicyLoading } = useEffectiveRoutingPolicy(
    application._id,
    access.can('app:read'),
  );
  const { data: connections = [] } = useAccountProviderConnections(
    ownerAccountId,
    canReadOwnerAccount,
  );
  const liveConnections = connections.filter(
    (connection) =>
      connectionAppliesToApplication(connection, application._id, ownerAccountId) &&
      (connection.status === 'active' || connection.status === 'pending_validation'),
  );

  const days = byDay.data?.rows ?? [];
  const totals = useMemo(() => {
    const rows = byDay.data?.rows ?? [];
    return rows.reduce(
      (sum, row) => ({
        requests: sum.requests + row.requestCount,
        errors: sum.errors + row.errorCount,
        input: sum.input + row.units.input_tokens,
        output: sum.output + row.units.output_tokens,
      }),
      { requests: 0, errors: 0, input: 0, output: 0 },
    );
  }, [byDay.data]);

  const chartData = useMemo(
    () =>
      [...days]
        .sort((a, b) => (a.day ?? '').localeCompare(b.day ?? ''))
        .map((row) => ({
          label: (row.day ?? '').slice(5),
          requests: row.requestCount,
          errors: row.errorCount,
        })),
    [days],
  );

  const toItems = (rows: ReadonlyArray<{ label: string; value: number }>) =>
    [...rows].sort((a, b) => b.value - a.value);
  const modelItems = toItems(
    (byModel.data?.rows ?? []).map((row) => ({
      label: row.requestedModelReference ?? '—',
      value: row.requestCount,
    })),
  );
  const providerItems = toItems(
    (byProvider.data?.rows ?? []).map((row) => ({
      label: row.servingProvider ?? '—',
      value: row.requestCount,
    })),
  );

  const stats = [
    ...(canReadUsage
      ? [
          {
            icon: RiBarChartLine,
            label: t('appsInference.overview.stats.requests'),
            value: formatCount(totals.requests),
            delta: t('appsInference.overview.stats.window', { days: RANGE_DAYS }),
            deltaColor: 'neutral' as const,
          },
          {
            icon: RiErrorWarningLine,
            label: t('appsInference.overview.stats.errors'),
            value: formatCount(totals.errors),
            delta: t('appsInference.overview.stats.window', { days: RANGE_DAYS }),
            deltaColor: 'neutral' as const,
          },
          {
            icon: RiCpuLine,
            label: t('appsInference.overview.stats.tokens'),
            value: `${formatCompactCount(totals.input)} / ${formatCompactCount(totals.output)}`,
            delta: t('appsInference.overview.stats.tokensDetail'),
            deltaColor: 'neutral' as const,
          },
        ]
      : []),
    ...(canReadSpend
      ? (spend.data?.totals ?? []).map((total) => ({
          icon: RiCoinsLine,
          label: t('appsInference.overview.stats.spend'),
          value: formatMoney(total.netAmount, total.currency),
          delta: t('appsInference.overview.stats.receipts', {
            count: total.receiptCount,
          }),
          deltaColor: 'neutral' as const,
        }))
      : []),
  ];

  const isLoadingReports = (canReadUsage && byDay.isLoading) || (canReadSpend && spend.isLoading);
  const hasPolicy = policy !== null && policy !== undefined;

  return (
    <>
      <InferenceAvailabilityNotice />

      {isLoadingReports ? (
        <Skeleton.Box width="100%" height={132} borderRadius={14} />
      ) : (
        stats.length > 0 && <StatCards stats={stats} />
      )}

      {canReadUsage && byDay.isError && (
        <Admonition type="error">{t('appsInference.overview.loadFailed')}</Admonition>
      )}

      {canReadUsage && !byDay.isLoading && !byDay.isError && chartData.length > 0 && (
        <>
          <AreaChartCard
            title={t('appsInference.overview.chart.title')}
            variant="overlap"
            range={t('appsInference.overview.chart.range', { days: RANGE_DAYS })}
            data={chartData}
            series={[
              { key: 'requests', label: t('appsInference.overview.stats.requests') },
              { key: 'errors', label: t('appsInference.overview.stats.errors') },
            ]}
            format={formatCount}
          />
          {(modelItems.length > 0 || providerItems.length > 0) && (
            <BarListCard
              tabs={[
                { id: 'models', label: t('appsInference.overview.bars.models'), items: modelItems },
                {
                  id: 'providers',
                  label: t('appsInference.overview.bars.providers'),
                  items: providerItems,
                },
              ]}
              metricLabel={t('appsInference.overview.stats.requests')}
              metric="value"
              format={formatCount}
            />
          )}
        </>
      )}

      {canReadUsage && !byDay.isLoading && !byDay.isError && chartData.length === 0 && (
        <Admonition type="info">
          {t('appsInference.overview.noUsage', { days: RANGE_DAYS })}
        </Admonition>
      )}

      <GroupedSection
        title={t('appsInference.overview.configuration.title')}
        footer={t('appsInference.overview.configuration.footer')}
        separator="line"
      >
        <GroupedSectionItem
          title={t('appsInference.overview.models.label')}
          description={
            catalogue.length === 0
              ? t('appsInference.overview.models.empty')
              : t('appsInference.overview.models.published')
          }
          titleNumberOfLines={0}
          rightElement={
            <Badge content={String(catalogue.length)} variant="subtle" color="primary" />
          }
        />
        <GroupedSectionItem
          title={t('appsInference.overview.policy.label')}
          description={
            isPolicyLoading
              ? undefined
              : hasPolicy
                ? t('appsInference.overview.policy.detail', {
                    version: policy.policy.policyVersion,
                    optimiseFor: policy.policy.optimiseFor,
                  })
                : t('appsInference.overview.policy.noneDetail')
          }
          titleNumberOfLines={0}
          value={
            !hasPolicy
              ? t('appsInference.overview.policy.none')
              : effectivePolicyOrigin(policy) === 'application'
                ? t('appsInference.overview.policy.application')
                : t('appsInference.overview.policy.inherited')
          }
        />
        <GroupedSectionItem
          title={t('appsInference.overview.credentials.label')}
          description={
            !canReadOwnerAccount
              ? t('appsInference.overview.credentials.noAccess')
              : liveConnections.length === 0
                ? t('appsInference.overview.credentials.none')
                : t('appsInference.overview.credentials.live')
          }
          titleNumberOfLines={0}
          rightElement={
            <Badge content={String(liveConnections.length)} variant="subtle" color="primary" />
          }
        />
      </GroupedSection>
    </>
  );
}
