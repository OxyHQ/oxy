import { useState } from 'react';
import { ActivityIndicator, View, StyleSheet } from 'react-native';
import { skip, useAction, useEntity, useList, useStore, withStore } from '@oxy.so/bloom-data';
import { isHttpRequestError } from '@oxy.so/core';
import type { OrganizationClaimReview as OrganizationClaimReviewInput } from '@oxy.so/contracts';
import { organizationClaimReviewCheck, parseContract } from '@oxy.so/contracts/client';
import { Button } from '@oxy.so/bloom/button';
import { GroupedSection, GroupedSectionItem } from '@oxy.so/bloom/grouped-section';
import { TextField, TextFieldInput } from '@oxy.so/bloom/text-field';
import { Text } from '@oxy.so/bloom/typography';
import { useOxy } from '../../context/oxyRuntimeContext';
import { useI18n } from '../../hooks/useI18n';
import { refreshAccount } from '../../data/account';
import { useAnswer } from '../../data/answer';
import {
  Organization,
  OrganizationClaim,
  organizationsByAccount,
  refreshOrganizationClaims,
  reviewClaimDetail,
  reviewOrganizationClaim,
  reviewOrganizationClaims,
} from '../../data/organizations';

/** The queue is requested only after an explicit action; the server rechecks staff authority. */
export function OrganizationClaimReview() {
  const { t } = useI18n();
  const { user, canUsePrivateApi } = useOxy();
  const [open, setOpen] = useState(false);
  return (
    <GroupedSection>
      <GroupedSectionItem
        title={t('organizationDirectory.review.title')}
        disabled={!canUsePrivateApi}
        onPress={() => setOpen((value) => !value)}
      />
      {open && user?.kind === 'personal' && canUsePrivateApi ? <ReviewQueue key={user.id} /> : null}
    </GroupedSection>
  );
}
function ReviewQueue() {
  const { t } = useI18n();
  const { oxyServices, user, canUsePrivateApi } = useOxy();
  const [selected, setSelected] = useState<string | null>(null);
  const requests = useList(
    reviewOrganizationClaims,
    ...(canUsePrivateApi ? ([oxyServices, user?.id ?? ''] as const) : ([skip] as const)),
  );
  const ids = [...new Set(requests.extra ?? [])].sort();
  const organizations = useAnswer(
    organizationsByAccount,
    ...(canUsePrivateApi && requests.status === 'success' && ids.length > 0
      ? ([oxyServices, ids] as const)
      : ([skip] as const)),
  );
  if (requests.isLoading) return <ActivityIndicator />;
  if (requests.status === 'error')
    return (
      <View style={styles.stack}>
        <Text accessibilityRole="alert">
          {t(
            isHttpRequestError(requests.error) && requests.error.status === 403
              ? 'organizationDirectory.review.forbidden'
              : 'organizationDirectory.requestError',
          )}
        </Text>
        <Button onPress={() => requests.refresh()}>{t('organizationDirectory.retry')}</Button>
      </View>
    );
  if (selected)
    return <ReviewDetail claimId={selected} key={selected} onClose={() => setSelected(null)} />;
  return (
    <View style={styles.stack}>
      {requests.ids.length === 0 ? <Text>{t('organizationDirectory.review.empty')}</Text> : null}
      {requests.ids.map((id) => (
        <ReviewRow
          key={id}
          claimId={id}
          organizations={organizations.value}
          onPress={() => setSelected(id)}
        />
      ))}
      {requests.hasMore ? (
        <Button onPress={() => requests.more()} disabled={requests.isFetching}>
          {t('organizationDirectory.loadMore')}
        </Button>
      ) : null}
    </View>
  );
}
function ReviewRow({
  claimId,
  organizations,
  onPress,
}: {
  claimId: string;
  organizations: Readonly<Record<string, string>> | undefined;
  onPress: () => void;
}) {
  const { t } = useI18n();
  const claim = useEntity(OrganizationClaim, claimId);
  const organization = useEntity(Organization, claim && organizations?.[claim.accountId]);
  return (
    <GroupedSectionItem
      title={organization?.name ?? t('organizationDirectory.view')}
      description={t('organizationDirectory.pending')}
      onPress={onPress}
    />
  );
}
function ReviewDetail({ claimId, onClose }: { claimId: string; onClose: () => void }) {
  const { t } = useI18n();
  const { oxyServices, user, canUsePrivateApi } = useOxy();
  const [evidence, setEvidence] = useState('');
  const [authorizationRevoked, setAuthorizationRevoked] = useState(false);
  const detail = useAnswer(
    reviewClaimDetail,
    ...(canUsePrivateApi ? ([oxyServices, claimId] as const) : ([skip] as const)),
  );
  const store = useStore();
  const review = useAction(reviewOrganizationClaim);
  // A review changes the claim lists this store shows.
  const refreshClaims = () => withStore(store, () => refreshOrganizationClaims(oxyServices));
  const decide = async (decision: OrganizationClaimReviewInput['decision']) => {
    try {
      await review.run(oxyServices, () => {
        if (
          !canUsePrivateApi ||
          authorizationRevoked ||
          detail.status !== 'success' ||
          !detail.value ||
          detail.value.claimantUserId === user?.id
        )
          throw new Error('Independent staff review is required');
        return {
          claimId,
          input: parseContract(organizationClaimReviewCheck, {
            decision,
            evidenceReference: evidence,
          }),
        };
      });
    } catch (error) {
      if (isHttpRequestError(error) && error.status === 403) setAuthorizationRevoked(true);
      return;
    }
    await refreshClaims();
    // The claimed account's own data (its kind, its owners) changed too.
    const claimed = detail.value?.accountId;
    if (claimed) await withStore(store, () => refreshAccount(oxyServices, claimed));
    onClose();
  };
  const conflict = isHttpRequestError(review.error) && review.error.status === 409;
  const forbidden = isHttpRequestError(review.error) && review.error.status === 403;
  const selfReview = detail.value?.claimantUserId === user?.id;
  const loaded = detail.status === 'success' && detail.value;
  return (
    <View style={styles.stack}>
      {detail.isLoading ? <ActivityIndicator /> : null}
      {detail.status === 'error' ? (
        <>
          <Text accessibilityRole="alert">
            {t(
              isHttpRequestError(detail.error) && detail.error.status === 403
                ? 'organizationDirectory.review.forbidden'
                : 'organizationDirectory.requestError',
            )}
          </Text>
          <Button onPress={() => detail.refresh()}>{t('organizationDirectory.retry')}</Button>
        </>
      ) : null}
      {authorizationRevoked ? (
        <Text accessibilityRole="alert">{t('organizationDirectory.review.forbidden')}</Text>
      ) : null}
      {loaded && canUsePrivateApi && !authorizationRevoked ? (
        <>
          <Text>{t('organizationDirectory.evidence')}</Text>
          <Text selectable>{loaded.evidenceReference}</Text>
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
          {review.error ? (
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
                loaded.status !== 'pending' ||
                !evidence.trim() ||
                review.isPending ||
                conflict ||
                forbidden
              }
              onPress={() => void decide(decision)}
            >
              {t(`organizationDirectory.review.${decision}`)}
            </Button>
          ))}
          {conflict ? (
            <Button
              onPress={async () => {
                await refreshClaims();
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

const styles = StyleSheet.create({
  stack: { gap: 16, padding: 16 },
});
