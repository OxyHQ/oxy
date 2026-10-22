import type React from 'react';
import type { BaseScreenProps } from '../types/navigation';
import {
  AccountSettings,
  useAccountSettingsNode,
} from '../components/accountSettings/AccountSettings';
import { useI18n } from '../hooks/useI18n';
import { useSurfaceHeader } from '../hooks/useSurfaceHeader';

/**
 * The `AccountSettings` surface: {@link AccountSettings} for the `accountId`
 * route prop, under the surface's own header. Self-surface for the caller's own
 * personal account lives in {@link ManageAccountScreen}; this screen manages a
 * non-personal account in the graph.
 */
const AccountSettingsScreen: React.FC<BaseScreenProps> = ({
  onClose,
  goBack,
  navigate,
  accountId,
}) => {
  const { t } = useI18n();
  const id = typeof accountId === 'string' ? accountId : '';
  const { node } = useAccountSettingsNode(id);

  // The nav large title is the account's handle once loaded (falls back to the
  // generic screen title before the account resolves).
  const username = node?.account?.username;
  useSurfaceHeader({
    title: username ? `@${username}` : t('accounts.settings.title'),
    subtitle: t('accounts.settings.subtitle'),
  });

  return <AccountSettings accountId={id} navigate={navigate} onClose={onClose ?? goBack} />;
};

export default AccountSettingsScreen;
