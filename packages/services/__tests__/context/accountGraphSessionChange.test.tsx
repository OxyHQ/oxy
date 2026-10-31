import { act, renderHook } from '@testing-library/react';
import { useOxyAccountGraph } from '../../src/ui/context/useOxyAccountGraph';

type Params = Parameters<typeof useOxyAccountGraph>[0];

it.each([
  ['superseded request', { code: 'AUTH_SESSION_CHANGED', status: 401 }, false],
  ['real 401', { code: 'UNAUTHORIZED', status: 401 }, true],
] as const)('handles %s without confusing it with the other case', async (_name, error, clears) => {
  const clearSession = jest.fn(async () => {});
  const params = {
    isAuthenticated: true,
    tokenReady: true,
    initialized: false,
    identityBound: false,
    isolatedOAuth: false,
    oxyServices: {
      session: { accessToken: 'account-a' },
      accounts: {
        list: jest.fn(async () => {
          throw error;
        }),
      },
    },
    sessionClient: {},
    syncFromClient: jest.fn(),
    commitSession: jest.fn(),
    accountDialogControllerRef: { current: null },
    clearSessionStateRef: { current: clearSession },
  } as unknown as Params;
  const { result } = renderHook(() => useOxyAccountGraph(params));
  await act(async () => {
    await result.current.refreshAccounts();
  });
  expect(clearSession).toHaveBeenCalledTimes(clears ? 1 : 0);
});
