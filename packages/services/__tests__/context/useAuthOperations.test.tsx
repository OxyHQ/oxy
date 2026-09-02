/**
 * Tests for `useAuthOperations`.
 *
 * Covers the three exported operations:
 *   - signIn (online happy path, best-effort device registration, error path)
 *   - logout (current session, partial vs full sign-out, 401 fast-path — with
 *     and without an explicit target, since every in-app affordance calls it
 *     with none)
 *   - logoutAll (no-active-session early-out, success, error, and the
 *     already-invalid-bearer case that follows an account deletion)
 *
 * `DeviceManager`, `SignatureService`, `fetchSessionsWithFallback`, the
 * device-first `AuthStateStore`, and the OxyServices network methods are mocked
 * so the test exercises the orchestration logic only — actual network, crypto,
 * and persistence belong to `@oxyhq/core` and are covered by its own tests.
 *
 * `logout` / `logoutAll` route SERVER-side revocation through a mocked
 * `SessionClient` (device-first) rather than the bearer/cookie logout
 * endpoints. A genuine FULL sign-out additionally clears the persisted refresh
 * family via `store.clear()` (`clearPersistedAuthSafe`).
 */

import { renderHook, act } from '@testing-library/react';
import type { SessionLoginResponse, User } from '@oxyhq/core';

jest.mock('@oxyhq/core', () => {
  return {
    __esModule: true,
    DeviceManager: {
      getDeviceFingerprint: jest.fn(() => ({
        userAgent: 'jest',
        platform: 'test',
      })),
      getDeviceInfo: jest.fn(async () => ({ deviceName: 'Test Device' })),
      getDefaultDeviceName: jest.fn(() => 'Default Device'),
    },
    SignatureService: {
      generateChallenge: jest.fn(async () => 'local-challenge'),
      signChallenge: jest.fn(async (challenge: string) => ({
        challenge: `signed:${challenge}`,
        timestamp: 1234567890,
      })),
    },
  };
});

jest.mock('expo-crypto', () => ({
  __esModule: true,
  randomUUID: jest.fn(() => 'test-uuid-0000'),
}), { virtual: true });

jest.mock('../../src/ui/utils/sessionHelpers', () => ({
  __esModule: true,
  fetchSessionsWithFallback: jest.fn(),
  mapSessionsToClient: jest.fn((sessions) => sessions),
}));

import { useAuthOperations } from '../../src/ui/context/hooks/useAuthOperations';
import * as sessionHelpers from '../../src/ui/utils/sessionHelpers';

interface FakeServices {
  requestChallenge: jest.Mock;
  verifyChallenge: jest.Mock;
  setTokens: jest.Mock;
  getCurrentUser: jest.Mock;
  logoutSession: jest.Mock;
}

const makeOxyServices = (overrides: Partial<FakeServices> = {}): FakeServices => ({
  requestChallenge: jest.fn(async () => ({ challenge: 'server-challenge' })),
  // The real `/auth/verify` always returns the first access token in its body,
  // and `OxyServices.verifyChallenge` now PLANTS that token internally
  // (mirroring `claimSessionByToken`). The mock returns the token to mirror the
  // real response shape, but the consumer no longer reads it directly. The
  // zero-cookie device credential (`deviceId` + `deviceSecret`) is returned so
  // `performSignIn` persists the durable blob (`store.save`).
  verifyChallenge: jest.fn(async (): Promise<SessionLoginResponse> => ({
    sessionId: 'new-session',
    deviceId: 'device-1',
    expiresAt: '2030-01-01',
    accessToken: 'verify-access-token',
    deviceSecret: 'verify-device-secret',
    user: { id: 'user-1', username: 'alice' },
  })),
  setTokens: jest.fn(),
  // `performSignIn` hydrates the full user from the bearer (`GET /users/me`)
  // now that `verifyChallenge` has planted the access token — not from a
  // session-id URL. `getCurrentUser` takes no args and returns the bearer's user.
  getCurrentUser: jest.fn(async (): Promise<User> => ({
    id: 'user-1',
    username: 'alice',
    privacySettings: {},
  } as User)),
  // Still used by `performSignIn`'s same-user duplicate-session dedup path —
  // unrelated to the SessionClient-routed `logout`/`logoutAll`.
  logoutSession: jest.fn(async () => undefined),
  ...overrides,
});

/** A device account tracked by the (mocked) `SessionClient`. */
interface FakeSessionAccount {
  accountId: string;
  sessionId: string;
  authuser: number;
}

/**
 * A controllable stand-in for `SessionClient`. `signOut` mutates the tracked
 * account list the same way the real server would, so `getState()` (read by
 * `logout`/`logoutAll` both before AND after the call) reflects the removal.
 * `registerAndActivate` is the deliberate-sign-in registration `performSignIn`
 * calls (adds the recovered account into the device set and activates it).
 */
function buildFakeSessionClient(initialAccounts: FakeSessionAccount[]) {
  let accounts = [...initialAccounts];
  const signOut = jest.fn(async (target: { accountId: string } | { all: true }) => {
    accounts = 'all' in target ? [] : accounts.filter((account) => account.accountId !== target.accountId);
  });
  const switchAccount = jest.fn(async () => undefined);
  const addCurrentAccount = jest.fn(async () => undefined);
  const registerAndActivate = jest.fn(async () => undefined);
  const getState = jest.fn(() => ({
    deviceId: 'dev-1',
    accounts,
    activeAccountId: accounts[0]?.accountId ?? null,
    revision: 1,
    updatedAt: Date.now(),
  }));
  return { signOut, switchAccount, addCurrentAccount, registerAndActivate, getState };
}

/** A controllable stand-in for the device-first `AuthStateStore`. */
/**
 * The runtime surface `useAuthOperations` touches, as a recorder.
 *
 * This suite mocks `@oxyhq/core` wholesale — its subject is the orchestration,
 * not the projection — so a real `OxyRuntime` would be built over a mocked core
 * and prove nothing extra. `activeSessionId` is a real mutable fact because the
 * hook READS it back to decide whether there is anything to sign out.
 */
function buildFakeRuntime(initialActiveSessionId: string | null) {
  let activeSessionId = initialActiveSessionId;
  const setActiveSessionId = jest.fn((sessionId: string | null) => {
    activeSessionId = sessionId;
  });
  return {
    getSnapshot: () => ({ activeSessionId }),
    batch: (mutate: () => void) => mutate(),
    setActiveSessionId,
    mergeSessions: jest.fn(),
    setAccount: jest.fn(),
    setLoading: jest.fn(),
    setError: jest.fn(),
  };
}

function buildFakeStore() {
  return {
    load: jest.fn(async () => null),
    save: jest.fn(async () => undefined),
    clear: jest.fn(async () => undefined),
  };
}

interface SetupOpts {
  oxyServices?: Partial<FakeServices>;
  activeSessionId?: string | null;
  sessionClient?: ReturnType<typeof buildFakeSessionClient>;
  store?: ReturnType<typeof buildFakeStore>;
  syncFromClient?: jest.Mock<Promise<void>, []>;
  identityBinding?: {
    pinStore: { save: jest.Mock; load: jest.Mock; clear: jest.Mock };
  };
  refreshPinnedAccountId?: jest.Mock<Promise<string | null>, []>;
}

const setup = (opts: SetupOpts = {}) => {
  const oxyServices = makeOxyServices(opts.oxyServices);
  const store = opts.store ?? buildFakeStore();
  const runtime = buildFakeRuntime(opts.activeSessionId ?? null);
  const saveActiveSessionId = jest.fn(async () => undefined);
  const clearSessionState = jest.fn(async () => undefined);
  const switchSession = jest.fn(async () => ({
    id: 'user-1',
    username: 'alice',
    privacySettings: {},
  } as User));
  const onAuthStateChange = jest.fn();
  const onError = jest.fn();
  const logger = jest.fn();
  const sessionClient = opts.sessionClient ?? buildFakeSessionClient([]);
  const syncFromClient = opts.syncFromClient ?? jest.fn(async () => undefined);

  // Reset session helper mocks
  (sessionHelpers.fetchSessionsWithFallback as jest.Mock).mockResolvedValue([]);

  const { result } = renderHook(() =>
    useAuthOperations({
      // Fake services match the runtime interface but TypeScript can't see
      // through mixin composition, so cast through `never`.
      oxyServices: oxyServices as never,
      store: store as never,
      storage: null,
      runtime: runtime as never,
      saveActiveSessionId,
      clearSessionState,
      switchSession,
      sessionClient: sessionClient as never,
      syncFromClient,
      onAuthStateChange,
      onError,
      logger,
      identityBinding: opts.identityBinding as never,
      refreshPinnedAccountId: opts.refreshPinnedAccountId,
    }),
  );

  return {
    result,
    oxyServices,
    store,
    sessionClient,
    syncFromClient,
    setActiveSessionId: runtime.setActiveSessionId,
    mergeSessions: runtime.mergeSessions,
    setAccount: runtime.setAccount,
    setLoading: runtime.setLoading,
    setError: runtime.setError,
    saveActiveSessionId,
    clearSessionState,
    switchSession,
    onAuthStateChange,
    onError,
    logger,
  };
};

describe('useAuthOperations.signIn — online flow', () => {
  it('authenticates via verifyChallenge and registers the account into the device set', async () => {
    (sessionHelpers.fetchSessionsWithFallback as jest.Mock).mockResolvedValueOnce([
      { sessionId: 'new-session', deviceId: 'device-1', userId: 'user-1', isCurrent: true },
    ]);

    const helpers = setup();

    let signedInUser: User | undefined;
    await act(async () => {
      signedInUser = await helpers.result.current.signIn('pubkey-1');
    });

    expect(helpers.oxyServices.requestChallenge).toHaveBeenCalledWith('pubkey-1');
    expect(helpers.oxyServices.verifyChallenge).toHaveBeenCalled();
    // `verifyChallenge` now plants the first access token internally (asserted
    // in @oxyhq/core's auth mixin tests), so the consumer no longer touches
    // `setTokens` directly...
    expect(helpers.oxyServices.setTokens).not.toHaveBeenCalled();
    // ...and hydrates the user from the bearer (`GET /users/me`), NOT a
    // session-id URL that could disagree with the planted token.
    expect(helpers.oxyServices.getCurrentUser).toHaveBeenCalled();
    // The response carried the zero-cookie device credential, so the durable blob
    // was persisted for a redirect-less reload restore.
    expect(helpers.store.save).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'new-session',
        userId: 'user-1',
        deviceId: 'device-1',
        deviceSecret: 'verify-device-secret',
      }),
    );
    // The recovered account+session is registered into the server-authoritative
    // device-session set AND made active (`registerAndActivate`).
    expect(helpers.sessionClient.registerAndActivate).toHaveBeenCalledWith('user-1');
    expect(helpers.syncFromClient).toHaveBeenCalledTimes(1);
    expect(helpers.setActiveSessionId).toHaveBeenCalledWith('new-session');
    expect(helpers.saveActiveSessionId).toHaveBeenCalledWith('new-session');
    expect(helpers.setAccount).toHaveBeenCalled();
    expect(helpers.onAuthStateChange).toHaveBeenCalled();
    expect(signedInUser?.id).toBe('user-1');
    expect(helpers.setLoading).toHaveBeenCalledWith(true);
    expect(helpers.setLoading).toHaveBeenLastCalledWith(false);
  });

  it('persists the identity pin when identityBinding is provided', async () => {
    (sessionHelpers.fetchSessionsWithFallback as jest.Mock).mockResolvedValueOnce([
      { sessionId: 'new-session', deviceId: 'device-1', userId: 'user-1', isCurrent: true },
    ]);

    const pinStore = {
      load: jest.fn(async () => null),
      save: jest.fn(async () => true),
      clear: jest.fn(async () => undefined),
    };
    const refreshPinnedAccountId = jest.fn(async () => 'user-1');
    const helpers = setup({ identityBinding: { pinStore }, refreshPinnedAccountId });

    await act(async () => {
      await helpers.result.current.signIn('AbC123');
    });

    expect(pinStore.save).toHaveBeenCalledWith({
      publicKey: 'abc123',
      accountId: 'user-1',
    });
    expect(refreshPinnedAccountId).toHaveBeenCalledTimes(1);
  });

  it('does not fail sign-in when device-session registration fails (best-effort)', async () => {
    (sessionHelpers.fetchSessionsWithFallback as jest.Mock).mockResolvedValueOnce([
      { sessionId: 'new-session', deviceId: 'device-1', userId: 'user-1', isCurrent: true },
    ]);

    const sessionClient = buildFakeSessionClient([]);
    sessionClient.registerAndActivate.mockRejectedValueOnce(new Error('network down'));
    const helpers = setup({ sessionClient });

    let signedInUser: User | undefined;
    await act(async () => {
      signedInUser = await helpers.result.current.signIn('pubkey-1');
    });

    expect(signedInUser?.id).toBe('user-1');
    expect(helpers.setAccount).toHaveBeenCalled();
    expect(helpers.logger).toHaveBeenCalledWith(
      'Failed to register sign-in into device session set',
      expect.any(Error),
    );
    // The registration failure must not have cascaded into re-throwing / a
    // failed sign-in. `signIn` opens by CLEARING any previous error, so the
    // assertion is that no error MESSAGE was ever recorded — not that the
    // setter went untouched.
    expect(helpers.setError.mock.calls.map(([message]: [string | null]) => message)).toEqual([null]);
  });

  it('continues sign-in when the verify response omits an access token', async () => {
    (sessionHelpers.fetchSessionsWithFallback as jest.Mock).mockResolvedValueOnce([
      { sessionId: 'new-session', deviceId: 'device-1', userId: 'user-1', isCurrent: true },
    ]);

    const helpers = setup({
      oxyServices: {
        // A token-less new identity (onboarding): verify returns no access
        // token. The consumer must still proceed to fetch the user without
        // depending on legacy session-id token exchange.
        verifyChallenge: jest.fn(async (): Promise<SessionLoginResponse> => ({
          sessionId: 'new-session',
          deviceId: 'device-1',
          expiresAt: '2030-01-01',
          user: { id: 'user-1', username: 'alice' },
        })),
      },
    });

    let signedInUser: User | undefined;
    await act(async () => {
      signedInUser = await helpers.result.current.signIn('pubkey-1');
    });

    expect(helpers.oxyServices.setTokens).not.toHaveBeenCalled();
    expect(helpers.oxyServices.getCurrentUser).toHaveBeenCalled();
    // No rotating refresh token in the response → nothing durable to persist.
    expect(helpers.store.save).not.toHaveBeenCalled();
    expect(signedInUser?.id).toBe('user-1');
  });

  it('rejects with the original error when verifyChallenge throws', async () => {
    const helpers = setup({
      oxyServices: {
        verifyChallenge: jest.fn(async () => {
          throw new Error('signature mismatch');
        }),
      },
    });

    let caught: unknown;
    await act(async () => {
      try {
        await helpers.result.current.signIn('pubkey-1');
      } catch (error) {
        caught = error;
      }
    });

    expect((caught as Error).message).toBe('signature mismatch');
    expect(helpers.setError).toHaveBeenCalledWith('signature mismatch');
    expect(helpers.onError).toHaveBeenCalledWith(expect.objectContaining({
      code: 'LOGIN_ERROR',
    }));
  });

  it('switches to an existing session for the same user instead of duplicating', async () => {
    (sessionHelpers.fetchSessionsWithFallback as jest.Mock).mockResolvedValueOnce([
      { sessionId: 'old-session', deviceId: 'device-1', userId: 'user-1', isCurrent: false },
      { sessionId: 'new-session', deviceId: 'device-1', userId: 'user-1', isCurrent: true },
    ]);

    const helpers = setup();

    await act(async () => {
      await helpers.result.current.signIn('pubkey-1');
    });

    // Should have killed the newly-created duplicate and switched to the existing one
    expect(helpers.oxyServices.logoutSession).toHaveBeenCalledWith('new-session', 'new-session');
    expect(helpers.switchSession).toHaveBeenCalledWith('old-session');
    expect(helpers.mergeSessions).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ sessionId: 'old-session' }),
      ]),
      { merge: false },
    );
  });
});

describe('useAuthOperations.signIn — requestChallenge failures', () => {
  it('does not create a local session when the network is unavailable', async () => {
    const helpers = setup({
      oxyServices: {
        requestChallenge: jest.fn(async () => {
          throw new Error('Network request failed');
        }),
      },
    });

    await expect(
      act(async () => {
        await helpers.result.current.signIn('offline-pubkey');
      }),
    ).rejects.toThrow('Network request failed');

    expect(helpers.oxyServices.verifyChallenge).not.toHaveBeenCalled();
    expect(helpers.oxyServices.getCurrentUser).not.toHaveBeenCalled();
    expect(helpers.setActiveSessionId).not.toHaveBeenCalled();
    expect(helpers.setAccount).not.toHaveBeenCalled();
    expect(helpers.onAuthStateChange).not.toHaveBeenCalled();
  });

  it('re-throws non-network errors from requestChallenge', async () => {
    const helpers = setup({
      oxyServices: {
        requestChallenge: jest.fn(async () => {
          throw new Error('bad request (400)');
        }),
      },
    });

    await expect(
      act(async () => {
        await helpers.result.current.signIn('pubkey-1');
      }),
    ).rejects.toThrow('bad request');

    // Did NOT switch to offline flow
    expect(helpers.setActiveSessionId).not.toHaveBeenCalled();
  });
});

describe('useAuthOperations.logout', () => {
  const twoDeviceAccounts: FakeSessionAccount[] = [
    { accountId: 'acc-1', sessionId: 'session-1', authuser: 0 },
    { accountId: 'acc-2', sessionId: 'session-2', authuser: 1 },
  ];

  it('no-ops when there is no active session', async () => {
    const sessionClient = buildFakeSessionClient(twoDeviceAccounts);
    const helpers = setup({ activeSessionId: null, sessionClient });
    await act(async () => {
      await helpers.result.current.logout();
    });
    expect(sessionClient.signOut).not.toHaveBeenCalled();
    expect(helpers.clearSessionState).not.toHaveBeenCalled();
  });

  it('signs out the active account via SessionClient and reprojects when other accounts remain', async () => {
    const sessionClient = buildFakeSessionClient(twoDeviceAccounts);
    const helpers = setup({ activeSessionId: 'session-1', sessionClient });
    await act(async () => {
      await helpers.result.current.logout();
    });
    expect(sessionClient.signOut).toHaveBeenCalledWith({ accountId: 'acc-1' });
    expect(helpers.syncFromClient).toHaveBeenCalledTimes(1);
    // Partial sign-out: other accounts remain → NO local teardown, NO persisted
    // store wipe (the device is still signed in).
    expect(helpers.clearSessionState).not.toHaveBeenCalled();
    expect(helpers.store.clear).not.toHaveBeenCalled();
  });

  it('clears local state AND the persisted store (full sign-out) when the last device account is signed out', async () => {
    const sessionClient = buildFakeSessionClient([{ accountId: 'acc-1', sessionId: 'session-1', authuser: 0 }]);
    const helpers = setup({ activeSessionId: 'session-1', sessionClient });
    await act(async () => {
      await helpers.result.current.logout();
    });
    expect(sessionClient.signOut).toHaveBeenCalledWith({ accountId: 'acc-1' });
    expect(helpers.syncFromClient).toHaveBeenCalledTimes(1);
    expect(helpers.clearSessionState).toHaveBeenCalledTimes(1);
    // Genuine FULL sign-out → the persisted device credential is cleared so the
    // next cold boot finds nothing to restore.
    expect(helpers.store.clear).toHaveBeenCalledTimes(1);
  });

  it('logs out a specific non-active session without disturbing the active one', async () => {
    const sessionClient = buildFakeSessionClient(twoDeviceAccounts);
    const helpers = setup({ activeSessionId: 'session-1', sessionClient });
    await act(async () => {
      await helpers.result.current.logout('session-2');
    });
    expect(sessionClient.signOut).toHaveBeenCalledWith({ accountId: 'acc-2' });
    expect(helpers.syncFromClient).toHaveBeenCalledTimes(1);
    expect(helpers.clearSessionState).not.toHaveBeenCalled();
    // A partial sign-out (other accounts remain) must NOT clear the store.
    expect(helpers.store.clear).not.toHaveBeenCalled();
  });

  it('reports a clear error (no silent no-op) when the target session has no matching device account', async () => {
    const sessionClient = buildFakeSessionClient([{ accountId: 'acc-1', sessionId: 'session-1', authuser: 0 }]);
    const helpers = setup({ activeSessionId: 'session-1', sessionClient });
    await act(async () => {
      await helpers.result.current.logout('session-unknown');
    });
    expect(sessionClient.signOut).not.toHaveBeenCalled();
    expect(helpers.clearSessionState).not.toHaveBeenCalled();
    expect(helpers.onError).toHaveBeenCalledWith(expect.objectContaining({
      code: 'LOGOUT_ERROR',
    }));
  });

  it('clears local state and the store when the server reports the session as invalid (401 fast-path)', async () => {
    const sessionClient = buildFakeSessionClient([{ accountId: 'acc-1', sessionId: 'session-1', authuser: 0 }]);
    sessionClient.signOut.mockImplementationOnce(async () => {
      const err: Error & { status?: number } = new Error('HTTP 401: invalid session');
      err.status = 401;
      throw err;
    });
    const helpers = setup({ activeSessionId: 'session-1', sessionClient });

    await act(async () => {
      await helpers.result.current.logout('session-1');
    });

    expect(helpers.clearSessionState).toHaveBeenCalledTimes(1);
    expect(helpers.store.clear).toHaveBeenCalledTimes(1);
    expect(helpers.onError).not.toHaveBeenCalled();
  });

  it('clears local state and the store on a 401 when called with NO target (the real sign-out call shape)', async () => {
    // Every in-app sign-out affordance calls `logout()` with no argument (see
    // `ManageAccountScreen.handleSignOut`), so the invalid-session fast-path has
    // to key on the RESOLVED session id, not on the raw optional parameter.
    const sessionClient = buildFakeSessionClient([{ accountId: 'acc-1', sessionId: 'session-1', authuser: 0 }]);
    sessionClient.signOut.mockImplementationOnce(async () => {
      const err: Error & { status?: number } = new Error('HTTP 401: invalid session');
      err.status = 401;
      throw err;
    });
    const helpers = setup({ activeSessionId: 'session-1', sessionClient });

    await act(async () => {
      await helpers.result.current.logout();
    });

    expect(helpers.clearSessionState).toHaveBeenCalledTimes(1);
    expect(helpers.store.clear).toHaveBeenCalledTimes(1);
    expect(helpers.onError).not.toHaveBeenCalled();
  });

  it('reports unexpected errors via onError', async () => {
    const sessionClient = buildFakeSessionClient([{ accountId: 'acc-1', sessionId: 'session-1', authuser: 0 }]);
    sessionClient.signOut.mockImplementationOnce(async () => {
      throw new Error('boom');
    });
    const helpers = setup({ activeSessionId: 'session-1', sessionClient });

    await act(async () => {
      await helpers.result.current.logout('session-1');
    });

    expect(helpers.onError).toHaveBeenCalledWith(expect.objectContaining({
      code: 'LOGOUT_ERROR',
    }));
  });
});

describe('useAuthOperations.logoutAll', () => {
  it('throws when there is no active session', async () => {
    const helpers = setup({ activeSessionId: null });
    await expect(
      act(async () => {
        await helpers.result.current.logoutAll();
      }),
    ).rejects.toThrow(/No active session/);
    expect(helpers.onError).toHaveBeenCalledWith(expect.objectContaining({
      code: 'LOGOUT_ALL_ERROR',
      status: 404,
    }));
  });

  it('revokes every device account via SessionClient and clears local state + the persisted store on success', async () => {
    const sessionClient = buildFakeSessionClient([
      { accountId: 'acc-1', sessionId: 'session-1', authuser: 0 },
      { accountId: 'acc-2', sessionId: 'session-2', authuser: 1 },
    ]);
    const helpers = setup({ activeSessionId: 'session-1', sessionClient });
    await act(async () => {
      await helpers.result.current.logoutAll();
    });
    expect(sessionClient.signOut).toHaveBeenCalledWith({ all: true });
    expect(helpers.clearSessionState).toHaveBeenCalledTimes(1);
    // logoutAll is ALWAYS a full sign-out → the persisted device credential is
    // cleared so the next cold boot finds nothing to restore.
    expect(helpers.store.clear).toHaveBeenCalledTimes(1);
  });

  it('re-throws and reports when SessionClient.signOut({ all: true }) fails', async () => {
    const sessionClient = buildFakeSessionClient([{ accountId: 'acc-1', sessionId: 'session-1', authuser: 0 }]);
    sessionClient.signOut.mockImplementationOnce(async () => {
      throw new Error('server down');
    });
    const helpers = setup({ activeSessionId: 'session-1', sessionClient });

    let caught: unknown;
    await act(async () => {
      try {
        await helpers.result.current.logoutAll();
      } catch (error) {
        caught = error;
      }
    });

    expect((caught as Error).message).toBe('server down');
    expect(sessionClient.signOut).toHaveBeenCalledWith({ all: true });
    expect(helpers.onError).toHaveBeenCalledWith(expect.objectContaining({
      code: 'LOGOUT_ALL_ERROR',
    }));
    // The failed revoke must NOT run the local teardown or wipe the store.
    expect(helpers.clearSessionState).not.toHaveBeenCalled();
    expect(helpers.store.clear).not.toHaveBeenCalled();
  });

  it('resolves (and tears down locally) when the bearer is already invalid — e.g. right after account deletion', async () => {
    // `DELETE /users/me` revokes every session of the deleted user and detaches
    // the account from all device-session docs, so the sign-out that FOLLOWS it
    // necessarily answers 401. That is a COMPLETED sign-out, not a failure: the
    // caller (Commons' delete-account flow) must reach its post-deletion cleanup
    // instead of being handed an error.
    const sessionClient = buildFakeSessionClient([{ accountId: 'acc-1', sessionId: 'session-1', authuser: 0 }]);
    sessionClient.signOut.mockImplementationOnce(async () => {
      // `HttpService` rejects with the PLAIN `ApiError` object `handleHttpError`
      // builds — not an `Error` instance. Mirror that exactly.
      throw { message: 'Session not found or expired', code: 'UNAUTHORIZED', status: 401 };
    });
    const helpers = setup({ activeSessionId: 'session-1', sessionClient });

    await act(async () => {
      await expect(helpers.result.current.logoutAll()).resolves.toBeUndefined();
    });

    expect(sessionClient.signOut).toHaveBeenCalledWith({ all: true });
    expect(helpers.clearSessionState).toHaveBeenCalledTimes(1);
    expect(helpers.store.clear).toHaveBeenCalledTimes(1);
    expect(helpers.onError).not.toHaveBeenCalled();
  });

  it('rejects with the SERVER message, not a generic one, when signOut fails with a plain ApiError object', async () => {
    // `HttpService` never rejects with an `Error` instance, so an
    // `error instanceof Error` rethrow guard always erased the real reason.
    const sessionClient = buildFakeSessionClient([{ accountId: 'acc-1', sessionId: 'session-1', authuser: 0 }]);
    sessionClient.signOut.mockImplementationOnce(async () => {
      throw { message: 'Service unavailable', code: 'SERVICE_UNAVAILABLE', status: 503 };
    });
    const helpers = setup({ activeSessionId: 'session-1', sessionClient });

    let caught: unknown;
    await act(async () => {
      try {
        await helpers.result.current.logoutAll();
      } catch (error) {
        caught = error;
      }
    });

    expect((caught as Error).message).toBe('Service unavailable');
    expect(helpers.onError).toHaveBeenCalledWith(expect.objectContaining({
      code: 'LOGOUT_ALL_ERROR',
      status: 503,
    }));
    expect(helpers.clearSessionState).not.toHaveBeenCalled();
    expect(helpers.store.clear).not.toHaveBeenCalled();
  });
});
