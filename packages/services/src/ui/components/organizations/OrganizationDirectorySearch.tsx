import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { ActivityIndicator, View } from 'react-native';
import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import type { Organization, OrganizationType } from '@oxy.so/contracts';
import {
  createOrganizationCheck,
  organizationClaimInputCheck,
  parseContract,
  checkContract,
} from '@oxy.so/contracts/client';
import { Avatar } from '@oxy.so/bloom/avatar';
import { Button } from '@oxy.so/bloom/button';
import { SettingsListGroup, SettingsListItem } from '@oxy.so/bloom/settings-list';
import { TextField, TextFieldInput } from '@oxy.so/bloom/text-field';
import { Text } from '@oxy.so/bloom/typography';
import { useOxy } from '../../context/oxyRuntimeContext';
import { useI18n } from '../../hooks/useI18n';
import { useOxyRuntime } from '../../runtime/runtimeContext';
import { OrganizationTypePicker } from './OrganizationTypePicker';

/** Finding an existing identity never grants ownership or silently creates an account. */
export function OrganizationDirectorySearch({
  onCreateAccount,
}: {
  onCreateAccount: (name: string, type: OrganizationType) => void;
}) {
  const runtime = useOxyRuntime();
  const { oxyServices } = useOxy();
  // Revisions are local to each instance, so equal counters do not identify a
  // replacement provider. React retries this render before committing it.
  const [instance, setInstance] = useState(() => ({ runtime, oxyServices, generation: 0 }));
  let instanceGeneration = instance.generation;
  if (instance.runtime !== runtime || instance.oxyServices !== oxyServices) {
    instanceGeneration += 1;
    setInstance({ runtime, oxyServices, generation: instanceGeneration });
  }
  const revision = useSyncExternalStore(
    runtime.subscribe,
    runtime.getAccountSessionRevision,
    runtime.getAccountSessionRevision,
  );
  const subscribeBearer = useCallback(
    (notify: () => void) => oxyServices.session.onChange(notify),
    [oxyServices],
  );
  const getBearerEpoch = useCallback(() => oxyServices.http.getSessionEpoch(), [oxyServices]);
  const bearerEpoch = useSyncExternalStore(subscribeBearer, getBearerEpoch, getBearerEpoch);
  return (
    <OrganizationDirectorySearchContent
      key={`${instanceGeneration}:${revision}:${bearerEpoch}`}
      revision={revision}
      bearerEpoch={bearerEpoch}
      onCreateAccount={onCreateAccount}
    />
  );
}

function OrganizationDirectorySearchContent({
  onCreateAccount,
  revision,
  bearerEpoch,
}: {
  onCreateAccount: (name: string, type: OrganizationType) => void;
  revision: number;
  bearerEpoch: number;
}) {
  const runtime = useOxyRuntime();
  const { oxyServices, user, activeSessionId, canUsePrivateApi } = useOxy();
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
  const lifecycle = useRef({ active: false });
  const pending = useRef<{ claim: object | null; create: object | null }>({
    claim: null,
    create: null,
  });
  const operations = useRef(
    new WeakMap<
      object,
      {
        identity: ReturnType<typeof runtime.getAccountSessionIdentity>;
        bearerEpoch: number;
        accountId?: string;
        evidence?: string;
        name?: string;
        type?: OrganizationType;
      }
    >(),
  );

  useEffect(() => {
    lifecycle.current.active = true;
    return () => {
      lifecycle.current.active = false;
    };
  }, []);

  function currentOwner(
    operation: NonNullable<ReturnType<typeof operations.current.get>>,
  ): boolean {
    const current = runtime.getAccountSessionIdentity();
    const subject = oxyServices.session.userId;
    return (
      oxyServices.http.getSessionEpoch() === operation.bearerEpoch &&
      current.revision === operation.identity.revision &&
      current.accountId === operation.identity.accountId &&
      current.sessionId === operation.identity.sessionId &&
      !!oxyServices.session.accessToken &&
      (subject === null || subject === current.accountId)
    );
  }

  function capture(input: {
    accountId?: string;
    evidence?: string;
    name?: string;
    type?: OrganizationType;
  }): object {
    const key = {};
    const identity = runtime.getAccountSessionIdentity();
    if (
      lifecycle.current.active &&
      personalReady &&
      identity.revision === revision &&
      oxyServices.http.getSessionEpoch() === bearerEpoch &&
      identity.accountId === user?.id &&
      identity.sessionId === activeSessionId
    ) {
      operations.current.set(key, {
        identity,
        bearerEpoch,
        ...input,
      });
    }
    return key;
  }
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
    // A lost response does not prove this non-idempotent claim was not sent.
    retry: false,
    mutationFn: (key: object) => {
      const operation = operations.current.get(key);
      if (!operation || !currentOwner(operation) || !operation.accountId || !operation.evidence)
        throw new Error('An active organization and personal session are required');
      return oxyServices.organizations.claim(
        operation.accountId,
        parseContract(organizationClaimInputCheck, { evidenceReference: operation.evidence }),
      );
    },
    onSuccess: (_result, key) => {
      const operation = operations.current.get(key);
      if (operation && currentOwner(operation))
        return queryClient.invalidateQueries({ queryKey: ['oxy', 'organizations'] });
    },
    onSettled: (_result, _error, key) => {
      operations.current.delete(key);
      if (pending.current.claim === key) pending.current.claim = null;
    },
  });
  const create = useMutation({
    // The directory creation endpoint does not carry an idempotency key.
    retry: false,
    mutationFn: (key: object) => {
      const operation = operations.current.get(key);
      if (!operation || !currentOwner(operation)) throw new Error('A personal session is required');
      return oxyServices.organizations.create(
        parseContract(createOrganizationCheck, {
          name: operation.name,
          organizationType: operation.type,
        }),
      );
    },
    onSuccess: (organization, key) => {
      const operation = operations.current.get(key);
      if (!operation || !currentOwner(operation)) return;
      if (lifecycle.current.active) {
        setSelected(organization);
        setAdding(false);
      }
      void queryClient.invalidateQueries({ queryKey: ['oxy', 'organizations'] });
    },
    onSettled: (_result, _error, key) => {
      operations.current.delete(key);
      if (pending.current.create === key) pending.current.create = null;
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
                  onPress={() => {
                    if (pending.current.claim) return;
                    const key =
                      selected.status === 'active'
                        ? capture({ accountId: selected.accountId, evidence })
                        : {};
                    pending.current.claim = key;
                    try {
                      claim.mutate(key);
                    } catch (error) {
                      pending.current.claim = null;
                      operations.current.delete(key);
                      throw error;
                    }
                  }}
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
          <Button
            onPress={() => {
              if (
                lifecycle.current.active &&
                runtime.getAccountSessionRevision() === revision &&
                oxyServices.http.getSessionEpoch() === bearerEpoch
              )
                onCreateAccount(search.trim(), type);
            }}
          >
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
                checkContract(createOrganizationCheck, {
                  name: search.trim(),
                  organizationType: type,
                }) === null
              ) {
                setValidationError(true);
                return;
              }
              if (pending.current.create) return;
              const key = capture({ name: search.trim(), type });
              pending.current.create = key;
              try {
                create.mutate(key);
              } catch (error) {
                pending.current.create = null;
                operations.current.delete(key);
                throw error;
              }
            }}
          >
            {t('organizationDirectory.addDirectory')}
          </Button>
        </>
      ) : null}
    </View>
  );
}
