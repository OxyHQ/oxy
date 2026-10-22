import { Tabs, TabsTrigger } from '@oxy.so/bloom/tabs';
import * as Skeleton from '@oxy.so/bloom/skeleton';
import { useState } from 'react';
import { Text, View } from 'react-native';

import type { Application, CallerAccess } from '@/hooks/use-applications';
import { useApplicationUsage } from '@/hooks/use-applications';
import { useTranslation } from '@/lib/i18n';
import { SectionBlock } from './primitives';

const PERIODS = ['24h', '7d', '30d', '90d'] as const;

interface UsageSectionProps {
  application: Application;
  access: CallerAccess;
}

function Stat({ value, label }: { value: string; label: string }) {
  return (
    <View>
      <Text className="text-2xl font-semibold text-foreground">{value}</Text>
      <Text className="mt-0.5 text-sm text-muted-foreground">{label}</Text>
    </View>
  );
}

function UsageRow({
  label,
  mono = false,
  figures,
}: {
  label: string;
  mono?: boolean;
  figures: string;
}) {
  return (
    <View className="flex-row flex-wrap items-center justify-between gap-x-6 gap-y-1 border-b border-border py-2">
      <Text className={mono ? 'font-mono text-sm text-foreground' : 'text-sm text-foreground'}>
        {label}
      </Text>
      <Text className="text-sm text-muted-foreground">{figures}</Text>
    </View>
  );
}

export function UsageSection({ application, access }: UsageSectionProps) {
  const { t } = useTranslation();
  const canRead = access.can('usage:read');
  const [period, setPeriod] = useState<string>('7d');
  const { data: usage, isLoading } = useApplicationUsage(application._id, period, canRead);

  if (!canRead) {
    return (
      <View className="py-12">
        <Text className="text-center text-sm text-muted-foreground">
          {t('applications.usage.noPermission')}
        </Text>
      </View>
    );
  }

  const summary = usage?.summary;

  return (
    <View className="gap-8">
      <SectionBlock
        title={t('applications.usage.title')}
        description={t('applications.usage.subtitle')}
        action={
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
        }
      />

      <SectionBlock title={t('applications.usage.overview')}>
        {isLoading ? (
          <View className="flex-row gap-12">
            {[1, 2, 3].map((key) => (
              <Skeleton.Box key={key} width={96} height={48} />
            ))}
          </View>
        ) : (
          <View className="flex-row flex-wrap gap-x-12 gap-y-4">
            <Stat
              value={(summary?.totalRequests ?? 0).toLocaleString()}
              label={t('applications.usage.totalRequests')}
            />
            <Stat
              value={(summary?.totalTokens ?? 0).toLocaleString()}
              label={t('applications.usage.totalTokens')}
            />
            <Stat
              value={(summary?.totalCredits ?? 0).toLocaleString()}
              label={t('applications.usage.credits')}
            />
            <Stat
              value={`${Math.round(summary?.avgResponseTime ?? 0)}ms`}
              label={t('applications.usage.avgResponse')}
            />
          </View>
        )}
      </SectionBlock>

      <SectionBlock title={t('applications.usage.byDay')}>
        {isLoading ? (
          <Skeleton.Box width="100%" height={96} />
        ) : usage?.byDay && usage.byDay.length > 0 ? (
          <View>
            {usage.byDay.map((day) => (
              <UsageRow
                key={day._id}
                label={day._id}
                figures={t('applications.usage.dayFigures', {
                  requests: day.requests.toLocaleString(),
                  tokens: day.tokens.toLocaleString(),
                  credits: day.credits.toLocaleString(),
                })}
              />
            ))}
          </View>
        ) : (
          <Text className="py-8 text-center text-sm text-muted-foreground">
            {t('applications.usage.noData')}
          </Text>
        )}
      </SectionBlock>

      <SectionBlock title={t('applications.usage.byEndpoint')}>
        {isLoading ? (
          <Skeleton.Box width="100%" height={96} />
        ) : usage?.byEndpoint && usage.byEndpoint.length > 0 ? (
          <View>
            {usage.byEndpoint.map((endpoint) => (
              <UsageRow
                key={endpoint._id}
                mono
                label={endpoint._id}
                figures={t('applications.usage.endpointFigures', {
                  requests: endpoint.requests.toLocaleString(),
                  tokens: endpoint.tokens.toLocaleString(),
                })}
              />
            ))}
          </View>
        ) : (
          <Text className="py-8 text-center text-sm text-muted-foreground">
            {t('applications.usage.noEndpointData')}
          </Text>
        )}
      </SectionBlock>
    </View>
  );
}
