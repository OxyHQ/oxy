/**
 * The headless `OxyRuntime` (ADR 0004) and the ordering invariant it exists to
 * hold (ADR 0002).
 *
 * These run with no React at all, which is the point: the runtime owns the
 * session facts and the order they become visible in, and neither property is
 * supposed to depend on being inside a render.
 */

import type { DeviceDirectory, DeviceSessionState } from '@oxyhq/contracts';
import type { User } from '@oxyhq/core';
import {
  createOxyRuntime,
  type OxyRuntime,
  type RuntimeClient,
  type RuntimeSessionClient,
  type RuntimeSessionHost,
  type SubjectTransition,
} from '../../src/ui/runtime';

function buildUser(id: string): User {
  return { id, username: `user-${id}`, publicKey: `pk-${id}` } as User;
}

function buildState(
  activeAccountId: string | null,
  revision = 1,
  accounts: Array<{ accountId: string; sessionId: string; authuser: number }> = [
    { accountId: 'a1', sessionId: 'sess-a1', authuser: 0 },
    { accountId: 'a2', sessionId: 'sess-a2', authuser: 1 },
  ],
): DeviceSessionState {
  return { deviceId: 'dev-1', accounts, activeAccountId, revision, updatedAt: 1_700_000_000_000 };
}

function buildDirectory(activeContextId: string | null, revision = 1): DeviceDirectory {
  return {
    deviceId: 'dev-1',
    revision,
    updatedAt: 1_700_000_000_000,
    activeContextId,
    principals: [
      {
        id: 'p-nate',
        userId: 'a1',
        authuser: 0,
        user: { id: 'a1', username: 'nate', name: 'Nate', avatar: null },
        contexts: [
          {
            id: 'ctx-nate-self',
            accountId: 'a1',
            kind: 'user',
            relationship: 'self',
            account: { id: 'a1', username: 'nate', name: 'Nate', avatar: null },
            onDevice: true,
            available: true,
            lastUsedAt: null,
          },
          {
            id: 'ctx-nate-collective',
            accountId: 'a2',
            kind: 'organization',
            relationship: 'operator',
            account: { id: 'a2', username: 'collective', name: 'The Oxy Collective', avatar: null },
            onDevice: true,
            available: true,
            lastUsedAt: null,
          },
        ],
      },
    ],
  };
}

interface Harness {
  runtime: OxyRuntime;
  setState(next: DeviceSessionState | null): void;
  setDirectory(next: DeviceDirectory | null): void;
  fire(): void;
  /** The bearer the fake client currently reports, as a plain account id. */
  bearer: { current: string | null };
  subjectChanges: SubjectTransition[];
  deviceEmptyCalls: number;
  identityUnbound: number[];
  profileFetches: string[][];
  calls: { activate: string[]; signOutContext: string[]; signOutPrincipal: string[] };
  /** Resolve the pending `getUsersByIds` promise, gating the projection. */
  releaseProfiles(): void;
  dispose(): void;
}

interface HarnessOptions {
  /** Deferred profile fetches, so a projection can be overtaken mid-flight. */
  deferProfiles?: boolean;
  pinnedAccountId?: string | null;
  /** Fires from `onSubjectChange`; used to record what a reset can observe. */
  onSubjectChangeExtra?: () => void;
  /** Make `POST /session/device/activate` refuse. */
  rejectActivation?: boolean;
}

function buildHarness(options: HarnessOptions = {}): Harness {
  let state: DeviceSessionState | null = null;
  let directory: DeviceDirectory | null = null;
  const listeners = new Set<(next: DeviceSessionState | null) => void>();
  const bearer = { current: null as string | null };
  const subjectChanges: SubjectTransition[] = [];
  const profileFetches: string[][] = [];
  const identityUnbound: number[] = [];
  let deviceEmptyCalls = 0;
  let releaseProfiles = (): void => undefined;

  const oxyServices: RuntimeClient = {
    getAccessToken: () => bearer.current,
    getUsersByIds: (ids) => {
      profileFetches.push([...ids]);
      const users = ids.map(buildUser);
      if (!options.deferProfiles) {
        return Promise.resolve(users);
      }
      return new Promise<User[]>((resolve) => {
        releaseProfiles = () => resolve(users);
      });
    },
  };

  const calls = { activate: [] as string[], signOutContext: [] as string[], signOutPrincipal: [] as string[] };

  const sessionClient: RuntimeSessionClient = {
    getState: () => state,
    getDirectory: () => directory,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    refreshDirectory: () => Promise.resolve(),
    activateContext: (contextId) => {
      calls.activate.push(contextId);
      return options.rejectActivation
        ? Promise.reject(new Error('refused'))
        : Promise.resolve();
    },
    signOutContext: (contextId) => {
      calls.signOutContext.push(contextId);
      return Promise.resolve();
    },
    signOutPrincipal: (principalId) => {
      calls.signOutPrincipal.push(principalId);
      return Promise.resolve();
    },
  };

  const sessionClientHost: RuntimeSessionHost = { setCurrentAccountId: () => undefined };

  const identity =
    options.pinnedAccountId === undefined
      ? null
      : {
          binding: {} as never,
          getPinnedAccountId: () => options.pinnedAccountId ?? null,
          ensurePinnedAccountId: () => Promise.resolve(options.pinnedAccountId ?? null),
          refreshPinnedAccountId: () => Promise.resolve(options.pinnedAccountId ?? null),
        };

  const runtime = createOxyRuntime({
    oxyServices,
    sessionClient,
    sessionClientHost,
    identity,
    onSubjectChange: (transition) => {
      subjectChanges.push(transition);
      options.onSubjectChangeExtra?.();
    },
    onDeviceEmpty: () => {
      deviceEmptyCalls += 1;
      runtime.clearSession();
      return Promise.resolve();
    },
    onIdentityUnbound: (_binding, revision) => {
      identityUnbound.push(revision);
    },
    logger: () => undefined,
  });

  const dispose = runtime.start();

  return {
    runtime,
    setState: (next) => {
      state = next;
    },
    setDirectory: (next) => {
      directory = next;
    },
    fire: () => {
      for (const listener of [...listeners]) {
        listener(state);
      }
    },
    bearer,
    subjectChanges,
    get deviceEmptyCalls() {
      return deviceEmptyCalls;
    },
    identityUnbound,
    profileFetches,
    calls,
    releaseProfiles: () => releaseProfiles(),
    dispose,
  };
}

/** Let every already-resolved promise in the projection chain settle. */
const settle = async (): Promise<void> => {
  for (let i = 0; i < 6; i += 1) {
    await Promise.resolve();
  }
};

describe('createOxyRuntime — the snapshot', () => {
  it('starts booting, signed out, with no bearer', () => {
    const harness = buildHarness();
    const snapshot = harness.runtime.getSnapshot();
    expect(snapshot.status).toBe('booting');
    expect(snapshot.account).toBeNull();
    expect(snapshot.tokenStatus).toBe('missing');
    expect(snapshot.sessions).toEqual([]);
    expect(snapshot.authResolved).toBe(false);
    harness.dispose();
  });

  it('returns the SAME object until a fact changes, and a new one after', () => {
    const harness = buildHarness();
    const first = harness.runtime.getSnapshot();
    expect(harness.runtime.getSnapshot()).toBe(first);

    // A setter writing the value already held publishes nothing: this is what
    // lets a selector compare by identity.
    harness.runtime.setLoading(false);
    expect(harness.runtime.getSnapshot()).toBe(first);

    harness.runtime.setLoading(true);
    expect(harness.runtime.getSnapshot()).not.toBe(first);
    expect(harness.runtime.getSnapshot().isLoading).toBe(true);
    harness.dispose();
  });

  it('derives status and tokenStatus rather than storing them', () => {
    const harness = buildHarness();
    harness.runtime.markAuthResolved();
    expect(harness.runtime.getSnapshot().status).toBe('signed_out');
    expect(harness.runtime.getSnapshot().tokenStatus).toBe('missing');

    harness.runtime.setError('mint refused');
    expect(harness.runtime.getSnapshot().status).toBe('error');
    expect(harness.runtime.getSnapshot().error).toEqual({
      message: 'mint refused',
      code: 'oxy_runtime_error',
    });

    harness.runtime.setAccount(buildUser('a1'));
    expect(harness.runtime.getSnapshot().status).toBe('authenticated');
    // An authenticated account with no planted bearer is refreshing, never
    // "missing" — the distinction is what stops a consumer treating a re-mint
    // window as a sign-out.
    expect(harness.runtime.getSnapshot().tokenStatus).toBe('refreshing');

    harness.runtime.setHasAccessToken(true);
    expect(harness.runtime.getSnapshot().tokenStatus).toBe('ready');

    harness.runtime.setTokenReady(false);
    expect(harness.runtime.getSnapshot().tokenStatus).toBe('refreshing');
    harness.dispose();
  });

  it('notifies subscribers once per transition, not once per fact', async () => {
    const harness = buildHarness();
    let notifications = 0;
    const unsubscribe = harness.runtime.subscribe(() => {
      notifications += 1;
    });

    harness.setState(buildState('a1'));
    harness.bearer.current = 'a1';
    harness.fire();
    await settle();

    // sessions + activeSessionId + account + deviceState all moved.
    expect(notifications).toBe(1);
    unsubscribe();
    harness.dispose();
  });
});

describe('createOxyRuntime — the device projection', () => {
  it('projects sessions, the active session id and the account', async () => {
    const harness = buildHarness();
    harness.setState(buildState('a2'));
    harness.bearer.current = 'a2';
    harness.fire();
    await settle();

    const snapshot = harness.runtime.getSnapshot();
    expect(snapshot.sessions.map((session) => session.sessionId).sort()).toEqual(['sess-a1', 'sess-a2']);
    expect(snapshot.activeSessionId).toBe('sess-a2');
    expect(snapshot.account?.id).toBe('a2');
    expect(snapshot.deviceState?.revision).toBe(1);
    harness.dispose();
  });

  it('hands an empty device to onDeviceEmpty instead of projecting nothing', async () => {
    const harness = buildHarness();
    harness.setState(buildState('a1'));
    harness.fire();
    await settle();
    expect(harness.runtime.getSnapshot().account?.id).toBe('a1');

    harness.setState(buildState(null, 2, []));
    harness.fire();
    await settle();

    expect(harness.deviceEmptyCalls).toBe(1);
    expect(harness.runtime.getSnapshot().account).toBeNull();
    expect(harness.runtime.getSnapshot().sessions).toEqual([]);
    harness.dispose();
  });

  it('discards a projection its own state moved past', async () => {
    const harness = buildHarness({ deferProfiles: true });
    harness.setState(buildState('a1', 1));
    harness.fire();
    await settle();

    // The device switched to a2 while the a1 profile fetch was still in flight.
    harness.setState(buildState('a2', 2));
    harness.releaseProfiles();
    await settle();

    // The overtaken projection must publish NOTHING — not a1 as the subject,
    // and not a1's session as active.
    expect(harness.runtime.getSnapshot().account).toBeNull();
    expect(harness.runtime.getSnapshot().activeSessionId).toBeNull();
    harness.dispose();
  });

  it('resolves the actor and the subject separately once a directory is held', async () => {
    const harness = buildHarness();
    harness.setState(buildState('a2'));
    harness.setDirectory(buildDirectory('ctx-nate-collective'));
    harness.fire();
    await settle();

    const snapshot = harness.runtime.getSnapshot();
    expect(snapshot.activeContext?.contextId).toBe('ctx-nate-collective');
    expect(snapshot.activeContext?.isDelegated).toBe(true);
    // Nate is OPERATING the collective: the audit actor and the rendered
    // subject are different people, which the flat lane cannot say.
    expect(snapshot.principal?.id).toBe('a1');
    expect(snapshot.account?.id).toBe('a2');
    harness.dispose();
  });

  it('reports the principal as the subject when no directory has been read', async () => {
    const harness = buildHarness();
    harness.setState(buildState('a1'));
    harness.fire();
    await settle();

    const snapshot = harness.runtime.getSnapshot();
    expect(snapshot.activeContext).toBeNull();
    expect(snapshot.principal?.id).toBe('a1');
    expect(snapshot.principal).toBe(snapshot.account);
    harness.dispose();
  });
});

describe('createOxyRuntime — identity mode', () => {
  it('projects the PINNED account, not the device active one', async () => {
    const harness = buildHarness({ pinnedAccountId: 'a1' });
    harness.setState(buildState('a2'));
    harness.fire();
    await settle();

    expect(harness.runtime.getSnapshot().account?.id).toBe('a1');
    expect(harness.runtime.getSnapshot().activeSessionId).toBe('sess-a1');
    expect(harness.identityUnbound).toEqual([]);
    harness.dispose();
  });

  it('refuses to project and asks for re-establishment when the pin left the device', async () => {
    const harness = buildHarness({ pinnedAccountId: 'a9' });
    harness.setState(buildState('a2', 7));
    harness.fire();
    await settle();

    expect(harness.identityUnbound).toEqual([7]);
    // Projecting here would mean projecting SOMEBODY ELSE.
    expect(harness.runtime.getSnapshot().account).toBeNull();
    harness.dispose();
  });
});

describe('createOxyRuntime — the ordering invariant (ADR 0002)', () => {
  it('commits the bearer and resets account-scoped caches BEFORE waking a subscriber', async () => {
    const resetLog: string[] = [];
    const harness = buildHarness({
      onSubjectChangeExtra: () => {
        resetLog.push('reset');
      },
    });

    harness.setState(buildState('a1'));
    harness.bearer.current = 'a1';
    harness.fire();
    await settle();

    // The initial sign-in already produced one reset; the switch's own reset is
    // the delta this test is about.
    const resetsBefore = resetLog.length;
    const observed: Array<{ subject: string | null; bearer: string | null; resetsSinceSubscribe: number }> = [];
    const unsubscribe = harness.runtime.subscribe(() => {
      observed.push({
        subject: harness.runtime.getSnapshot().account?.id ?? null,
        bearer: harness.bearer.current,
        resetsSinceSubscribe: resetLog.length - resetsBefore,
      });
    });

    // The switch, exactly as `SessionClient` delivers it: the mint is awaited
    // before the client notifies, so the bearer already belongs to a2 here.
    harness.bearer.current = 'a2';
    harness.setState(buildState('a2', 2));
    harness.fire();
    await settle();

    expect(observed).toHaveLength(1);
    // A component woken by this must never render a2 while holding a1's bearer,
    // and must never read a cache entry a1 populated.
    expect(observed[0]).toEqual({ subject: 'a2', bearer: 'a2', resetsSinceSubscribe: 1 });
    unsubscribe();
    harness.dispose();
  });

  it('classifies the three subject transitions so a warm cache is only dropped on a real switch', async () => {
    const harness = buildHarness();

    harness.setState(buildState('a1'));
    harness.fire();
    await settle();

    harness.setState(buildState('a2', 2));
    harness.fire();
    await settle();

    harness.setState(buildState(null, 3, []));
    harness.fire();
    await settle();

    expect(harness.subjectChanges).toEqual([
      { previous: null, next: 'a1' },
      { previous: 'a1', next: 'a2' },
      { previous: 'a2', next: null },
    ]);
    harness.dispose();
  });

  it('batches a session commit into one publish and one reset', () => {
    const harness = buildHarness();
    let notifications = 0;
    const unsubscribe = harness.runtime.subscribe(() => {
      notifications += 1;
    });

    // Exactly the shape of a commit: an optimistic session mirror, the active
    // id, and the account, before any server round-trip has landed.
    harness.runtime.batch(() => {
      harness.runtime.mergeSessions(
        [
          {
            sessionId: 'sess-a1',
            deviceId: 'dev-1',
            userId: 'a1',
            isCurrent: true,
            expiresAt: '2030-01-01T00:00:00.000Z',
            lastActive: '2030-01-01T00:00:00.000Z',
          },
        ],
        { merge: true },
      );
      harness.runtime.setActiveSessionId('sess-a1');
      harness.runtime.setAccount(buildUser('a1'));
    });

    expect(notifications).toBe(1);
    expect(harness.subjectChanges).toEqual([{ previous: null, next: 'a1' }]);
    const snapshot = harness.runtime.getSnapshot();
    expect(snapshot.activeSessionId).toBe('sess-a1');
    expect(snapshot.account?.id).toBe('a1');
    unsubscribe();
    harness.dispose();
  });

  it('resets once for a projection that touches the account through several facts', async () => {
    const harness = buildHarness();
    harness.setState(buildState('a1'));
    harness.fire();
    await settle();

    // One transition — sessions, active id, deviceState and account all moved —
    // must produce exactly one reset, not one per fact.
    expect(harness.subjectChanges).toHaveLength(1);
    harness.dispose();
  });

  it('does not fire a subject change when the projection re-lands the same account', async () => {
    const harness = buildHarness();
    harness.setState(buildState('a1', 1));
    harness.fire();
    await settle();
    harness.setState(buildState('a1', 2));
    harness.fire();
    await settle();

    expect(harness.subjectChanges).toEqual([{ previous: null, next: 'a1' }]);
    harness.dispose();
  });
});

describe('createOxyRuntime — activation and the two removal meanings', () => {
  it('activates by contextId and publishes `switching` for the whole round trip', async () => {
    const harness = buildHarness();
    const switchingSeen: boolean[] = [];
    const unsubscribe = harness.runtime.subscribe(() => {
      switchingSeen.push(harness.runtime.getSnapshot().switching);
    });

    harness.setState(buildState('a2'));
    await harness.runtime.activateContext('ctx-nate-collective');

    expect(harness.calls.activate).toEqual(['ctx-nate-collective']);
    // A switcher must be able to disable its rows for the duration, so
    // `switching` has to be observable as true and then false — not merely be
    // false again by the time the promise resolves.
    expect(switchingSeen).toContain(true);
    expect(harness.runtime.getSnapshot().switching).toBe(false);
    unsubscribe();
    harness.dispose();
  });

  it('clears `switching` when the activation is refused', async () => {
    const harness = buildHarness({ rejectActivation: true });

    await expect(harness.runtime.activateContext('ctx-x')).rejects.toThrow('refused');

    // A refused activation must not strand the flag on, or a switcher stays
    // disabled forever with no error it can see.
    expect(harness.runtime.getSnapshot().switching).toBe(false);
    harness.dispose();
  });

  it('removes one principal-to-account pair, and one person, through distinct calls', async () => {
    const harness = buildHarness();
    harness.setState(buildState('a1'));

    await harness.runtime.signOutContext('ctx-nate-collective');
    await harness.runtime.signOutPrincipal('p-nate');

    // Two different questions, two different endpoints. Collapsing them onto
    // `signOut({accountId})` removes every person's route to that account.
    expect(harness.calls.signOutContext).toEqual(['ctx-nate-collective']);
    expect(harness.calls.signOutPrincipal).toEqual(['p-nate']);
    expect(harness.calls.activate).toEqual([]);
    harness.dispose();
  });
});
