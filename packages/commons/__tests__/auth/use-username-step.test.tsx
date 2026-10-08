/**
 * The username step is what creates the account: a key without one is
 * registered here WITH the username (`syncIdentity({ username })`), never
 * before. Offline, the choice is kept as the pending username for the
 * reconnect sync.
 */
import { act, renderHook } from '@testing-library/react';
import { __resetOxyState, __setOxyState } from '@/__mocks__/oxy-services';

const syncIdentityMock = jest.fn();
jest.mock('@/hooks/identity/useSyncIdentity', () => ({
  useSyncIdentity: () => ({ syncIdentity: (opts: unknown) => syncIdentityMock(opts) }),
}));
const checkIfOfflineMock = jest.fn();
jest.mock('@/utils/auth/networkUtils', () => ({
  checkIfOffline: () => checkIfOfflineMock(),
}));
const persistPendingUsernameMock = jest.fn(async () => undefined);
const getPendingUsernameMock = jest.fn(async (): Promise<string | null> => null);
jest.mock('@/hooks/identity/identityStore', () => ({
  persistPendingUsername: (username: string | null) => persistPendingUsernameMock(username),
  getPendingUsernameFromStorage: () => getPendingUsernameMock(),
}));
jest.mock('@/contexts/auth-flow-context', () => ({
  useAuthFlowContext: () => ({ error: null, setAuthError: jest.fn() }),
}));
jest.mock('@/lib/i18n', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

// eslint-disable-next-line import/first
import { useUsernameStep } from '@/hooks/auth/useUsernameStep';

function httpError(status: number, message: string) {
  return Object.assign(new Error(message), { status });
}

async function renderStep() {
  const onDone = jest.fn();
  const hook = renderHook(() => useUsernameStep({ onDone }));
  // Let the pending-username read settle.
  await act(async () => {
    await Promise.resolve();
  });
  act(() => hook.result.current.setUsername('alice'));
  return { ...hook, onDone };
}

describe('useUsernameStep', () => {
  beforeEach(() => {
    __resetOxyState();
    // No session: the key has no account yet.
    __setOxyState({ oxyServices: { getCurrentUserId: jest.fn(() => null) } });
    syncIdentityMock.mockReset().mockResolvedValue({ id: 'u1', username: 'alice' });
    checkIfOfflineMock.mockReset().mockResolvedValue(false);
    persistPendingUsernameMock.mockClear();
    getPendingUsernameMock.mockReset().mockResolvedValue(null);
  });

  it('online with no account: registers the key WITH the username, then finishes', async () => {
    const { result, onDone } = await renderStep();

    await act(async () => {
      await result.current.handleContinue();
    });

    expect(syncIdentityMock).toHaveBeenCalledWith({ username: 'alice' });
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it('offline: keeps the username pending and registers nothing', async () => {
    checkIfOfflineMock.mockResolvedValue(true);
    const { result, onDone } = await renderStep();

    await act(async () => {
      await result.current.handleContinue();
    });

    expect(persistPendingUsernameMock).toHaveBeenCalledWith('alice');
    expect(syncIdentityMock).not.toHaveBeenCalled();
    expect(onDone).not.toHaveBeenCalled();
    expect(result.current.updateError).toBe('auth.usernameStep.savedOffline');
  });

  it('a username taken at registration keeps the user on the step', async () => {
    syncIdentityMock.mockRejectedValue(httpError(409, 'Username already taken'));
    const { result, onDone } = await renderStep();

    await act(async () => {
      await result.current.handleContinue();
    });

    expect(onDone).not.toHaveBeenCalled();
    expect(result.current.updateError).toBe('auth.usernameStep.taken');
  });

  it('prefills the pending username chosen earlier', async () => {
    getPendingUsernameMock.mockResolvedValue('offline-pick');
    const { result } = renderHook(() => useUsernameStep({ onDone: jest.fn() }));
    await act(async () => {
      await Promise.resolve();
    });

    expect(result.current.username).toBe('offline-pick');
  });
});
