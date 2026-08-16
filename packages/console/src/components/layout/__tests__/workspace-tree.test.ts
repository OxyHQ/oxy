import { describe, expect, it } from 'vitest';
import { ACCOUNT_KINDS } from '@oxyhq/contracts';
import type { AccountKind, AccountNode, AccountRelationship } from '@oxyhq/core';
import { buildWorkspaceTree } from '../workspace-tree';

function node(
  accountId: string,
  kind: AccountKind,
  relationship: AccountRelationship,
  parentAccountId: string | null = null,
  permissions?: string[] | null,
): AccountNode {
  const membership =
    relationship === 'self'
      ? null
      : {
          _id: `m_${accountId}`,
          accountId,
          memberUserId: 'caller',
          role: relationship === 'owner' ? ('owner' as const) : ('admin' as const),
          status: 'active' as const,
          permissions:
            permissions ??
            (relationship === 'owner'
              ? ['account:act_as', 'account:read']
              : ['account:act_as', 'account:read']),
          inherit: true,
          source: 'direct' as const,
          // `AccountMember` carries both, so the fixture must too — without them
          // this file is a type error, and `bunx tsc --noEmit` is the only gate
          // that sees it (the Vite build does not typecheck).
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
        };

  return {
    accountId,
    kind,
    parentAccountId,
    account: {
      id: accountId,
      publicKey: `pk_${accountId}`,
      username: accountId,
      name: { displayName: accountId },
    } as AccountNode['account'],
    relationship,
    callerMembership: membership,
  };
}

/**
 * The workspace switcher's rows each perform a REAL session switch, so what it
 * lists is a security-adjacent question and not a cosmetic one: a channel row
 * here is an affordance for something `POST /accounts/:id/switch` answers 403
 * to, every time.
 *
 * The Console reaches this list through its own `listAccounts()` React Query,
 * which is exactly how it kept rendering channels after the shared predicate
 * learned to drop them — so this suite exists to keep the two answers together.
 */
describe('buildWorkspaceTree', () => {
  /**
   * EXHAUSTIVE over `ACCOUNT_KINDS`, and asserted as one object equality so it
   * cannot pass vacuously.
   *
   * Three kinds must SURVIVE. A fixture list of channels alone could not tell
   * "drops channels" from "drops everything" — and dropping everything is the
   * worse failure, because it would empty an operator's switcher of the orgs
   * they actually work in. Adding a sixth kind fails this with a missing key.
   */
  it('lists every switchable kind and no channel', () => {
    const accounts = ACCOUNT_KINDS.map((kind) =>
      node(kind, kind, kind === 'personal' ? 'self' : 'owner')
    );

    const { yourAccounts } = buildWorkspaceTree(accounts);

    expect(Object.fromEntries(
      ACCOUNT_KINDS.map((kind) => [kind, yourAccounts.some((a) => a.kind === kind)])
    )).toEqual({
      personal: true,
      organization: true,
      project: true,
      bot: true,
      channel: false,
    });
  });

  /**
   * The caller's own personal account is act-as INELIGIBLE, so a switcher
   * narrowed with `isActAsEligibleKind` instead of `isSwitchTargetAccount`
   * would drop the row that returns you to yourself — the one row that must
   * never disappear. Pinned separately from the matrix above so the reason is
   * legible when it breaks.
   */
  it('keeps the caller’s own personal account', () => {
    const { yourAccounts } = buildWorkspaceTree([node('me', 'personal', 'self')]);
    expect(yourAccounts.map((a) => a.accountId)).toEqual(['me']);
  });

  /**
   * The fixture that tells `isSwitchTargetAccount` from a `kind !== 'channel'`
   * literal, and the ONLY input shape that does.
   *
   * Every other case in this file has exactly one personal account and it is
   * the caller's own, so both readings agree on all of them — a suite made
   * entirely of those cannot see the difference, and a mutation to the literal
   * passed all seven before this was added. Somebody else's personal account is
   * a human login: `POST /accounts/:id/switch` refuses it as impersonation, so
   * offering the row is a 403 with a friendly avatar on it.
   */
  it('drops a personal account that is not the caller’s own', () => {
    const { yourAccounts, sharedAccounts } = buildWorkspaceTree([
      node('me', 'personal', 'self'),
      node('someoneElse', 'personal', 'member'),
      node('alsoNotMe', 'personal', 'owner'),
    ]);

    expect(yourAccounts.map((a) => a.accountId)).toEqual(['me']);
    expect(sharedAccounts).toEqual([]);
  });

  it('separates accounts shared via membership from owned roots', () => {
    const { yourAccounts, sharedAccounts } = buildWorkspaceTree([
      node('me', 'personal', 'self'),
      node('mine', 'organization', 'owner'),
      node('theirs', 'organization', 'member'),
      node('theirChannel', 'channel', 'member'),
    ]);

    expect(yourAccounts.map((a) => a.accountId)).toEqual(['me', 'mine']);
    expect(sharedAccounts.map((a) => a.accountId)).toEqual(['theirs']);
  });

  it('drops a shared member without account:act_as', () => {
    const { sharedAccounts } = buildWorkspaceTree([
      node('me', 'personal', 'self'),
      node('billingOnly', 'organization', 'member', null, ['account:read', 'billing:manage']),
    ]);

    expect(sharedAccounts).toEqual([]);
  });

  it('nests direct children one level under their root, channels excluded', () => {
    const { yourAccounts, childrenOf } = buildWorkspaceTree([
      node('me', 'personal', 'self'),
      node('org', 'organization', 'owner', 'me'),
      node('proj', 'project', 'owner', 'org'),
      node('chan', 'channel', 'owner', 'org'),
    ]);

    expect(yourAccounts.map((a) => a.accountId)).toEqual(['me']);
    expect(childrenOf('me').map((a) => a.accountId)).toEqual(['org']);
    expect(childrenOf('org').map((a) => a.accountId)).toEqual(['proj']);
  });

  /**
   * Dropping a channel must not strand what hangs off it. `underChan` is
   * parented to a channel that no longer renders, so its parent is absent from
   * the switchable set and it has to promote to a root — otherwise it would be
   * reachable only as a child of a row nobody can see, i.e. not at all.
   *
   * And having promoted, it must not ALSO come back from `childrenOf('chan')`,
   * or the same account is offered twice.
   */
  it('promotes a descendant of a dropped channel to a root, exactly once', () => {
    const { yourAccounts, childrenOf } = buildWorkspaceTree([
      node('me', 'personal', 'self'),
      node('chan', 'channel', 'owner', 'me'),
      node('underChan', 'project', 'owner', 'chan'),
    ]);

    expect(yourAccounts.map((a) => a.accountId)).toEqual(['me', 'underChan']);
    expect(childrenOf('chan')).toEqual([]);
  });

  /**
   * The roots and the nested rows must PARTITION the switchable set: every
   * switchable account appears exactly once across the whole rendered tree, and
   * no unswitchable one appears at all.
   *
   * Asserted over a fixture that exercises every branch at once — a shared
   * root, two nested children, a channel to drop, and a child orphaned by that
   * drop — because each of the earlier tests pins one group in isolation and
   * none of them would notice an account counted twice across two groups.
   *
   * The fixture is at most two levels deep because the switcher itself renders
   * two: `renderAccountTree` draws a root and `childrenOf(root)` and stops. A
   * grandchild is therefore unreachable here — a pre-existing limit of this
   * component, untouched by the switch-target filter, and deliberately not
   * papered over by a fixture that pretends otherwise.
   */
  it('renders each switchable account exactly once across the whole tree', () => {
    const accounts = [
      node('me', 'personal', 'self'),
      node('org', 'organization', 'owner', 'me'),
      node('bot', 'bot', 'owner', 'me'),
      node('chan', 'channel', 'owner', 'me'),
      node('underChan', 'project', 'owner', 'chan'),
      node('shared', 'organization', 'member'),
    ];
    const { yourAccounts, sharedAccounts, childrenOf } = buildWorkspaceTree(accounts);

    const rendered = [...yourAccounts, ...sharedAccounts].flatMap((root) => [
      root.accountId,
      ...childrenOf(root.accountId).map((child) => child.accountId),
    ]);

    expect(rendered.slice().sort()).toEqual(['bot', 'me', 'org', 'shared', 'underChan']);
    // Exactly once each — a set comparison alone cannot see a duplicate.
    expect(rendered).toHaveLength(new Set(rendered).size);
    expect(rendered).not.toContain('chan');
  });

  it('returns empty groups for an empty account list', () => {
    const { yourAccounts, sharedAccounts, childrenOf } = buildWorkspaceTree([]);
    expect(yourAccounts).toEqual([]);
    expect(sharedAccounts).toEqual([]);
    expect(childrenOf('anything')).toEqual([]);
  });
});
