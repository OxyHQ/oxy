import { useState } from 'react';
import { View } from 'react-native';
import { RiCloudLine } from '@oxy.so/bloom/icons/RiCloudLine';
import { RiEqualizerLine } from '@oxy.so/bloom/icons/RiEqualizerLine';
import { RiLineChartLine } from '@oxy.so/bloom/icons/RiLineChartLine';
import { RiRouteLine } from '@oxy.so/bloom/icons/RiRouteLine';
import { RiSparklingLine } from '@oxy.so/bloom/icons/RiSparklingLine';
import { Tabs, TabsTrigger } from '@oxy.so/bloom/tabs';
import { useAppDetail } from '@/components/apps/app-context';
import { ApplicationBudgets } from '@/components/apps/inference/ApplicationBudgets';
import { InferenceLimits } from '@/components/apps/inference/InferenceLimits';
import { InferenceOverview } from '@/components/apps/inference/InferenceOverview';
import { ProviderConnections } from '@/components/apps/inference/ProviderConnections';
import { RoutingPolicy } from '@/components/apps/inference/RoutingPolicy';
import { UsageSpend } from '@/components/apps/inference/UsageSpend';
import { useTranslation } from '@/lib/i18n';

type InferenceTab = 'overview' | 'routing' | 'byok' | 'reporting' | 'budgets';

/**
 * How Oxy serves this application: overview, routing policy and limits, provider
 * connections (BYOK), usage and spend, budgets.
 *
 * The two reporting tabs take the API's own permissions, `usage:read` for units and
 * `billing:read` for money, and each is offered only to a caller holding the one its
 * endpoint enforces, so nobody clicks into a guaranteed 403.
 */
export default function AppInferenceScreen() {
  const { t } = useTranslation();
  const { access } = useAppDetail();
  const [tab, setTab] = useState<InferenceTab>('overview');
  const showReporting = access.can('usage:read') || access.can('billing:read');
  const showBudgets = access.can('billing:read');

  return (
    <View className="gap-6">
      <Tabs
        value={tab}
        onValueChange={(value) => setTab(value as InferenceTab)}
        variant="pill"
        label={t('appsInference.tabs.label')}
      >
        <TabsTrigger
          value="overview"
          label={t('appsInference.tabs.overview')}
          leadingIcon={RiSparklingLine}
        />
        <TabsTrigger
          value="routing"
          label={t('appsInference.tabs.routing')}
          leadingIcon={RiRouteLine}
        />
        <TabsTrigger value="byok" label={t('appsInference.tabs.byok')} leadingIcon={RiCloudLine} />
        {showReporting && (
          <TabsTrigger
            value="reporting"
            label={t('appsInference.tabs.reporting')}
            leadingIcon={RiLineChartLine}
          />
        )}
        {showBudgets && (
          <TabsTrigger
            value="budgets"
            label={t('appsInference.tabs.budgets')}
            leadingIcon={RiEqualizerLine}
          />
        )}
      </Tabs>

      {tab === 'overview' && <InferenceOverview />}
      {tab === 'routing' && (
        <>
          <RoutingPolicy />
          <InferenceLimits />
        </>
      )}
      {tab === 'byok' && <ProviderConnections />}
      {tab === 'reporting' && showReporting && <UsageSpend />}
      {tab === 'budgets' && showBudgets && <ApplicationBudgets />}
    </View>
  );
}
