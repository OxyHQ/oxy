/**
 * What a caller is told when a follow is refused.
 *
 * The mutations deliberately never reject — a refusal becomes error state so
 * the button can render it — which is precisely why they have to return the
 * outcome. Without it, `await follow()` is indistinguishable from a write that
 * happened, and an application mirroring the follow into its own store (a
 * shelf, a ranking signal, a taste profile) mirrors failures as successes and
 * ends up disagreeing with the button standing next to it.
 *
 * Found by wiring Syra, where exactly that mirror exists.
 */

import { renderHook, act } from '@testing-library/react';
import { useFollowTarget } from '../../src/ui/hooks/useFollowTarget';
import { useFollowTargetStore } from '../../src/ui/stores/followTargetStore';

const oxyServices = {
  getFollowTargetStatus: jest.fn(),
  followTarget: jest.fn(),
  unfollowTarget: jest.fn(),
  setFollowApplicationMode: jest.fn(),
};

jest.mock('../../src/ui/context/OxyContext', () => ({
  useOxy: () => ({ oxyServices, canUsePrivateApi: true }),
}));

const NOT_FOLLOWING = {
  globalState: 'none' as const,
  applicationMode: 'inherit' as const,
  effectiveState: 'not_following' as const,
};

beforeEach(() => {
  jest.clearAllMocks();
  useFollowTargetStore.getState().reset();
  oxyServices.getFollowTargetStatus.mockResolvedValue(NOT_FOLLOWING);
});

describe('useFollowTarget reports whether the server accepted', () => {
  it('resolves true when the follow was accepted', async () => {
    oxyServices.followTarget.mockResolvedValue({
      relationshipId: 'rel-1',
      created: true,
      status: { ...NOT_FOLLOWING, globalState: 'active', effectiveState: 'following' },
    });

    const { result } = renderHook(() => useFollowTarget('target-1'));
    let outcome: boolean | undefined;
    await act(async () => {
      outcome = await result.current.follow();
    });

    expect(outcome).toBe(true);
    expect(result.current.isFollowing).toBe(true);
  });

  it('resolves FALSE when the server refuses, and does not reject', async () => {
    // A refused write is the ordinary case, not an exception: a missing scope,
    // a revoked grant, a target that has gone. The hook turns it into state.
    oxyServices.followTarget.mockRejectedValue(new Error('Missing scope: follows:write'));

    const { result } = renderHook(() => useFollowTarget('target-1'));
    let outcome: boolean | undefined;
    await act(async () => {
      outcome = await result.current.follow();
    });

    expect(outcome).toBe(false);
    // The optimistic flip is rolled back, so the button tells the truth...
    expect(result.current.isFollowing).toBe(false);
    // ...and the reason is available to render, rather than thrown away.
    expect(result.current.error).toContain('follows:write');
  });

  it('resolves false for an unfollow the server refuses', async () => {
    oxyServices.getFollowTargetStatus.mockResolvedValue({
      relationshipId: 'rel-1',
      globalState: 'active',
      applicationMode: 'inherit',
      effectiveState: 'following',
    });
    oxyServices.unfollowTarget.mockRejectedValue(new Error('nope'));

    const { result } = renderHook(() => useFollowTarget('target-1'));
    // Let the initial status read settle so a relationship id exists to act on.
    await act(async () => {
      await Promise.resolve();
    });

    let outcome: boolean | undefined;
    await act(async () => {
      outcome = await result.current.unfollow();
    });

    expect(outcome).toBe(false);
    // Still following, because the unfollow did not happen.
    expect(result.current.isFollowing).toBe(true);
  });

  it('resolves false without calling the server when there is nothing to act on', async () => {
    // An optimistic follow has no relationship id until the server answers.
    // Reporting `true` here would be reporting a write that was never sent.
    const { result } = renderHook(() => useFollowTarget('target-1'));
    let outcome: boolean | undefined;
    await act(async () => {
      outcome = await result.current.unfollow();
    });

    expect(outcome).toBe(false);
    expect(oxyServices.unfollowTarget).not.toHaveBeenCalled();
  });

  it('leaves the button interactive when the status read fails', async () => {
    oxyServices.getFollowTargetStatus.mockRejectedValue(new Error('network down'));

    const { result } = renderHook(() => useFollowTarget('target-1'));
    await act(async () => {
      await Promise.resolve();
    });

    expect(result.current.isUnknown).toBe(false);
    expect(result.current.error).toContain('network down');
  });

  it('refetches when initialStatus is incomplete (following without relationshipId)', async () => {
    oxyServices.getFollowTargetStatus.mockResolvedValue({
      relationshipId: 'rel-from-server',
      globalState: 'active',
      applicationMode: 'inherit',
      effectiveState: 'following',
    });

    const { result } = renderHook(() =>
      useFollowTarget('target-1', {
        initialStatus: {
          globalState: 'active',
          applicationMode: 'inherit',
          effectiveState: 'following',
        },
      })
    );

    await act(async () => {
      await Promise.resolve();
    });

    expect(oxyServices.getFollowTargetStatus).toHaveBeenCalledWith('target-1');
    expect(result.current.status.relationshipId).toBe('rel-from-server');
  });
});
