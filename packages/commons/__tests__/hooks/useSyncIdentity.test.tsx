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
jest.mock('@/hooks/identity/identityStore', () => {
  const actual = jest.requireActual('@/hooks/identity/identityStore');
  return {
    ...actual,
    persistIdentitySyncState: jest.fn(async () => undefined),
    getIdentitySyncStateFromStorage: jest.fn(async () => false),
  };
});

// eslint-disable-next-line import/first
import { useSyncIdentity } from '@/hooks/identity/useSyncIdentity';
// eslint-disable-next-line import/first
import { useIdentityStore, persistIdentitySyncState } from '@/hooks/identity/identityStore';
// eslint-disable-next-line import/first
import { releaseSyncLock } from '@/hooks/identity/syncLock';

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

  it('rejects when oxyServices is not initialized', async () => {
    __setOxyState({ oxyServices: null });
    const { result } = renderHook(() => useSyncIdentity());

    await expect(result.current.syncIdentity()).rejects.toThrow('OxyServices not initialized');
    expect(syncIdentityWithServerMock).not.toHaveBeenCalled();
  });
});
