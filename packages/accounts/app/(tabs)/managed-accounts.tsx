import React, { useCallback, useState } from 'react';
import { View, StyleSheet, Text, TouchableOpacity, ActivityIndicator } from 'react-native';
import { useColors } from '@/hooks/useColors';
import { ThemedText } from '@/components/themed-text';
import { ScreenContentWrapper } from '@/components/screen-content-wrapper';
import { ScreenHeader, AccountCard, EmptyStateCard } from '@/components/ui';
import { Section } from '@/components/section';
import { GroupedSection } from '@/components/grouped-section';
import { useOxy } from '@oxyhq/services';
import { alert, toast } from '@oxyhq/bloom';
import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';
import { useHapticPress } from '@/hooks/use-haptic-press';
import { useTranslation } from '@/lib/i18n';
import type { AccountNode } from '@oxyhq/core';
import { getAccountDisplayName, getNormalizedUserHandle, canSwitchIntoAccount } from '@oxyhq/core';
import { useAccountRowBuilder } from '@/components/managed-accounts/account-row';
import { useManagedAccountGroups } from '@/hooks/managed-accounts/useManagedAccountGroups';

export default function ManagedAccountsScreen() {
  const colors = useColors();
  const handlePressIn = useHapticPress();
  const { t, locale } = useTranslation();

  // Auth is enforced by the `(tabs)` layout — assume a session here.
  // `user` is the account the app is currently signed in as. Selecting a
  // managed account performs a REAL session switch via `switchToAccount`, after
  // which `user` becomes that account — so the "current" account is simply
  // whichever row matches `user.id`.
  const {
    isLoading: oxyLoading,
    accounts,
    user,
    switchToAccount,
    showBottomSheet,
    oxyServices,
    refreshAccounts,
  } = useOxy();

  const [refreshing, setRefreshing] = useState(false);
  const [archivingId, setArchivingId] = useState<string | null>(null);

  const handleRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await refreshAccounts();
    } catch (error) {
      console.error('Failed to refresh accounts', error);
    } finally {
      setRefreshing(false);
    }
  }, [refreshAccounts]);

  const handleCreateAccount = useCallback(() => {
    showBottomSheet?.('CreateAccount');
  }, [showBottomSheet]);

  // True account switch — selecting an account makes the whole app sign in as
  // it (a real session switch). Returning to the personal account is itself a
  // switch, performed from the account switcher, never an "un-act-as".
  const handleSwitchTo = useCallback((accountId: string) => {
    Promise.resolve(switchToAccount(accountId)).catch((error) => {
      console.error('Failed to switch account', error);
    });
  }, [switchToAccount]);

  const handleManageMembers = useCallback((accountId: string) => {
    showBottomSheet?.({ screen: 'AccountMembers', props: { accountId } });
  }, [showBottomSheet]);

  const handleEditProfile = useCallback((accountId: string) => {
    const node = accounts.find((entry) => entry.accountId === accountId);
    // An account the caller cannot switch into — a channel, or a membership
    // without `account:act_as` — cannot be edited by switching into it first.
    // Edit via the per-account settings sheet, which PATCHes by id without a
    // session switch. `canSwitchIntoAccount` encodes both the kind rule and the
    // permission gate so this branch stays aligned with the API's switch route.
    if (!node || !canSwitchIntoAccount(node)) {
      showBottomSheet?.({ screen: 'AccountSettings', props: { accountId } });
      return;
    }
    // Editing a non-personal account's profile happens through the shared
    // profile editor, which targets the current account — so switch into the
    // account first, then open the editor.
    Promise.resolve(switchToAccount(accountId))
      .then(() => {
        showBottomSheet?.({
          screen: 'EditProfileField',
          props: { fieldType: 'displayName' },
        });
      })
      .catch((error) => {
        console.error('Failed to switch account before editing', error);
      });
  }, [switchToAccount, showBottomSheet, accounts]);

  const handleArchiveAccount = useCallback((node: AccountNode) => {
    const name =
      node.account?.name?.displayName ??
      getNormalizedUserHandle(node.account) ??
      getAccountDisplayName(null, locale);
    alert(
      t('managedAccounts.archive.confirmTitle'),
      t('managedAccounts.archive.confirmBody', { name }),
      [
        { text: t('common.cancel'), style: 'cancel' },
        {
          text: t('managedAccounts.archive.confirm'),
          style: 'destructive',
          onPress: async () => {
            try {
              setArchivingId(node.accountId);
              await oxyServices.archiveAccount(node.accountId);
              await refreshAccounts();
            } catch (error) {
              console.error('Failed to archive account', error);
              toast.error(t('managedAccounts.archive.error'));
            } finally {
              setArchivingId(null);
            }
          },
        },
      ],
    );
  }, [oxyServices, refreshAccounts, locale, t]);

  const buildItem = useAccountRowBuilder({
    currentAccountId: user?.id ?? null,
    archivingId,
    oxyServices,
    onSwitchTo: handleSwitchTo,
    onManageMembers: handleManageMembers,
    onEditProfile: handleEditProfile,
    onArchive: handleArchiveAccount,
  });

  const { groups, totalCount } = useManagedAccountGroups(accounts);

  if (oxyLoading) {
    return (
      <ScreenContentWrapper>
        <View style={[styles.container, styles.loadingContainer, { backgroundColor: colors.background }]}>
          <ActivityIndicator size="large" color={colors.tint} />
          <ThemedText style={[styles.loadingText, { color: colors.text }]}>{t('common.loading')}</ThemedText>
        </View>
      </ScreenContentWrapper>
    );
  }

  return (
    <ScreenContentWrapper refreshing={refreshing} onRefresh={handleRefresh}>
      <View style={[styles.container, { backgroundColor: colors.background }]}>
        <View style={styles.content}>
          <ScreenHeader
            title={t('managedAccounts.title')}
            subtitle={t('managedAccounts.subtitle')}
          />

          <Section title="">
            <TouchableOpacity
              style={[styles.createButton, { backgroundColor: colors.tint }]}
              onPressIn={handlePressIn}
              onPress={handleCreateAccount}
              activeOpacity={0.8}
              accessibilityRole="button"
              accessibilityLabel={t('managedAccounts.createNew')}
            >
              <MaterialCommunityIcons name="account-plus-outline" size={20} color="#FFFFFF" />
              <Text style={styles.createButtonText}>{t('managedAccounts.createNew')}</Text>
            </TouchableOpacity>
          </Section>

          {totalCount === 0 ? (
            <Section title="">
              <EmptyStateCard
                icon="account-group-outline"
                title={t('managedAccounts.empty.title')}
                subtitle={t('managedAccounts.empty.subtitle')}
              />
            </Section>
          ) : (
            <>
              {groups.organizations.length > 0 && (
                <Section title={t('managedAccounts.groups.organizations')}>
                  <AccountCard>
                    <GroupedSection items={groups.organizations.map(buildItem)} />
                  </AccountCard>
                </Section>
              )}
              {groups.projects.length > 0 && (
                <Section title={t('managedAccounts.groups.projects')}>
                  <AccountCard>
                    <GroupedSection items={groups.projects.map(buildItem)} />
                  </AccountCard>
                </Section>
              )}
              {groups.bots.length > 0 && (
                <Section title={t('managedAccounts.groups.bots')}>
                  <AccountCard>
                    <GroupedSection items={groups.bots.map(buildItem)} />
                  </AccountCard>
                </Section>
              )}
              {groups.channels.length > 0 && (
                <Section title={t('managedAccounts.groups.channels')}>
                  <AccountCard>
                    <GroupedSection items={groups.channels.map(buildItem)} />
                  </AccountCard>
                </Section>
              )}
              {groups.shared.length > 0 && (
                <Section title={t('managedAccounts.groups.shared')}>
                  <AccountCard>
                    <GroupedSection items={groups.shared.map(buildItem)} />
                  </AccountCard>
                </Section>
              )}
            </>
          )}
        </View>
      </View>
    </ScreenContentWrapper>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  content: {
    padding: 20,
  },
  loadingContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    gap: 16,
  },
  loadingText: {
    fontSize: 16,
    opacity: 0.7,
  },
  createButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 14,
    paddingHorizontal: 24,
    borderRadius: 28,
    gap: 8,
  },
  createButtonText: {
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: '600',
  },
});
