import React, { useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  TextInput,
  View,
  useWindowDimensions,
} from 'react-native';
import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';
import { useQuery } from '@tanstack/react-query';
import { alert, toast } from '@oxyhq/bloom';
import { useOxy } from '@oxyhq/services';
import type { AutonomyLevel, CapabilityPackage, GrantLimit } from '@oxyhq/contracts';
import type { AvailableCapabilityCatalog, DelegationGrantView } from '@oxyhq/core';
import { AccountCard, EmptyStateCard, ScreenHeader } from '@/components/ui';
import { ScreenContentWrapper } from '@/components/screen-content-wrapper';
import { Section } from '@/components/section';
import { ThemedText } from '@/components/themed-text';
import { useColors } from '@/hooks/useColors';
import { useTranslation } from '@/lib/i18n';
import {
  useAgencySettings,
  useCreateDelegationGrant,
  useDeleteAccountCapabilityPolicy,
  usePutAccountCapabilityPolicy,
  useRevokeDelegationGrant,
  useRevokeExecutionAuthorization,
  useUpdateDelegationGrant,
} from '@/hooks/useAgencySettings';

const AUTONOMY_LEVELS: readonly AutonomyLevel[] = [
  'read_only',
  'draft',
  'execute_on_request',
  'autonomous',
];

const CAPABILITY_PACKAGES: readonly CapabilityPackage[] = [
  'read',
  'create',
  'publish',
  'communicate',
  'administer',
  'finance',
  'security',
  'delegate',
];

function accountDisplayName(node: {
  accountId: string;
  account: { name?: { displayName?: string; full?: string }; username?: string };
}): string {
  return node.account.name?.displayName
    ?? node.account.name?.full
    ?? node.account.username
    ?? node.accountId;
}

function activeGrant(grant: DelegationGrantView, referenceTime: number): boolean {
  return grant.revokedAt === null && (!grant.expiresAt || new Date(grant.expiresAt).getTime() > referenceTime);
}

function TogglePill({
  active,
  label,
  onPress,
}: {
  active: boolean;
  label: string;
  onPress: () => void;
}) {
  const colors = useColors();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected: active }}
      onPress={onPress}
      style={[
        styles.pill,
        { borderColor: active ? colors.tint : colors.border },
        active && { backgroundColor: colors.tint },
      ]}
    >
      <ThemedText style={[styles.pillText, active && styles.activePillText]}>{label}</ThemedText>
    </Pressable>
  );
}

function ActionButton({
  destructive = false,
  disabled = false,
  label,
  onPress,
}: {
  destructive?: boolean;
  disabled?: boolean;
  label: string;
  onPress: () => void;
}) {
  const colors = useColors();
  return (
    <Pressable
      accessibilityRole="button"
      disabled={disabled}
      onPress={onPress}
      style={[
        styles.actionButton,
        { backgroundColor: destructive ? colors.error : colors.tint },
        disabled && styles.disabled,
      ]}
    >
      <ThemedText style={styles.actionButtonText}>{label}</ThemedText>
    </Pressable>
  );
}

function GrantComposer({
  accountId,
  bots,
  catalogs,
  grant,
  onDone,
}: {
  accountId: string;
  bots: { accountId: string; name: string }[];
  catalogs: AvailableCapabilityCatalog[];
  grant?: DelegationGrantView;
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const colors = useColors();
  const createGrant = useCreateDelegationGrant(accountId);
  const updateGrant = useUpdateDelegationGrant(accountId);
  const [actorAccountId, setActorAccountId] = useState(
    grant?.actor.type === 'agent' ? grant.actor.accountId : bots[0]?.accountId ?? '',
  );
  const [appId, setAppId] = useState(grant?.resource.appId ?? catalogs[0]?.appId ?? '');
  const [autonomy, setAutonomy] = useState<AutonomyLevel>(grant?.maximumAutonomy ?? 'execute_on_request');
  const [packages, setPackages] = useState<CapabilityPackage[]>(grant?.capabilityPackages ?? ['read']);
  const [deniedTools, setDeniedTools] = useState<string[]>(
    grant?.toolOverrides.filter((override) => override.decision === 'deny').map((override) => override.tool) ?? [],
  );
  const [limitValues, setLimitValues] = useState<Record<string, string>>(() => {
    const values: Record<string, string> = {};
    for (const limit of grant?.limits ?? []) values[`${limit.tool}:${limit.key}`] = String(limit.value);
    return values;
  });

  const selectedCatalog = catalogs.find((catalog) => catalog.appId === appId) ?? null;
  const availableTools = selectedCatalog?.catalog.tools.filter((tool) =>
    tool.exposure.includes('internal') && tool.resourceTypes.includes(selectedCatalog.catalog.accountResourceType)) ?? [];
  const selectedTools = availableTools.filter((tool) => packages.includes(tool.capabilityPackage));
  const enabledTools = selectedTools.filter((tool) => !deniedTools.includes(tool.name));
  const capabilities = [...new Set(enabledTools.flatMap((tool) => tool.requiredCapabilities))];
  const limitDefinitions = enabledTools.flatMap((tool) => tool.limitKeys.map((limit) => ({
    tool: tool.name,
    key: limit.key,
    kind: limit.kind,
  })));
  const missingSensitiveLimits = autonomy === 'autonomous' && enabledTools.some((tool) => {
    if (tool.effect !== 'financial' && tool.effect !== 'security') return false;
    if (tool.limitKeys.length === 0) return true;
    return tool.limitKeys.some((limit) => {
      const raw = limitValues[`${tool.name}:${limit.key}`];
      return raw === undefined || raw === '';
    });
  });

  const togglePackage = (capabilityPackage: CapabilityPackage) => {
    setPackages((current) => current.includes(capabilityPackage)
      ? current.filter((entry) => entry !== capabilityPackage)
      : [...current, capabilityPackage]);
  };

  const toggleDeniedTool = (toolName: string) => {
    setDeniedTools((current) => current.includes(toolName)
      ? current.filter((entry) => entry !== toolName)
      : [...current, toolName]);
  };

  const submit = () => {
    if (!selectedCatalog || !actorAccountId || capabilities.length === 0) return;
    const limits: GrantLimit[] = [];
    for (const definition of limitDefinitions) {
      const raw = limitValues[`${definition.tool}:${definition.key}`];
      if (raw === undefined || raw === '') continue;
      if (definition.kind === 'exact_boolean') {
        limits.push({ tool: definition.tool, key: definition.key, value: raw === 'true' });
        continue;
      }
      const value = Number(raw);
      if (Number.isFinite(value)) limits.push({ tool: definition.tool, key: definition.key, value });
    }
    const authority = {
      capabilityPackages: packages,
      capabilities,
      toolOverrides: deniedTools.map((tool) => ({ tool, decision: 'deny' as const })),
      maximumAutonomy: autonomy,
      canRedelegate: packages.includes('delegate') && capabilities.includes('access.delegate'),
      limits,
      expiresAt: grant?.expiresAt ?? null,
    };
    const callbacks = {
      onSuccess: () => {
        toast.success(t(grant ? 'agency.grantUpdated' : 'agency.grantCreated'));
        onDone();
      },
      onError: (error: unknown) => toast.error(error instanceof Error ? error.message : t('agency.saveFailed')),
    };
    if (grant) {
      updateGrant.mutate({ grantId: grant.id, input: authority }, callbacks);
      return;
    }
    createGrant.mutate({
      ownerAccountId: accountId,
      actorAccountId,
      resource: {
        appId: selectedCatalog.appId,
        effectiveAccountId: accountId,
        resourceType: selectedCatalog.catalog.accountResourceType,
        resourceId: accountId,
      },
      ...authority,
    }, callbacks);
  };

  return (
    <AccountCard>
      <View style={styles.cardContent}>
        <ThemedText style={styles.cardTitle}>{t(grant ? 'agency.editGrant' : 'agency.newGrant')}</ThemedText>
        <ThemedText style={styles.label}>{t('agency.agent')}</ThemedText>
        <View style={styles.wrapRow}>
          {bots.map((bot) => (
            <TogglePill
              key={bot.accountId}
              active={bot.accountId === actorAccountId}
              label={bot.name}
              onPress={() => {
                if (!grant) setActorAccountId(bot.accountId);
              }}
            />
          ))}
        </View>
        <ThemedText style={styles.label}>{t('agency.app')}</ThemedText>
        <View style={styles.wrapRow}>
          {catalogs.map((catalog) => (
            <TogglePill
              key={catalog.id}
              active={catalog.appId === appId}
              label={catalog.appId}
              onPress={() => {
                if (grant) return;
                setAppId(catalog.appId);
                setDeniedTools([]);
              }}
            />
          ))}
        </View>
        <ThemedText style={styles.label}>{t('agency.capabilityPackages')}</ThemedText>
        <View style={styles.wrapRow}>
          {CAPABILITY_PACKAGES.map((capabilityPackage) => (
            <TogglePill
              key={capabilityPackage}
              active={packages.includes(capabilityPackage)}
              label={t(`agency.packages.${capabilityPackage}`)}
              onPress={() => togglePackage(capabilityPackage)}
            />
          ))}
        </View>
        {selectedTools.length > 0 && (
          <>
            <ThemedText style={styles.label}>{t('agency.toolExceptions')}</ThemedText>
            <ThemedText style={styles.hint}>{t('agency.toolExceptionsHint')}</ThemedText>
            <View style={styles.wrapRow}>
              {selectedTools.map((tool) => (
                <TogglePill
                  key={tool.name}
                  active={!deniedTools.includes(tool.name)}
                  label={tool.name}
                  onPress={() => toggleDeniedTool(tool.name)}
                />
              ))}
            </View>
          </>
        )}
        {limitDefinitions.length > 0 && (
          <>
            <ThemedText style={styles.label}>{t('agency.limits')}</ThemedText>
            <ThemedText style={styles.hint}>{t('agency.limitsHint')}</ThemedText>
            {limitDefinitions.map((definition) => {
              const id = `${definition.tool}:${definition.key}`;
              return (
                <View key={id} style={styles.limitRow}>
                  <ThemedText style={styles.meta}>{definition.tool} · {definition.key}</ThemedText>
                  {definition.kind === 'exact_boolean' ? (
                    <View style={styles.wrapRow}>
                      {['', 'true', 'false'].map((value) => (
                        <TogglePill
                          key={value || 'unset'}
                          active={(limitValues[id] ?? '') === value}
                          label={value === '' ? t('agency.noLimit') : t(`common.${value === 'true' ? 'yes' : 'no'}`)}
                          onPress={() => setLimitValues((current) => ({ ...current, [id]: value }))}
                        />
                      ))}
                    </View>
                  ) : (
                    <TextInput
                      accessibilityLabel={`${definition.tool} ${definition.key}`}
                      keyboardType="numeric"
                      onChangeText={(value) => setLimitValues((current) => ({ ...current, [id]: value }))}
                      placeholder={t('agency.noLimit')}
                      placeholderTextColor={colors.textSecondary}
                      style={[styles.limitInput, { borderColor: colors.border, color: colors.text }]}
                      value={limitValues[id] ?? ''}
                    />
                  )}
                </View>
              );
            })}
          </>
        )}
        <ThemedText style={styles.label}>{t('agency.maximumAutonomy')}</ThemedText>
        <View style={styles.wrapRow}>
          {AUTONOMY_LEVELS.map((level) => (
            <TogglePill
              key={level}
              active={level === autonomy}
              label={t(`agency.autonomy.${level}`)}
              onPress={() => setAutonomy(level)}
            />
          ))}
        </View>
        {missingSensitiveLimits && (
          <ThemedText style={[styles.hint, { color: colors.error }]}>{t('agency.sensitiveLimitsRequired')}</ThemedText>
        )}
        <View style={styles.actionRow}>
          <ActionButton label={t('common.cancel')} onPress={onDone} />
          <ActionButton
            disabled={!selectedCatalog || !actorAccountId || capabilities.length === 0 || missingSensitiveLimits || createGrant.isPending || updateGrant.isPending}
            label={createGrant.isPending || updateGrant.isPending ? t('common.loading') : t('common.save')}
            onPress={submit}
          />
        </View>
      </View>
    </AccountCard>
  );
}

export default function AgencySettingsScreen() {
  const colors = useColors();
  const { width } = useWindowDimensions();
  const isDesktop = Platform.OS === 'web' && width >= 768;
  const { t } = useTranslation();
  const { oxyServices, user } = useOxy();
  const [selectedAccountId, setSelectedAccountId] = useState<string | null>(null);
  const [composerGrantId, setComposerGrantId] = useState<string | 'new' | null>(null);
  const [renderReferenceTime] = useState(() => Date.now());

  const accountsQuery = useQuery({
    queryKey: ['agency-settings', 'accounts', user?.id ?? null],
    enabled: Boolean(user?.id),
    queryFn: () => oxyServices.listAccounts(),
    staleTime: 60_000,
  });
  const accounts = useMemo(() => accountsQuery.data ?? [], [accountsQuery.data]);
  const accountId = selectedAccountId ?? user?.id ?? null;
  const settings = useAgencySettings(accountId);
  const revokeGrant = useRevokeDelegationGrant(accountId ?? '');
  const revokeAuthorization = useRevokeExecutionAuthorization(accountId ?? '');
  const putPolicy = usePutAccountCapabilityPolicy(accountId ?? '');
  const deletePolicy = useDeleteAccountCapabilityPolicy(accountId ?? '');

  const bots = useMemo(() => accounts
    .filter((node) => node.kind === 'bot')
    .map((node) => ({
      accountId: node.accountId,
      name: accountDisplayName(node),
    })), [accounts]);
  const accountName = (id: string) => {
    const node = accounts.find((entry) => entry.accountId === id);
    return node ? accountDisplayName(node) : id;
  };
  const data = settings.data;
  const liveGrants = data?.grants.filter((grant) => activeGrant(grant, renderReferenceTime)) ?? [];
  const liveAuthorizations = data?.authorizations.filter((authorization) =>
    authorization.revokedAt === null && new Date(authorization.expiresAt).getTime() > renderReferenceTime) ?? [];

  const confirmRevokeGrant = (grant: DelegationGrantView) => {
    alert(t('agency.revokeGrantTitle'), t('agency.revokeGrantMessage'), [
      { text: t('common.cancel'), style: 'cancel' },
      {
        text: t('agency.revoke'),
        style: 'destructive',
        onPress: () => revokeGrant.mutate(grant.id, {
          onSuccess: () => toast.success(t('agency.revoked')),
          onError: (error: unknown) => toast.error(error instanceof Error ? error.message : t('agency.saveFailed')),
        }),
      },
    ]);
  };

  const renderContent = () => {
    if (accountsQuery.isLoading || settings.isLoading) {
      return <ActivityIndicator size="large" color={colors.tint} style={styles.loader} />;
    }
    if (accountsQuery.error || settings.error || !accountId || !data) {
      const error = accountsQuery.error ?? settings.error;
      return (
        <EmptyStateCard
          icon="alert-circle-outline"
          title={t('agency.loadFailed')}
          subtitle={error instanceof Error ? error.message : t('common.error')}
        />
      );
    }

    return (
      <>
        <Section title={t('agency.account')} isFirst>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.accountSelector}>
            {accounts.filter((node) => node.kind !== 'bot').map((node) => (
              <TogglePill
                key={node.accountId}
                active={node.accountId === accountId}
                label={accountDisplayName(node)}
                onPress={() => {
                  setSelectedAccountId(node.accountId);
                  setComposerGrantId(null);
                }}
              />
            ))}
          </ScrollView>
        </Section>

        <Section title={t('agency.appAutonomy')}>
          <ThemedText style={styles.sectionSubtitle}>{t('agency.appAutonomyHint')}</ThemedText>
          {data.catalogs.map((catalog) => {
            const policy = data.policies.find((entry) => entry.appSlug === catalog.appId);
            const current = policy?.maximumAutonomy ?? 'autonomous';
            const appCapabilities = [...new Set(catalog.catalog.tools.flatMap((tool) => tool.requiredCapabilities))];
            return (
              <AccountCard key={catalog.id}>
                <View style={styles.cardContent}>
                  <View style={styles.cardHeader}>
                    <View style={styles.cardTitleBlock}>
                      <ThemedText style={styles.cardTitle}>{catalog.appId}</ThemedText>
                      <ThemedText style={styles.meta}>v{catalog.version} · {catalog.catalog.tools.length} tools</ThemedText>
                    </View>
                    {policy && (
                      <Pressable onPress={() => deletePolicy.mutate(catalog.appId)}>
                        <ThemedText style={{ color: colors.tint }}>{t('agency.useDefault')}</ThemedText>
                      </Pressable>
                    )}
                  </View>
                  <View style={styles.wrapRow}>
                    {AUTONOMY_LEVELS.map((level) => (
                      <TogglePill
                        key={level}
                        active={level === current}
                        label={t(`agency.autonomy.${level}`)}
                        onPress={() => putPolicy.mutate({
                          appId: catalog.appId,
                          policy: {
                            accountId,
                            maximumAutonomy: level,
                            deniedCapabilities: policy?.deniedCapabilities ?? [],
                          },
                        })}
                      />
                    ))}
                  </View>
                  {appCapabilities.length > 0 && (
                    <>
                      <ThemedText style={styles.label}>{t('agency.accountCapabilityPolicy')}</ThemedText>
                      <ThemedText style={styles.hint}>{t('agency.accountCapabilityPolicyHint')}</ThemedText>
                      <View style={styles.wrapRow}>
                        {appCapabilities.map((capability) => {
                          const denied = policy?.deniedCapabilities.includes(capability) ?? false;
                          return (
                            <TogglePill
                              key={capability}
                              active={!denied}
                              label={capability}
                              onPress={() => putPolicy.mutate({
                                appId: catalog.appId,
                                policy: {
                                  accountId,
                                  maximumAutonomy: current,
                                  deniedCapabilities: denied
                                    ? (policy?.deniedCapabilities ?? []).filter((entry) => entry !== capability)
                                    : [...(policy?.deniedCapabilities ?? []), capability],
                                },
                              })}
                            />
                          );
                        })}
                      </View>
                    </>
                  )}
                </View>
              </AccountCard>
            );
          })}
        </Section>

        <Section title={t('agency.delegatedAccess')}>
          <ThemedText style={styles.sectionSubtitle}>{t('agency.delegatedAccessHint')}</ThemedText>
          {composerGrantId ? (
            <GrantComposer
              accountId={accountId}
              bots={bots}
              catalogs={data.catalogs}
              grant={composerGrantId === 'new' ? undefined : liveGrants.find((grant) => grant.id === composerGrantId)}
              onDone={() => setComposerGrantId(null)}
            />
          ) : (
            <ActionButton
              disabled={bots.length === 0 || data.catalogs.length === 0}
              label={bots.length === 0 ? t('agency.noAgents') : t('agency.addGrant')}
              onPress={() => setComposerGrantId('new')}
            />
          )}
          {liveGrants.length === 0 ? (
            <EmptyStateCard icon="robot-outline" title={t('agency.noGrants')} subtitle={t('agency.noGrantsHint')} />
          ) : liveGrants.map((grant) => (
            <AccountCard key={grant.id}>
              <View style={styles.cardContent}>
                <View style={styles.cardHeader}>
                  <View style={styles.cardTitleBlock}>
                    <ThemedText style={styles.cardTitle}>{accountName(grant.actor.type === 'agent' ? grant.actor.accountId : '')}</ThemedText>
                    <ThemedText style={styles.meta}>
                      {grant.resource.appId} · {grant.resource.resourceType} · {t(`agency.autonomy.${grant.maximumAutonomy}`)}
                    </ThemedText>
                  </View>
                  <MaterialCommunityIcons name="shield-account-outline" size={24} color={colors.tint} />
                </View>
                <ThemedText style={styles.meta}>{grant.capabilityPackages.join(' · ')}</ThemedText>
                {grant.toolOverrides.length > 0 && (
                  <ThemedText style={styles.meta}>{t('agency.exceptionsCount', { count: grant.toolOverrides.length })}</ThemedText>
                )}
                {grant.limits.length > 0 && (
                  <ThemedText style={styles.meta}>{t('agency.limitsCount', { count: grant.limits.length })}</ThemedText>
                )}
                <View style={styles.actionRow}>
                  <ActionButton label={t('common.edit')} onPress={() => setComposerGrantId(grant.id)} />
                  <ActionButton destructive label={t('agency.revoke')} onPress={() => confirmRevokeGrant(grant)} />
                </View>
              </View>
            </AccountCard>
          ))}
        </Section>

        <Section title={t('agency.activeRuns')}>
          {liveAuthorizations.length === 0 ? (
            <EmptyStateCard icon="progress-check" title={t('agency.noActiveRuns')} subtitle={t('agency.noActiveRunsHint')} />
          ) : liveAuthorizations.map((authorization) => (
            <AccountCard key={authorization.id}>
              <View style={styles.cardContent}>
                <ThemedText style={styles.cardTitle}>{authorization.tool}</ThemedText>
                <ThemedText style={styles.meta}>
                  {authorization.resourceApp} · {authorization.actorType} · {authorization.kind}
                </ThemedText>
                <ActionButton
                  destructive
                  label={t('agency.stop')}
                  onPress={() => revokeAuthorization.mutate(authorization.id)}
                />
              </View>
            </AccountCard>
          ))}
        </Section>

        <Section title={t('agency.history')}>
          {data.auditEvents.length === 0 ? (
            <EmptyStateCard icon="history" title={t('agency.noHistory')} subtitle={t('agency.noHistoryHint')} />
          ) : data.auditEvents.slice(0, 50).map((event) => (
            <AccountCard key={event.eventId}>
              <View style={styles.cardContent}>
                <View style={styles.cardHeader}>
                  <ThemedText style={styles.cardTitle}>{event.tool}</ThemedText>
                  <ThemedText style={styles.meta}>{event.result.status}</ThemedText>
                </View>
                <ThemedText style={styles.meta}>
                  {event.appId} · {event.executor.type === 'agent' ? accountName(event.executor.accountId) : 'Alia'}
                </ThemedText>
                <ThemedText style={styles.meta}>{event.policyDecision.reason}</ThemedText>
              </View>
            </AccountCard>
          ))}
        </Section>
      </>
    );
  };

  if (isDesktop) {
    return (
      <>
        <ScreenHeader title={t('agency.title')} subtitle={t('agency.subtitle')} />
        {renderContent()}
      </>
    );
  }

  return (
    <ScreenContentWrapper>
      <View style={[styles.container, { backgroundColor: colors.background }]}>
        <View style={styles.mobileContent}>
          <ScreenHeader title={t('agency.title')} subtitle={t('agency.subtitle')} />
          {renderContent()}
        </View>
      </View>
    </ScreenContentWrapper>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  mobileContent: { padding: 16, paddingBottom: 120 },
  loader: { marginVertical: 64 },
  sectionSubtitle: { fontSize: 14, opacity: 0.7 },
  accountSelector: { gap: 8, paddingBottom: 4 },
  cardContent: { padding: 16, gap: 12 },
  cardHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
  cardTitleBlock: { flex: 1, gap: 2 },
  cardTitle: { fontSize: 16, fontWeight: '600' },
  label: { fontSize: 13, fontWeight: '600', opacity: 0.8 },
  hint: { fontSize: 12, opacity: 0.65 },
  meta: { fontSize: 13, opacity: 0.7 },
  wrapRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  pill: { borderWidth: 1, borderRadius: 999, paddingHorizontal: 12, paddingVertical: 8 },
  pillText: { fontSize: 12, fontWeight: '500' },
  activePillText: { color: '#FFFFFF' },
  actionRow: { flexDirection: 'row', justifyContent: 'flex-end', gap: 8 },
  actionButton: { borderRadius: 10, paddingHorizontal: 16, paddingVertical: 10, alignSelf: 'flex-start' },
  actionButtonText: { color: '#FFFFFF', fontSize: 13, fontWeight: '600' },
  disabled: { opacity: 0.45 },
  limitRow: { gap: 8 },
  limitInput: { borderWidth: 1, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10 },
});
