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
import { resolveActiveContext, resolveDeviceContext } from '../deviceDirectory';

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
