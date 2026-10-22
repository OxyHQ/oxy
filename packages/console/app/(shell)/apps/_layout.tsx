import { AppShellPanel, AppShellPanels } from '@oxy.so/bloom/app-shell';
import { Slot, usePathname } from 'expo-router';

import { ApplicationsListPanel } from '@/components/apps/applications-list-panel';

/**
 * Applications: a resizable list panel beside the selected application's detail
 * panel, like Inbox's mailbox split. Below `lg` one panel shows at a time: the
 * list at `/apps`, the detail once an application is open.
 */
export default function AppsLayout() {
  const pathname = usePathname();
  const hasSelection = /^\/apps\/[^/]+/.test(pathname);

  return (
    <AppShellPanels collapseBelow="lg" show={hasSelection ? 'detail' : 'list'}>
      <AppShellPanel id="list" width={380} minWidth={320} maxWidth={520} resizable>
        <ApplicationsListPanel />
      </AppShellPanel>
      <AppShellPanel id="detail" minWidth={420}>
        <Slot />
      </AppShellPanel>
    </AppShellPanels>
  );
}
