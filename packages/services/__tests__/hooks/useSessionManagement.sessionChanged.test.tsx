import { act, renderHook } from '@testing-library/react';
import { useSessionManagement } from '../../src/ui/hooks/useSessionManagement';

it('rejects a session switch superseded during device-session synchronization', async () => {
  let reject!: (error: unknown) => void;
  const changed = { code: 'AUTH_SESSION_CHANGED', status: 401 };
  const oxyServices = {
    session: {
      accessToken: 'a',
      validate: jest.fn().mockResolvedValue({ valid: true, user: { id: 'a' } }),
      list: jest.fn(),
    },
    devices: {
      sessions: jest.fn(
        () =>
          new Promise((_resolve, rej) => {
            reject = rej;
          }),
      ),
    },
  };
  const runtime = {
    batch: (fn: () => void) => fn(),
    setTokenReady: jest.fn(),
    setActiveSessionId: jest.fn(),
    setAccount: jest.fn(),
    mergeSessions: jest.fn(),
  };
  const onError = jest.fn();
  const setAuthError = jest.fn();
  const { result } = renderHook(() =>
    useSessionManagement({
      oxyServices: oxyServices as never,
      runtime: runtime as never,
      storage: null,
      onError,
      setAuthError,
    }),
  );
  let pending!: Promise<unknown>;
  await act(async () => {
    pending = result.current.switchSession('session-a');
    for (let i = 0; i < 10 && !reject; i++) await Promise.resolve();
  });
  expect(reject).toBeDefined();
  await act(async () => {
    reject(changed);
    await expect(pending).rejects.toBe(changed);
  });
  expect(oxyServices.session.list).not.toHaveBeenCalled();
  expect(runtime.mergeSessions).not.toHaveBeenCalled();
  expect(onError).not.toHaveBeenCalled();
  expect(setAuthError).not.toHaveBeenCalled();
});
