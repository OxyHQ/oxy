import { eq } from 'drizzle-orm';
import { getDb } from '../config/postgres';
import { users } from '../db/schema/users';
import { organizationProfiles } from '../db/schema/organizationProfiles';
import { createAuthorityCache } from '../utils/authorityCache';

/**
 * Per-task, 5 s (`utils/authorityCache.ts`): every service request asks this for
 * its application's owner, and every validated session for its account. An
 * organization losing its claim or being suspended takes effect within the TTL
 * on every task; a failed read is never cached and still fails closed.
 */
const organizationAuthorityCache = createAuthorityCache<boolean>('organization-authority');

export function invalidateOrganizationAuthority(accountId: string): void {
  organizationAuthorityCache.invalidate(accountId);
}

/** Live authority ceiling for existing sessions and service credentials, including pre-directory history. */
export function hasOrganizationOperatingAuthority(accountId: string): Promise<boolean> {
  return organizationAuthorityCache.get(accountId, () =>
    readOrganizationOperatingAuthority(accountId),
  );
}

async function readOrganizationOperatingAuthority(accountId: string): Promise<boolean> {
  const [account] = await getDb()
    .select({
      kind: users.kind,
      claimStatus: organizationProfiles.claimStatus,
      status: organizationProfiles.status,
    })
    .from(users)
    .leftJoin(organizationProfiles, eq(organizationProfiles.accountId, users.id))
    .where(eq(users.id, accountId));
  if (!account) return false;
  return (
    account.kind !== 'organization' ||
    (account.claimStatus === 'claimed' && account.status === 'active')
  );
}
