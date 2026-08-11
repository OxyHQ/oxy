/**
 * `deviceSwitcherRows` — the switcher's render model.
 *
 * Pure, so it is tested without a render. The cases that matter are the ones
 * where a plausible shortcut and the correct answer disagree: naming a row by
 * recomposing a name the server deliberately did not compose, marking a row
 * active by comparing account ids on a device where two people reach one
 * account, and deciding switchability from anything other than `available`.
 */

import type { DeviceDirectory } from '@oxyhq/contracts';
import { projectDevicePrincipals } from '../deviceDirectory';
import { buildSwitcherRows, showsPrincipalHeaders } from '../deviceSwitcherRows';

const avatarUrl = (avatar: string | null | undefined): string | undefined =>
  avatar ? `https://cdn/${avatar}` : undefined;

/** Nate and Alice, both able to act as `org`. Nate is enumerated first. */
function sharedDirectory(activeContextId: string | null): DeviceDirectory {
  return {
    deviceId: 'device-1',
    revision: 4,
    activeContextId,
    updatedAt: 1_720_000_000_000,
    principals: [
      {
        id: 'p-nate',
        userId: 'nate',
        authuser: 0,
        user: { id: 'nate', username: 'nate', name: { displayName: 'Nate I.' }, avatar: 'av-nate' },
        contexts: [
          {
            id: 'ctx-nate',
            accountId: 'nate',
            kind: 'personal',
            relationship: 'self',
            account: { id: 'nate', username: 'nate', name: { displayName: 'Nate I.' }, avatar: 'av-nate' },
            onDevice: true,
            available: true,
            active: activeContextId === 'ctx-nate',
            lastUsedAt: null,
          },
          {
            id: 'ctx-nate-org',
            accountId: 'org',
            kind: 'organization',
            relationship: 'owner',
            account: { id: 'org', username: 'oxy', avatar: null },
            onDevice: true,
            available: true,
            active: activeContextId === 'ctx-nate-org',
            lastUsedAt: null,
          },
        ],
      },
      {
        id: 'p-alice',
        userId: 'alice',
        authuser: 1,
        user: { id: 'alice', username: 'alice' },
        contexts: [
          {
            id: 'ctx-alice-org',
            accountId: 'org',
            kind: 'organization',
            relationship: 'member',
            account: { id: 'org', username: 'oxy', avatar: null },
            // A live delegated session under a principal whose own session died:
            // on the device, and still not activatable.
            onDevice: true,
            available: false,
            active: activeContextId === 'ctx-alice-org',
            lastUsedAt: null,
          },
        ],
      },
    ],
  };
}

const rowsFor = (directory: DeviceDirectory, activeContextId: string | null) =>
  buildSwitcherRows(projectDevicePrincipals(directory), activeContextId, avatarUrl, 'en-US');

describe('buildSwitcherRows', () => {
  it('renders the same account under both people, as two rows with two ids', () => {
    const rows = rowsFor(sharedDirectory('ctx-nate'), 'ctx-nate');

    const orgRows = rows.flatMap((row) => row.contexts.filter((c) => c.accountId === 'org'));
    expect(orgRows.map((c) => c.contextId)).toEqual(['ctx-nate-org', 'ctx-alice-org']);
    expect(rows.map((row) => row.principalId)).toEqual(['p-nate', 'p-alice']);
  });

  it('marks active by CONTEXT id, so one of two routes to an account lights up', () => {
    const rows = rowsFor(sharedDirectory('ctx-nate-org'), 'ctx-nate-org');

    const orgRows = rows.flatMap((row) => row.contexts.filter((c) => c.accountId === 'org'));
    // Comparing on `accountId` would light BOTH of these, i.e. claim the device
    // is signed in as one account through two different people at once.
    expect(orgRows.map((c) => c.isActive)).toEqual([true, false]);
  });

  it('takes switchability from `available` alone', () => {
    const rows = rowsFor(sharedDirectory('ctx-nate'), 'ctx-nate');

    const alice = rows[1].contexts[0];
    expect(alice.canActivate).toBe(false);
    // `available || onDevice` would offer this row: the delegated session is
    // alive, so `onDevice` is true, and the server still answers 403 because the
    // principal's own session is gone.
    const nateOrg = rows[0].contexts[1];
    expect(nateOrg.canActivate).toBe(true);
  });

  it('names a row by displayName, then handle — never a recomposed name', () => {
    const rows = rowsFor(sharedDirectory('ctx-nate'), 'ctx-nate');

    expect(rows[0].displayName).toBe('Nate I.');
    // `org` has no `displayName`: the handle, not a synthesized one.
    expect(rows[0].contexts[1].displayName).toBe('oxy');
    expect(rows[0].contexts[1].handle).toBe('oxy');
  });

  it('resolves avatar file ids through the caller-supplied resolver', () => {
    const rows = rowsFor(sharedDirectory('ctx-nate'), 'ctx-nate');

    expect(rows[0].avatarUrl).toBe('https://cdn/av-nate');
    // A null avatar resolves to nothing, never to a URL with an empty id in it.
    expect(rows[0].contexts[1].avatarUrl).toBeUndefined();
  });

  it('flags delegation by comparing the pair, not by reading the relationship word', () => {
    const rows = rowsFor(sharedDirectory('ctx-nate'), 'ctx-nate');

    expect(rows[0].contexts[0].isDelegated).toBe(false);
    expect(rows[0].contexts[1].isDelegated).toBe(true);
  });

  it('marks the person the active context belongs to, and only them', () => {
    expect(rowsFor(sharedDirectory('ctx-alice-org'), 'ctx-alice-org').map((r) => r.isActive)).toEqual([
      false,
      true,
    ]);
    expect(rowsFor(sharedDirectory('ctx-nate-org'), 'ctx-nate-org').map((r) => r.isActive)).toEqual([
      true,
      false,
    ]);
  });
});

describe('showsPrincipalHeaders', () => {
  const person = (id: string, contextIds: string[]) => ({
    principalId: id,
    displayName: id,
    handle: id,
    avatarUrl: undefined,
    isActive: false,
    contexts: contextIds.map((contextId) => ({
      contextId,
      accountId: contextId,
      displayName: contextId,
      handle: contextId,
      avatarUrl: undefined,
      isActive: false,
      isDelegated: false,
      canActivate: true,
    })),
  });

  it('stays off while every person holds exactly one account', () => {
    // Both of these are the flat list again: every row already IS a person, so a
    // header would print each name twice.
    expect(showsPrincipalHeaders([person('a', ['ctx-a'])])).toBe(false);
    expect(showsPrincipalHeaders([person('a', ['ctx-a']), person('b', ['ctx-b'])])).toBe(false);
  });

  it('turns on as soon as one person holds two', () => {
    expect(showsPrincipalHeaders([person('a', ['ctx-a', 'ctx-a-org'])])).toBe(true);
    expect(
      showsPrincipalHeaders([person('a', ['ctx-a', 'ctx-a-org']), person('b', ['ctx-b'])]),
    ).toBe(true);
  });

  it('is off for an empty device', () => {
    expect(showsPrincipalHeaders([])).toBe(false);
  });
});
