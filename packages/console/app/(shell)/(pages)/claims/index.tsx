import { AppShellMenuButton } from '@oxy.so/bloom/app-shell';
import { PageHeader } from '@oxy.so/bloom/page-header';
import { Screen, ScreenScrollView } from '@oxy.so/bloom/screen';

import { ClaimsQueue } from '@/components/claims/ClaimsQueue';
import { ClaimsRefusal } from '@/components/claims/ClaimsRefusal';
import { DetailSkeleton } from '@/components/loading/ContentSkeleton';
import { useContentClaimsAccess } from '@/hooks/use-content-claims';
import { useTranslation } from '@/lib/i18n';

/** The content-claim queue (ADR 0043 D10), for the staff who hold `content:claims`. */
export default function ContentClaimsScreen() {
  const { t } = useTranslation();
  const access = useContentClaimsAccess();

  return (
    <Screen
      scroll="auto"
      header={
        <PageHeader
          title={t('claimsPage.title')}
          subtitle={t('claimsPage.subtitle')}
          leading={<AppShellMenuButton />}
          safeArea={false}
        />
      }
    >
      <ScreenScrollView contentContainerClassName="p-4 md:p-6">
        {access.isLoading ? (
          <DetailSkeleton />
        ) : access.data?.canReview === true ? (
          <ClaimsQueue />
        ) : (
          <ClaimsRefusal />
        )}
      </ScreenScrollView>
    </Screen>
  );
}
