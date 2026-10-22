import { useAppShellPanel } from '@oxy.so/bloom/app-shell';
import { Avatar } from '@oxy.so/bloom/avatar';
import { Badge } from '@oxy.so/bloom/badge';
import { RiBarChartLine } from '@oxy.so/bloom/icons/RiBarChartLine';
import { RiGroupLine } from '@oxy.so/bloom/icons/RiGroupLine';
import { RiKey2Line } from '@oxy.so/bloom/icons/RiKey2Line';
import { RiPlugLine } from '@oxy.so/bloom/icons/RiPlugLine';
import { RiRocket2Line } from '@oxy.so/bloom/icons/RiRocket2Line';
import { RiSettings3Line } from '@oxy.so/bloom/icons/RiSettings3Line';
import { RiSparklingLine } from '@oxy.so/bloom/icons/RiSparklingLine';
import { RiStore2Line } from '@oxy.so/bloom/icons/RiStore2Line';
import { PageHeader } from '@oxy.so/bloom/page-header';
import { type RouterTabItem, RouterTabs } from '@oxy.so/bloom/tabs/expo-router';
import { useAuth } from '@oxy.so/services/ui/client';
import { type Href, useRouter } from 'expo-router';
import { View } from 'react-native';

import type { Application, CallerAccess } from '@/hooks/use-applications';
import { useTranslation } from '@/lib/i18n';
import { resolveStoredImageUrl } from '@/lib/image-upload';

/**
 * The detail `Screen` header: identity, then the section tabs (the route IS the
 * selection). Back shows only while the detail panel is drawn alone (below `lg`);
 * beside the list, the list is the way back.
 *
 * Each tab is offered only to callers holding the permission the API enforces
 * behind it, so nobody sees a tab that would only 403: `credentials:read`,
 * `roles:read`, `webhooks:read`, `usage:read`, `app:read` for Inference and Store
 * (each gates its own writes on `app:update`), and `updates:manage` for Updates.
 */
export function ApplicationHeader({
  application,
  access,
}: {
  application: Application;
  access: CallerAccess;
}) {
  const { t } = useTranslation();
  const router = useRouter();
  const { oxyServices } = useAuth();
  const { alone } = useAppShellPanel();
  const base = `/apps/${application._id}`;
  const active = application.status === 'active';

  const tabs: ReadonlyArray<{
    value: string;
    allowed: boolean;
    icon: RouterTabItem['leadingIcon'];
  }> = [
    { value: 'credentials', allowed: access.can('credentials:read'), icon: RiKey2Line },
    { value: 'roles', allowed: access.can('roles:read'), icon: RiGroupLine },
    { value: 'webhooks', allowed: access.can('webhooks:read'), icon: RiPlugLine },
    { value: 'usage', allowed: access.can('usage:read'), icon: RiBarChartLine },
    { value: 'inference', allowed: access.can('app:read'), icon: RiSparklingLine },
    { value: 'store', allowed: access.can('app:read'), icon: RiStore2Line },
    { value: 'updates', allowed: access.can('updates:manage'), icon: RiRocket2Line },
  ];
  const items: Array<RouterTabItem> = [
    {
      value: 'general',
      label: t('applications.tabs.general'),
      href: base as Href,
      leadingIcon: RiSettings3Line,
    },
    ...tabs
      .filter((tab) => tab.allowed)
      .map((tab) => ({
        value: tab.value,
        label: t(`applications.tabs.${tab.value}`),
        href: `${base}/${tab.value}` as Href,
        leadingIcon: tab.icon,
      })),
  ];

  return (
    <View>
      <PageHeader
        safeArea={false}
        presentation="bar"
        border="none"
        title={application.name}
        subtitle={application.description || undefined}
        onBack={alone ? () => router.navigate('/apps') : undefined}
        backLabel={t('applications.backToList')}
        leading={
          <Avatar
            size="md"
            name={application.name}
            source={resolveStoredImageUrl(oxyServices, application.icon) ?? null}
          />
        }
        actions={
          <Badge
            content={active ? t('applications.status.active') : t('applications.status.inactive')}
            size="label-small"
            variant={active ? 'solid' : 'subtle'}
            color={active ? 'success' : 'default'}
          />
        }
      />
      <View className="px-4">
        <RouterTabs items={items} label={t('applications.tabs.label')} />
      </View>
    </View>
  );
}
