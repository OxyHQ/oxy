import { useAppShellPanel } from '@oxy.so/bloom/app-shell';
import { Avatar } from '@oxy.so/bloom/avatar';
import { PageHeader } from '@oxy.so/bloom/page-header';
import { Tabs, TabsTrigger } from '@oxy.so/bloom/tabs';
import { useAuth } from '@oxy.so/services/ui/client';
import { type Href, usePathname, useRouter } from 'expo-router';

import type { Application, CallerAccess } from '@/hooks/use-applications';
import { useTranslation } from '@/lib/i18n';
import { resolveStoredImageUrl } from '@/lib/image-upload';
import { ApplicationStatusBadge } from './ApplicationStatusBadge';

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

  const tabs: ReadonlyArray<{
    value: string;
    allowed: boolean;
  }> = [
    { value: 'credentials', allowed: access.can('credentials:read') },
    { value: 'roles', allowed: access.can('roles:read') },
    { value: 'webhooks', allowed: access.can('webhooks:read') },
    { value: 'usage', allowed: access.can('usage:read') },
    { value: 'inference', allowed: access.can('app:read') },
    { value: 'store', allowed: access.can('app:read') },
    { value: 'updates', allowed: access.can('updates:manage') },
  ];
  const items: ReadonlyArray<{
    value: string;
    label: string;
    href: Href;
  }> = [
    {
      value: 'general',
      label: t('applications.tabs.general'),
      href: base as Href,
    },
    ...tabs
      .filter((tab) => tab.allowed)
      .map((tab) => ({
        value: tab.value,
        label: t(`applications.tabs.${tab.value}`),
        href: `${base}/${tab.value}` as Href,
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
      actions={<ApplicationStatusBadge status={application.status} />}
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
            <TabsTrigger key={item.value} value={item.value} label={item.label} />
          ))}
        </Tabs>
      }
    />
  );
}
