/**
 * Single-user count fetch is driven by React Query, not a manual useEffect.
 *
 * The hook previously kicked off the follower/following count fetch from a
 * render-phase `useEffect` whenever the counts were missing. That was migrated
 * to a gated `useQuery` (AGENTS.md anti-useEffect rule) that owns ONLY the fetch
 * lifecycle; the Zustand store stays the canonical home for the count values, so
 * components keep reading `followerCount` / `followingCount` through the granular
 * selectors. These tests pin the migrated behaviour:
 *  - counts are fetched once on mount when missing,
 *  - the resolved values land in the store and are surfaced by the hook,
 *  - the query does NOT refetch once the counts are present (no loop / no
 *    duplicate network calls).
 */
import type { ReactNode } from 'react';
import { createElement } from 'react';
import { renderHook as rtlRenderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const getUserById = jest.fn(async () => ({ _count: { followers: 7, following: 3 } }));

const oxyServicesStub = {
  getFollowStatus: jest.fn(async () => ({ isFollowing: false })),
  getUserById,
  followUser: jest.fn(async () => ({})),
  unfollowUser: jest.fn(async () => ({})),
  getCurrentUserId: jest.fn(() => 'me'),
};

let ctx = {
  oxyServices: oxyServicesStub,
  canUsePrivateApi: true,
  user: { id: 'me' },
};

jest.mock('../../src/ui/context/OxyContext', () => ({
  useOxy: () => ctx,
}));

jest.mock('@oxyhq/core', () => ({
  logger: { warn: jest.fn(), error: jest.fn(), info: jest.fn() },
}));

import { useFollow } from '../../src/ui/hooks/useFollow';
import { useFollowStore } from '../../src/ui/stores/followStore';

const renderHook: typeof rtlRenderHook = ((render, options) => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client }, children);
  return rtlRenderHook(render, { wrapper, ...options });
}) as typeof rtlRenderHook;

describe('useFollow single-user — count fetch via React Query', () => {
  beforeEach(() => {
    useFollowStore.getState().resetFollowState();
    getUserById.mockClear();
    ctx = { oxyServices: oxyServicesStub, canUsePrivateApi: true, user: { id: 'me' } };
  });

  it('fetches missing counts on mount and surfaces them from the store', async () => {
    const { result } = renderHook(() => useFollow('u1'));

    await waitFor(() => {
      if (!('followerCount' in result.current)) throw new Error('expected single-user shape');
      expect(result.current.followerCount).toBe(7);
    });

    if (!('followingCount' in result.current)) throw new Error('expected single-user shape');
    expect(result.current.followingCount).toBe(3);
    expect(getUserById).toHaveBeenCalledTimes(1);
    expect(getUserById).toHaveBeenCalledWith('u1');
  });

  it('does not refetch once counts are already present in the store', async () => {
    // Seed counts before mount → the query gate is false → no network call.
    useFollowStore.getState().setFollowerCount('u2', 11);
    useFollowStore.getState().setFollowingCount('u2', 22);

    const { result, rerender } = renderHook(() => useFollow('u2'));

    if (!('followerCount' in result.current)) throw new Error('expected single-user shape');
    expect(result.current.followerCount).toBe(11);
    expect(result.current.followingCount).toBe(22);

    rerender();
    await waitFor(() => expect(getUserById).not.toHaveBeenCalled());
  });

  it('fetches counts when only one side is missing', async () => {
    useFollowStore.getState().setFollowerCount('u3', 5);

    const { result } = renderHook(() => useFollow('u3'));

    await waitFor(() => {
      if (!('followingCount' in result.current)) throw new Error('expected single-user shape');
      expect(result.current.followingCount).toBe(3);
    });

    if (!('followerCount' in result.current)) throw new Error('expected single-user shape');
    // fetchUserCounts reconciles both sides from the API response.
    expect(result.current.followerCount).toBe(7);
    expect(getUserById).toHaveBeenCalledTimes(1);
  });

  it('does not fetch counts in multi-user mode', async () => {
    renderHook(() => useFollow(['u1', 'u2']));
    // Give any (incorrectly enabled) query a tick to fire.
    await waitFor(() => expect(getUserById).not.toHaveBeenCalled());
  });
});
