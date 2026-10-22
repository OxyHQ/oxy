import { AppShellMenuButton } from '@oxy.so/bloom/app-shell';
import { Avatar } from '@oxy.so/bloom/avatar';
import { Badge } from '@oxy.so/bloom/badge';
import { Button } from '@oxy.so/bloom/button';
import { EmptyState } from '@oxy.so/bloom/empty-state';
import { RiAddLine } from '@oxy.so/bloom/icons/RiAddLine';
import { RiBox3Line } from '@oxy.so/bloom/icons/RiBox3Line';
import { RiFileCopyLine } from '@oxy.so/bloom/icons/RiFileCopyLine';
import { Item } from '@oxy.so/bloom/item';
import { PageHeader } from '@oxy.so/bloom/page-header';
import { Screen, ScreenScrollView } from '@oxy.so/bloom/screen';
import * as Skeleton from '@oxy.so/bloom/skeleton';
import { useAuth } from '@oxy.so/services/ui/client';
import { usePathname, useRouter } from 'expo-router';
import { useState } from 'react';
import { View } from 'react-native';

import { useAccount } from '@/hooks/use-account';
import { useApplications } from '@/hooks/use-applications';
import { copyText } from '@/lib/clipboard';
import { useTranslation } from '@/lib/i18n';
import { resolveStoredImageUrl } from '@/lib/image-upload';
import { CreateApplicationDialog } from './create-application-dialog';

/** The applications list panel: the account's applications, and the create action. */
export function ApplicationsListPanel() {
  const { t } = useTranslation();
  const router = useRouter();
  const pathname = usePathname();
  const { oxyServices } = useAuth();
  const { currentAccount, canCreateApplications } = useAccount();
  const { data: applications = [], isLoading } = useApplications();
  const [showCreate, setShowCreate] = useState(false);
  const selectedId = /^\/apps\/([^/]+)/.exec(pathname)?.[1];

  // Creating an application is `apps:create` on the ACTIVE account, read from
  // the server's own permission list on `callerMembership` rather than inferred
  // from the role name — the server is the only authority on the role map, and
  // a per-member revoke can withdraw the permission without changing the role.
  const canCreate = currentAccount ? canCreateApplications(currentAccount) : false;

  return (
    <Screen
      header={
        <PageHeader
          safeArea={false}
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
                onPress={() => setShowCreate(true)}
              />
            ) : undefined
          }
        />
      }
    >
      <ScreenScrollView contentContainerClassName="pb-6">
        {isLoading ? (
          <View className="gap-4 p-4">
            {[1, 2, 3].map((key) => (
              <View key={key} className="gap-2">
                <Skeleton.Box width={128} height={16} />
                <Skeleton.Box width={192} height={12} />
              </View>
            ))}
          </View>
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
                    onPress: () => setShowCreate(true),
                  }
                : undefined
            }
          />
        ) : (
          applications.map((app) => (
            <Item
              key={app._id}
              selected={app._id === selectedId}
              onPress={() => router.push(`/apps/${app._id}`)}
              accessibilityLabel={app.name}
              title={app.name}
              subtitle={
                app.description
                  ? `${app.description}\n${t('applications.createdOn', { date: new Date(app.createdAt).toLocaleDateString() })}`
                  : t('applications.createdOn', {
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
                <View className="flex-row items-center gap-2">
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
                  <Button
                    iconOnly
                    size="sm"
                    appearance="plain"
                    leadingIcon={RiFileCopyLine}
                    stopPropagation
                    accessibilityLabel={t('applications.copyId')}
                    onPress={() => void copyText(app._id, t('applications.idCopied'))}
                  />
                </View>
              }
            />
          ))
        )}
      </ScreenScrollView>
      <CreateApplicationDialog open={showCreate} onClose={() => setShowCreate(false)} />
    </Screen>
  );
}
