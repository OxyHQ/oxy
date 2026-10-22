import type { ContentClaimState } from '@oxy.so/contracts';
import { Badge } from '@/components/ui/badge';
import { CLAIM_STATE_LABELS, claimStateVariant, deadlineStatus } from '@/lib/content-claims';

export function ClaimStateBadge({ state }: { state: ContentClaimState }) {
  return (
    <Badge variant={claimStateVariant(state)} className="text-xs">
      {CLAIM_STATE_LABELS[state]}
    </Badge>
  );
}

/**
 * An erasure request's statutory deadline (one month, GDPR art. 12(3)): red
 * once it has passed, outlined within a week of it, plain otherwise. Nothing
 * for a claim without one, or once the claim is closed.
 */
export function ClaimDeadlineBadge({
  claim,
}: {
  claim: { deadlineAt: string | null; state: ContentClaimState };
}) {
  const status = deadlineStatus(claim);
  if (status === 'none' || claim.deadlineAt === null) return null;
  const date = new Date(claim.deadlineAt).toLocaleDateString();
  if (status === 'overdue') {
    return (
      <Badge variant="destructive" className="text-xs">
        Overdue · {date}
      </Badge>
    );
  }
  return (
    <Badge variant={status === 'due_soon' ? 'outline' : 'ghost'} className="text-xs">
      {status === 'due_soon' ? 'Due soon' : 'Due'} · {date}
    </Badge>
  );
}

/** What someone without the `content:claims` capability sees, instead of a spinner. */
export function ClaimsRefusal() {
  return (
    <div className="px-6 py-8 max-w-2xl">
      <p className="text-sm text-muted-foreground">
        This page is for Oxy staff who review content claims. Reviewing claims needs the
        content:claims staff capability, which an administrator grants.
      </p>
    </div>
  );
}
