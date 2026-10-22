import { Text, View } from 'react-native';
import { Admonition } from '@oxy.so/bloom/admonition';
import { Badge } from '@oxy.so/bloom/badge';
import { Card, CardBody, CardDescription, CardHeader, CardTitle } from '@oxy.so/bloom/card';
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
      <View>
        <CardTitle>{t('appsInference.overview.title')}</CardTitle>
        <CardDescription>{t('appsInference.overview.description')}</CardDescription>
      </View>

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

      <Admonition type="info">
        <Text className="font-semibold">{t('appsInference.overview.notReported.title')}</Text>
        {`\n${t('appsInference.overview.notReported.body')}`}
      </Admonition>

      {catalogue.length === 0 && (
        <Card appearance="outline" radius="radius-16">
          <CardHeader>
            <View className="flex-row items-center gap-2">
              <Badge
                content={t('appsInference.overview.catalogueEmpty.badge')}
                variant="outlined"
                size="label-small"
              />
              <CardTitle>{t('appsInference.overview.catalogueEmpty.title')}</CardTitle>
            </View>
          </CardHeader>
          <CardBody>
            <CardDescription>{t('appsInference.overview.catalogueEmpty.body')}</CardDescription>
          </CardBody>
        </Card>
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
    <Card appearance="outline" radius="radius-16" className="min-w-48 flex-1">
      <CardHeader>
        <CardDescription>{label}</CardDescription>
      </CardHeader>
      <CardBody>
        {isLoading ? <Skeleton.Box width={80} height={28} /> : <CardTitle>{value}</CardTitle>}
      </CardBody>
      <CardBody>
        <CardDescription>{detail}</CardDescription>
      </CardBody>
    </Card>
  );
}
