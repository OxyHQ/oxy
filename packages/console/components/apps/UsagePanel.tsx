import { Admonition } from '@oxy.so/bloom/admonition';
import { Button } from '@oxy.so/bloom/button';
import { AreaChartCard } from '@oxy.so/bloom/chart-cards';
import { Code } from '@oxy.so/bloom/code';
import { DataTable, type DataTableColumn } from '@oxy.so/bloom/data-table';
import { EmptyState } from '@oxy.so/bloom/empty-state';
import { GroupedSection, GroupedSectionItem } from '@oxy.so/bloom/grouped-section';
import { RiBarChartLine } from '@oxy.so/bloom/icons/RiBarChartLine';
import * as Skeleton from '@oxy.so/bloom/skeleton';
import { Tabs, TabsTrigger } from '@oxy.so/bloom/tabs';
import { Muted, Text } from '@oxy.so/bloom/typography';
import { useMemo, useState } from 'react';

import type { Application, AppUsageStats, CallerAccess } from '@/hooks/use-applications';
import { useApplicationUsage } from '@/hooks/use-applications';
import { useTranslation } from '@/lib/i18n';

const PERIODS = ['24h', '7d', '30d', '90d'] as const;

type DayRow = AppUsageStats['byDay'][number];
type EndpointRow = AppUsageStats['byEndpoint'][number];

const count = (value: number) => value.toLocaleString();

/** Platform API calls made with this application's credentials, over a period. */
export function UsagePanel({
  application,
  access,
}: {
  application: Application;
  access: CallerAccess;
}) {
  const { t } = useTranslation();
  const canRead = access.can('usage:read');
  const [period, setPeriod] = useState<string>('7d');
  const {
    data: usage,
    isLoading,
    isError,
    refetch,
  } = useApplicationUsage(application._id, period, canRead);

  const dayColumns = useMemo<ReadonlyArray<DataTableColumn<DayRow>>>(
    () => [
      {
        id: 'day',
        header: t('applications.usage.day'),
        accessor: (row) => row._id,
        minWidth: 140,
        cell: ({ row }) => <Text>{row._id}</Text>,
      },
      {
        id: 'requests',
        header: t('applications.usage.totalRequests'),
        accessor: (row) => row.requests,
        align: 'end',
        width: 140,
        cell: ({ row }) => <Text className="tabular-nums">{count(row.requests)}</Text>,
      },
      {
        id: 'tokens',
        header: t('applications.usage.totalTokens'),
        accessor: (row) => row.tokens,
        align: 'end',
        width: 140,
        cell: ({ row }) => <Muted className="tabular-nums">{count(row.tokens)}</Muted>,
      },
      {
        id: 'credits',
        header: t('applications.usage.credits'),
        accessor: (row) => row.credits,
        align: 'end',
        width: 140,
        cell: ({ row }) => <Muted className="tabular-nums">{count(row.credits)}</Muted>,
      },
    ],
    [t],
  );

  const endpointColumns = useMemo<ReadonlyArray<DataTableColumn<EndpointRow>>>(
    () => [
      {
        id: 'endpoint',
        header: t('applications.usage.endpoint'),
        accessor: (row) => row._id,
        minWidth: 220,
        flex: 2,
        cell: ({ row }) => <Code>{row._id}</Code>,
      },
      {
        id: 'requests',
        header: t('applications.usage.totalRequests'),
        accessor: (row) => row.requests,
        align: 'end',
        width: 140,
        cell: ({ row }) => <Text className="tabular-nums">{count(row.requests)}</Text>,
      },
      {
        id: 'tokens',
        header: t('applications.usage.totalTokens'),
        accessor: (row) => row.tokens,
        align: 'end',
        width: 140,
        cell: ({ row }) => <Muted className="tabular-nums">{count(row.tokens)}</Muted>,
      },
    ],
    [t],
  );

  if (!canRead) {
    return <EmptyState icon={RiBarChartLine} title={t('applications.usage.noPermission')} />;
  }

  const summary = usage?.summary;
  const byDay = usage?.byDay ?? [];

  return (
    <>
      <Tabs
        variant="filled"
        value={period}
        onValueChange={setPeriod}
        label={t('applications.usage.period')}
      >
        {PERIODS.map((value) => (
          <TabsTrigger key={value} value={value} label={value} />
        ))}
      </Tabs>

      {isError ? (
        <Admonition type="error">
          {t('applications.usage.loadFailed')}{' '}
          <Button size="sm" appearance="plain" onPress={() => void refetch()}>
            {t('applications.retry')}
          </Button>
        </Admonition>
      ) : isLoading ? (
        <>
          <Skeleton.Box width="100%" height={260} borderRadius={20} />
          <Skeleton.Box width="100%" height={176} borderRadius={20} />
        </>
      ) : (
        <>
          {byDay.length > 0 ? (
            <AreaChartCard
              title={t('applications.usage.totalRequests')}
              data={byDay.map((day) => ({ label: day._id, requests: day.requests }))}
              series={[{ key: 'requests', label: t('applications.usage.totalRequests') }]}
              variant="overlap"
              format={count}
              accessibilityLabel={t('applications.usage.byDay')}
            />
          ) : null}

          <GroupedSection title={t('applications.usage.overview')}>
            <GroupedSectionItem
              title={t('applications.usage.totalRequests')}
              value={count(summary?.totalRequests ?? 0)}
            />
            <GroupedSectionItem
              title={t('applications.usage.totalTokens')}
              value={count(summary?.totalTokens ?? 0)}
            />
            <GroupedSectionItem
              title={t('applications.usage.credits')}
              value={count(summary?.totalCredits ?? 0)}
            />
            <GroupedSectionItem
              title={t('applications.usage.avgResponse')}
              value={`${Math.round(summary?.avgResponseTime ?? 0)}ms`}
            />
          </GroupedSection>

          <DataTable
            rows={byDay}
            columns={dayColumns}
            getRowId={(row) => row._id}
            accessibilityLabel={t('applications.usage.byDay')}
            title={t('applications.usage.byDay')}
            emptyState={t('applications.usage.noData')}
            defaultSort={{ columnId: 'day', direction: 'descending' }}
            pageSize={10}
            minWidth={560}
          />

          <DataTable
            rows={usage?.byEndpoint ?? []}
            columns={endpointColumns}
            getRowId={(row) => row._id}
            accessibilityLabel={t('applications.usage.byEndpoint')}
            title={t('applications.usage.byEndpoint')}
            emptyState={t('applications.usage.noEndpointData')}
            pageSize={10}
            minWidth={520}
          />
        </>
      )}
    </>
  );
}
