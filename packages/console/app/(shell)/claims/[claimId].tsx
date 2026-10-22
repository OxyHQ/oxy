import { EmptyState } from '@oxy.so/bloom/empty-state';
import { Loading } from '@oxy.so/bloom/loading';
import { useLocalSearchParams } from 'expo-router';
import { Text, View } from 'react-native';

import { ClaimDetail } from '@/components/claims/claim-detail';
import {
  ClaimDeadlineBadge,
  ClaimStateBadge,
  ClaimsRefusal,
} from '@/components/claims/claim-badges';
import { ContentScreen } from '@/components/content/ContentScreen';
import { TextLink } from '@/components/content/TextLink';
import { useContentClaim, useContentClaimsAccess } from '@/hooks/use-content-claims';
import { isPermissionRefused } from '@/lib/api-error';
import { useTranslation } from '@/lib/i18n';

/** One content claim, behind the same `content:claims` gate as the queue. */
export default function ContentClaimScreen() {
  const { t } = useTranslation();
  const { claimId } = useLocalSearchParams<{ claimId: string }>();
  const access = useContentClaimsAccess();
  const canReview = access.data?.canReview === true;
  const query = useContentClaim(claimId, canReview);
  const claim = query.data;

  const title = claim?.reference ?? t('claimsPage.title');
  const backHref = '/claims' as const;

  let body: React.ReactNode;
  if (access.isLoading || (canReview && query.isLoading)) {
    body = (
      <View className="items-center py-12">
        <Loading />
      </View>
    );
  } else if (!canReview || (query.isError && isPermissionRefused(query.error))) {
    body = <ClaimsRefusal />;
  } else if (query.isError || !claim) {
    body = (
      <EmptyState
        variant="compact"
        description={t('claimsPage.detail.loadFailed')}
        footer={<TextLink href={backHref}>{t('claimsPage.detail.back')}</TextLink>}
      />
    );
  } else {
    body = (
      <>
        <View className="gap-2">
          <View className="flex-row flex-wrap items-center gap-2">
            <ClaimStateBadge state={claim.state} />
            <ClaimDeadlineBadge claim={claim} />
          </View>
          <Text className="text-sm text-muted-foreground">
            {t('claimsPage.detail.meta', {
              kind: t(`claimsPage.kinds.${claim.kind}`),
              relationship: t(`claimsPage.relationships.${claim.relationship}`),
              received: new Date(claim.receivedAt).toLocaleString(),
              closed: claim.closedAt
                ? t('claimsPage.detail.closed', { date: new Date(claim.closedAt).toLocaleString() })
                : '',
              submitted: claim.submittedByUserId
                ? t('claimsPage.detail.submittedBy', { user: claim.submittedByUserId })
                : '',
            })}
          </Text>
          {claim.deadlineAt ? (
            <Text className="text-sm text-muted-foreground">
              {t('claimsPage.detail.deadline', {
                date: new Date(claim.deadlineAt).toLocaleDateString(),
              })}
            </Text>
          ) : null}
        </View>
        <ClaimDetail claim={claim} />
      </>
    );
  }

  return (
    <ContentScreen title={title} backHref={backHref} maxWidth="xl">
      {body}
    </ContentScreen>
  );
}
