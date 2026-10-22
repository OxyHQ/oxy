import { useAppShellPanel } from '@oxy.so/bloom/app-shell';
import { EmptyState } from '@oxy.so/bloom/empty-state';
import { PageHeader } from '@oxy.so/bloom/page-header';
import { Screen, ScreenScrollView } from '@oxy.so/bloom/screen';
import * as Skeleton from '@oxy.so/bloom/skeleton';
import { Slot, useLocalSearchParams, useRouter } from 'expo-router';

import { AppDetailProvider } from '@/components/apps/app-context';
import { AppDetailHeader } from '@/components/apps/app-detail-header';
import { useApplication, useCallerAccess } from '@/hooks/use-applications';
import { useTranslation } from '@/lib/i18n';

/**
 * Application detail: a `Screen` whose header carries the section tabs, and the
 * routed section below it. Sections read the loaded application with `useAppDetail()`.
 */
export default function AppDetailLayout() {
  const { t } = useTranslation();
  const router = useRouter();
  const { alone } = useAppShellPanel();
  const { appId } = useLocalSearchParams<{ appId: string }>();
  const { data: application, isLoading, isError } = useApplication(appId);
  // Access derives from the caller's membership in the application's OWNING
  // account, embedded on the application response as `callerMembership`. Members
  // are managed at the account level (Settings), not per application.
  const access = useCallerAccess(application);

  if (isLoading || isError || !application) {
    return (
      <Screen
        header={
          <PageHeader
            safeArea={false}
            onBack={alone ? () => router.navigate('/apps') : undefined}
            backLabel={t('applications.backToList')}
          />
        }
      >
        {isLoading ? (
          <ScreenScrollView contentContainerClassName="gap-4 p-4">
            <Skeleton.Box width={240} height={28} />
            <Skeleton.Box width="100%" height={120} borderRadius={14} />
          </ScreenScrollView>
        ) : (
          <EmptyState
            title={t('applications.loadFailed')}
            action={{
              label: t('applications.backToList'),
              onPress: () => router.navigate('/apps'),
            }}
          />
        )}
      </Screen>
    );
  }

  return (
    <AppDetailProvider application={application} access={access}>
      <Screen header={<AppDetailHeader application={application} access={access} />}>
        <ScreenScrollView
          contentContainerClassName="w-full max-w-4xl gap-6 p-4"
          keyboardShouldPersistTaps="handled"
        >
          <Slot />
        </ScreenScrollView>
      </Screen>
    </AppDetailProvider>
  );
}
