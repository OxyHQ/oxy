import { AppShell } from '@oxy.so/bloom/app-shell';
import type { SidebarNavItem, SidebarProps } from '@oxy.so/bloom/sidebar';
import { ProfileButton, useOxy } from '@oxy.so/services/ui/client';
import { type Href, usePathname, useRouter } from 'expo-router';
import { type ReactNode, useCallback, useState } from 'react';
import { Linking } from 'react-native';

import { AccountSwitcher } from '@/components/settings/AccountSwitcher';
import { useConsoleSettings } from '@/components/settings/ConsoleSettings';
import { useTranslation } from '@/lib/i18n';
import { buildSecondaryItems, buildSidebarItems, sectionOf } from '@/lib/navigation';
import { CommandMenu } from './CommandMenu';
import { ConsoleBottomBar } from './ConsoleBottomBar';

/**
 * The console frame, composed like Homiio's: `AppShell variant="feed" panels` owns the
 * gutter, sidebar, drawer and bottom bar; the route group below wraps each page in an
 * `AppShellPanel`, and each page's `Screen` owns its `PageHeader`.
 */
export function ConsoleShell({ children }: { children: ReactNode }) {
  const { t } = useTranslation();
  const router = useRouter();
  const pathname = usePathname();
  const { openAccountDialog } = useOxy();
  const { open: openSettings } = useConsoleSettings();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(false);

  const onNavigate = useCallback(
    (item: SidebarNavItem) => {
      if (item.href) router.push(item.href as Href);
      setDrawerOpen(false);
    },
    [router],
  );

  const sidebar: SidebarProps = {
    items: buildSidebarItems(t, (url) => void Linking.openURL(url)),
    secondaryItems: buildSecondaryItems(t, () => {
      openSettings();
      setDrawerOpen(false);
    }),
    selected: sectionOf(pathname),
    onNavigate,
    collapsed,
    onCollapsedChange: setCollapsed,
    logo: {
      wordmark: t('app.name'),
      onPress: () => {
        router.push('/dashboard');
        setDrawerOpen(false);
      },
    },
    header: ({ collapsed: compact }) => <AccountSwitcher compact={compact} />,
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

  return (
    <>
      <CommandMenu />
      <AppShell
        variant="feed"
        panels
        scroll="page"
        sidebar={sidebar}
        drawer="reveal"
        drawerOpen={drawerOpen}
        onDrawerOpenChange={setDrawerOpen}
        drawerOpenLabel={t('shell.openMenu')}
        drawerCloseLabel={t('common.close')}
        header={null}
        contentWidth={1800}
        navigationAlign="content"
        navigationGap={8}
        gutter={8}
        bottomBar={<ConsoleBottomBar />}
        testID="console-workspace"
      >
        {children}
      </AppShell>
    </>
  );
}
