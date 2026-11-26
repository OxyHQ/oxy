/**
 * Regression: useFollow multi-user mode must NOT enter an infinite render loop.
 *
 * The multi-user subscription previously returned a 2-level-nested `followData`
 * object through `useShallow`, whose one-level shallow compare always reported
 * inequality (freshly allocated per-user objects). That made
 * `useSyncExternalStore` resubscribe on every commit and loop until React threw
 * "Maximum update depth exceeded", which the app ErrorBoundary surfaced as a
 * render crash. It only fired once `userIds` was non-empty (populated map), i.e.
 * exactly the production `[] -> populated` transition the multi-mode
 * FollowButton drives. The members are now read from `User` (`useEntities`),
 * which returns the same array while no member changed.
 */
import { renderHook as rtlRenderHook, act } from '@testing-library/react';
import type { Store } from '@oxy.so/bloom-data';
import { dataWrapper, openTestStore } from '../helpers/dataStore';

// Each test reads its own account store, as `OxyProvider` gives one per account.
let store: Store;
const renderHook: typeof rtlRenderHook = ((render, options) =>
  rtlRenderHook(render, { wrapper: dataWrapper(store), ...options })) as typeof rtlRenderHook;

const oxyServicesStub = {
  follows: {
    status: jest.fn(async () => ({ isFollowing: false })),
    follow: jest.fn(async () => ({})),
    unfollow: jest.fn(async () => ({})),
    followMany: jest.fn(async (ids: string[]) => ({
      followedCount: ids.length,
      results: ids.map((id) => ({ userId: id, success: true, alreadyFollowing: false })),
    })),
    unfollowMany: jest.fn(async (ids: string[]) => ({
      unfollowedCount: ids.length,
      results: ids.map((id) => ({ userId: id, success: true, wasFollowing: true })),
    })),
  },
  users: { get: jest.fn(async () => ({ _count: { followers: 1, following: 2 } })) },
  session: {
    get userId() {
      return jest.fn(() => 'me')();
    },
  },
};

let ctx = {
  oxyServices: oxyServicesStub,
  canUsePrivateApi: false,
  user: { id: 'me' },
};

jest.mock('../../src/ui/context/oxyRuntimeContext', () => ({
  useOxy: () => ctx,
}));

jest.mock('@oxy.so/core', () => ({
  logger: { warn: jest.fn(), error: jest.fn(), info: jest.fn() },
}));

import { useFollow } from '../../src/ui/hooks/useFollow';
import { setFollowStatus } from '../../src/ui/data/follow';

describe('useFollow multi-user mode — no infinite render loop', () => {
  beforeEach(() => {
    store = openTestStore();
    ctx = { oxyServices: oxyServicesStub, canUsePrivateApi: false, user: { id: 'me' } };
  });

  it('survives userIds [] -> populated with canUsePrivateApi false -> true', () => {
    const { result, rerender } = renderHook(({ ids }: { ids: string[] }) => useFollow(ids), {
      initialProps: { ids: [] as string[] },
    });

    expect('followAllUsers' in result.current).toBe(true);

    act(() => {
      ctx = { ...ctx, canUsePrivateApi: true };
    });
    rerender({ ids: [] });
    expect('followAllUsers' in result.current).toBe(true);

    // The transition that used to loop forever:
    rerender({ ids: ['u1', 'u2', 'u3'] });
    expect('followAllUsers' in result.current).toBe(true);
    expect('isAnyLoading' in result.current).toBe(true);

    // Store churn from per-member buttons writing status while multi is mounted.
    act(() => {
      setFollowStatus('u1', true);
      setFollowStatus('u2', false);
    });
    rerender({ ids: ['u1', 'u2', 'u3'] });
    expect('followAllUsers' in result.current).toBe(true);
  });

  it('exposes a structurally correct followData map for multi mode', () => {
    const { result } = renderHook(() => useFollow(['u1', 'u2']));
    const multi = result.current;
    if ('followData' in multi) {
      expect(multi.followData.u1).toEqual({ isFollowing: false, isLoading: false, error: null });
      expect(multi.followData.u2).toEqual({ isFollowing: false, isLoading: false, error: null });
    } else {
      throw new Error('expected multi-user shape with followData');
    }
  });

  it('derives allFollowing reactively from per-user store status', () => {
    const { result, rerender } = renderHook(({ ids }: { ids: string[] }) => useFollow(ids), {
      initialProps: { ids: ['u1', 'u2'] },
    });

    // No member is followed yet → aggregate is false.
    expect('allFollowing' in result.current && result.current.allFollowing).toBe(false);

    // Following only one member keeps the aggregate false.
    act(() => {
      setFollowStatus('u1', true);
    });
    rerender({ ids: ['u1', 'u2'] });
    expect('allFollowing' in result.current && result.current.allFollowing).toBe(false);

    // Following every member flips the aggregate to true.
    act(() => {
      setFollowStatus('u2', true);
    });
    rerender({ ids: ['u1', 'u2'] });
    expect('allFollowing' in result.current && result.current.allFollowing).toBe(true);

    // Unfollowing one member reverts the aggregate to false.
    act(() => {
      setFollowStatus('u1', false);
    });
    rerender({ ids: ['u1', 'u2'] });
    expect('allFollowing' in result.current && result.current.allFollowing).toBe(false);
  });

  it('unfollowAllUsers unfollows every member in one call and flips allFollowing to false', async () => {
    const { result, rerender } = renderHook(({ ids }: { ids: string[] }) => useFollow(ids), {
      initialProps: { ids: ['u1', 'u2'] },
    });

    // Authenticate so the bulk unfollow is permitted.
    act(() => {
      ctx = { ...ctx, canUsePrivateApi: true };
    });
    rerender({ ids: ['u1', 'u2'] });

    // Seed both members as followed → aggregate is true.
    act(() => {
      setFollowStatus('u1', true);
      setFollowStatus('u2', true);
    });
    rerender({ ids: ['u1', 'u2'] });
    expect('allFollowing' in result.current && result.current.allFollowing).toBe(true);

    // Multi mode exposes a callable unfollowAllUsers.
    expect('unfollowAllUsers' in result.current).toBe(true);
    expect(typeof (result.current as { unfollowAllUsers: unknown }).unfollowAllUsers).toBe(
      'function',
    );

    await act(async () => {
      if ('unfollowAllUsers' in result.current) {
        await result.current.unfollowAllUsers();
      }
    });
    rerender({ ids: ['u1', 'u2'] });

    expect(oxyServicesStub.follows.unfollowMany).toHaveBeenCalledWith(['u1', 'u2']);
    expect('allFollowing' in result.current && result.current.allFollowing).toBe(false);
  });
});
