/**
 * Query-key scoping for single-profile fetches.
 *
 * `useUserByUsername` embeds a viewer-relative `relationship` when
 * authenticated, so its key includes the active viewer id — an anonymous
 * cold-boot entry must not freeze once the session resolves.
 *
 * `useUserById` is the opposite by design: it is the card-identity workhorse
 * (name/avatar/username) and keys on the viewer-INDEPENDENT
 * `queryKeys.users.detail(id)` so external by-id identity seeders / precache
 * layers share one cache entry. It must NEVER be viewer-scoped.
 */

import type { ReactNode } from 'react';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { User } from '@oxy.so/core';
import { queryKeys } from '../../src/ui/hooks/queries/queryKeys';
import { useUserById, useUserByUsername } from '../../src/ui/hooks/queries/useAccountQueries';

interface MockOxyServices {
  getUserById: jest.Mock;
  getProfileByUsername: jest.Mock;
}

interface MockOxyState {
  oxyServices: MockOxyServices;
  user: { id: string } | null;
}

const ANON_PROFILE: User = {
  id: 'target-1',
  username: 'alice',
  name: { displayName: 'Alice' },
} as User;

const AUTH_PROFILE: User = {
  ...ANON_PROFILE,
  relationship: { isFollowing: false, followsYou: true },
} as User;

const makeServices = (): MockOxyServices => ({
  getUserById: jest.fn(async () => ANON_PROFILE),
  getProfileByUsername: jest.fn(async () => ANON_PROFILE),
});

let mockState: MockOxyState = {
  oxyServices: makeServices(),
  user: null,
};

jest.mock('../../src/ui/context/OxyContext', () => ({
  __esModule: true,
  useOxy: () => mockState,
}));

const makeWrapper = (queryClient: QueryClient) =>
  function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  };

describe('useUserById identity (viewer-independent)', () => {
  let queryClient: QueryClient;

  beforeEach(() => {
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    mockState = {
      oxyServices: makeServices(),
      user: null,
    };
  });

  it('keys on queryKeys.users.detail(id) and does NOT re-scope when the viewer resolves', async () => {
    const { result, rerender } = renderHook(() => useUserById('target-1'), {
      wrapper: makeWrapper(queryClient),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockState.oxyServices.getUserById).toHaveBeenCalledTimes(1);

    // The identity entry lives at the viewer-INDEPENDENT key.
    expect(queryClient.getQueryData(queryKeys.users.detail('target-1'))).toEqual(ANON_PROFILE);

    // Viewer session lands (~5-25s later). Swapping the mock proves that even
    // if the API would now return a viewer-relative payload, the shared
    // identity entry is reused: no new fetch, no viewer-scoped cache entry.
    mockState = {
      oxyServices: {
        ...makeServices(),
        getUserById: jest.fn(async () => AUTH_PROFILE),
      },
      user: { id: 'viewer-1' },
    };
    rerender();

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockState.oxyServices.getUserById).not.toHaveBeenCalled();
    expect(result.current.data).toEqual(ANON_PROFILE);

    // The key never became viewer-scoped, so no detailForViewer entry exists.
    expect(
      queryClient.getQueryData(queryKeys.users.detailForViewer('target-1', 'viewer-1')),
    ).toBeUndefined();
    expect(
      queryClient.getQueryData(queryKeys.users.detailForViewer('target-1', '')),
    ).toBeUndefined();
  });
});

describe('useUserByUsername viewer scope', () => {
  let queryClient: QueryClient;

  beforeEach(() => {
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    mockState = {
      oxyServices: makeServices(),
      user: null,
    };
  });

  it('refetches when the viewer session resolves', async () => {
    const { result, rerender } = renderHook(() => useUserByUsername('alice'), {
      wrapper: makeWrapper(queryClient),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockState.oxyServices.getProfileByUsername).toHaveBeenCalledTimes(1);
    expect(mockState.oxyServices.getProfileByUsername).toHaveBeenCalledWith('alice');

    mockState = {
      oxyServices: {
        ...makeServices(),
        getProfileByUsername: jest.fn(async () => AUTH_PROFILE),
      },
      user: { id: 'viewer-1' },
    };
    rerender();

    await waitFor(() => expect(result.current.data?.relationship?.followsYou).toBe(true));
    expect(mockState.oxyServices.getProfileByUsername).toHaveBeenCalledTimes(1);
    expect(queryClient.getQueryData(queryKeys.users.byUsername('alice', 'viewer-1'))).toEqual(
      AUTH_PROFILE,
    );
  });

  it('normalizes mixed-case usernames before fetching', async () => {
    renderHook(() => useUserByUsername('Alice'), {
      wrapper: makeWrapper(queryClient),
    });

    await waitFor(() =>
      expect(mockState.oxyServices.getProfileByUsername).toHaveBeenCalledWith('alice'),
    );
  });
});
