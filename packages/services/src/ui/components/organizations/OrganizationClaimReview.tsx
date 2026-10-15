import { useState } from 'react';
import { ActivityIndicator, View } from 'react-native';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { isHttpRequestError } from '@oxy.so/core';
import {
  organizationClaimReviewSchema,
  type OrganizationClaimReview as OrganizationClaimReviewInput,
} from '@oxy.so/contracts';
import { Button } from '@oxy.so/bloom/button';
import { SettingsListGroup, SettingsListItem } from '@oxy.so/bloom/settings-list';
import { TextField, TextFieldInput } from '@oxy.so/bloom/text-field';
import { Text } from '@oxy.so/bloom/typography';
import { useOxy } from '../../context/OxyContext';
import { useI18n } from '../../hooks/useI18n';

/** The queue is requested only after an explicit action; the server rechecks staff authority. */
export function OrganizationClaimReview() {
  const { t } = useI18n();
  const { user, canUsePrivateApi } = useOxy();
  const [open, setOpen] = useState(false);
  return (
    <SettingsListGroup>
      <SettingsListItem
        title={t('organizationDirectory.review.title')}
        disabled={!canUsePrivateApi}
        onPress={() => setOpen((value) => !value)}
      />
      {open && user?.kind === 'personal' && canUsePrivateApi ? <ReviewQueue key={user.id} /> : null}
    </SettingsListGroup>
  );
}
function ReviewQueue() {
  const { t } = useI18n();
  const { oxyServices, user, canUsePrivateApi } = useOxy();
  const [selected, setSelected] = useState<string | null>(null);
  const requests = useInfiniteQuery({
    queryKey: ['oxy', 'organizations', 'review', user?.id, canUsePrivateApi],
    queryFn: ({ pageParam }) =>
      oxyServices.organizations.reviewClaims({
        status: 'pending',
        limit: 20,
        ...(pageParam ? { cursor: pageParam } : {}),
      }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    enabled: canUsePrivateApi,
    retry: false,
    gcTime: 0,
  });
  const claims = requests.data?.pages.flatMap((page) => page.items) ?? [];
  const ids = [...new Set(claims.map((claim) => claim.accountId))].sort();
  const organizations = useQuery({
    queryKey: ['oxy', 'organizations', 'review-organizations', ids],
    queryFn: async () => {
      const batches = [];
      for (let offset = 0; offset < ids.length; offset += 100)
        batches.push(oxyServices.organizations.batch({ ids: ids.slice(offset, offset + 100) }));
      return (await Promise.all(batches)).flatMap((batch) => batch.items);
    },
    enabled: canUsePrivateApi && requests.isSuccess && ids.length > 0,
    retry: false,
  });
  if (requests.isPending) return <ActivityIndicator />;
  if (requests.isError)
    return (
      <View className="gap-space-16 p-space-16">
        <Text accessibilityRole="alert">
          {t(
            isHttpRequestError(requests.error) && requests.error.status === 403
              ? 'organizationDirectory.review.forbidden'
              : 'organizationDirectory.requestError',
          )}
        </Text>
        <Button onPress={() => requests.refetch()}>{t('organizationDirectory.retry')}</Button>
      </View>
    );
  if (selected)
    return <ReviewDetail claimId={selected} key={selected} onClose={() => setSelected(null)} />;
  return (
    <View className="gap-space-16 p-space-16">
      {claims.length === 0 ? <Text>{t('organizationDirectory.review.empty')}</Text> : null}
      {claims.map((claim) => (
        <SettingsListItem
          key={claim.id}
          title={
            organizations.data?.find((item) => item.requestedAccountId === claim.accountId)
              ?.organization.name ?? t('organizationDirectory.view')
          }
          description={t('organizationDirectory.pending')}
          onPress={() => setSelected(claim.id)}
        />
      ))}
      {requests.hasNextPage ? (
        <Button onPress={() => requests.fetchNextPage()} disabled={requests.isFetchingNextPage}>
          {t('organizationDirectory.loadMore')}
        </Button>
      ) : null}
    </View>
  );
}
function ReviewDetail({ claimId, onClose }: { claimId: string; onClose: () => void }) {
  const { t } = useI18n();
  const { oxyServices, user, canUsePrivateApi } = useOxy();
  const queryClient = useQueryClient();
  const [evidence, setEvidence] = useState('');
  const detail = useQuery({
    queryKey: ['oxy', 'organizations', 'review-detail', user?.id, canUsePrivateApi, claimId],
    queryFn: () => oxyServices.organizations.reviewClaimDetail(claimId),
    enabled: canUsePrivateApi,
    retry: false,
    gcTime: 0,
  });
  const review = useMutation({
    mutationFn: (decision: OrganizationClaimReviewInput['decision']) => {
      if (
        !canUsePrivateApi ||
        !detail.isSuccess ||
        !detail.data ||
        detail.data.claimantUserId === user?.id
      )
        throw new Error('Independent staff review is required');
      return oxyServices.organizations.reviewClaim(
        claimId,
        organizationClaimReviewSchema.parse({ decision, evidenceReference: evidence }),
      );
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['oxy', 'organizations'] });
      await queryClient.invalidateQueries({ queryKey: ['accounts'] });
      onClose();
    },
  });
  const conflict = isHttpRequestError(review.error) && review.error.status === 409;
  const forbidden = isHttpRequestError(review.error) && review.error.status === 403;
  const selfReview = detail.data?.claimantUserId === user?.id;
  return (
    <View className="gap-space-16 p-space-16">
      {detail.isPending ? <ActivityIndicator /> : null}
      {detail.isError ? (
        <>
          <Text accessibilityRole="alert">
            {t(
              isHttpRequestError(detail.error) && detail.error.status === 403
                ? 'organizationDirectory.review.forbidden'
                : 'organizationDirectory.requestError',
            )}
          </Text>
          <Button onPress={() => detail.refetch()}>{t('organizationDirectory.retry')}</Button>
        </>
      ) : null}
      {detail.isSuccess && canUsePrivateApi ? (
        <>
          <Text>{t('organizationDirectory.evidence')}</Text>
          <Text selectable>{detail.data.evidenceReference}</Text>
          <Text>{t('organizationDirectory.review.hint')}</Text>
          {selfReview ? <Text>{t('organizationDirectory.review.independent')}</Text> : null}
          <TextField>
            <TextFieldInput
              label={t('organizationDirectory.review.evidence')}
              value={evidence}
              onChangeText={setEvidence}
              maxLength={1000}
            />
          </TextField>
          {review.isError ? (
            <Text accessibilityRole="alert">
              {t(
                conflict
                  ? 'organizationDirectory.review.conflict'
                  : forbidden
                    ? 'organizationDirectory.review.forbidden'
                    : 'organizationDirectory.review.failed',
              )}
            </Text>
          ) : null}
          {(['approved', 'rejected'] as const).map((decision) => (
            <Button
              key={decision}
              disabled={
                !canUsePrivateApi ||
                selfReview ||
                detail.data.status !== 'pending' ||
                !evidence.trim() ||
                review.isPending ||
                conflict ||
                forbidden
              }
              onPress={() => review.mutate(decision)}
            >
              {t(`organizationDirectory.review.${decision}`)}
            </Button>
          ))}
          {conflict ? (
            <Button
              onPress={async () => {
                await queryClient.invalidateQueries({ queryKey: ['oxy', 'organizations'] });
                onClose();
              }}
            >
              {t('organizationDirectory.retry')}
            </Button>
          ) : null}
        </>
      ) : null}
      <Button appearance="outline" onPress={onClose} disabled={review.isPending}>
        {t('organizationDirectory.back')}
      </Button>
    </View>
  );
}
