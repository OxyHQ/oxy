import { useState } from 'react';
import { View } from 'react-native';
import { RiCloudLine } from '@oxy.so/bloom/icons/RiCloudLine';
import { RiEqualizerLine } from '@oxy.so/bloom/icons/RiEqualizerLine';
import { RiLineChartLine } from '@oxy.so/bloom/icons/RiLineChartLine';
import { RiRouteLine } from '@oxy.so/bloom/icons/RiRouteLine';
import { RiSparklingLine } from '@oxy.so/bloom/icons/RiSparklingLine';
import { Tabs, TabsTrigger } from '@oxy.so/bloom/tabs';
import { ApplicationBudgetsSection } from '@/components/apps-inference/application-budgets-section';
import { ApplicationUsageSpendSection } from '@/components/apps-inference/application-usage-spend-section';
import { InferenceLimitsSection } from '@/components/apps-inference/inference-limits-section';
import { InferenceOverviewSection } from '@/components/apps-inference/inference-overview-section';
import { ProviderConnectionsSection } from '@/components/apps-inference/provider-connections-section';
import { RoutingPolicySection } from '@/components/apps-inference/routing-policy-section';
import { useAppDetail } from '@/components/apps/app-context';
import { useTranslation } from '@/lib/i18n';

type InferenceTab = 'overview' | 'routing' | 'byok' | 'reporting' | 'budgets';

/**
 * The application's inference configuration and its reporting: overview, routing
 * policy, BYOK, usage and spend, limits and budgets.
 *
 * A section of its own rather than more tabs under Settings, because these are
 * about how Oxy SERVES this application rather than about what the application IS.
 * Reaching it needs `app:read`, which is what the routes behind the configuration
 * tabs gate their reads on.
 *
 * The two reporting tabs take their own permissions, which is the API's split
 * rather than this page's: `usage:read` to see units, `billing:read` to see money.
 * Offering a tab to somebody the API would refuse turns a guaranteed 403 into an
 * error after a click, so each is shown only to a caller holding the right the
 * endpoint behind it enforces.
 */
export default function AppInferenceScreen() {
  const { t } = useTranslation();
  const { application, access } = useAppDetail();
  const [tab, setTab] = useState<InferenceTab>('overview');
  const showReporting = access.can('usage:read') || access.can('billing:read');
  const showBudgets = access.can('billing:read');

  return (
    <View className="gap-6">
      <Tabs
        value={tab}
        onValueChange={(value) => setTab(value as InferenceTab)}
        variant="underline"
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

      {tab === 'overview' && <InferenceOverviewSection application={application} access={access} />}
      {tab === 'routing' && (
        <View className="gap-10">
          <RoutingPolicySection application={application} access={access} />
          <InferenceLimitsSection application={application} access={access} />
        </View>
      )}
      {tab === 'byok' && <ProviderConnectionsSection application={application} access={access} />}
      {tab === 'reporting' && showReporting && (
        <ApplicationUsageSpendSection application={application} access={access} />
      )}
      {tab === 'budgets' && showBudgets && (
        <ApplicationBudgetsSection application={application} access={access} />
      )}
    </View>
  );
}
