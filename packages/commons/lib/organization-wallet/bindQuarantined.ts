/**
 * Organization keys the iOS access-group migration kept QUARANTINED (oxy ADR
 * 0062 D4 as amended; round-5 review R5-7): a copy found in the shared keychain
 * group, which every Oxy app could write, is never adopted on the device's
 * word. It waits in the organization's retired ring, reached by nobody, until
 * the organization's own key history (`oxy.accounts.identityKey.get`) names
 * it. This binds those, and when the bound key is the organization's CURRENT
 * key and this phone holds no pair for it, makes it the live pair again, so
 * the Peable wallet derives from it as before.
 *
 * An organization whose history this person cannot read (not an owner or
 * admin, offline) is skipped: its entries stay quarantined for a later launch.
 */
import {
  adoptOrganizationKeyFromRing,
  claimRetiredOrganizationKeys,
  listQuarantinedOrganizationKeys,
} from '@oxy.so/core/crypto';

export interface OrganizationKeyHistoryReader {
  accounts: {
    identityKey: {
      get(accountId: string): Promise<{
        publicKey: string | null;
        keys: ReadonlyArray<{ publicKey: string }>;
      }>;
    };
  };
}

/** Resolves how many quarantined organization keys were bound. */
export async function bindQuarantinedOrganizationKeys(
  oxy: OrganizationKeyHistoryReader,
): Promise<number> {
  const quarantined = await listQuarantinedOrganizationKeys();
  let bound = 0;
  for (const accountId of new Set(quarantined.map((entry) => entry.accountId))) {
    let state: Awaited<ReturnType<OrganizationKeyHistoryReader['accounts']['identityKey']['get']>>;
    try {
      state = await oxy.accounts.identityKey.get(accountId);
    } catch {
      continue;
    }
    bound += await claimRetiredOrganizationKeys(
      accountId,
      state.keys.map((key) => key.publicKey),
    );
    if (state.publicKey) await adoptOrganizationKeyFromRing(accountId, state.publicKey);
  }
  return bound;
}
