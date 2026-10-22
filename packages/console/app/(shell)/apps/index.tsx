import { Avatar } from '@oxy.so/bloom/avatar';
import { Badge } from '@oxy.so/bloom/badge';
import { Button } from '@oxy.so/bloom/button';
import { EmptyState } from '@oxy.so/bloom/empty-state';
import { RiAddLine } from '@oxy.so/bloom/icons/RiAddLine';
import { RiArrowRightSLine } from '@oxy.so/bloom/icons/RiArrowRightSLine';
import { RiBox3Line } from '@oxy.so/bloom/icons/RiBox3Line';
import { RiFileCopyLine } from '@oxy.so/bloom/icons/RiFileCopyLine';
import { Item } from '@oxy.so/bloom/item';
import { PageHeader } from '@oxy.so/bloom/page-header';
import * as Skeleton from '@oxy.so/bloom/skeleton';
import { useAuth } from '@oxy.so/services/ui/client';
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { ScrollView, View } from 'react-native';

import { CreateApplicationDialog } from '@/components/apps/create-application-dialog';
import { MutedIcon, copyToClipboard } from '@/components/apps/primitives';
import { useAccount } from '@/hooks/use-account';
import { useApplications } from '@/hooks/use-applications';
import { useTranslation } from '@/lib/i18n';
import { resolveStoredImageUrl } from '@/lib/image-upload';

export default function ApplicationsScreen() {
  const { t } = useTranslation();
  const router = useRouter();
  const { oxyServices } = useAuth();
  const { currentAccount, canCreateApplications } = useAccount();
  const { data: applications = [], isLoading } = useApplications();
  const [showCreate, setShowCreate] = useState(false);

  // Creating an application is `apps:create` on the ACTIVE account, read from
  // the server's own permission list on `callerMembership` rather than inferred
  // from the role name — the server is the only authority on the role map, and
  // a per-member revoke can withdraw the permission without changing the role.
  const canCreate = currentAccount ? canCreateApplications(currentAccount) : false;

  return (
    <View className="flex-1 bg-background">
      <PageHeader
        presentation="bar"
        safeArea={false}
        sticky={false}
        title={t('applications.title')}
        subtitle={t('applications.subtitle')}
        actions={
          canCreate ? (
            <Button leadingIcon={RiAddLine} onPress={() => setShowCreate(true)}>
              {t('applications.create.cta')}
            </Button>
          ) : undefined
        }
      />
      <ScrollView className="flex-1" contentContainerClassName="w-full max-w-3xl px-4 pb-6">
        {isLoading ? (
          <View className="gap-4 py-6">
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
          <View>
            {applications.map((app) => (
              <Item
                key={app._id}
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
                      onPress={() => void copyToClipboard(app._id, t('applications.idCopied'))}
                    />
                    <MutedIcon icon={RiArrowRightSLine} />
                  </View>
                }
              />
            ))}
          </View>
        )}
      </ScrollView>
      <CreateApplicationDialog open={showCreate} onClose={() => setShowCreate(false)} />
    </View>
  );
}
