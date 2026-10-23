import { Badge, type BadgeProps } from '@oxy.so/bloom/badge';
import type { ContentClaimState } from '@oxy.so/contracts';

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
