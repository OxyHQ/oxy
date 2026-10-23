import { AppShellMenuButton } from '@oxy.so/bloom/app-shell';
import { PageHeader } from '@oxy.so/bloom/page-header';
import { Screen, ScreenScrollView } from '@oxy.so/bloom/screen';
import { useLocalSearchParams, useRouter } from 'expo-router';

import { ClaimDetail } from '@/components/claims/ClaimDetail';
import { ClaimsRefusal } from '@/components/claims/ClaimsRefusal';
import { ApiState } from '@/components/loading/ApiState';
import { DetailSkeleton } from '@/components/loading/ContentSkeleton';
import { useContentClaim, useContentClaimsAccess } from '@/hooks/use-content-claims';
import { useTranslation } from '@/lib/i18n';

/** One content claim, behind the same `content:claims` gate as the queue. */
export default function ContentClaimScreen() {
  const { t } = useTranslation();
  const router = useRouter();
  const { claimId } = useLocalSearchParams<{ claimId: string }>();
  const access = useContentClaimsAccess();
  const canReview = access.data?.canReview === true;
  const claim = useContentClaim(claimId, canReview);

  return (
    <Screen
      scroll="auto"
      header={
        <PageHeader
          title={claim.data?.reference ?? t('claimsPage.title')}
          subtitle={claim.data ? t(`claimsPage.kinds.${claim.data.kind}`) : undefined}
          leading={<AppShellMenuButton />}
          onBack={() => router.navigate('/claims')}
          backLabel={t('claimsPage.detail.back')}
          safeArea={false}
        />
      }
    >
      <ScreenScrollView contentContainerClassName="p-4 md:p-6">
        {access.isLoading || (canReview && claim.isLoading) ? (
          <DetailSkeleton />
        ) : !canReview ? (
          <ClaimsRefusal />
        ) : claim.isError ? (
          <ApiState error={claim.error} onRetry={claim.refetch} />
        ) : claim.data ? (
          <ClaimDetail claim={claim.data} />
        ) : null}
      </ScreenScrollView>
    </Screen>
  );
}
