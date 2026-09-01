import { useMemo } from 'react';
import type { AccountNode } from '@oxyhq/core';

export interface ManagedAccountGroups {
  organizations: AccountNode[];
  projects: AccountNode[];
  bots: AccountNode[];
  /** Publishing identities — operable via membership, never switchable. */
  channels: AccountNode[];
  shared: AccountNode[];
}

export interface UseManagedAccountGroupsResult {
  groups: ManagedAccountGroups;
  totalCount: number;
}

/**
 * Partitions the accessible account forest into the managed-accounts screen's
 * groups: owned accounts split by kind (organizations / projects / bots /
 * channels) plus accounts shared with the caller via membership. The caller's
 * own personal
 * (`self`) account is naturally excluded — it is neither a managed kind nor a
 * `member` relationship.
 *
 * Extracted verbatim from the managed-accounts screen's inline `useMemo`.
 */
export function useManagedAccountGroups(accounts: AccountNode[]): UseManagedAccountGroupsResult {
  const groups = useMemo<ManagedAccountGroups>(() => {
    const owned = accounts.filter((a) => a.relationship !== 'member' && a.kind !== 'personal');
    return {
      organizations: owned.filter((a) => a.kind === 'organization'),
      projects: owned.filter((a) => a.kind === 'project'),
      bots: owned.filter((a) => a.kind === 'bot'),
      channels: owned.filter((a) => a.kind === 'channel'),
      shared: accounts.filter((a) => a.relationship === 'member'),
    };
  }, [accounts]);

  const totalCount =
    groups.organizations.length
    + groups.projects.length
    + groups.bots.length
    + groups.channels.length
    + groups.shared.length;

  return { groups, totalCount };
}
