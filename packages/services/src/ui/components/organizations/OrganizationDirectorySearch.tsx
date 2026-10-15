import { useEffect, useState } from 'react';
import { ActivityIndicator, View } from 'react-native';
import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  createOrganizationSchema,
  organizationClaimInputSchema,
  type Organization,
  type OrganizationType,
} from '@oxy.so/contracts';
import { Avatar } from '@oxy.so/bloom/avatar';
import { Button } from '@oxy.so/bloom/button';
import { SettingsListGroup, SettingsListItem } from '@oxy.so/bloom/settings-list';
import { TextField, TextFieldInput } from '@oxy.so/bloom/text-field';
import { Text } from '@oxy.so/bloom/typography';
import { useOxy } from '../../context/OxyContext';
import { useI18n } from '../../hooks/useI18n';
import { OrganizationTypePicker } from './OrganizationTypePicker';

/** Finding an existing identity never grants ownership or silently creates an account. */
export function OrganizationDirectorySearch({
  onCreateAccount,
}: {
  onCreateAccount: (name: string, type: OrganizationType) => void;
}) {
  const { oxyServices, user, canUsePrivateApi } = useOxy();
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<Organization | null>(null);
  const [adding, setAdding] = useState(false);
  const [type, setType] = useState<OrganizationType>('business');
  const [evidence, setEvidence] = useState('');
  const [validationError, setValidationError] = useState(false);
  const personalReady = canUsePrivateApi && user?.kind === 'personal';
  useEffect(() => {
    const timer = setTimeout(() => setQuery(search.trim()), 300);
    return () => clearTimeout(timer);
  }, [search]);
  const results = useInfiniteQuery({
    queryKey: ['oxy', 'organizations', 'search', query],
    queryFn: ({ pageParam }) =>
      oxyServices.organizations.search({
        query,
        limit: 20,
        ...(pageParam ? { cursor: pageParam } : {}),
      }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    enabled: query.length > 0,
    retry: false,
  });
  const claim = useMutation({
    mutationFn: () => {
      if (!personalReady || !selected || selected.status !== 'active')
        throw new Error('An active organization and personal session are required');
      return oxyServices.organizations.claim(
        selected.accountId,
        organizationClaimInputSchema.parse({ evidenceReference: evidence }),
      );
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['oxy', 'organizations'] }),
  });
  const create = useMutation({
    mutationFn: () => {
      if (!personalReady) throw new Error('A personal session is required');
      return oxyServices.organizations.create(
        createOrganizationSchema.parse({ name: search.trim(), organizationType: type }),
      );
    },
    onSuccess: (organization) => {
      setSelected(organization);
      setAdding(false);
      void queryClient.invalidateQueries({ queryKey: ['oxy', 'organizations'] });
    },
  });
  const reset = () => {
    setSelected(null);
    setAdding(false);
    setEvidence('');
    claim.reset();
    create.reset();
    setValidationError(false);
  };
  if (selected)
    return (
      <SettingsListGroup title={selected.name}>
        <View className="gap-space-16 p-space-16">
          <Text>{t(`organizationDirectory.${selected.claimStatus}`)}</Text>
          {selected.status === 'inactive' ? (
            <Text>{t('organizationDirectory.inactive')}</Text>
          ) : null}
          {selected.claimStatus === 'unclaimed' ? (
            <>
              <Text>{t('organizationDirectory.claimHint')}</Text>
              <TextField>
                <TextFieldInput
                  label={t('organizationDirectory.evidence')}
                  value={evidence}
                  onChangeText={setEvidence}
                  maxLength={1000}
                />
              </TextField>
              <Text>{t('organizationDirectory.evidenceHint')}</Text>
              {claim.isSuccess ? (
                <Text accessibilityRole="alert">{t('organizationDirectory.claimSent')}</Text>
              ) : (
                <Button
                  onPress={() => claim.mutate()}
                  disabled={
                    !personalReady ||
                    selected.status !== 'active' ||
                    !evidence.trim() ||
                    claim.isPending
                  }
                  loading={claim.isPending}
                >
                  {t('organizationDirectory.claim')}
                </Button>
              )}
              {claim.isError ? (
                <Text accessibilityRole="alert">{t('organizationDirectory.claimFailed')}</Text>
              ) : null}
            </>
          ) : (
            <Text>{t('organizationDirectory.claimedHint')}</Text>
          )}
          <Button appearance="outline" onPress={reset} disabled={claim.isPending}>
            {t('organizationDirectory.back')}
          </Button>
        </View>
      </SettingsListGroup>
    );
  return (
    <View className="gap-space-16">
      <Text>{t('organizationDirectory.searchHint')}</Text>
      <TextField>
        <TextFieldInput
          label={t('organizationDirectory.search')}
          value={search}
          onChangeText={(value) => {
            setSearch(value);
            setValidationError(false);
          }}
          maxLength={200}
        />
      </TextField>
      {query && results.isPending ? <ActivityIndicator /> : null}
      {results.isError ? (
        <View>
          <Text accessibilityRole="alert">{t('organizationDirectory.failed')}</Text>
          <Button onPress={() => results.refetch()}>{t('organizationDirectory.retry')}</Button>
        </View>
      ) : null}
      {results.data ? (
        <SettingsListGroup title={t('organizationDirectory.title')}>
          {results.data.pages
            .flatMap((page) => page.items)
            .map((organization) => (
              <SettingsListItem
                key={organization.accountId}
                title={organization.name}
                description={[
                  organization.websiteUrl,
                  organization.countryCode,
                  t(`organizationDirectory.${organization.claimStatus}`),
                ]
                  .filter(Boolean)
                  .join(' · ')}
                icon={<Avatar source={organization.avatar} name={organization.name} size={40} />}
                onPress={() => setSelected(organization)}
              />
            ))}
          {results.data.pages[0].items.length === 0 ? (
            <Text>{t('organizationDirectory.empty')}</Text>
          ) : null}
          {results.hasNextPage ? (
            <Button onPress={() => results.fetchNextPage()} disabled={results.isFetchingNextPage}>
              {t('organizationDirectory.loadMore')}
            </Button>
          ) : null}
        </SettingsListGroup>
      ) : null}
      {results.isSuccess && query === search.trim() ? (
        <>
          <Text>{t('organizationDirectory.newAccountHint')}</Text>
          <Button onPress={() => onCreateAccount(search.trim(), type)}>
            {t('organizationDirectory.newAccount')}
          </Button>
          {personalReady && !adding ? (
            <Button appearance="outline" onPress={() => setAdding(true)}>
              {t('organizationDirectory.addDirectory')}
            </Button>
          ) : null}
        </>
      ) : null}
      {adding ? (
        <>
          <Text>{t('organizationDirectory.directoryHint')}</Text>
          <OrganizationTypePicker value={type} onChange={setType} disabled={create.isPending} />
          {validationError ? (
            <Text accessibilityRole="alert">{t('organizationDirectory.invalid')}</Text>
          ) : null}
          {create.isError ? (
            <Text accessibilityRole="alert">{t('organizationDirectory.saveFailed')}</Text>
          ) : null}
          <Button
            disabled={
              !personalReady || create.isPending || !results.isSuccess || query !== search.trim()
            }
            loading={create.isPending}
            onPress={() => {
              if (
                !createOrganizationSchema.safeParse({ name: search.trim(), organizationType: type })
                  .success
              ) {
                setValidationError(true);
                return;
              }
              create.mutate();
            }}
          >
            {t('organizationDirectory.addDirectory')}
          </Button>
        </>
      ) : null}
    </View>
  );
}
