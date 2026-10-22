import { Avatar } from '@oxy.so/bloom/avatar';
import { Button } from '@oxy.so/bloom/button';
import { RiAddLine } from '@oxy.so/bloom/icons/RiAddLine';
import { RiArrowRightSLine } from '@oxy.so/bloom/icons/RiArrowRightSLine';
import { RiBarChartLine } from '@oxy.so/bloom/icons/RiBarChartLine';
import { RiExternalLinkLine } from '@oxy.so/bloom/icons/RiExternalLinkLine';
import { RiFileCopyLine } from '@oxy.so/bloom/icons/RiFileCopyLine';
import { RiGroupLine } from '@oxy.so/bloom/icons/RiGroupLine';
import { RiKey2Line } from '@oxy.so/bloom/icons/RiKey2Line';
import { RiPlugLine } from '@oxy.so/bloom/icons/RiPlugLine';
import { RiRocket2Line } from '@oxy.so/bloom/icons/RiRocket2Line';
import { RiSettings3Line } from '@oxy.so/bloom/icons/RiSettings3Line';
import { RiSparklingLine } from '@oxy.so/bloom/icons/RiSparklingLine';
import { RiStore2Line } from '@oxy.so/bloom/icons/RiStore2Line';
import type { SidebarIcon, SidebarTree, SidebarTreeItem } from '@oxy.so/bloom/sidebar';
import { useOxy } from '@oxy.so/services/ui/client';
import { usePathname, useRouter } from 'expo-router';
import { useCallback, useMemo, useState } from 'react';
import { View } from 'react-native';

import { useApplications } from '@/hooks/use-applications';
import { copyText } from '@/lib/clipboard';
import { useTranslation } from '@/lib/i18n';
import { resolveStoredImageUrl } from '@/lib/image-upload';
import {
  type AppTab,
  activeAppIdOf,
  appHref,
  buildApplicationRows,
  selectedTreeKeyOf,
} from '@/lib/sidebar-tree';
import { openNewApplication } from './NewApplicationDialog';

const TAB_ICONS: Record<AppTab, SidebarIcon> = {
  general: RiSettings3Line,
  credentials: RiKey2Line,
  roles: RiGroupLine,
  webhooks: RiPlugLine,
  usage: RiBarChartLine,
  inference: RiSparklingLine,
  store: RiStore2Line,
  updates: RiRocket2Line,
};

/**
 * The "Applications" section of the sidebar: the ACTIVE workspace's applications as rows that
 * open into their sub-pages, with hover actions, a "View all" row past the limit and a
 * "New application" row. Returns the section plus the selection and press handler that go with it.
 */
export function useApplicationsTree({ onAction }: { onAction?: () => void }) {
  const { t } = useTranslation();
  const router = useRouter();
  const pathname = usePathname();
  const { oxyServices } = useOxy();
  const { data: applications, isLoading, isError } = useApplications();
  const [open, setOpen] = useState<Record<string, boolean>>({});

  const navigate = useCallback(
    (href: string) => {
      router.navigate(href as never);
      onAction?.();
    },
    [router, onAction],
  );

  const section = useMemo<SidebarTree>(() => {
    const { rows, hidden } = buildApplicationRows(applications ?? [], {
      activeAppId: activeAppIdOf(pathname),
      open,
      onOpenChange: (appId, next) => setOpen((all) => ({ ...all, [appId]: next })),
      tabLabel: (tab) => t(`applications.tabs.${tab}`),
      tabIcon: (tab) => TAB_ICONS[tab],
      leading: (app) => (
        <Avatar
          size="xs"
          shape="squircle"
          source={resolveStoredImageUrl(oxyServices, app.icon) ?? null}
          name={app.name}
        />
      ),
      actions: (app) => (
        <View className="flex-row items-center">
          <Button
            appearance="plain"
            size="xs"
            iconOnly
            leadingIcon={RiFileCopyLine}
            accessibilityLabel={t('sidebar.copyId')}
            onPress={() => void copyText(app._id, t('sidebar.idCopied'))}
          />
          <Button
            appearance="plain"
            size="xs"
            iconOnly
            leadingIcon={RiExternalLinkLine}
            accessibilityLabel={t('sidebar.open')}
            onPress={() => navigate(appHref(app._id))}
          />
        </View>
      ),
    });

    const items: Array<SidebarTreeItem> = [...rows];
    if (hidden > 0) {
      items.push({
        key: 'apps:all',
        label: t('sidebar.viewAll'),
        icon: RiArrowRightSLine,
        href: '/apps',
      });
    }
    if (rows.length > 0) {
      items.push({
        key: 'apps:new',
        label: t('sidebar.newApplication'),
        icon: RiAddLine,
        onPress: () => {
          openNewApplication();
          onAction?.();
        },
      });
    }

    return {
      key: 'applications',
      label: t('sidebar.applications'),
      collapsible: true,
      actionsVisibility: 'hover',
      actions: (
        <Button
          appearance="plain"
          size="xs"
          iconOnly
          leadingIcon={RiAddLine}
          accessibilityLabel={t('sidebar.newApplication')}
          onPress={openNewApplication}
        />
      ),
      items,
      loading: isLoading,
      error: isError ? t('sidebar.loadFailed') : undefined,
      emptyLabel: t('sidebar.noApplications'),
    };
  }, [applications, pathname, open, t, oxyServices, navigate, onAction, isLoading, isError]);

  return {
    tree: section,
    selectedTreeItem: selectedTreeKeyOf(pathname),
    onTreeItemPress: (item: SidebarTreeItem) => {
      if (item.href) navigate(item.href);
    },
  };
}
