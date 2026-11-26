/**
 * Single-user counts are a gated bloom-data read (`followCounts`), not a
 * manual useEffect. The counts live on the person (`User._count`), so
 * components read `followerCount` / `followingCount` from the same record a
 * profile read fills. These tests pin the behaviour:
 *  - counts are read once on mount when missing,
 *  - the answer lands on `User` and is surfaced by the hook,
 *  - the read does NOT happen once the counts are present (it is skipped).
 */
import { renderHook as rtlRenderHook, waitFor } from '@testing-library/react';
import type { Store } from '@oxy.so/bloom-data';
import { dataWrapper, openTestStore } from '../helpers/dataStore';

const getUserById = jest.fn(async (id: string) => ({ id, _count: { followers: 7, following: 3 } }));

const oxyServicesStub = {
  follows: {
    status: jest.fn(async () => ({ isFollowing: false })),
    follow: jest.fn(async () => ({})),
    unfollow: jest.fn(async () => ({})),
  },
  users: { get: getUserById },
  session: {
    get userId() {
      return jest.fn(() => 'me')();
    },
  },
};

let ctx = {
  oxyServices: oxyServicesStub,
  canUsePrivateApi: true,
  user: { id: 'me' },
};

jest.mock('../../src/ui/context/oxyRuntimeContext', () => ({
  useOxy: () => ctx,
}));

jest.mock('@oxy.so/core', () => ({
  logger: { warn: jest.fn(), error: jest.fn(), info: jest.fn() },
}));

import { useFollow } from '../../src/ui/hooks/useFollow';
import { setFollowCounts } from '../../src/ui/data/follow';

let store: Store;
const renderHook: typeof rtlRenderHook = ((render, options) =>
  rtlRenderHook(render, { wrapper: dataWrapper(store), ...options })) as typeof rtlRenderHook;

describe('useFollow single-user — count read through bloom-data', () => {
  beforeEach(() => {
    store = openTestStore();
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
    setFollowCounts('u2', { followers: 11, following: 22 });

    const { result, rerender } = renderHook(() => useFollow('u2'));

    if (!('followerCount' in result.current)) throw new Error('expected single-user shape');
    expect(result.current.followerCount).toBe(11);
    expect(result.current.followingCount).toBe(22);

    rerender();
    await waitFor(() => expect(getUserById).not.toHaveBeenCalled());
  });

  it('fetches counts when only one side is missing', async () => {
    setFollowCounts('u3', { followers: 5 });

    const { result } = renderHook(() => useFollow('u3'));

    await waitFor(() => {
      if (!('followingCount' in result.current)) throw new Error('expected single-user shape');
      expect(result.current.followingCount).toBe(3);
    });

    if (!('followerCount' in result.current)) throw new Error('expected single-user shape');
    // The read reconciles both sides from the API response.
    expect(result.current.followerCount).toBe(7);
    expect(getUserById).toHaveBeenCalledTimes(1);
  });

  it('does not fetch counts in multi-user mode', async () => {
    renderHook(() => useFollow(['u1', 'u2']));
    // Give any (incorrectly enabled) query a tick to fire.
    await waitFor(() => expect(getUserById).not.toHaveBeenCalled());
  });
});
