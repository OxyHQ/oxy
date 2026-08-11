import { ACCOUNT_KINDS } from '@oxyhq/contracts';
import type { User } from '../../models/interfaces';
import type { AccountNode } from '../../mixins/OxyServices.accounts';
import { canSwitchIntoAccount, isSwitchTargetAccount } from '../accountSwitchTargets';

function graphNode(id: string, over: Partial<AccountNode> = {}): AccountNode {
  return {
    accountId: id,
    kind: 'organization',
    parentAccountId: null,
    account: { id, publicKey: `pk_${id}`, username: `user_${id}` } as User,
    relationship: 'owner',
    callerMembership: null,
    ...over,
  };
}

describe('isSwitchTargetAccount', () => {
  /**
   * EXHAUSTIVE over `ACCOUNT_KINDS`, as one object equality rather than a
   * per-kind assertion, for two reasons that a `channel → false` spot-check
   * cannot give:
   *
   *  - It distinguishes "excludes channels" from "excludes everything". Three
   *    kinds must come back `true` here, so a predicate that answered `false`
   *    unconditionally — the shape that empties a switcher instead of filtering
   *    it — fails on those three, not on the channel.
   *  - Adding a sixth kind fails this test with a missing key, forcing the
   *    decision to be made HERE rather than inherited silently from whichever
   *    literal comparison happened to be written first.
   */
  it('answers by kind for an account the caller merely owns or is a member of', () => {
    expect(
      Object.fromEntries(
        ACCOUNT_KINDS.map((kind) => [kind, isSwitchTargetAccount({ kind, relationship: 'owner' })]),
      ),
    ).toEqual({
      personal: false,
      organization: true,
      project: true,
      bot: true,
      channel: false,
    });
  });

  /**
   * The `self` ground, and the reason this predicate is not `isActAsEligibleKind`.
   *
   * `personal` is act-as INELIGIBLE — assuming somebody's human login would be
   * impersonation — so a switcher gated on that predicate alone would drop the
   * caller's OWN account and render an empty list. `GET /accounts` resolves its
   * caller through `resolveOperatorId`, so a `self` node is always the human
   * operator's own personal account, even while they operate an org.
   */
  it('admits the caller’s own personal account, which is act-as ineligible', () => {
    expect(isSwitchTargetAccount({ kind: 'personal', relationship: 'self' })).toBe(true);
    // Same kind, not the caller's own → refused. The `relationship` is doing the
    // work, so neither half of the predicate can be deleted without a failure.
    expect(isSwitchTargetAccount({ kind: 'personal', relationship: 'member' })).toBe(false);
  });

  it('refuses an account with no kind information rather than assuming', () => {
    expect(isSwitchTargetAccount({})).toBe(false);
    expect(isSwitchTargetAccount({ kind: null })).toBe(false);
    expect(isSwitchTargetAccount({ kind: undefined, relationship: 'owner' })).toBe(false);
  });
});

describe('canSwitchIntoAccount', () => {
  it('admits self without membership permissions', () => {
    expect(canSwitchIntoAccount({ kind: 'personal', relationship: 'self' })).toBe(true);
  });

  it('admits an owned switch target when membership is absent (owner baseline)', () => {
    expect(canSwitchIntoAccount({ kind: 'organization', relationship: 'owner' })).toBe(true);
  });

  it('requires account:act_as for member relationships', () => {
    expect(
      canSwitchIntoAccount({
        kind: 'organization',
        relationship: 'member',
        callerMembership: {
          _id: 'm1',
          accountId: 'org1',
          memberUserId: 'u1',
          role: 'billing',
          status: 'active',
          permissions: ['account:read', 'billing:manage'],
          inherit: true,
          source: 'direct',
        },
      }),
    ).toBe(false);

    expect(
      canSwitchIntoAccount({
        kind: 'organization',
        relationship: 'member',
        callerMembership: {
          _id: 'm2',
          accountId: 'org1',
          memberUserId: 'u1',
          role: 'admin',
          status: 'active',
          permissions: ['account:act_as', 'account:read'],
          inherit: true,
          source: 'direct',
        },
      }),
    ).toBe(true);
  });

  it('refuses channels even with act_as permission', () => {
    expect(
      canSwitchIntoAccount({
        kind: 'channel',
        relationship: 'owner',
        callerMembership: {
          _id: 'm3',
          accountId: 'chan1',
          memberUserId: 'u1',
          role: 'owner',
          status: 'active',
          permissions: ['account:act_as'],
          inherit: true,
          source: 'direct',
        },
      }),
    ).toBe(false);
  });
});
