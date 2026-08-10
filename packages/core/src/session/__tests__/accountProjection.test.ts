import type { DeviceSessionState } from '@oxyhq/contracts';
import { ACCOUNT_KINDS } from '@oxyhq/contracts';
import type { User } from '../../models/interfaces';
import type { AccountNode } from '../../mixins/OxyServices.accounts';
import {
  canSwitchIntoAccount,
  isSwitchTargetAccount,
  projectSwitchableAccounts,
  switchableAccountIds,
} from '../accountProjection';

function user(id: string, over: Partial<User> = {}): User {
  return {
    id,
    publicKey: `pk_${id}`,
    username: `user_${id}`,
    name: { displayName: `User ${id}` },
    ...over,
  } as User;
}

function state(
  accounts: Array<{ accountId: string; sessionId: string; authuser?: number; operatedByUserId?: string }>,
  activeAccountId: string | null,
): DeviceSessionState {
  return {
    deviceId: 'device-1',
    accounts: accounts.map((a) => ({
      accountId: a.accountId,
      sessionId: a.sessionId,
      authuser: a.authuser ?? 0,
      operatedByUserId: a.operatedByUserId,
    })),
    activeAccountId,
    revision: 1,
    updatedAt: 1_720_000_000_000,
  };
}

function graphNode(id: string, over: Partial<AccountNode> = {}): AccountNode {
  return {
    accountId: id,
    kind: 'organization',
    parentAccountId: null,
    account: user(id),
    relationship: 'owner',
    callerMembership: null,
    ...over,
  };
}

const mapOf = (...users: User[]): Map<string, User> => {
  const map = new Map<string, User>();
  for (const u of users) map.set(u.id, u);
  return map;
};

const noAvatar = (): undefined => undefined;

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

describe('projectSwitchableAccounts', () => {
  it('returns [] for null state and empty graph', () => {
    expect(
      projectSwitchableAccounts({ state: null, graph: [], profilesById: new Map(), resolveAvatarUrl: noAvatar }),
    ).toEqual([]);
  });

  it('projects device rows and flags the active account current', () => {
    const rows = projectSwitchableAccounts({
      state: state([{ accountId: 'a1', sessionId: 's1', authuser: 0 }, { accountId: 'a2', sessionId: 's2', authuser: 1 }], 'a2'),
      graph: [],
      profilesById: mapOf(user('a1'), user('a2')),
      resolveAvatarUrl: noAvatar,
    });

    expect(rows.map((r) => r.accountId)).toEqual(['a1', 'a2']);
    expect(rows.map((r) => r.isCurrent)).toEqual([false, true]);
    expect(rows.every((r) => r.onDevice)).toBe(true);
    expect(rows[1].sessionId).toBe('s2');
    expect(rows[1].authuser).toBe(1);
  });

  it('omits device accounts whose profile is not resolved (except the active one via activeUser)', () => {
    const rows = projectSwitchableAccounts({
      state: state([{ accountId: 'a1', sessionId: 's1' }, { accountId: 'a2', sessionId: 's2' }], 'a1'),
      graph: [],
      // a2 has no resolved profile; a1 is active and provided via activeUser.
      profilesById: new Map(),
      activeUser: user('a1', { name: { displayName: 'Fresh A1' } }),
      resolveAvatarUrl: noAvatar,
    });

    expect(rows.map((r) => r.accountId)).toEqual(['a1']);
    expect(rows[0].displayName).toBe('Fresh A1');
    expect(rows[0].isCurrent).toBe(true);
  });

  it('prefers activeUser over profilesById for the active row (freshness)', () => {
    const rows = projectSwitchableAccounts({
      state: state([{ accountId: 'a1', sessionId: 's1' }], 'a1'),
      graph: [],
      profilesById: mapOf(user('a1', { name: { displayName: 'Stale' } })),
      activeUser: user('a1', { name: { displayName: 'Fresh' } }),
      resolveAvatarUrl: noAvatar,
    });
    expect(rows[0].displayName).toBe('Fresh');
  });

  it('merges graph-only accounts after device rows, carrying graph metadata', () => {
    const rows = projectSwitchableAccounts({
      state: state([{ accountId: 'a1', sessionId: 's1' }], 'a1'),
      graph: [graphNode('org1', { kind: 'organization', relationship: 'owner', parentAccountId: 'a1' })],
      profilesById: mapOf(user('a1')),
      resolveAvatarUrl: noAvatar,
    });

    expect(rows.map((r) => r.accountId)).toEqual(['a1', 'org1']);
    const org = rows[1];
    expect(org.onDevice).toBe(false);
    expect(org.isCurrent).toBe(false);
    expect(org.sessionId).toBeUndefined();
    expect(org.kind).toBe('organization');
    expect(org.relationship).toBe('owner');
    expect(org.parentAccountId).toBe('a1');
  });

  /**
   * A channel is a content identity nobody acts as, so it must never be offered
   * as a switch target. It reaches the projection through the GRAPH lane, not
   * the device lane — a channel has no credentials and so can never be a device
   * session, which is exactly why "no-login accounts can't appear here by
   * construction" is false: `listAccounts()` contributes credential-less
   * accounts on purpose (that is how an org first becomes switchable).
   */
  it('omits a graph-only channel account from the switcher', () => {
    const rows = projectSwitchableAccounts({
      state: state([{ accountId: 'a1', sessionId: 's1' }], 'a1'),
      graph: [
        graphNode('org1', { kind: 'organization' }),
        graphNode('chan1', { kind: 'channel' }),
      ],
      profilesById: mapOf(user('a1')),
      resolveAvatarUrl: noAvatar,
    });

    expect(rows.map((r) => r.accountId)).toEqual(['a1', 'org1']);
    expect(rows.some((r) => r.kind === 'channel')).toBe(false);
  });

  /**
   * The same rule as the `isSwitchTargetAccount` matrix above, asserted through
   * the projection so the WIRING is covered and not just the predicate.
   *
   * The fixture deliberately carries one graph-only node of every kind, and
   * FOUR of the five must survive: a fixture list of channels alone could not
   * tell "omits channels" from "omits every graph-only row", which is the
   * failure mode that would silently empty an operator's switcher of the orgs
   * they actually work in. `a1` is a device row and is asserted separately, so
   * the graph lane's output is never confused with the device lane's.
   */
  it('keeps every switchable kind while dropping the channel (graph lane)', () => {
    const rows = projectSwitchableAccounts({
      state: state([{ accountId: 'a1', sessionId: 's1' }], 'a1'),
      graph: [
        graphNode('self1', { kind: 'personal', relationship: 'self' }),
        graphNode('org1', { kind: 'organization' }),
        graphNode('proj1', { kind: 'project' }),
        graphNode('bot1', { kind: 'bot' }),
        graphNode('chan1', { kind: 'channel' }),
      ],
      profilesById: mapOf(
        user('a1'),
        user('self1'),
        user('org1'),
        user('proj1'),
        user('bot1'),
        user('chan1'),
      ),
      resolveAvatarUrl: noAvatar,
    });

    expect(rows.map((r) => r.accountId)).toEqual(['a1', 'self1', 'org1', 'proj1', 'bot1']);
    // Stated the other way round too, so a fixture that stopped reaching the
    // graph lane at all could not pass this as a vacuous "no channels found".
    expect(rows.map((r) => r.kind)).toEqual([
      undefined,
      'personal',
      'organization',
      'project',
      'bot',
    ]);
  });

  it('omits a graph-only member without account:act_as', () => {
    const rows = projectSwitchableAccounts({
      state: state([{ accountId: 'a1', sessionId: 's1' }], 'a1'),
      graph: [
        graphNode('org1', { kind: 'organization', relationship: 'member', callerMembership: {
          _id: 'm1',
          accountId: 'org1',
          memberUserId: 'a1',
          role: 'billing',
          status: 'active',
          permissions: ['account:read', 'billing:manage'],
          inherit: true,
          source: 'direct',
        } }),
        graphNode('org2', { kind: 'organization', relationship: 'member', callerMembership: {
          _id: 'm2',
          accountId: 'org2',
          memberUserId: 'a1',
          role: 'admin',
          status: 'active',
          permissions: ['account:act_as', 'account:read'],
          inherit: true,
          source: 'direct',
        } }),
      ],
      profilesById: mapOf(user('a1'), user('org1'), user('org2')),
      resolveAvatarUrl: noAvatar,
    });

    expect(rows.map((r) => r.accountId)).toEqual(['a1', 'org2']);
  });

  it('dedups an account present as BOTH device session and graph node into ONE enriched row', () => {
    const rows = projectSwitchableAccounts({
      state: state([{ accountId: 'a1', sessionId: 's1', authuser: 0 }], 'a1'),
      graph: [graphNode('a1', { kind: 'personal', relationship: 'self', callerMembership: null })],
      profilesById: mapOf(user('a1')),
      resolveAvatarUrl: noAvatar,
    });

    expect(rows).toHaveLength(1);
    const row = rows[0];
    // Keeps the device sessionId + active flag, gains the graph metadata.
    expect(row.sessionId).toBe('s1');
    expect(row.onDevice).toBe(true);
    expect(row.isCurrent).toBe(true);
    expect(row.kind).toBe('personal');
    expect(row.relationship).toBe('self');
  });

  it('resolves avatar url via the injected resolver and falls back email to @handle', () => {
    const rows = projectSwitchableAccounts({
      state: state([{ accountId: 'a1', sessionId: 's1' }], 'a1'),
      graph: [],
      profilesById: mapOf(user('a1', { avatar: 'file123', email: undefined, username: 'nate' })),
      resolveAvatarUrl: (avatar) => (avatar ? `https://cdn/${avatar}` : undefined),
    });
    expect(rows[0].avatarUrl).toBe('https://cdn/file123');
    // No real email → `@handle` secondary line, never synthesized.
    expect(rows[0].email).toBe('@nate');
  });

  it('uses a real email when present', () => {
    const rows = projectSwitchableAccounts({
      state: state([{ accountId: 'a1', sessionId: 's1' }], 'a1'),
      graph: [],
      profilesById: mapOf(user('a1', { email: 'real@oxy.so' })),
      resolveAvatarUrl: noAvatar,
    });
    expect(rows[0].email).toBe('real@oxy.so');
  });

  it('marks no row current when activeAccountId is null', () => {
    const rows = projectSwitchableAccounts({
      state: state([{ accountId: 'a1', sessionId: 's1' }], null),
      graph: [],
      profilesById: mapOf(user('a1')),
      resolveAvatarUrl: noAvatar,
    });
    expect(rows.every((r) => !r.isCurrent)).toBe(true);
  });

  it('keeps the OPERATOR full set when acting-as a sub-account (no collapse to the active account)', () => {
    // nate operates albert: albert is the active on-device account, nate is also
    // on-device, and the graph is OPERATOR-anchored (the server returns nate's
    // full forest regardless of which account is active). The projection must
    // faithfully union — switching in only changes which row is `isCurrent`,
    // never which accounts are listed. This is the switcher-collapse regression.
    const rows = projectSwitchableAccounts({
      state: state([{ accountId: 'nate', sessionId: 's-nate' }, { accountId: 'albert', sessionId: 's-albert' }], 'albert'),
      graph: [
        graphNode('nate', { kind: 'personal', relationship: 'self' }),
        graphNode('albert', { relationship: 'owner' }),
        graphNode('oxy', { relationship: 'owner' }),
        graphNode('faircoin', { relationship: 'owner' }),
      ],
      profilesById: mapOf(user('nate'), user('albert'), user('oxy'), user('faircoin')),
      resolveAvatarUrl: noAvatar,
    });

    // The full operable set is present even though a leaf sub-account is active.
    expect(rows.map((r) => r.accountId).sort()).toEqual(['albert', 'faircoin', 'nate', 'oxy']);
    // Exactly the active sub-account is flagged current; operator + siblings stay.
    expect(rows.find((r) => r.accountId === 'albert')?.isCurrent).toBe(true);
    expect(rows.filter((r) => r.isCurrent)).toHaveLength(1);
    // The operator's own personal account is not dropped by acting-as.
    expect(rows.find((r) => r.accountId === 'nate')).toBeDefined();
    // Graph-only siblings (operable but not yet on this device) still appear.
    expect(rows.find((r) => r.accountId === 'oxy')?.onDevice).toBe(false);
    expect(rows.find((r) => r.accountId === 'faircoin')?.onDevice).toBe(false);
  });

  /**
   * The pin, which this projection did not take until #937.
   *
   * Reading `state.activeAccountId` directly was correct only for as long as an
   * identity-bound client never built a switcher — a coupling to what happens to
   * be reachable from where, not a property anything checks. Every projection in
   * `projectSessionState.ts` already took the pin; this one now answers through
   * the same `boundAccountIdOf`, so the switcher and the session projection can
   * never disagree about which row is current.
   */
  it('marks the PINNED row current rather than the device’s active account', () => {
    const rows = projectSwitchableAccounts({
      state: state([{ accountId: 'vault', sessionId: 's-vault' }, { accountId: 'other', sessionId: 's-other' }], 'other'),
      graph: [],
      profilesById: mapOf(user('vault'), user('other')),
      pinnedAccountId: 'vault',
      resolveAvatarUrl: noAvatar,
    });

    expect(rows.find((r) => r.accountId === 'vault')?.isCurrent).toBe(true);
    expect(rows.find((r) => r.accountId === 'other')?.isCurrent).toBe(false);
  });

  it('treats an empty-string pin as no pin at all', () => {
    const rows = projectSwitchableAccounts({
      state: state([{ accountId: 'vault', sessionId: 's-vault' }, { accountId: 'other', sessionId: 's-other' }], 'other'),
      graph: [],
      profilesById: mapOf(user('vault'), user('other')),
      pinnedAccountId: '',
      resolveAvatarUrl: noAvatar,
    });

    expect(rows.find((r) => r.accountId === 'other')?.isCurrent).toBe(true);
  });

  it('prefers activeUser for the PINNED row, not for the device’s active one', () => {
    const fresh = user('vault', { name: { displayName: 'Freshly Renamed' } });
    const rows = projectSwitchableAccounts({
      state: state([{ accountId: 'vault', sessionId: 's-vault' }, { accountId: 'other', sessionId: 's-other' }], 'other'),
      graph: [],
      profilesById: mapOf(user('vault'), user('other')),
      activeUser: fresh,
      pinnedAccountId: 'vault',
      resolveAvatarUrl: noAvatar,
    });

    expect(rows.find((r) => r.accountId === 'vault')?.displayName).toBe('Freshly Renamed');
  });

  /**
   * `operatedByUserId` has ridden the wire since the multi-account model shipped
   * and no client has ever read it, so an org somebody is OPERATING has rendered
   * identically to one signed in directly — different audit actor, same row.
   * The directory is the full answer; this is the same fact on the flat lane.
   */
  it('surfaces the human operating a delegated device row', () => {
    const rows = projectSwitchableAccounts({
      state: state(
        [
          { accountId: 'nate', sessionId: 's-nate' },
          { accountId: 'org', sessionId: 's-org', authuser: 1, operatedByUserId: 'nate' },
        ],
        'org',
      ),
      graph: [],
      profilesById: mapOf(user('nate'), user('org')),
      resolveAvatarUrl: noAvatar,
    });

    expect(rows.find((r) => r.accountId === 'org')?.operatedByUserId).toBe('nate');
    // A directly signed-in account carries no operator — absence is the signal.
    expect(rows.find((r) => r.accountId === 'nate')?.operatedByUserId).toBeUndefined();
  });
});

describe('switchableAccountIds', () => {
  it('unions device + graph ids, deduped and sorted', () => {
    const ids = switchableAccountIds(
      state([{ accountId: 'b', sessionId: 's1' }, { accountId: 'a', sessionId: 's2' }], 'a'),
      [graphNode('c'), graphNode('a')],
    );
    expect(ids).toEqual(['a', 'b', 'c']);
  });

  it('returns [] for null state and empty graph', () => {
    expect(switchableAccountIds(null, [])).toEqual([]);
  });

  /**
   * Must stay in lockstep with the projection's own filter in BOTH directions:
   * an id fetched for a dropped row is wasted work, but an id NOT fetched for a
   * row the projection keeps is worse — that row has no profile, so the
   * projection's device lane skips it and it silently never renders.
   */
  it('applies the same switch-target filter as the projection', () => {
    const ids = switchableAccountIds(null, [
      graphNode('self1', { kind: 'personal', relationship: 'self' }),
      graphNode('org1', { kind: 'organization' }),
      graphNode('proj1', { kind: 'project' }),
      graphNode('bot1', { kind: 'bot' }),
      graphNode('chan1', { kind: 'channel' }),
      graphNode('other1', { kind: 'personal', relationship: 'member' }),
    ]);
    expect(ids).toEqual(['bot1', 'org1', 'proj1', 'self1']);
  });
});
