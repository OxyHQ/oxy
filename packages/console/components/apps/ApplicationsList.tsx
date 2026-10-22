import { AppShellMenuButton } from '@oxy.so/bloom/app-shell';
import { Admonition } from '@oxy.so/bloom/admonition';
import { Avatar } from '@oxy.so/bloom/avatar';
import { Badge } from '@oxy.so/bloom/badge';
import { Button } from '@oxy.so/bloom/button';
import { EmptyState } from '@oxy.so/bloom/empty-state';
import { RiAddLine } from '@oxy.so/bloom/icons/RiAddLine';
import { RiBox3Line } from '@oxy.so/bloom/icons/RiBox3Line';
import { Item } from '@oxy.so/bloom/item';
import { PageHeader } from '@oxy.so/bloom/page-header';
import { Screen, ScreenScrollView } from '@oxy.so/bloom/screen';
import { Search } from '@oxy.so/bloom/search';
import * as Skeleton from '@oxy.so/bloom/skeleton';
import { useAuth } from '@oxy.so/services/ui/client';
import { usePathname, useRouter } from 'expo-router';
import { useState } from 'react';
import { View } from 'react-native';

import { useAccount } from '@/hooks/use-account';
import { useApplications } from '@/hooks/use-applications';
import { useTranslation } from '@/lib/i18n';
import { resolveStoredImageUrl } from '@/lib/image-upload';
import { CreateApplicationDialog } from './CreateApplicationDialog';

/** The list panel: the account's applications, a filter and the create action. */
export function ApplicationsList() {
  const { t } = useTranslation();
  const router = useRouter();
  const pathname = usePathname();
  const { oxyServices } = useAuth();
  const { currentAccount, canCreateApplications } = useAccount();
  const { data: applications = [], isLoading, isError, refetch } = useApplications();
  const [creating, setCreating] = useState(false);
  const [query, setQuery] = useState('');
  const selectedId = /^\/apps\/([^/]+)/.exec(pathname)?.[1];

  // Creating an application is `apps:create` on the ACTIVE account, read from the
  // server's own permission list on `callerMembership` rather than inferred from
  // the role name: a per-member revoke can withdraw it without changing the role.
  const canCreate = currentAccount ? canCreateApplications(currentAccount) : false;

  const needle = query.trim().toLowerCase();
  const visible = needle
    ? applications.filter(
        (app) =>
          app.name.toLowerCase().includes(needle) ||
          (app.description ?? '').toLowerCase().includes(needle),
      )
    : applications;

  return (
    <Screen
      header={
        <PageHeader
          safeArea={false}
          presentation="bar"
          leading={<AppShellMenuButton />}
          title={t('applications.title')}
          subtitle={t('applications.subtitle')}
          actions={
            canCreate ? (
              <Button
                iconOnly
                size="sm"
                leadingIcon={RiAddLine}
                accessibilityLabel={t('applications.create.cta')}
                onPress={() => setCreating(true)}
              />
            ) : undefined
          }
        />
      }
    >
      <ScreenScrollView contentContainerClassName="gap-2 p-2 pb-6">
        {applications.length > 5 ? (
          <View className="px-2 pb-1">
            <Search
              label={t('applications.search')}
              placeholder={t('applications.search')}
              value={query}
              onChangeText={setQuery}
            />
          </View>
        ) : null}
        {isLoading ? (
          <View className="gap-4 p-3">
            {[1, 2, 3].map((key) => (
              <View key={key} className="flex-row items-center gap-3">
                <Skeleton.Circle size={40} />
                <View className="gap-2">
                  <Skeleton.Box width={128} height={14} />
                  <Skeleton.Box width={192} height={12} />
                </View>
              </View>
            ))}
          </View>
        ) : isError ? (
          <Admonition type="error">
            {t('applications.listFailed')}{' '}
            <Button size="sm" appearance="plain" onPress={() => void refetch()}>
              {t('applications.retry')}
            </Button>
          </Admonition>
        ) : applications.length === 0 ? (
          <EmptyState
            icon={RiBox3Line}
            title={t('applications.empty.title')}
            description={
              canCreate ? t('applications.empty.canCreate') : t('applications.empty.cannotCreate')
            }
            action={
              canCreate
                ? {
                    label: t('applications.empty.cta'),
                    icon: RiAddLine,
                    onPress: () => setCreating(true),
                  }
                : undefined
            }
          />
        ) : visible.length === 0 ? (
          <EmptyState title={t('applications.noMatches')} />
        ) : (
          visible.map((app) => (
            <Item
              key={app._id}
              selected={app._id === selectedId}
              onPress={() => router.push(`/apps/${app._id}`)}
              accessibilityLabel={app.name}
              title={app.name}
              subtitle={
                app.description ||
                t('applications.createdOn', {
                  date: new Date(app.createdAt).toLocaleDateString(),
                })
              }
              leading={
                <Avatar
                  size="md"
                  name={app.name}
                  source={resolveStoredImageUrl(oxyServices, app.icon) ?? null}
                />
              }
              trailing={
                <Badge
                  content={
                    app.status === 'active'
                      ? t('applications.status.active')
                      : t('applications.status.inactive')
                  }
                  size="label-small"
                  variant={app.status === 'active' ? 'solid' : 'subtle'}
                  color={app.status === 'active' ? 'success' : 'default'}
                />
              }
            />
          ))
        )}
      </ScreenScrollView>
      <CreateApplicationDialog open={creating} onClose={() => setCreating(false)} />
    </Screen>
  );
}
