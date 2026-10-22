import { EmptyState } from '@oxy.so/bloom/empty-state';
import * as Skeleton from '@oxy.so/bloom/skeleton';
import { Slot, useLocalSearchParams, useRouter } from 'expo-router';
import { ScrollView, View } from 'react-native';

import { AppDetailHeader } from '@/components/apps/app-detail-header';
import { AppDetailProvider } from '@/components/apps/app-context';
import { useApplication, useCallerAccess } from '@/hooks/use-applications';
import { useTranslation } from '@/lib/i18n';

/**
 * Application detail: the header with its section tabs, and the routed section
 * below it. Sections read the loaded application with `useAppDetail()`.
 */
export default function AppDetailLayout() {
  const { t } = useTranslation();
  const router = useRouter();
  const { appId } = useLocalSearchParams<{ appId: string }>();
  const { data: application, isLoading, isError } = useApplication(appId);
  // Access derives from the caller's membership in the application's OWNING
  // account, embedded on the application response as `callerMembership`. Members
  // are managed at the account level (Settings), not per application.
  const access = useCallerAccess(application);

  if (isLoading) {
    return (
      <View className="flex-1 gap-4 bg-background p-6">
        <Skeleton.Box width={240} height={28} />
        <Skeleton.Box width="100%" height={120} borderRadius={14} />
      </View>
    );
  }

  if (isError || !application) {
    return (
      <View className="flex-1 justify-center bg-background">
        <EmptyState
          title={t('applications.loadFailed')}
          action={{ label: t('applications.backToList'), onPress: () => router.navigate('/apps') }}
        />
      </View>
    );
  }

  return (
    <AppDetailProvider application={application} access={access}>
      <View className="flex-1 bg-background">
        <AppDetailHeader application={application} access={access} />
        <ScrollView
          className="flex-1"
          contentContainerClassName="w-full max-w-3xl p-6"
          keyboardShouldPersistTaps="handled"
        >
          <Slot />
        </ScrollView>
      </View>
    </AppDetailProvider>
  );
}
