import { AppShellPanel, AppShellPanels } from '@oxy.so/bloom/app-shell';
import { Slot, usePathname } from 'expo-router';

import { ApplicationsList } from '@/components/apps/ApplicationsList';
import { useTranslation } from '@/lib/i18n';

/**
 * Applications: a resizable list panel beside the selected application's detail
 * panel, like Inbox's mailbox split. Below `lg` one panel shows at a time: the
 * list at `/apps`, the detail once an application is open.
 */
export default function AppsLayout() {
  const { t } = useTranslation();
  const pathname = usePathname();
  const hasSelection = /^\/apps\/[^/]+/.test(pathname);

  return (
    <AppShellPanels collapseBelow="lg" show={hasSelection ? 'detail' : 'list'}>
      <AppShellPanel
        id="list"
        width={380}
        minWidth={320}
        maxWidth={520}
        resizable
        resizeLabel={t('applications.resize')}
      >
        <ApplicationsList />
      </AppShellPanel>
      <AppShellPanel id="detail" minWidth={420} errorBoundary>
        <Slot />
      </AppShellPanel>
    </AppShellPanels>
  );
}
