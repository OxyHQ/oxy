import { RiAddLine } from '@oxy.so/bloom/icons/RiAddLine';
import { RiBuilding2Line } from '@oxy.so/bloom/icons/RiBuilding2Line';
import { RiUserLine } from '@oxy.so/bloom/icons/RiUserLine';
import type {
  SidebarAvatar,
  SidebarMenuGroup,
  SidebarMenuItem,
  SidebarNavItem,
  SidebarProps,
} from '@oxy.so/bloom/sidebar';
import { toast } from '@oxy.so/bloom/toast';
import { LogoIcon, ProfileButton, useOxy } from '@oxy.so/services/ui/client';
import { usePathname, useRouter } from 'expo-router';
import { useCallback, useMemo, useState } from 'react';
import { Linking } from 'react-native';

import { useConsoleSettings } from '@/components/settings/ConsoleSettings';
import { accountInitials, useAccountLabels } from '@/components/settings/account-labels';
import { buildWorkspaceTree } from '@/components/settings/workspace-tree';
import { type AccountNode, accountLabel, useAccount } from '@/hooks/use-account';
import { getErrorMessage } from '@/lib/api-error';
import { resolveStoredImageUrl } from '@/lib/image-upload';
import { useTranslation } from '@/lib/i18n';
import { CONSOLE_NAV, SETTINGS_NAV, sectionOf } from '@/lib/navigation';
import { openCreateWorkspace } from './CreateWorkspaceDialog';

/**
 * The console's navigation as Bloom `SidebarProps`: sections as href items (key = route),
 * Settings as a secondary action, the workspace switcher in the `team` slot and the Oxy
 * profile in the footer. The same descriptor feeds the desktop panel, the rail and the
 * mobile drawer; Bloom owns measurement, collapse and drawer chrome.
 *
 * `onAction` runs after any navigation or action, so the shell can close its drawer.
 */
export function useConsoleSidebar({ onAction }: { onAction?: () => void } = {}): SidebarProps {
  const { t } = useTranslation();
  const router = useRouter();
  const pathname = usePathname();
  const { oxyServices, openAccountDialog } = useOxy();
  const { open: openSettings } = useConsoleSettings();
  const labels = useAccountLabels();
  const { accounts, currentAccount, setCurrentAccount } = useAccount();
  const [collapsed, setCollapsed] = useState(false);

  const avatarOf = useCallback(
    (node: AccountNode): SidebarAvatar => ({
      source: resolveStoredImageUrl(oxyServices, node.account.avatar),
      initials: accountInitials(accountLabel(node)),
    }),
    [oxyServices],
  );

  const items = useMemo<Array<SidebarNavItem>>(
    () =>
      CONSOLE_NAV.map((entry) => ({
        key: entry.href,
        label: t(entry.labelKey),
        icon: entry.icon,
        ...(entry.external
          ? {
              onPress: () => {
                void Linking.openURL(entry.external as string);
                onAction?.();
              },
            }
          : { href: entry.href }),
      })),
    [t, onAction],
  );

  const secondaryItems = useMemo<Array<SidebarNavItem>>(
    () => [
      {
        key: SETTINGS_NAV.key,
        label: t(SETTINGS_NAV.labelKey),
        icon: SETTINGS_NAV.icon,
        onPress: () => {
          openSettings();
          onAction?.();
        },
      },
    ],
    [t, openSettings, onAction],
  );

  const team = useMemo<SidebarProps['team']>(() => {
    if (!currentAccount) return undefined;
    const { yourAccounts, sharedAccounts, childrenOf } = buildWorkspaceTree(accounts);

    const switchTo = async (node: AccountNode) => {
      if (node.accountId === currentAccount.accountId) return;
      try {
        await setCurrentAccount(node);
        toast.success(t('settingsPage.switcher.switched', { name: accountLabel(node) }));
      } catch (error) {
        toast.error(getErrorMessage(error, t('settingsPage.switcher.switchFailed')));
      }
    };

    const rows = (roots: Array<AccountNode>): Array<SidebarMenuItem> =>
      roots.flatMap((root) =>
        [root, ...childrenOf(root.accountId)].map((node) => ({
          key: node.accountId,
          label: accountLabel(node),
          icon: node.kind === 'personal' ? RiUserLine : RiBuilding2Line,
          badge: labels.accountRole(node) ?? undefined,
          selected: node.accountId === currentAccount.accountId,
          onPress: () => void switchTo(node),
        })),
      );

    const groups: Array<SidebarMenuGroup> = [
      { id: 'yours', label: t('settingsPage.switcher.workspaces'), items: rows(yourAccounts) },
      ...(sharedAccounts.length > 0
        ? [{ id: 'shared', label: t('settingsPage.switcher.shared'), items: rows(sharedAccounts) }]
        : []),
      {
        id: 'actions',
        items: [
          {
            key: 'workspace-settings',
            label: t('settingsPage.switcher.settings'),
            icon: SETTINGS_NAV.icon,
            onPress: () => {
              openSettings('account');
              onAction?.();
            },
          },
          {
            key: 'create-workspace',
            label: t('settingsPage.switcher.create'),
            icon: RiAddLine,
            onPress: () => {
              openCreateWorkspace();
              onAction?.();
            },
          },
        ],
      },
    ];

    return {
      name: accountLabel(currentAccount),
      email: labels.kind(currentAccount.kind),
      avatar: avatarOf(currentAccount),
      groups,
      menuLabel: t('settingsPage.switcher.label'),
    };
  }, [accounts, currentAccount, setCurrentAccount, labels, avatarOf, openSettings, onAction, t]);

  return {
    surface: 'plain',
    items,
    secondaryItems,
    selected: sectionOf(pathname),
    onNavigate: (item) => {
      if (item.href) router.navigate(item.href as never);
      onAction?.();
    },
    team,
    logo: {
      icon: <LogoIcon height={28} />,
      wordmark: t('app.name'),
      accessibilityLabel: t('app.name'),
      onPress: () => {
        router.navigate('/dashboard');
        onAction?.();
      },
    },
    collapsed,
    onCollapsedChange: setCollapsed,
    showSearch: false,
    showThemeToggle: false,
    footer: ({ collapsed: compact }) => (
      <ProfileButton
        expanded={!compact}
        placement="up"
        onAddAccount={() => openAccountDialog('signin')}
      />
    ),
  };
}
