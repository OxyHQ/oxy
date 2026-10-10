import { act, renderHook } from '@testing-library/react';
import { __resetOxyState, __setOxyState } from '@/__mocks__/oxy-services';

// Stub only the server round-trip; the hook's lock + store wiring stays real.
const syncIdentityWithServerMock = jest.fn();
jest.mock('@/hooks/identity/syncService', () => ({
  syncIdentityWithServer: (opts: unknown) => syncIdentityWithServerMock(opts),
}));
// useSyncIdentity now uses the SILENT key sign-in (no biometric gate).
jest.mock('@/hooks/useSilentKeySignIn', () => ({
  useSilentKeySignIn: () => ({ signInWithKeySilent: jest.fn() }),
}));
const pendingUsername: { value: string | null } = { value: null };
jest.mock('@/hooks/identity/identityStore', () => {
  const actual = jest.requireActual('@/hooks/identity/identityStore');
  return {
    ...actual,
    persistIdentitySyncState: jest.fn(async () => undefined),
    getIdentitySyncStateFromStorage: jest.fn(async () => false),
    persistPendingUsername: jest.fn(async (username: string | null) => {
      pendingUsername.value = username;
    }),
    getPendingUsernameFromStorage: jest.fn(async () => pendingUsername.value),
  };
});
const syncSharedIdentityMock = jest.fn(async () => true);
jest.mock('@oxy.so/core/crypto', () => {
  const actual = jest.requireActual('@oxy.so/core/crypto');
  return {
    ...actual,
    KeyManager: { ...actual.KeyManager, syncSharedIdentity: () => syncSharedIdentityMock() },
  };
});

import { useSyncIdentity } from '@/hooks/identity/useSyncIdentity';
import { useIdentityStore, persistIdentitySyncState } from '@/hooks/identity/identityStore';
import { releaseSyncLock } from '@/hooks/identity/syncLock';
import { UsernameRequiredError } from '@/hooks/identity/identityErrors';
import { handleAuthError } from '@oxy.so/services';

/** Let the on-mount hydrate settle so it can't clobber a later sync-state write. */
async function flushHydrate() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
}

describe('useSyncIdentity', () => {
  beforeEach(() => {
    __resetOxyState();
    __setOxyState({ oxyServices: { register: jest.fn() } });
    syncIdentityWithServerMock.mockReset();
    (persistIdentitySyncState as jest.Mock).mockClear();
    syncSharedIdentityMock.mockClear();
    pendingUsername.value = null;
    releaseSyncLock();
    useIdentityStore.getState().reset();
  });

  it('reflects the reactive sync state from the store', async () => {
    const { result } = renderHook(() => useSyncIdentity());
    await flushHydrate();

    expect(result.current.identitySyncState).toEqual({ isSynced: false, isSyncing: false });

    act(() => {
      useIdentityStore.getState().setSynced(true);
    });
    expect(result.current.identitySyncState.isSynced).toBe(true);
  });

  it('syncs via syncIdentityWithServer, returns the user, and persists the synced flag', async () => {
    syncIdentityWithServerMock.mockResolvedValue({ user: { id: 'me' }, wasRegistered: false });
    const { result } = renderHook(() => useSyncIdentity());
    await flushHydrate();

    let user: unknown;
    await act(async () => {
      user = await result.current.syncIdentity();
    });

    expect(user).toEqual({ id: 'me' });
    expect(syncIdentityWithServerMock).toHaveBeenCalledTimes(1);
    expect(persistIdentitySyncState).toHaveBeenCalledWith(true);
    expect(useIdentityStore.getState().isSynced).toBe(true);
  });

  it('registers with the username just chosen, keeping it pending until the sync succeeds', async () => {
    syncIdentityWithServerMock.mockImplementation(async (opts: { username?: string | null }) => {
      // Persisted BEFORE the round-trip, so an offline / failed attempt keeps it.
      expect(pendingUsername.value).toBe('alice');
      expect(opts.username).toBe('alice');
      return { user: { id: 'me', username: 'alice' }, wasRegistered: true };
    });
    const { result } = renderHook(() => useSyncIdentity());
    await flushHydrate();

    await act(async () => {
      await result.current.syncIdentity({ username: '  alice ' });
    });

    expect(syncIdentityWithServerMock).toHaveBeenCalledTimes(1);
    expect(pendingUsername.value).toBeNull();
    expect(syncSharedIdentityMock).toHaveBeenCalledTimes(1);
  });

  it('a later sync (the reconnect loop) registers with the pending username', async () => {
    pendingUsername.value = 'offline-pick';
    syncIdentityWithServerMock.mockResolvedValue({ user: { id: 'me' }, wasRegistered: true });
    const { result } = renderHook(() => useSyncIdentity());
    await flushHydrate();

    await act(async () => {
      await result.current.syncIdentity();
    });

    expect(syncIdentityWithServerMock).toHaveBeenCalledWith(expect.objectContaining({ username: 'offline-pick' }));
    expect(pendingUsername.value).toBeNull();
  });

  it('a key still waiting for its username rejects quietly and keeps nothing synced', async () => {
    syncIdentityWithServerMock.mockRejectedValue(new UsernameRequiredError());
    (handleAuthError as jest.Mock).mockClear();
    const { result } = renderHook(() => useSyncIdentity());
    await flushHydrate();

    await act(async () => {
      await expect(result.current.syncIdentity()).rejects.toBeInstanceOf(UsernameRequiredError);
    });

    expect(syncIdentityWithServerMock).toHaveBeenCalledWith(expect.objectContaining({ username: null }));
    expect(persistIdentitySyncState).not.toHaveBeenCalledWith(true);
    expect(handleAuthError).not.toHaveBeenCalled();
  });

  it('rejects when oxyServices is not initialized', async () => {
    __setOxyState({ oxyServices: null });
    const { result } = renderHook(() => useSyncIdentity());

    await expect(result.current.syncIdentity()).rejects.toThrow('OxyServices not initialized');
    expect(syncIdentityWithServerMock).not.toHaveBeenCalled();
  });
});
