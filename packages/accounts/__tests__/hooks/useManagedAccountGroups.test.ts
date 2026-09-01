import { renderHook } from '@testing-library/react';
import type { AccountNode } from '@oxyhq/core';
import { useManagedAccountGroups } from '@/hooks/managed-accounts/useManagedAccountGroups';

function node(accountId: string, kind: AccountNode['kind'], relationship: AccountNode['relationship']): AccountNode {
  return {
    accountId,
    kind,
    relationship,
    parentAccountId: null,
    rootAccountId: accountId,
    account: { id: accountId, kind } as AccountNode['account'],
    callerMembership: null,
    callerMembershipSource: 'direct',
    childCount: 0,
  };
}

describe('useManagedAccountGroups', () => {
  it('places owned channel accounts in the channels group', () => {
    const accounts = [
      node('personal', 'personal', 'self'),
      node('org1', 'organization', 'owner'),
      node('chan1', 'channel', 'owner'),
    ];

    const { result } = renderHook(() => useManagedAccountGroups(accounts));

    expect(result.current.groups.channels).toHaveLength(1);
    expect(result.current.groups.channels[0]?.accountId).toBe('chan1');
    expect(result.current.groups.organizations).toHaveLength(1);
    expect(result.current.totalCount).toBe(2);
  });
});
