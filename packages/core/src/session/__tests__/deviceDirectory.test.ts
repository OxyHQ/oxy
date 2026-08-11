/**
 * The device directory's two halves, kept apart.
 *
 * Every fixture here puts the SAME organization under TWO principals, because
 * that is the shape the flat projection cannot hold and the shape where a loose
 * reading of "find the active context" and the correct one disagree: matching on
 * `accountId` finds whichever person is enumerated first, and on this device
 * that is the wrong human.
 */
import type { DeviceDirectory, DeviceDirectoryProfile } from '@oxyhq/contracts';
import {
  canActivateContext,
  directoryDisplayName,
  directoryHandle,
  projectDevicePrincipals,
  resolveActiveContext,
  resolveDeviceContext,
} from '../deviceDirectory';

const profileFor = (id: string): DeviceDirectoryProfile => ({ id, username: id });

const NATE = profileFor('nate');
const ALICE = profileFor('alice');
const ORG = profileFor('org');

/**
 * `The Oxy Collective` reachable through Nate (who owns it) AND through Alice
 * (a member). Nate's route is enumerated FIRST; Alice's is the active one.
 */
function sharedDeviceDirectory(activeContextId: string | null): DeviceDirectory {
  return {
    deviceId: 'd1',
    revision: 7,
    activeContextId,
    updatedAt: 1_720_000_000_000,
    principals: [
      {
        id: 'p-nate',
        userId: 'nate',
        authuser: 0,
        user: NATE,
        contexts: [
          {
            id: 'ctx-nate-self',
            accountId: 'nate',
            kind: 'personal',
            relationship: 'self',
            account: NATE,
            onDevice: true,
            available: true,
            active: false,
            lastUsedAt: 1_719_000_000_000,
          },
          {
            id: 'ctx-nate-org',
            accountId: 'org',
            kind: 'organization',
            relationship: 'owner',
            account: ORG,
            onDevice: true,
            available: true,
            active: false,
            lastUsedAt: 1_719_500_000_000,
          },
        ],
      },
      {
        id: 'p-alice',
        userId: 'alice',
        authuser: 1,
        user: ALICE,
        contexts: [
          {
            id: 'ctx-alice-self',
            accountId: 'alice',
            kind: 'personal',
            relationship: 'self',
            account: ALICE,
            onDevice: true,
            available: true,
            active: false,
            lastUsedAt: null,
          },
          {
            id: 'ctx-alice-org',
            accountId: 'org',
            kind: 'organization',
            relationship: 'member',
            account: ORG,
            onDevice: false,
            available: false,
            active: true,
            lastUsedAt: null,
          },
        ],
      },
    ],
  };
}

describe('resolveActiveContext', () => {
  it('resolves the actor through the CONTEXT, not through the account', () => {
    const context = resolveActiveContext(sharedDeviceDirectory('ctx-alice-org'));

    // Both principals reach `org`; only one of them is the active context's.
    expect(context?.actor).toEqual({
      principalId: 'p-alice',
      userId: 'alice',
      authuser: 1,
      profile: ALICE,
    });
    expect(context?.subject.accountId).toBe('org');
    expect(context?.contextId).toBe('ctx-alice-org');
  });

  it('marks a delegated context delegated and a personal one not', () => {
    expect(resolveActiveContext(sharedDeviceDirectory('ctx-alice-org'))?.isDelegated).toBe(true);
    expect(resolveActiveContext(sharedDeviceDirectory('ctx-nate-self'))?.isDelegated).toBe(false);
  });

  it('carries the subject facts a switcher renders verbatim', () => {
    const context = resolveActiveContext(sharedDeviceDirectory('ctx-alice-org'));

    // `available: false` is a membership that was revoked. It is returned as a
    // row, not omitted, so the UI can explain it instead of silently dropping it.
    expect(context?.subject).toEqual({
      accountId: 'org',
      kind: 'organization',
      relationship: 'member',
      profile: ORG,
      onDevice: false,
      available: false,
      lastUsedAt: null,
    });
  });

  it('is null for no directory, no active context, and an active id nobody holds', () => {
    expect(resolveActiveContext(null)).toBeNull();
    expect(resolveActiveContext(sharedDeviceDirectory(null))).toBeNull();
    // A directory that disagrees with itself resolves to "nothing active",
    // never to whichever context happened to look closest.
    expect(resolveActiveContext(sharedDeviceDirectory('ctx-healed-away'))).toBeNull();
  });

  it('refuses to read an ACCOUNT id as if it named a context', () => {
    // `org` is a real account on this device, reachable through both people. A
    // resolver that fell back to matching on `accountId` would answer with one
    // of them — a guess about WHICH HUMAN is signed in, made inside the path
    // that decides what the app renders and which bearer it holds. The whole
    // reason activation takes a `contextId` is that this guess is not ours to
    // make, so it resolves to nothing instead.
    expect(resolveActiveContext(sharedDeviceDirectory('org'))).toBeNull();
    expect(resolveDeviceContext(sharedDeviceDirectory(null), 'org')).toBeNull();
  });
});

describe('resolveDeviceContext', () => {
  it('resolves each route to the same account under its own principal', () => {
    const directory = sharedDeviceDirectory('ctx-alice-org');

    expect(resolveDeviceContext(directory, 'ctx-nate-org')?.actor.userId).toBe('nate');
    expect(resolveDeviceContext(directory, 'ctx-alice-org')?.actor.userId).toBe('alice');
    expect(resolveDeviceContext(directory, 'ctx-nate-org')?.subject.accountId).toBe(
      resolveDeviceContext(directory, 'ctx-alice-org')?.subject.accountId,
    );
  });

  it('is null for an unknown context id and a null directory', () => {
    expect(resolveDeviceContext(sharedDeviceDirectory(null), 'nope')).toBeNull();
    expect(resolveDeviceContext(null, 'ctx-nate-self')).toBeNull();
  });
});

describe('canActivateContext', () => {
  /**
   * A principal whose OWN personal session has died. Their delegated context
   * still holds a live delegated session, so `onDevice` is true — and it is
   * still not activatable, because activation has no proof of who is acting
   * once the human's session is gone. The server answers such a request with a
   * 403 and heals the row away, so a switcher that offered it would be offering
   * a button that deletes the row it sits on.
   */
  function deadPrincipalDirectory(): DeviceDirectory {
    return {
      deviceId: 'd1',
      revision: 3,
      activeContextId: null,
      updatedAt: 1_720_000_000_000,
      principals: [
        {
          id: 'p-nate',
          userId: 'nate',
          authuser: 0,
          user: NATE,
          contexts: [
            {
              id: 'ctx-nate-self',
              accountId: 'nate',
              kind: 'personal',
              relationship: 'self',
              account: NATE,
              onDevice: true,
              available: false,
              active: false,
              lastUsedAt: null,
            },
            {
              id: 'ctx-nate-org',
              accountId: 'org',
              kind: 'organization',
              relationship: 'owner',
              account: ORG,
              // A LIVE delegated session, under a dead principal.
              onDevice: true,
              available: false,
              active: false,
              lastUsedAt: null,
            },
          ],
        },
      ],
    };
  }

  it('refuses every context of a principal whose own session died', () => {
    const directory = deadPrincipalDirectory();
    const personal = resolveDeviceContext(directory, 'ctx-nate-self');
    const delegated = resolveDeviceContext(directory, 'ctx-nate-org');

    expect(delegated?.subject.onDevice).toBe(true);
    expect(canActivateContext(delegated?.subject ?? { available: true })).toBe(false);
    expect(canActivateContext(personal?.subject ?? { available: true })).toBe(false);
  });

  it('admits a reachable context that has never been activated here', () => {
    // `onDevice: false` is the ordinary "reachable, session minted on first
    // activation" row. Requiring `onDevice` would hide every organization the
    // person has not used on this device yet.
    const directory: DeviceDirectory = {
      deviceId: 'd1',
      revision: 3,
      activeContextId: null,
      updatedAt: 1_720_000_000_000,
      principals: [
        {
          id: 'p-nate',
          userId: 'nate',
          authuser: 0,
          user: NATE,
          contexts: [
            {
              id: 'ctx-nate-org',
              accountId: 'org',
              kind: 'organization',
              relationship: 'owner',
              account: ORG,
              onDevice: false,
              available: true,
              active: false,
              lastUsedAt: null,
            },
          ],
        },
      ],
    };
    const context = resolveDeviceContext(directory, 'ctx-nate-org');

    expect(context?.subject.onDevice).toBe(false);
    expect(canActivateContext(context?.subject ?? { available: false })).toBe(true);
  });
});

describe('projectDevicePrincipals', () => {
  it('puts the same organization under BOTH people, as two distinct rows', () => {
    const groups = projectDevicePrincipals(sharedDeviceDirectory('ctx-alice-org'));

    expect(groups.map((group) => group.principalId)).toEqual(['p-nate', 'p-alice']);
    // The fact the flat list structurally cannot hold: one account, two routes,
    // two different humans, two different context ids.
    const orgRows = groups.flatMap((group) =>
      group.contexts.filter((context) => context.subject.accountId === 'org'),
    );
    expect(orgRows).toHaveLength(2);
    expect(orgRows.map((context) => context.contextId)).toEqual(['ctx-nate-org', 'ctx-alice-org']);
    expect(orgRows.map((context) => context.actor.userId)).toEqual(['nate', 'alice']);
  });

  it('marks only the person the ACTIVE context belongs to as active', () => {
    const throughAlice = projectDevicePrincipals(sharedDeviceDirectory('ctx-alice-org'));
    expect(throughAlice.map((group) => group.isActive)).toEqual([false, true]);

    // Same account, reached through the other person: the active flag moves.
    const throughNate = projectDevicePrincipals(sharedDeviceDirectory('ctx-nate-org'));
    expect(throughNate.map((group) => group.isActive)).toEqual([true, false]);
  });

  it('marks nobody active when the active id names a row nobody holds', () => {
    const groups = projectDevicePrincipals(sharedDeviceDirectory('ctx-healed-away'));
    expect(groups.some((group) => group.isActive)).toBe(false);

    // An ACCOUNT id is not a context id, so it activates nobody either — the
    // same refusal `resolveActiveContext` makes, and for the same reason.
    expect(projectDevicePrincipals(sharedDeviceDirectory('org')).some((g) => g.isActive)).toBe(
      false,
    );
    expect(projectDevicePrincipals(sharedDeviceDirectory(null)).some((g) => g.isActive)).toBe(
      false,
    );
  });

  it('preserves the server order and does not re-sort', () => {
    // The account ids are chosen so the server's order and a plausible
    // client-side re-sort DISAGREE: the server puts a principal's PERSONAL
    // context first, and `zeta` sorts after `org`. With ids that happen to
    // already be alphabetical, a re-sorting projection passes this test.
    const directory: DeviceDirectory = {
      deviceId: 'd1',
      revision: 8,
      activeContextId: null,
      updatedAt: 1_720_000_000_000,
      principals: [
        {
          id: 'p-zeta',
          userId: 'zeta',
          authuser: 0,
          user: profileFor('zeta'),
          contexts: [
            {
              id: 'ctx-zeta-self',
              accountId: 'zeta',
              kind: 'personal',
              relationship: 'self',
              account: profileFor('zeta'),
              onDevice: true,
              available: true,
              active: false,
              lastUsedAt: null,
            },
            {
              id: 'ctx-zeta-org',
              accountId: 'org',
              kind: 'organization',
              relationship: 'owner',
              account: ORG,
              onDevice: true,
              available: true,
              active: false,
              lastUsedAt: null,
            },
          ],
        },
      ],
    };

    const groups = projectDevicePrincipals(directory);

    expect(groups[0].contexts.map((context) => context.contextId)).toEqual([
      'ctx-zeta-self',
      'ctx-zeta-org',
    ]);
    // And principals keep the server's `authuser` ordering, not a re-derived one.
    expect(projectDevicePrincipals(sharedDeviceDirectory(null)).map((g) => g.authuser)).toEqual([
      0, 1,
    ]);
  });

  it('keeps a person who has no contexts left', () => {
    // Their every context was removed while they remain on the device. Dropping
    // the group would strand "sign out of this person" with no row to hang off.
    const directory: DeviceDirectory = {
      deviceId: 'd1',
      revision: 4,
      activeContextId: null,
      updatedAt: 1_720_000_000_000,
      principals: [{ id: 'p-nate', userId: 'nate', authuser: 0, user: NATE, contexts: [] }],
    };
    const groups = projectDevicePrincipals(directory);

    expect(groups).toHaveLength(1);
    expect(groups[0].principalId).toBe('p-nate');
    expect(groups[0].contexts).toEqual([]);
    expect(groups[0].isActive).toBe(false);
  });

  it('is empty for no directory', () => {
    expect(projectDevicePrincipals(null)).toEqual([]);
  });
});

describe('directoryDisplayName / directoryHandle', () => {
  it('prefers the API displayName, then the handle, then the sentinel', () => {
    expect(directoryDisplayName({ id: 'u', username: 'nate', name: { displayName: 'Nate I.' } }))
      .toBe('Nate I.');
    expect(directoryDisplayName({ id: 'u', username: 'nate' })).toBe('nate');
    // No displayName and no username: the localized unnamed sentinel, never an
    // account id and never a synthesized name.
    const unnamed = directoryDisplayName({ id: 'u', username: '' });
    expect(unnamed).not.toBe('');
    expect(unnamed).not.toBe('u');
  });

  it('does not rebuild the first/last chain the identity contract forbids', () => {
    // `name.first`/`name.last` without a `displayName` means the server
    // deliberately composed no display name. Falling through to the handle is
    // the contract; recomposing "Nate Isern" here would put a second, divergent
    // naming rule in the client.
    expect(
      directoryDisplayName({ id: 'u', username: 'nate', name: { first: 'Nate', last: 'Isern' } }),
    ).toBe('nate');
  });

  it('treats a whitespace-only displayName as absent', () => {
    expect(directoryDisplayName({ id: 'u', username: 'nate', name: { displayName: '  ' } })).toBe(
      'nate',
    );
  });

  it('answers the handle, or null when there is no usable username', () => {
    expect(directoryHandle({ id: 'u', username: 'nate' })).toBe('nate');
    expect(directoryHandle({ id: 'u', username: '' })).toBeNull();
  });
});
