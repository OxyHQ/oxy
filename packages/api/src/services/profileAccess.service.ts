import { and, eq, or } from 'drizzle-orm';
import type { ProfileAccessDecision } from '@oxy.so/contracts';
import { getDb } from '../config/postgres';
import { users } from '../db/schema/users';
import { blocks } from '../db/schema/blocks';
import { visibleOrganizationIdentityPredicate } from '../utils/profileQuery';

/** Sensitive profile detail policy, deliberately stricter than public identity/discovery. Follows are not consent. */
export async function decideProfileAccess(
  subjectAccountId: string,
  requesterAccountId: string | null,
): Promise<ProfileAccessDecision> {
  const decision = (
    allowed: boolean,
    reason: ProfileAccessDecision['reason'],
  ): ProfileAccessDecision => ({ allowed, reason, policyVersion: '1' });
  const [subject] = await getDb()
    .select({
      status: users.accountStatus,
      reputationTier: users.reputationTier,
      isPrivate: users.privacyIsPrivateAccount,
      profileVisible: users.privacyProfileVisibility,
    })
    .from(users)
    .where(and(eq(users.id, subjectAccountId), visibleOrganizationIdentityPredicate()));
  if (subject?.status !== 'active' || subject.reputationTier === 'restricted')
    return decision(false, 'unavailable');
  if (subjectAccountId === requesterAccountId) return decision(true, 'owner');
  if (requesterAccountId) {
    const [block] = await getDb()
      .select({ id: blocks.id })
      .from(blocks)
      .where(
        or(
          and(eq(blocks.userId, requesterAccountId), eq(blocks.blockedId, subjectAccountId)),
          and(eq(blocks.userId, subjectAccountId), eq(blocks.blockedId, requesterAccountId)),
        ),
      )
      .limit(1);
    if (block) return decision(false, 'blocked');
  }
  if (subject.isPrivate || !subject.profileVisible) return decision(false, 'private');
  return decision(true, 'public');
}
