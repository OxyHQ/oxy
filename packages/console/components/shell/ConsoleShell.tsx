import { AppShell } from '@oxy.so/bloom/app-shell';
import { type ReactNode, useCallback, useState } from 'react';

import { useTranslation } from '@/lib/i18n';
import { CommandMenu } from './CommandMenu';
import { ConsoleBottomBar } from './ConsoleBottomBar';
import { CreateWorkspaceDialog } from './CreateWorkspaceDialog';
import { useConsoleSidebar } from './useConsoleSidebar';

/**
 * The console frame, composed like Homiio's: `AppShell variant="feed" panels` owns the
 * gutter, sidebar (panel, rail, drawer by width) and bottom bar; the route group below wraps
 * each page in an `AppShellPanel`, and each page's `Screen` owns its `PageHeader`
 * (with `AppShellMenuButton` as `leading` to open the drawer).
 */
export function ConsoleShell({ children }: { children: ReactNode }) {
  const { t } = useTranslation();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const closeDrawer = useCallback(() => setDrawerOpen(false), []);
  const sidebar = useConsoleSidebar({ onAction: closeDrawer });

  return (
    <>
      <CommandMenu />
      <CreateWorkspaceDialog />
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
        bottomBarVisibility="compact"
        testID="console-workspace"
      >
        {children}
      </AppShell>
    </>
  );
}
