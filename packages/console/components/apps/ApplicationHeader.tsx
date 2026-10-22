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
import { Tabs, TabsTrigger } from '@oxy.so/bloom/tabs';
import { useAuth } from '@oxy.so/services/ui/client';
import type { ComponentProps } from 'react';
import { type Href, usePathname, useRouter } from 'expo-router';

import type { Application, CallerAccess } from '@/hooks/use-applications';
import { useTranslation } from '@/lib/i18n';
import { resolveStoredImageUrl } from '@/lib/image-upload';

/**
 * The detail `Screen` header: identity, then the section tabs in the header's
 * `accessory` (so header and tabs pin together; the route IS the selection, derived from
 * the pathname, not Bloom's `RouterTabs`, which prefetches every section). Back shows only while the detail panel is drawn alone (below `lg`);
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
  const pathname = usePathname();
  const { oxyServices } = useAuth();
  const { alone } = useAppShellPanel();
  const base = `/apps/${application._id}`;
  const active = application.status === 'active';

  const tabs: ReadonlyArray<{
    value: string;
    allowed: boolean;
    icon: ComponentProps<typeof TabsTrigger>['leadingIcon'];
  }> = [
    { value: 'credentials', allowed: access.can('credentials:read'), icon: RiKey2Line },
    { value: 'roles', allowed: access.can('roles:read'), icon: RiGroupLine },
    { value: 'webhooks', allowed: access.can('webhooks:read'), icon: RiPlugLine },
    { value: 'usage', allowed: access.can('usage:read'), icon: RiBarChartLine },
    { value: 'inference', allowed: access.can('app:read'), icon: RiSparklingLine },
    { value: 'store', allowed: access.can('app:read'), icon: RiStore2Line },
    { value: 'updates', allowed: access.can('updates:manage'), icon: RiRocket2Line },
  ];
  const items: ReadonlyArray<{
    value: string;
    label: string;
    href: Href;
    leadingIcon: ComponentProps<typeof TabsTrigger>['leadingIcon'];
  }> = [
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

  const section = pathname.slice(base.length + 1).split('/')[0];
  const selected = items.some((item) => item.value === section) ? section : 'general';

  return (
    <PageHeader
      safeArea={false}
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
      accessory={
        <Tabs
          value={selected}
          onValueChange={(value) => {
            const item = items.find((candidate) => candidate.value === value);
            if (item) router.navigate(item.href);
          }}
          variant="underline"
          label={t('applications.tabs.label')}
        >
          {items.map((item) => (
            <TabsTrigger
              key={item.value}
              value={item.value}
              label={item.label}
              leadingIcon={item.leadingIcon}
            />
          ))}
        </Tabs>
      }
    />
  );
}
