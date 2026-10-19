import { OrganizationClaimReview } from '../components/organizations/OrganizationClaimReview';
import { OrganizationClaims } from '../components/organizations/OrganizationClaims';
import { SpinnerIcon } from '@oxy.so/bloom/loading';
import type React from 'react';
import { useCallback, useMemo, useState } from 'react';
import { View, StyleSheet, Linking, Platform } from 'react-native';
import { toast } from '@oxy.so/bloom/toast';
import { surfaces } from '@oxy.so/bloom/surfaces';
import { useTheme } from '@oxy.so/bloom/theme';
import { Text } from '@oxy.so/bloom/typography';
import { GroupedSection, GroupedSectionItem } from '@oxy.so/bloom/grouped-section';
import {
  getAccountDisplayName,
  getAccountFallbackHandle,
  getNormalizedUserHandle,
  logger as loggerUtil,
  packageInfo,
} from '@oxy.so/core';
import type { BaseScreenProps } from '../types/navigation';
import ProfileSummaryCard from '../components/ProfileSummaryCard';
import { SettingsIcon } from '../components/SettingsIcon';
import { presentDeleteAccount } from '../components/modals/DeleteAccountModal';
import { runAccountDeletionHandoff } from '../utils/accountDeletionHandoff';
import { useOxy } from '../context/oxyRuntimeContext';
import { useI18n } from '../hooks/useI18n';
import { useSurfaceHeader } from '../hooks/useSurfaceHeader';
import { isWebBrowser } from '../utils/isWebBrowser';
import { useCurrentUser } from '../hooks/queries/useAccountQueries';
import { useUserSubscription } from '../hooks/queries/usePaymentQueries';

/**
 * Unified "Manage your Oxy Account" screen.
 *
 * Replaces AccountOverview + AccountSettings + the per-account half of
 * SessionManagement. Lists ONLY the active user's profile, its sign-in and
 * security page (`SignInSecurity`: methods and sessions), and the destructive
 * actions for THIS account. Multi-account
 * surface lives in the unified `OxyAccountDialogScreen` — keep these concerns separate.
 */
interface ManageAccountScreenProps extends BaseScreenProps {
  section?: 'data';
}

const ManageAccountScreen: React.FC<ManageAccountScreenProps> = ({
  onClose,
  goBack,
  navigate,
  section,
}) => {
  const bloomTheme = useTheme();
  const { t, locale } = useI18n();

  useSurfaceHeader({
    title: section === 'data' ? t('accountMenu.data') : t('manageAccount.title'),
  });
  const {
    user: contextUser,
    isAuthenticated,
    oxyServices,
    logout,
    openAvatarPicker,
    accounts,
    openAccountDialog,
    hasIdentity,
  } = useOxy();

  const { data: userFromQuery, isLoading: userLoading } = useCurrentUser({
    enabled: isAuthenticated,
  });
  // `user` IS the active account. In the real-session switch model, switching
  // into an org/project/bot makes it the active session, so `useOxy().user`
  // (and the freshest `useCurrentUser` copy) already reflects the switched
  // account everywhere — identity-of-me surfaces and management/GDPR actions
  // alike read this single `user`.
  const user = userFromQuery ?? contextUser;

  const { data: subscription } = useUserSubscription({ enabled: isAuthenticated });
  const [signingOut, setSigningOut] = useState(false);

  const displayName = useMemo(
    () =>
      user?.name?.displayName ??
      getNormalizedUserHandle(user) ??
      getAccountDisplayName(null, locale),
    [user, locale],
  );
  const handle = useMemo(() => getAccountFallbackHandle(user), [user]);
  const avatarUri = useMemo(() => {
    return user?.avatar ? oxyServices.assets.publicUrl(user.avatar, 'thumb') : undefined;
  }, [user?.avatar, oxyServices]);

  const handleSignOut = useCallback(async () => {
    if (signingOut) {
      return;
    }
    const confirmed = await surfaces.confirm({
      title: t('common.actions.signOut') || 'Sign out',
      description: t('common.confirms.signOut') || 'Are you sure you want to sign out?',
      confirmLabel: t('common.actions.signOut') || 'Sign out',
      cancelLabel: t('common.cancel') || 'Cancel',
      destructive: true,
    });
    if (!confirmed) {
      return;
    }
    setSigningOut(true);
    try {
      await logout();
      toast.success(t('common.actions.signedOut') || 'Signed out');
      onClose?.();
    } catch (error) {
      loggerUtil.warn('Sign out failed', { component: 'ManageAccountScreen' }, error as unknown);
      toast.error(t('common.errors.signOutFailed') || 'Failed to sign out');
    } finally {
      setSigningOut(false);
    }
  }, [signingOut, logout, t, onClose]);

  // The signed, open-format export (`GET /users/me/export`): one JSON bundle
  // carrying Oxy's provenance attestation — the "credible exit" snapshot.
  const handleDownloadData = useCallback(async () => {
    if (!user) {
      toast.error(t('accountOverview.items.downloadData.error') || 'Service not available');
      return;
    }
    try {
      toast.info(t('accountOverview.items.downloadData.downloading') || 'Preparing download...');
      const bundle = await oxyServices.identity.export();
      if (Platform.OS === 'web') {
        const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = `oxy-export-${Date.now()}.json`;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(url);
      }
      toast.success(
        t('accountOverview.items.downloadData.success') || 'Data downloaded successfully',
      );
    } catch (error) {
      loggerUtil.warn(
        'Download account data failed',
        { component: 'ManageAccountScreen' },
        error as unknown,
      );
      toast.error(
        (error instanceof Error ? error.message : null) ||
          t('accountOverview.items.downloadData.error') ||
          'Failed to download data',
      );
    }
  }, [oxyServices, user, t]);

  // Runs the actual deletion from inside the delete-account surface; it throws
  // on failure so the surface can surface the error and stay open. Sign-out +
  // close happen in `handleDeleteAccount` once the surface resolves `true`.
  const handleConfirmDelete = useCallback(
    async (confirmText: string) => {
      if (!user) {
        throw new Error(t('accountOverview.items.deleteAccount.error') || 'Service not available');
      }
      // Native deletion is signed with the identity key held on this device.
      await oxyServices.users.deleteMe(confirmText, { deviceKey: true });
      toast.success(
        t('accountOverview.items.deleteAccount.success') || 'Account deleted successfully',
      );
    },
    [oxyServices, user, t],
  );

  const handleDeleteAccount = useCallback(async () => {
    if (!user) {
      toast.error(t('accountOverview.items.deleteAccount.error') || 'User not available');
      return;
    }
    // An account without a key confirms its deletion with a code by email,
    // right here; the panel also tells a keyed account on the web where its
    // key is.
    if (!user.publicKey || isWebBrowser()) {
      navigate?.('DeleteAccount');
      return;
    }
    // Native: the deletion is signed with the identity key. When this app
    // does not hold it (Commons keeps it on this device, or it lives on
    // another device), hand off to where it can be signed instead of
    // failing inside the confirmation surface.
    const route = await runAccountDeletionHandoff({
      hasIdentity,
      canOpenURL: (url) => Linking.canOpenURL(url),
      openURL: (url) => Linking.openURL(url),
      t,
    });
    if (route !== 'local') {
      return;
    }
    const deleted = await presentDeleteAccount({
      username: user.username || '',
      onDelete: handleConfirmDelete,
      t,
    });
    if (deleted) {
      await logout();
      onClose?.();
    }
  }, [user, t, handleConfirmDelete, hasIdentity, logout, onClose, navigate]);

  if (!isAuthenticated) {
    return (
      <>
        <View className="items-center py-space-40">
          <Text className="text-text font-medium text-base">
            {t('common.status.notSignedIn') || 'Not signed in'}
          </Text>
        </View>
      </>
    );
  }

  return (
    <>
      <View className="px-screen-margin pb-space-24">
        {section !== 'data' ? (
          <>
            {/* Profile card */}
            <ProfileSummaryCard
              displayName={displayName}
              avatarUri={avatarUri}
              onAvatarPress={openAvatarPicker}
              showCameraBadge
              avatarAccessibilityLabel={t('editProfile.changeAvatar') || 'Change avatar'}
              lines={[
                handle ? (user?.username ? `@${handle}` : handle) : null,
                user?.email || null,
              ]}
            />

            {/* Profile section */}
            <GroupedSection title={t('manageAccount.sections.profile') || 'Profile'}>
              <GroupedSectionItem
                icon={<SettingsIcon name="account-circle" color={bloomTheme.colors.primary} />}
                title={t('manageAccount.items.editProfile.title') || 'Edit profile'}
                description={
                  t('manageAccount.items.editProfile.subtitle') || 'Name, username, bio, links'
                }
                onPress={() => navigate?.('EditProfile')}
              />
              <GroupedSectionItem
                icon={<SettingsIcon name="palette" color={bloomTheme.colors.info} />}
                title={t('manageAccount.items.theme.title') || 'Theme color'}
                description={
                  t('manageAccount.items.theme.subtitle') || 'Personalize your Bloom color'
                }
                onPress={() => navigate?.('Preferences')}
              />
              <GroupedSectionItem
                icon={<SettingsIcon name="eye" color={bloomTheme.colors.success} />}
                title={t('editProfile.items.previewProfile.title') || 'Preview profile'}
                description={
                  t('editProfile.items.previewProfile.subtitle') ||
                  'See how your profile looks to others'
                }
                onPress={() => (user?.id ? navigate?.('Profile', { userId: user.id }) : undefined)}
                disabled={!user?.id}
              />
              <GroupedSectionItem
                icon={<SettingsIcon name="check-circle" color={bloomTheme.colors.primary} />}
                title={t('editProfile.items.verifyAccount.title') || 'Verify account'}
                description={
                  t('editProfile.items.verifyAccount.subtitle') || 'Get a verified badge'
                }
                onPress={() => navigate?.('AccountVerification')}
              />
            </GroupedSection>

            {user?.kind === 'organization' ? (
              <GroupedSection title={t('organizationDirectory.title')}>
                <GroupedSectionItem
                  title={t('organizationDirectory.view')}
                  onPress={() => navigate?.('AccountSettings', { accountId: user.id })}
                />
              </GroupedSection>
            ) : null}

            {user?.kind === 'personal' ? (
              <>
                <OrganizationClaims key={user.id} />
                <OrganizationClaimReview key={`review:${user.id}`} />
              </>
            ) : null}

            {user?.kind === 'personal' ? (
              <GroupedSection title={t('supervision.title')}>
                <GroupedSectionItem
                  title={t('supervision.title')}
                  description={t('supervision.entryDescription')}
                  onPress={() => navigate?.('Supervision')}
                />
              </GroupedSection>
            ) : null}

            {/* Security: one page for how the account signs in and where. */}
            <GroupedSection title={t('manageAccount.sections.security') || 'Security'}>
              <GroupedSectionItem
                icon={<SettingsIcon name="shield-check" color={bloomTheme.colors.primary} />}
                title={t('signInSecurity.title')}
                description={t('signInSecurity.subtitle')}
                onPress={() => navigate?.('SignInSecurity')}
                testID="manage-account-sign-in-security"
              />
              {user?.isPremium || subscription?.status === 'active' ? (
                <GroupedSectionItem
                  icon={<SettingsIcon name="credit-card" color={bloomTheme.colors.success} />}
                  title={t('manageAccount.items.billing.title') || 'Billing'}
                  description={
                    t('manageAccount.items.billing.subtitle') ||
                    'Manage subscription and payment methods'
                  }
                  onPress={() => navigate?.('PaymentGateway')}
                />
              ) : null}
            </GroupedSection>
          </>
        ) : null}

        {/* Account & data */}
        <GroupedSection title={t('accountOverview.sections.quickActions') || 'Account & data'}>
          <GroupedSectionItem
            icon={<SettingsIcon name="clock" color={bloomTheme.colors.primary} />}
            title={t('accountOverview.items.history.title') || 'History'}
            description={
              t('accountOverview.items.history.subtitle') || 'View and manage your search history'
            }
            onPress={() => navigate?.('HistoryView')}
          />
          <GroupedSectionItem
            icon={<SettingsIcon name="folder" color={bloomTheme.colors.info} />}
            title={t('accountCenter.items.fileManagement.title') || 'Files'}
            description={
              t('accountCenter.items.fileManagement.subtitle') ||
              'Upload, download, and manage your files'
            }
            onPress={() => navigate?.('FileManagement')}
          />
          <GroupedSectionItem
            icon={<SettingsIcon name="download" color={bloomTheme.colors.primary} />}
            title={t('accountOverview.items.downloadData.title') || 'Download your data'}
            description={
              t('accountOverview.items.downloadData.subtitle') ||
              'Export a copy of your account data'
            }
            onPress={handleDownloadData}
          />
        </GroupedSection>

        {section !== 'data' ? (
          <>
            {/* Accounts (unified account graph) */}
            {accounts.length > 0 || isAuthenticated ? (
              <GroupedSection title={t('accountCenter.sections.accounts') || 'Accounts'}>
                <GroupedSectionItem
                  icon={<SettingsIcon name="account-switch" color={bloomTheme.colors.info} />}
                  title={t('accounts.manage.switch.title') || 'Switch account'}
                  description={
                    accounts.length > 0
                      ? // One account is "1 account", not "1 accounts".
                        t(
                          accounts.length === 1
                            ? 'accounts.manage.switch.countOne'
                            : 'accounts.manage.switch.count',
                          { count: accounts.length },
                        )
                      : t('accounts.manage.switch.empty') || 'Accounts you own or share'
                  }
                  onPress={() => openAccountDialog('accounts')}
                />
                <GroupedSectionItem
                  icon={<SettingsIcon name="account-plus" color={bloomTheme.colors.primary} />}
                  title={t('accounts.create.title') || 'Create account'}
                  description={
                    t('accounts.manage.create.subtitle') || 'Add an organization, project, or bot'
                  }
                  onPress={() => navigate?.('CreateAccount')}
                />
              </GroupedSection>
            ) : null}

            {/* Preferences */}
            <GroupedSection title={t('manageAccount.sections.preferences') || 'Preferences'}>
              <GroupedSectionItem
                icon={<SettingsIcon name="cog" color={bloomTheme.colors.info} />}
                title={t('preferences.title') || 'Preferences'}
                description={t('preferences.subtitle') || 'Theme, motion, and regional settings'}
                onPress={() => navigate?.('Preferences')}
              />
              <GroupedSectionItem
                icon={<SettingsIcon name="bell" color={bloomTheme.colors.primary} />}
                title={t('notifications.title') || 'Notifications'}
                description={
                  t('notifications.subtitle') || 'Manage push, email, and security alerts'
                }
                onPress={() => navigate?.('Notifications')}
              />
              <GroupedSectionItem
                icon={<SettingsIcon name="translate" color={bloomTheme.colors.primary} />}
                title={t('language.title') || 'Language'}
                description={t('language.subtitle') || 'Choose your preferred language'}
                onPress={() => navigate?.('LanguageSelector')}
              />
              <GroupedSectionItem
                icon={<SettingsIcon name="apps" color={bloomTheme.colors.info} />}
                title={t('connectedApps.title') || 'Connected apps'}
                description={t('connectedApps.subtitle') || 'Manage third-party app access'}
                onPress={() => navigate?.('ConnectedApps')}
              />
              <GroupedSectionItem
                icon={<SettingsIcon name="web" color={bloomTheme.colors.success} />}
                title={t('domains.title')}
                description={t('domains.subtitle')}
                onPress={() => navigate?.('Domains')}
              />
              <GroupedSectionItem
                icon={<SettingsIcon name="magnify" color={bloomTheme.colors.primary} />}
                title={t('accountOverview.items.searchSettings.title') || 'Search settings'}
                description={
                  t('accountOverview.items.searchSettings.subtitle') ||
                  'SafeSearch and personalization'
                }
                onPress={() => navigate?.('SearchSettings')}
              />
            </GroupedSection>

            {/* Support */}
            <GroupedSection title={t('accountOverview.sections.support') || 'Support'}>
              <GroupedSectionItem
                icon={<SettingsIcon name="help-circle" color={bloomTheme.colors.primary} />}
                title={t('accountOverview.items.help.title') || 'Help & support'}
                description={
                  t('accountOverview.items.help.subtitle') || 'Get help and contact support'
                }
                onPress={() => navigate?.('HelpSupport')}
              />
              <GroupedSectionItem
                icon={<SettingsIcon name="information" color={bloomTheme.colors.success} />}
                title={t('accountOverview.items.about.title') || 'About'}
                description={
                  t('accountOverview.items.about.subtitle') || 'Version and system details'
                }
                onPress={() => navigate?.('AppInfo')}
              />
            </GroupedSection>

            {/* Legal */}
            <GroupedSection title={t('manageAccount.sections.legal') || 'Legal'}>
              <GroupedSectionItem
                icon={<SettingsIcon name="shield-check" color={bloomTheme.colors.primary} />}
                title={t('accountOverview.items.privacyPolicy.title') || 'Privacy policy'}
                description={
                  t('accountOverview.items.privacyPolicy.subtitle') || 'How we handle your data'
                }
                onPress={() => navigate?.('LegalDocuments', { initialStep: 1 })}
              />
              <GroupedSectionItem
                icon={<SettingsIcon name="file-document" color={bloomTheme.colors.primary} />}
                title={t('accountOverview.items.termsOfService.title') || 'Terms of service'}
                description={
                  t('accountOverview.items.termsOfService.subtitle') ||
                  'Terms and conditions of use'
                }
                onPress={() => navigate?.('LegalDocuments', { initialStep: 2 })}
              />
            </GroupedSection>

            {/* Danger zone */}
            <GroupedSection title={t('manageAccount.sections.dangerZone') || 'Danger zone'}>
              <GroupedSectionItem
                icon={<SettingsIcon name="delete" color={bloomTheme.colors.error} />}
                title={t('accountOverview.items.deleteAccount.title') || 'Delete account'}
                description={
                  t('accountOverview.items.deleteAccount.subtitle') ||
                  'Permanently delete your account and all data'
                }
                onPress={handleDeleteAccount}
                destructive
              />
            </GroupedSection>

            {/* Sign out of this account */}
            <GroupedSection>
              <GroupedSectionItem
                icon={<SettingsIcon name="logout" color={bloomTheme.colors.error} />}
                title={t('manageAccount.signOutOfThisAccount') || 'Sign out of this account'}
                onPress={handleSignOut}
                destructive
                showChevron={false}
                disabled={signingOut}
                rightElement={
                  signingOut ? <SpinnerIcon color={bloomTheme.colors.error} size={16} /> : undefined
                }
              />
            </GroupedSection>

            <View className="items-center mt-space-12 mb-space-8">
              <Text className="text-text-tertiary text-xs">
                {t('accountCenter.version', { version: packageInfo.version }) ||
                  `Version ${packageInfo.version}`}
              </Text>
            </View>
          </>
        ) : null}
        <View style={styles.footerSpacer} />
      </View>
    </>
  );
};

// Layout-only styles: flex centering, the absolutely-positioned avatar badge,
// and measured pixel dimensions that no token class can express. Colors,
// spacing, radius, and typography roles live on Bloom components + NativeWind
// token classes.
const styles = StyleSheet.create({
  footerSpacer: {
    height: 24,
  },
});

export default ManageAccountScreen;
