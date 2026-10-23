import { useAppShellPanel } from '@oxy.so/bloom/app-shell';
import { EmptyState } from '@oxy.so/bloom/empty-state';
import { PageHeader } from '@oxy.so/bloom/page-header';
import { Screen, ScreenScrollView } from '@oxy.so/bloom/screen';
import * as Skeleton from '@oxy.so/bloom/skeleton';
import { Slot, useLocalSearchParams, useRouter } from 'expo-router';

import { AppDetailProvider } from '@/components/apps/app-context';
import { ApplicationHeader } from '@/components/apps/ApplicationHeader';
import { useApplication, useCallerAccess } from '@/hooks/use-applications';
import { useTranslation } from '@/lib/i18n';

/**
 * Application detail: a `Screen` whose header carries the identity and the
 * section tabs, with the routed section below. Sections read the loaded
 * application with `useAppDetail()` and render bare content; this layout owns
 * the scrolling and the width.
 */
export default function AppDetailLayout() {
  const { t } = useTranslation();
  const router = useRouter();
  const { alone } = useAppShellPanel();
  const { appId } = useLocalSearchParams<{ appId: string }>();
  const { data: application, isLoading, refetch } = useApplication(appId);
  // Access derives from the caller's membership in the application's OWNING
  // account, embedded on the response as `callerMembership`. Members are managed
  // at the account level (Settings), not per application.
  const access = useCallerAccess(application);

  if (!application) {
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
            <Skeleton.Box width="100%" height={160} borderRadius={20} />
          </ScreenScrollView>
        ) : (
          <EmptyState
            title={t('applications.loadFailed')}
            action={{ label: t('applications.retry'), onPress: () => void refetch() }}
            secondaryAction={{
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
      <Screen header={<ApplicationHeader application={application} access={access} />}>
        <ScreenScrollView
          contentContainerClassName="w-full max-w-5xl gap-6 p-4 pb-12"
          keyboardShouldPersistTaps="handled"
        >
          <Slot />
        </ScreenScrollView>
      </Screen>
    </AppDetailProvider>
  );
}
