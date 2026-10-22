import { Card, CardBody, CardDescription, CardHeader, CardTitle } from '@oxy.so/bloom/card';
import { Code } from '@oxy.so/bloom/code';
import { EmptyState } from '@oxy.so/bloom/empty-state';
import { GroupedSection, GroupedSectionItem } from '@oxy.so/bloom/grouped-section';
import { RiBarChartLine } from '@oxy.so/bloom/icons/RiBarChartLine';
import * as Skeleton from '@oxy.so/bloom/skeleton';
import { Tabs, TabsTrigger } from '@oxy.so/bloom/tabs';
import {
  Table,
  TableBody,
  TableCell,
  TableColumn,
  TableHeader,
  TableRow,
} from '@oxy.so/bloom/table';
import { useState } from 'react';
import { View } from 'react-native';

import type { Application, CallerAccess } from '@/hooks/use-applications';
import { useApplicationUsage } from '@/hooks/use-applications';
import { useTranslation } from '@/lib/i18n';

const PERIODS = ['24h', '7d', '30d', '90d'] as const;

interface UsageSectionProps {
  application: Application;
  access: CallerAccess;
}

export function UsageSection({ application, access }: UsageSectionProps) {
  const { t } = useTranslation();
  const canRead = access.can('usage:read');
  const [period, setPeriod] = useState<string>('7d');
  const { data: usage, isLoading } = useApplicationUsage(application._id, period, canRead);

  if (!canRead) {
    return (
      <EmptyState
        variant="compact"
        icon={RiBarChartLine}
        title={t('applications.usage.noPermission')}
      />
    );
  }

  const summary = usage?.summary;

  return (
    <View className="gap-6">
      <Card appearance="outline">
        <CardHeader>
          <CardTitle>{t('applications.usage.title')}</CardTitle>
          <CardDescription>{t('applications.usage.subtitle')}</CardDescription>
        </CardHeader>
        <CardBody>
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
        </CardBody>
      </Card>

      {isLoading ? (
        <Skeleton.Box width="100%" height={96} />
      ) : (
        <GroupedSection title={t('applications.usage.overview')}>
          <GroupedSectionItem
            title={t('applications.usage.totalRequests')}
            value={(summary?.totalRequests ?? 0).toLocaleString()}
          />
          <GroupedSectionItem
            title={t('applications.usage.totalTokens')}
            value={(summary?.totalTokens ?? 0).toLocaleString()}
          />
          <GroupedSectionItem
            title={t('applications.usage.credits')}
            value={(summary?.totalCredits ?? 0).toLocaleString()}
          />
          <GroupedSectionItem
            title={t('applications.usage.avgResponse')}
            value={`${Math.round(summary?.avgResponseTime ?? 0)}ms`}
          />
        </GroupedSection>
      )}

      <Card appearance="outline">
        <CardHeader>
          <CardTitle>{t('applications.usage.byDay')}</CardTitle>
        </CardHeader>
        {isLoading ? (
          <Skeleton.Box width="100%" height={96} />
        ) : (
          <Table accessibilityLabel={t('applications.usage.byDay')}>
            <TableHeader>
              <TableColumn>{t('applications.usage.byDay')}</TableColumn>
              <TableColumn align="end">{t('applications.usage.totalRequests')}</TableColumn>
              <TableColumn align="end">{t('applications.usage.totalTokens')}</TableColumn>
              <TableColumn align="end">{t('applications.usage.credits')}</TableColumn>
            </TableHeader>
            <TableBody emptyState={t('applications.usage.noData')}>
              {(usage?.byDay ?? []).map((day) => (
                <TableRow key={day._id}>
                  <TableCell>{day._id}</TableCell>
                  <TableCell>{day.requests.toLocaleString()}</TableCell>
                  <TableCell>{day.tokens.toLocaleString()}</TableCell>
                  <TableCell>{day.credits.toLocaleString()}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Card>

      <Card appearance="outline">
        <CardHeader>
          <CardTitle>{t('applications.usage.byEndpoint')}</CardTitle>
        </CardHeader>
        {isLoading ? (
          <Skeleton.Box width="100%" height={96} />
        ) : (
          <Table accessibilityLabel={t('applications.usage.byEndpoint')}>
            <TableHeader>
              <TableColumn flex={2}>{t('applications.usage.byEndpoint')}</TableColumn>
              <TableColumn align="end">{t('applications.usage.totalRequests')}</TableColumn>
              <TableColumn align="end">{t('applications.usage.totalTokens')}</TableColumn>
            </TableHeader>
            <TableBody emptyState={t('applications.usage.noEndpointData')}>
              {(usage?.byEndpoint ?? []).map((endpoint) => (
                <TableRow key={endpoint._id}>
                  <TableCell flex={2}>
                    <Code>{endpoint._id}</Code>
                  </TableCell>
                  <TableCell>{endpoint.requests.toLocaleString()}</TableCell>
                  <TableCell>{endpoint.tokens.toLocaleString()}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Card>
    </View>
  );
}
