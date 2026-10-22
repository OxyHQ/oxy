import { useAppShellPanel } from '@oxy.so/bloom/app-shell';
import { Avatar } from '@oxy.so/bloom/avatar';
import { RiBarChartLine } from '@oxy.so/bloom/icons/RiBarChartLine';
import { RiGroupLine } from '@oxy.so/bloom/icons/RiGroupLine';
import { RiKey2Line } from '@oxy.so/bloom/icons/RiKey2Line';
import { RiPlugLine } from '@oxy.so/bloom/icons/RiPlugLine';
import { RiRocket2Line } from '@oxy.so/bloom/icons/RiRocket2Line';
import { RiSettings3Line } from '@oxy.so/bloom/icons/RiSettings3Line';
import { RiSparklingLine } from '@oxy.so/bloom/icons/RiSparklingLine';
import { RiStore2Line } from '@oxy.so/bloom/icons/RiStore2Line';
import { PageHeader } from '@oxy.so/bloom/page-header';
import { RouterTabs, type RouterTabItem } from '@oxy.so/bloom/tabs/expo-router';
import { useAuth } from '@oxy.so/services/ui/client';
import { type Href, useRouter } from 'expo-router';
import { View } from 'react-native';

import type { Application, CallerAccess } from '@/hooks/use-applications';
import { useTranslation } from '@/lib/i18n';
import { resolveStoredImageUrl } from '@/lib/image-upload';

/**
 * The `Screen` header of an application's detail pages: back (when the panel is
 * alone), identity, and the section tabs (the route IS the selection).
 *
 * Each section is offered only to callers holding the permission the API
 * enforces behind it, so nobody sees a tab that would only 403: `credentials:read`,
 * `roles:read`, `webhooks:read` and `usage:read` for their own sections,
 * `app:read` for Inference and Store (each section gates its own writes on
 * `app:update`), and `updates:manage` for Updates.
 */
export function AppDetailHeader({
  application,
  access,
}: {
  application: Application;
  access: CallerAccess;
}) {
  const { t } = useTranslation();
  const router = useRouter();
  const { oxyServices } = useAuth();
  // The back button only exists while the detail panel is drawn alone (below `lg`);
  // beside the list the list itself is the way back.
  const { alone } = useAppShellPanel();
  const base = `/apps/${application._id}`;

  const items: Array<RouterTabItem> = [
    {
      value: 'general',
      label: t('applications.tabs.general'),
      href: base as Href,
      leadingIcon: RiSettings3Line,
    },
  ];
  const add = (
    allowed: boolean,
    value: string,
    label: string,
    leadingIcon: RouterTabItem['leadingIcon'],
  ) => {
    if (allowed) items.push({ value, label, href: `${base}/${value}` as Href, leadingIcon });
  };
  add(
    access.can('credentials:read'),
    'credentials',
    t('applications.tabs.credentials'),
    RiKey2Line,
  );
  add(access.can('roles:read'), 'roles', t('applications.tabs.roles'), RiGroupLine);
  add(access.can('webhooks:read'), 'webhooks', t('applications.tabs.webhooks'), RiPlugLine);
  add(access.can('usage:read'), 'usage', t('applications.tabs.usage'), RiBarChartLine);
  add(access.can('app:read'), 'inference', t('applications.tabs.inference'), RiSparklingLine);
  add(access.can('app:read'), 'store', t('applications.tabs.store'), RiStore2Line);
  add(access.can('updates:manage'), 'updates', t('applications.tabs.updates'), RiRocket2Line);

  return (
    <View>
      <PageHeader
        safeArea={false}
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
      />
      <View className="px-4">
        <RouterTabs items={items} label={t('applications.tabs.label')} />
      </View>
    </View>
  );
}
