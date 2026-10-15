import { View } from 'react-native';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { Button } from '@oxy.so/bloom/button';
import { SettingsListGroup, SettingsListItem } from '@oxy.so/bloom/settings-list';
import { Text } from '@oxy.so/bloom/typography';
import { useOxy } from '../../context/OxyContext';
import { useI18n } from '../../hooks/useI18n';

export function OrganizationClaims() {
  const { oxyServices, user, canUsePrivateApi } = useOxy();
  const { t } = useI18n();
  const enabled = canUsePrivateApi && user?.kind === 'personal';
  const requests = useInfiniteQuery({
    queryKey: ['oxy', 'organizations', 'claims', user?.id, canUsePrivateApi],
    queryFn: ({ pageParam }) =>
      oxyServices.organizations.myClaims({
        limit: 20,
        ...(pageParam ? { cursor: pageParam } : {}),
      }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    enabled,
    retry: false,
    gcTime: 0,
  });
  const claims = requests.data?.pages.flatMap((page) => page.items) ?? [];
  const ids = [...new Set(claims.map((claim) => claim.accountId))].sort();
  const organizations = useQuery({
    queryKey: ['oxy', 'organizations', 'claims-employers', ids],
    queryFn: async () => {
      const batches = [];
      for (let offset = 0; offset < ids.length; offset += 100)
        batches.push(oxyServices.organizations.batch({ ids: ids.slice(offset, offset + 100) }));
      return (await Promise.all(batches)).flatMap((batch) => batch.items);
    },
    enabled: enabled && ids.length > 0,
    retry: false,
  });
  if (!enabled || (!requests.isError && claims.length === 0)) return null;
  return (
    <SettingsListGroup title={t('organizationDirectory.requests')}>
      {requests.isError ? (
        <View>
          <Text accessibilityRole="alert">{t('organizationDirectory.requestError')}</Text>
          <Button onPress={() => requests.refetch()}>{t('organizationDirectory.retry')}</Button>
        </View>
      ) : null}
      {!requests.isError &&
        claims.map((claim) => (
          <SettingsListItem
            key={claim.id}
            title={
              organizations.data?.find((item) => item.requestedAccountId === claim.accountId)
                ?.organization.name ?? t('organizationDirectory.view')
            }
            description={t(`organizationDirectory.${claim.status}`)}
            showChevron={false}
          />
        ))}
      {requests.hasNextPage ? (
        <Button onPress={() => requests.fetchNextPage()} disabled={requests.isFetchingNextPage}>
          {t('organizationDirectory.loadMore')}
        </Button>
      ) : null}
    </SettingsListGroup>
  );
}
