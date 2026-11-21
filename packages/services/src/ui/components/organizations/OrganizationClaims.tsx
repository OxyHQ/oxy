import { View } from 'react-native';
import { skip, useEntity, useList } from '@oxy.so/bloom-data';
import { Button } from '@oxy.so/bloom/button';
import { GroupedSection, GroupedSectionItem } from '@oxy.so/bloom/grouped-section';
import { Text } from '@oxy.so/bloom/typography';
import { useOxy } from '../../context/oxyRuntimeContext';
import { useI18n } from '../../hooks/useI18n';
import { useAnswer } from '../../data/answer';
import {
  myOrganizationClaims,
  Organization,
  OrganizationClaim,
  organizationsByAccount,
} from '../../data/organizations';

export function OrganizationClaims() {
  const { oxyServices, user, canUsePrivateApi } = useOxy();
  const { t } = useI18n();
  const enabled = canUsePrivateApi && user?.kind === 'personal';
  const requests = useList(
    myOrganizationClaims,
    ...(enabled && user ? ([oxyServices, user.id] as const) : ([skip] as const)),
  );
  const ids = [...new Set(requests.extra ?? [])].sort();
  const organizations = useAnswer(
    organizationsByAccount,
    ...(enabled && ids.length > 0 ? ([oxyServices, ids] as const) : ([skip] as const)),
  );
  const failed = requests.status === 'error';
  if (!enabled || (!failed && requests.ids.length === 0)) return null;
  return (
    <GroupedSection title={t('organizationDirectory.requests')}>
      {failed ? (
        <View>
          <Text accessibilityRole="alert">{t('organizationDirectory.requestError')}</Text>
          <Button onPress={() => requests.refresh()}>{t('organizationDirectory.retry')}</Button>
        </View>
      ) : null}
      {!failed &&
        requests.ids.map((id) => (
          <ClaimRow key={id} claimId={id} organizations={organizations.value} />
        ))}
      {!failed && requests.hasMore ? (
        <Button onPress={() => requests.more()} disabled={requests.isFetching}>
          {t('organizationDirectory.loadMore')}
        </Button>
      ) : null}
    </GroupedSection>
  );
}

function ClaimRow({
  claimId,
  organizations,
}: {
  claimId: string;
  organizations: Readonly<Record<string, string>> | undefined;
}) {
  const { t } = useI18n();
  const claim = useEntity(OrganizationClaim, claimId);
  const organization = useEntity(Organization, claim && organizations?.[claim.accountId]);
  if (!claim) return null;
  return (
    <GroupedSectionItem
      title={organization?.name ?? t('organizationDirectory.view')}
      description={t(`organizationDirectory.${claim.status}`)}
      showChevron={false}
    />
  );
}
