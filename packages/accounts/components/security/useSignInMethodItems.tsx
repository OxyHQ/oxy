import { useMemo } from 'react';
import { useOxy, useSignInMethods } from '@oxy.so/services';
import { useColors } from '@/hooks/useColors';
import { useTranslation } from '@/lib/i18n';
import type { GroupedItem } from '@/components/sections/types';

/**
 * The "How you sign in" rows of an account WITHOUT a key of its own: its email
 * (a code or a link each time), the optional password, the authenticator app
 * and its backup codes, and linking Commons. Each opens the SDK's own panel
 * (`SignInPassword`, `SignInAuthenticator`, `LinkCommons`), the same one the
 * account dialog's "Manage your account" opens. Returns `[]` for an account
 * with a Commons key: it signs in with Commons.
 */
export function useSignInMethodItems(): GroupedItem[] {
  const colors = useColors();
  const { t } = useTranslation();
  const { user, showBottomSheet } = useOxy();
  const keyed = Boolean(user?.publicKey);
  const { data: methods } = useSignInMethods({ enabled: !keyed });

  return useMemo<GroupedItem[]>(() => {
    if (keyed || !methods) return [];
    const open = (screen: 'SignInPassword' | 'SignInAuthenticator' | 'LinkCommons') => () => showBottomSheet?.(screen);
    const items: GroupedItem[] = [];

    if (methods.hasEmail) {
      items.push({
        id: 'email-sign-in',
        icon: 'email-outline',
        iconColor: colors.success,
        title: t('security.signInMethods.email'),
        subtitle: user?.email ?? t('security.signInMethods.emailSubtitle'),
        showChevron: false,
      });
    }
    items.push({
      id: 'password',
      icon: 'form-textbox-password',
      iconColor: methods.hasPassword ? colors.success : colors.sidebarIconSecurity,
      title: t('security.signInMethods.password'),
      subtitle: methods.hasPassword ? t('security.signInMethods.passwordSet') : t('security.signInMethods.passwordNotSet'),
      onPress: open('SignInPassword'),
      showChevron: true,
    });
    items.push({
      id: 'authenticator',
      icon: 'cellphone-key',
      iconColor: methods.totpEnabled ? colors.success : colors.sidebarIconSecurity,
      title: t('security.signInMethods.authenticator'),
      subtitle: methods.totpEnabled
        ? t('security.signInMethods.authenticatorOn', { count: methods.backupCodesRemaining })
        : t('security.signInMethods.authenticatorOff'),
      onPress: open('SignInAuthenticator'),
      showChevron: true,
    });
    items.push({
      id: 'link-commons',
      icon: 'shield-key-outline',
      iconColor: colors.warning,
      title: t('security.signInMethods.linkCommons'),
      subtitle: t('security.signInMethods.linkCommonsSubtitle'),
      onPress: open('LinkCommons'),
      showChevron: true,
    });
    return items;
  }, [keyed, methods, user?.email, showBottomSheet, colors, t]);
}
