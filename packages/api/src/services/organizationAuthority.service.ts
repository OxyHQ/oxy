import { eq } from 'drizzle-orm';
import { getDb } from '../config/postgres';
import { users } from '../db/schema/users';
import { organizationProfiles } from '../db/schema/organizationProfiles';

/** Live authority ceiling for existing sessions and service credentials, including pre-directory history. */
export async function hasOrganizationOperatingAuthority(accountId: string): Promise<boolean> {
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
