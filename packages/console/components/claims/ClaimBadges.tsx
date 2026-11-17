import { Badge, type BadgeProps } from '@oxy.so/bloom/badge';
import type { ContentClaimState, ContentReferralReason } from '@oxy.so/contracts';

import { claimStateVariant, deadlineStatus } from '@/lib/content-claims';
import { useTranslation } from '@/lib/i18n';

/** How `claimStateVariant`'s buckets read in Bloom's badge vocabulary. */
const STATE_BADGE: Record<
  ReturnType<typeof claimStateVariant>,
  Pick<BadgeProps, 'variant' | 'color'>
> = {
  default: { variant: 'solid', color: 'primary' },
  secondary: { variant: 'subtle', color: 'default' },
  destructive: { variant: 'solid', color: 'error' },
  outline: { variant: 'outlined', color: 'default' },
};

export function ClaimStateBadge({ state }: { state: ContentClaimState }) {
  const { t } = useTranslation();
  return (
    <Badge
      size="label-small"
      content={t(`claimsPage.states.${state}`)}
      {...STATE_BADGE[claimStateVariant(state)]}
    />
  );
}

/**
 * A claim an Oxy service referred (ADR 0043 D14), by its reason. Solid red: a
 * referral is content a service thinks may be illegal, and it has no claimant
 * waiting, so the badge is what makes it stand out in the queue.
 */
export function ClaimReferralBadge({
  referral,
}: {
  referral: { reason: ContentReferralReason } | null;
}) {
  const { t } = useTranslation();
  if (referral === null) return null;
  return (
    <Badge
      size="label-small"
      variant="solid"
      color="error"
      content={t(`claimsPage.referrals.${referral.reason}`)}
    />
  );
}

/**
 * An erasure request's statutory deadline (one month, GDPR art. 12(3)): red once it
 * has passed, outlined within a week of it, plain otherwise. Nothing for a claim
 * without one, or once the claim is closed.
 */
export function ClaimDeadlineBadge({
  claim,
}: {
  claim: { deadlineAt: string | null; state: ContentClaimState };
}) {
  const { t } = useTranslation();
  const status = deadlineStatus(claim);
  if (status === 'none' || claim.deadlineAt === null) return null;
  const date = new Date(claim.deadlineAt).toLocaleDateString();

  if (status === 'overdue') {
    return (
      <Badge
        size="label-small"
        variant="solid"
        color="error"
        content={t('claimsPage.deadline.overdue', { date })}
      />
    );
  }
  return (
    <Badge
      size="label-small"
      variant={status === 'due_soon' ? 'outlined' : 'subtle'}
      content={t(
        status === 'due_soon' ? 'claimsPage.deadline.dueSoon' : 'claimsPage.deadline.due',
        {
          date,
        },
      )}
    />
  );
}
