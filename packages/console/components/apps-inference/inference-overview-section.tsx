import { Text, View } from 'react-native';
import * as Skeleton from '@oxy.so/bloom/skeleton';
import type { Application, CallerAccess } from '@/hooks/use-applications';
import { useAccount } from '@/hooks/use-account';
import { useModelCatalogue } from '@/hooks/use-models';
import { useEffectiveRoutingPolicy } from '@/hooks/use-routing-policy';
import { useAccountProviderConnections } from '@/hooks/use-provider-connections';
import { useTranslation } from '@/lib/i18n';
import { connectionAppliesToApplication } from '@/lib/provider-connection';
import { effectivePolicyOrigin } from '@/lib/routing-policy';
import { InferenceAvailabilityNotice } from '@/components/inference-availability-notice';
import { Notice, Panel, Pill, SectionHeader } from './ui';

/**
 * What is actually true about inference for this application, right now.
 *
 * Every line reads a real API. Where an API does not exist yet the section says so
 * in one sentence rather than rendering an empty chart, because an empty chart and
 * "nothing is measured yet" look identical and only one of them is true.
 */
export function InferenceOverviewSection({
  application,
  access,
}: {
  application: Application;
  access: CallerAccess;
}) {
  const { t } = useTranslation();
  const { accounts, canReadAccount } = useAccount();
  const ownerAccountId = application.ownerAccountId;
  const ownerAccount = accounts.find((account) => account.accountId === ownerAccountId);
  // Through the predicate rather than comparing the raw `permissions` array: that
  // field is `string[]` on the wire, so an inline `includes('account:raed')` is
  // neither a compile error nor something the permission-vocabulary gate can see.
  const canReadOwnerAccount = ownerAccount !== undefined && canReadAccount(ownerAccount);

  const { data: catalogue = [], isLoading: isCatalogueLoading } = useModelCatalogue();
  const { data: policy, isLoading: isPolicyLoading } = useEffectiveRoutingPolicy(
    application._id,
    access.can('app:read'),
  );
  const { data: connections = [] } = useAccountProviderConnections(
    ownerAccountId,
    canReadOwnerAccount,
  );

  const liveConnections = connections
    .filter((connection) =>
      connectionAppliesToApplication(connection, application._id, ownerAccountId),
    )
    .filter(
      (connection) => connection.status === 'active' || connection.status === 'pending_validation',
    );

  const hasPolicy = policy !== null && policy !== undefined;

  return (
    <View className="gap-6">
      <SectionHeader
        title={t('appsInference.overview.title')}
        description={t('appsInference.overview.description')}
      />

      <InferenceAvailabilityNotice />

      <View className="flex-row flex-wrap gap-3">
        <SummaryCard
          label={t('appsInference.overview.models.label')}
          isLoading={isCatalogueLoading}
          value={String(catalogue.length)}
          detail={
            catalogue.length === 0
              ? t('appsInference.overview.models.empty')
              : t('appsInference.overview.models.published')
          }
        />
        <SummaryCard
          label={t('appsInference.overview.policy.label')}
          isLoading={isPolicyLoading}
          value={
            !hasPolicy
              ? t('appsInference.overview.policy.none')
              : effectivePolicyOrigin(policy) === 'application'
                ? t('appsInference.overview.policy.application')
                : t('appsInference.overview.policy.inherited')
          }
          detail={
            !hasPolicy
              ? t('appsInference.overview.policy.noneDetail')
              : t('appsInference.overview.policy.detail', {
                  version: policy.policy.policyVersion,
                  optimiseFor: policy.policy.optimiseFor,
                })
          }
        />
        <SummaryCard
          label={t('appsInference.overview.credentials.label')}
          isLoading={false}
          value={String(liveConnections.length)}
          detail={
            !canReadOwnerAccount
              ? t('appsInference.overview.credentials.noAccess')
              : liveConnections.length === 0
                ? t('appsInference.overview.credentials.none')
                : t('appsInference.overview.credentials.live')
          }
        />
      </View>

      <Notice title={t('appsInference.overview.notReported.title')}>
        {t('appsInference.overview.notReported.body')}
      </Notice>

      {catalogue.length === 0 && (
        <Panel className="px-4 py-3">
          <View className="flex-row items-center gap-2">
            <Pill label={t('appsInference.overview.catalogueEmpty.badge')} tone="outline" />
            <Text className="text-sm text-foreground">
              {t('appsInference.overview.catalogueEmpty.title')}
            </Text>
          </View>
          <Text className="mt-1 text-sm text-muted-foreground">
            {t('appsInference.overview.catalogueEmpty.body')}
          </Text>
        </Panel>
      )}
    </View>
  );
}

function SummaryCard({
  label,
  value,
  detail,
  isLoading,
}: {
  label: string;
  value: string;
  detail: string;
  isLoading: boolean;
}) {
  return (
    <Panel className="min-w-48 flex-1 px-4 py-3">
      <Text className="text-xs text-muted-foreground">{label}</Text>
      {isLoading ? (
        <View className="mt-1">
          <Skeleton.Box width={80} height={28} />
        </View>
      ) : (
        <Text className="mt-0.5 text-xl font-semibold text-foreground">{value}</Text>
      )}
      <Text className="mt-1 text-xs text-muted-foreground">{detail}</Text>
    </Panel>
  );
}
