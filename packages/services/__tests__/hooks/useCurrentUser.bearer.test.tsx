/**
 * `useCurrentUser` hydrates the CURRENT user from the bearer (`GET /users/me`),
 * NOT from a session id in the URL (`GET /session/user/:activeSessionId`).
 *
 * Post zero-cookie cutover the bearer is the single source of session truth. The
 * old session-id URL was a second, independently-updated source that, on an
 * account switch, fired under the PREVIOUS account's token against the NEW
 * account's session id and 404'd. Keying the request off the bearer means it can
 * never target a mismatched session: it always returns whoever the bearer is.
 *
 * These tests assert (a) the hook calls `getCurrentUser()` and NEVER
 * `getUserBySession()` — so no session id ever reaches the URL, and (b) the
 * query re-scopes per active account so a switch refetches the new account, and
 * (c) it re-reads on focus, the one way an owner-only change made on another
 * device (their languages) reaches an open app.
 */

import type { ReactNode } from 'react';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider, focusManager } from '@tanstack/react-query';
import { act } from 'react';
import type { User } from '@oxy.so/core';
import { useCurrentUser } from '../../src/ui/hooks/queries/useAccountQueries';
import { queryKeys } from '../../src/ui/hooks/queries/queryKeys';
import { useAuthStore } from '../../src/ui/stores/authStore';

interface MockOxyServices {
  getCurrentUser: jest.Mock<Promise<User>, []>;
  getUserBySession: jest.Mock<Promise<User>, [string]>;
}

interface MockOxyState {
  oxyServices: MockOxyServices;
  activeSessionId: string | null;
  isAuthenticated: boolean;
}

const ACCOUNT_A = 'user-a';
const ACCOUNT_B = 'user-b';
const SESSION_A = 'sess-a';
const SESSION_B = 'sess-b';

// Languages the bearer account currently has in Oxy — edited "on another device"
// by reassigning it.
let bearerLanguages = ['es-ES', 'en-US'];

// The "current bearer" account is tracked here; `getCurrentUser` returns the
// user for whichever account the bearer currently identifies — exactly how
// `GET /users/me` behaves. `getUserBySession` must never be called.
let bearerAccountId = ACCOUNT_A;

const makeServices = (): MockOxyServices => ({
  users: {
    me: jest.fn(
      async (): Promise<User> =>
        ({
          id: bearerAccountId,
          username: bearerAccountId,
          name: { displayName: bearerAccountId },
          languages: bearerLanguages,
        }) as User,
    ),
    bySession: jest.fn(async (): Promise<User> => {
      throw new Error('getUserBySession must not be called by useCurrentUser');
    }),
  },
});

let mockState: MockOxyState = {
  oxyServices: makeServices(),
  activeSessionId: SESSION_A,
  isAuthenticated: true,
};

jest.mock('../../src/ui/context/oxyRuntimeContext', () => ({
  __esModule: true,
  useOxy: () => mockState,
}));

const makeWrapper = (queryClient: QueryClient) =>
  function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  };

describe('useCurrentUser hydrates from the bearer, never a session id', () => {
  let queryClient: QueryClient;

  beforeEach(() => {
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    bearerAccountId = ACCOUNT_A;
    bearerLanguages = ['es-ES', 'en-US'];
    mockState = {
      oxyServices: makeServices(),
      activeSessionId: SESSION_A,
      isAuthenticated: true,
    };
    useAuthStore.getState().logout();
  });

  it('calls getCurrentUser (GET /users/me) and NEVER getUserBySession', async () => {
    const { result } = renderHook(() => useCurrentUser(), {
      wrapper: makeWrapper(queryClient),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockState.oxyServices.users.me).toHaveBeenCalledTimes(1);
    expect(mockState.oxyServices.users.bySession).not.toHaveBeenCalled();
    expect(result.current.data?.id).toBe(ACCOUNT_A);
  });

  it('re-scopes and refetches the NEW account on a switch — always returning the bearer account, never a 404 on a mismatched session', async () => {
    const { result, rerender } = renderHook(() => useCurrentUser(), {
      wrapper: makeWrapper(queryClient),
    });

    await waitFor(() => expect(result.current.data?.id).toBe(ACCOUNT_A));

    // Account switch: the bearer now identifies B, and the active session flips.
    // The ordering fix guarantees the bearer already matches before the switch is
    // observed, so the refetch returns B (not a session-id 404).
    bearerAccountId = ACCOUNT_B;
    mockState = {
      oxyServices: mockState.oxyServices,
      activeSessionId: SESSION_B,
      isAuthenticated: true,
    };
    rerender();

    await waitFor(() => expect(result.current.data?.id).toBe(ACCOUNT_B));
    // Two fetches (one per account-scoped key), still zero session-id fetches.
    expect(mockState.oxyServices.users.me).toHaveBeenCalledTimes(2);
    expect(mockState.oxyServices.users.bySession).not.toHaveBeenCalled();
  });

  it("re-reads the owner profile on focus, so another device's language change arrives", async () => {
    const { result } = renderHook(() => useCurrentUser(), {
      wrapper: makeWrapper(queryClient),
    });
    await waitFor(() => expect(result.current.data?.languages).toEqual(['es-ES', 'en-US']));

    bearerLanguages = ['ca-ES', 'es-ES', 'en-US'];
    // Older than `staleTime`, as it is after the app has been in the background.
    queryClient.setQueryData(queryKeys.accounts.current(SESSION_A), result.current.data, {
      updatedAt: Date.now() - 2 * 60 * 1000,
    });
    act(() => {
      focusManager.setFocused(false);
      focusManager.setFocused(true);
    });

    await waitFor(() =>
      expect(result.current.data?.languages).toEqual(['ca-ES', 'es-ES', 'en-US']),
    );
    focusManager.setFocused(undefined);
  });
});
