import { RiAddLine } from '@oxy.so/bloom/icons/RiAddLine';
import { RiBookOpenLine } from '@oxy.so/bloom/icons/RiBookOpenLine';
import { RiLogoutBoxRLine } from '@oxy.so/bloom/icons/RiLogoutBoxRLine';
import { RiSearchLine } from '@oxy.so/bloom/icons/RiSearchLine';
import type {
  SidebarAvatar,
  SidebarMenuGroup,
  SidebarMenuItem,
  SidebarNavItem,
  SidebarProps,
} from '@oxy.so/bloom/sidebar';
import { toast } from '@oxy.so/bloom/toast';
import { useOxy } from '@oxy.so/services/ui/client';
import {
  getAccountDisplayName,
  getAccountFallbackHandle,
  getNormalizedUserHandle,
} from '@oxy.so/core';
import { usePathname, useRouter } from 'expo-router';
import { useCallback, useMemo, useState } from 'react';
import { Linking } from 'react-native';

import { useConsoleSettings } from '@/components/settings/ConsoleSettings';
import { accountInitials, useAccountLabels } from '@/components/settings/account-labels';
import { buildWorkspaceTree } from '@/components/settings/workspace-tree';
import { useContentClaimsAccess } from '@/hooks/use-content-claims';
import { type AccountNode, accountLabel, useAccount } from '@/hooks/use-account';
import { getErrorMessage } from '@/lib/api-error';
import { resolveStoredImageUrl } from '@/lib/image-upload';
import { useTranslation } from '@/lib/i18n';
import { CONSOLE_NAV, SETTINGS_NAV, sectionOf } from '@/lib/navigation';
import { selectedNavKeyOf } from '@/lib/sidebar-tree';
import { openCommandMenu } from './CommandMenu';
import { openCreateWorkspace } from './CreateWorkspaceDialog';
import { useApplicationsTree } from './useApplicationsTree';

/**
 * The console's navigation as Bloom `SidebarProps`, laid out like Notion's: the active
 * workspace is the switcher at the top (`team` + `teamPlacement="header"`), then Search (the
 * ⌘K palette), the section rows, the Applications tree, and Settings and Documentation as
 * secondary rows above the Oxy profile. The same descriptor feeds the desktop panel, the rail
 * and the mobile drawer; Bloom owns measurement, collapse and drawer chrome.
 *
 * `onAction` runs after any navigation or action, so the shell can close its drawer.
 */
export function useConsoleSidebar({ onAction }: { onAction?: () => void } = {}): SidebarProps {
  const { t } = useTranslation();
  const router = useRouter();
  const pathname = usePathname();
  const { oxyServices, openAccountDialog, user, isAuthenticated, logout } = useOxy();
  const { open: openSettings } = useConsoleSettings();
  const labels = useAccountLabels();
  const { accounts, currentAccount, setCurrentAccount } = useAccount();
  const isStaff = useContentClaimsAccess().data?.canReview === true;
  const [collapsed, setCollapsed] = useState(false);

  const avatarOf = useCallback(
    (node: AccountNode): SidebarAvatar => ({
      source: resolveStoredImageUrl(oxyServices, node.account.avatar),
      initials: accountInitials(accountLabel(node)),
      shape: node.kind === 'personal' ? 'circle' : 'squircle',
    }),
    [oxyServices],
  );

  const applicationsTree = useApplicationsTree({ onAction });

  const items = useMemo<Array<SidebarNavItem>>(
    () => [
      {
        key: 'search',
        label: t('sidebar.search'),
        icon: RiSearchLine,
        shortcut: 'Mod+K',
        // CommandMenu binds the key itself; the row only shows the hint.
        shortcutBinding: 'app',
        onPress: () => {
          openCommandMenu();
          onAction?.();
        },
      },
      ...CONSOLE_NAV.filter((entry) => !entry.external && (!entry.staff || isStaff)).map(
        (entry) => ({
          key: entry.href,
          label: t(entry.labelKey),
          icon: entry.icon,
          href: entry.href,
        }),
      ),
    ],
    [t, onAction, isStaff],
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
      ...CONSOLE_NAV.filter((entry) => entry.external).map((entry) => ({
        key: entry.href,
        label: t(entry.labelKey),
        icon: RiBookOpenLine,
        onPress: () => {
          void Linking.openURL(entry.external as string);
          onAction?.();
        },
      })),
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
          avatar: avatarOf(node),
          description: labels.accountRole(node) ?? labels.kind(node.kind),
          selected: node.accountId === currentAccount.accountId,
          onPress: () => void switchTo(node),
        })),
      );

    const groups: Array<SidebarMenuGroup> = [
      {
        id: 'yours',
        label: t('settingsPage.switcher.workspaces'),
        selection: 'single',
        items: rows(yourAccounts),
      },
      ...(sharedAccounts.length > 0
        ? [
            {
              id: 'shared',
              label: t('settingsPage.switcher.shared'),
              selection: 'single' as const,
              items: rows(sharedAccounts),
            },
          ]
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
      avatar: avatarOf(currentAccount),
      groups,
      menuLabel: t('settingsPage.switcher.label'),
    };
  }, [accounts, currentAccount, setCurrentAccount, labels, avatarOf, openSettings, onAction, t]);

  const account = useMemo<SidebarProps['account']>(() => {
    if (!isAuthenticated || !user) return undefined;
    const name =
      user.name?.displayName ?? getNormalizedUserHandle(user) ?? getAccountDisplayName(null);
    const handle = getAccountFallbackHandle(user);
    return {
      name,
      email: handle ? `@${handle}` : undefined,
      // A bare Oxy file id or URL; thumb resolution matches the workspace avatars.
      avatar: {
        source: resolveStoredImageUrl(oxyServices, user.avatar),
        initials: accountInitials(name),
      },
      menuLabel: t('sidebar.accountMenu'),
      onManage: () => {
        openAccountDialog('accounts');
        onAction?.();
      },
      onAddUser: () => {
        openAccountDialog('signin');
        onAction?.();
      },
      groups: [
        {
          id: 'session',
          items: [
            {
              key: 'sign-out',
              label: t('sidebar.signOut'),
              icon: RiLogoutBoxRLine,
              tone: 'destructive',
              onPress: () => {
                void logout();
                onAction?.();
              },
            },
          ],
        },
      ],
    };
  }, [isAuthenticated, user, oxyServices, openAccountDialog, logout, onAction, t]);

  return {
    surface: 'docked',
    size: 'sm',
    items,
    secondaryItems,
    selected: selectedNavKeyOf(pathname, sectionOf),
    onNavigate: (item) => {
      if (item.href) router.navigate(item.href as never);
      onAction?.();
    },
    team,
    teamPlacement: 'header',
    ...applicationsTree,
    collapsed,
    onCollapsedChange: setCollapsed,
    showSearch: false,
    showThemeToggle: false,
    account,
  };
}
