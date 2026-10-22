import { AppShell } from '@oxy.so/bloom/app-shell';
import type { SidebarNavItem, SidebarProps } from '@oxy.so/bloom/sidebar';
import { ProfileButton, useOxy } from '@oxy.so/services/ui/client';
import { usePathname, useRouter } from 'expo-router';
import { type ReactNode, useCallback, useState } from 'react';

import { AccountSwitcher } from '@/components/settings/AccountSwitcher';
import { CommandMenu } from './CommandMenu';
import { useTranslation } from '@/lib/i18n';
import { CONSOLE_NAV, buildSidebarItems, sectionOf } from '@/lib/navigation';
import { ConsoleBottomBar } from './ConsoleBottomBar';
import {
  CONSOLE_DETAIL_PANEL,
  CONSOLE_LIST_PANEL,
  CONSOLE_PANELS,
  CONSOLE_WORKSPACE,
} from './workspace';

interface ConsoleShellProps {
  children: ReactNode;
  /** Optional list pane rendered beside the routed detail (desktop split). */
  list?: ReactNode;
}

export function ConsoleShell({ children, list }: ConsoleShellProps) {
  const { t } = useTranslation();
  const router = useRouter();
  const pathname = usePathname();
  const { openAccountDialog } = useOxy();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [listWidth, setListWidth] = useState<number>(CONSOLE_LIST_PANEL.width);

  const onNavigate = useCallback(
    (item: SidebarNavItem) => {
      const entry = CONSOLE_NAV.find((candidate) => candidate.key === item.key);
      if (entry) router.navigate(entry.href);
      setDrawerOpen(false);
    },
    [router],
  );

  const sidebar: SidebarProps = {
    items: buildSidebarItems(t),
    selected: sectionOf(pathname),
    onNavigate,
    collapsed,
    onCollapsedChange: setCollapsed,
    logo: {
      wordmark: t('app.name'),
      onPress: () => {
        router.navigate('/dashboard');
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

  const errorBoundary = { resetKey: pathname };

  return (
    <>
      <CommandMenu />
      <AppShell
        {...CONSOLE_WORKSPACE}
        testID="console-workspace"
        drawerOpen={drawerOpen}
        onDrawerOpenChange={setDrawerOpen}
        sidebar={sidebar}
        bottomBar={<ConsoleBottomBar />}
        drawerOpenLabel={t('shell.openMenu')}
        drawerCloseLabel={t('common.close')}
        panelLayout={{
          ...CONSOLE_PANELS,
          activePanel: 'detail',
          widths: { list: listWidth },
          onWidthsChange: (widths) => setListWidth(widths.list ?? listWidth),
          panels: [
            ...(list
              ? [
                  {
                    ...CONSOLE_LIST_PANEL,
                    resizable: true,
                    resizeLabel: t('shell.resizePanes'),
                    errorBoundary,
                    content: list,
                  },
                ]
              : []),
            { ...CONSOLE_DETAIL_PANEL, errorBoundary, content: children },
          ],
        }}
      />
    </>
  );
}
