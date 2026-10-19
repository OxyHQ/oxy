/**
 * "Sign-in & security": every way the signed-in account signs in, each with
 * its state, and every place it is signed in. One page, rendered by the
 * account dialog's "Manage your account" (`SignInSecurity`) and by the
 * Accounts app's security page.
 *
 * Each method opens its own panel: the email (`SignInEmail`), the password
 * (`SignInPassword`), the authenticator app (`SignInAuthenticator`) and
 * linking Commons (`LinkCommons`). An account with a Commons key signs in with
 * Commons, so it sees only that; an organization, project or bot has no
 * methods of its own, only its sessions.
 */

import type React from 'react';
import { View } from 'react-native';
import { GroupedSection, GroupedSectionItem } from '@oxy.so/bloom/grouped-section';
import { useTheme } from '@oxy.so/bloom/theme';
import { useOxy } from '../../context/oxyRuntimeContext';
import { useI18n } from '../../hooks/useI18n';
import type { RouteName } from '../../navigation/routes';
import { SettingsIcon } from '../SettingsIcon';
import { AccountFlowNotice } from './accountFlowParts';
import { useAccountSecurityState } from './accountSecurityState';
import { SessionsSection } from './SessionsSection';

type SignInSecurityRoute = Extract<
  RouteName,
  'SignInEmail' | 'SignInPassword' | 'SignInAuthenticator' | 'LinkCommons'
>;

export interface OxySignInSecurityPanelProps {
  /**
   * Open one method's panel. Defaults to the provider's `showBottomSheet`;
   * a surface passes its own `navigate` so the panel stacks inside it.
   */
  onOpen?: (route: SignInSecurityRoute) => void;
}

export const OxySignInSecurityPanel: React.FC<OxySignInSecurityPanelProps> = ({ onOpen }) => {
  const theme = useTheme();
  const { t } = useI18n();
  const { user, showBottomSheet } = useOxy();
  const { keyed, personal, methods } = useAccountSecurityState();
  const open = (route: SignInSecurityRoute) => () =>
    onOpen ? onOpen(route) : showBottomSheet?.(route);
  const on = theme.colors.success;
  const off = theme.colors.textTertiary;

  const renderMethods = (): React.ReactNode => {
    if (keyed) {
      return (
        <GroupedSectionItem
          icon={<SettingsIcon name="key" color={on} />}
          title={t('signInSecurity.commons.title')}
          description={t('linkCommons.already')}
          showChevron={false}
          disabled
        />
      );
    }
    if (!personal) {
      return (
        <GroupedSectionItem
          icon={<SettingsIcon name="information" color={off} />}
          title={t('signInSecurity.notPersonal')}
          showChevron={false}
          disabled
        />
      );
    }
    if (!methods.data) {
      return methods.isError ? (
        <GroupedSectionItem
          icon={<SettingsIcon name="alert-circle" color={theme.colors.error} />}
          title={t('signInSecurity.loadFailed')}
          description={t('signInSecurity.retry')}
          onPress={() => void methods.refetch()}
          testID="sign-in-security-retry"
        />
      ) : (
        <GroupedSectionItem
          icon={<SettingsIcon name="sync" color={theme.colors.primary} />}
          title={t('common.status.loading')}
          showChevron={false}
          disabled
        />
      );
    }
    const { hasEmail, hasPassword, totpEnabled, backupCodesRemaining } = methods.data;
    return (
      <>
        <GroupedSectionItem
          icon={<SettingsIcon name="email" color={hasEmail ? on : off} />}
          title={t('signInSecurity.email.title')}
          description={
            hasEmail
              ? (user?.email ?? t('signInSecurity.status.on'))
              : t('signInSecurity.email.none')
          }
          onPress={open('SignInEmail')}
          testID="sign-in-security-email"
        />
        <GroupedSectionItem
          icon={<SettingsIcon name="key" color={hasPassword ? on : off} />}
          title={t('signInSecurity.password.title')}
          description={
            hasPassword ? t('signInSecurity.status.on') : t('signInSecurity.password.row')
          }
          onPress={open('SignInPassword')}
          testID="sign-in-security-password"
        />
        <GroupedSectionItem
          icon={<SettingsIcon name="shield-check" color={totpEnabled ? on : off} />}
          title={t('signInSecurity.totp.title')}
          description={
            totpEnabled
              ? t('signInSecurity.totp.onWithCodes', { count: backupCodesRemaining })
              : t('signInSecurity.totp.row')
          }
          onPress={open('SignInAuthenticator')}
          testID="sign-in-security-totp"
        />
        <GroupedSectionItem
          icon={<SettingsIcon name="link" color={theme.colors.primary} />}
          title={t('linkCommons.title')}
          description={t('linkCommons.row')}
          onPress={open('LinkCommons')}
          testID="sign-in-security-commons"
        />
      </>
    );
  };

  const noEmail = personal && !keyed && methods.data?.hasEmail === false;

  return (
    <View>
      <GroupedSection title={t('signInSecurity.methodsTitle')}>{renderMethods()}</GroupedSection>
      {noEmail ? (
        <AccountFlowNotice type="warning" testID="sign-in-security-no-email">
          {t('signInSecurity.noEmailWarning')}
        </AccountFlowNotice>
      ) : null}
      <SessionsSection />
    </View>
  );
};
