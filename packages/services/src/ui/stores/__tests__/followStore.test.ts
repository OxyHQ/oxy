/**
 * followStore — tri-state seed, micro-batched resolution, and optimistic
 * mutation tests.
 *
 * Covers the follow-system efficiency overhaul:
 *  - `setFollowStatuses` seeds only-if-absent (never clobbers a definite value)
 *  - `resolveFollowStatuses` coalesces every UNKNOWN id requested in one tick
 *    into a SINGLE `getFollowStatuses` call, and skips known/seeded ids
 *  - `toggleFollowUser` writes optimistically BEFORE the await and rolls back on
 *    error
 */

import type { OxyServices, FollowMutationResult } from '@oxyhq/core';
import { useFollowStore } from '../followStore';

// A microtask + macrotask flush: `resolveFollowStatuses` schedules its bulk call
// via `queueMicrotask`, and the mocked `getFollowStatuses` resolves on the
// microtask queue, so a single macrotask turn drains both.
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

interface FollowServicesMock {
  getFollowStatuses: jest.Mock<Promise<Record<string, boolean>>, [string[]]>;
  followUser: jest.Mock<Promise<FollowMutationResult>, [string]>;
  unfollowUser: jest.Mock<Promise<FollowMutationResult>, [string]>;
  getCurrentUserId: jest.Mock<string | null, []>;
}

const makeServices = (): { mock: FollowServicesMock; services: OxyServices } => {
  const mock: FollowServicesMock = {
    getFollowStatuses: jest.fn(async (ids: string[]) =>
      Object.fromEntries(ids.map((id) => [id, false])),
    ),
    followUser: jest.fn(async () => ({ message: 'ok' })),
    unfollowUser: jest.fn(async () => ({ message: 'ok' })),
    getCurrentUserId: jest.fn(() => 'viewer-1'),
  };
  return { mock, services: mock as unknown as OxyServices };
};

beforeEach(() => {
  useFollowStore.getState().resetFollowState();
});

afterEach(async () => {
  // Drain any pending micro-batch so module-level state never leaks between tests.
  await flush();
});

describe('setFollowStatuses (seed-only-if-absent)', () => {
  it('seeds absent ids and never clobbers an existing definite value', () => {
    const store = useFollowStore.getState();
    store.setFollowStatuses({ u1: true });
    store.setFollowStatuses({ u1: false, u2: true });

    expect(useFollowStore.getState().followingUsers).toEqual({ u1: true, u2: true });
  });
});

describe('resolveFollowStatuses (micro-batched)', () => {
  it('coalesces every id requested in one tick into a SINGLE call', async () => {
    const { mock, services } = makeServices();
    mock.getFollowStatuses.mockImplementation(async (ids) =>
      Object.fromEntries(ids.map((id) => [id, id === 'u1'])),
    );

    const store = useFollowStore.getState();
    store.resolveFollowStatuses(['u1', 'u2'], services);
    store.resolveFollowStatuses(['u3'], services);

    await flush();

    expect(mock.getFollowStatuses).toHaveBeenCalledTimes(1);
    expect(mock.getFollowStatuses).toHaveBeenCalledWith(['u1', 'u2', 'u3']);
    expect(useFollowStore.getState().followingUsers).toEqual({ u1: true, u2: false, u3: false });
  });

  it('skips ids whose status is already known/seeded', async () => {
    const { mock, services } = makeServices();
    const store = useFollowStore.getState();
    store.setFollowStatuses({ u1: false }); // seeded → must NOT re-fetch

    store.resolveFollowStatuses(['u1', 'u2'], services);
    await flush();

    expect(mock.getFollowStatuses).toHaveBeenCalledTimes(1);
    expect(mock.getFollowStatuses).toHaveBeenCalledWith(['u2']);
    // The seeded false is preserved; u2 resolved.
    expect(useFollowStore.getState().followingUsers).toEqual({ u1: false, u2: false });
  });

  it('performs NO call when every requested id is already known', async () => {
    const { mock, services } = makeServices();
    const store = useFollowStore.getState();
    store.setFollowStatuses({ u1: true, u2: false });

    store.resolveFollowStatuses(['u1', 'u2'], services);
    await flush();

    expect(mock.getFollowStatuses).not.toHaveBeenCalled();
  });
});

describe('toggleFollowUser (optimistic)', () => {
  it('writes the new value BEFORE the await and reconciles on success', async () => {
    const { mock, services } = makeServices();
    let resolveFollow: (value: FollowMutationResult) => void = () => {};
    mock.followUser.mockReturnValueOnce(
      new Promise<FollowMutationResult>((resolve) => { resolveFollow = resolve; }),
    );

    const store = useFollowStore.getState();
    const pending = store.toggleFollowUser('u1', services, false);

    // Optimistic write happened synchronously, before the network resolved.
    expect(useFollowStore.getState().followingUsers.u1).toBe(true);
    expect(useFollowStore.getState().loadingUsers.u1).toBe(true);

    resolveFollow({ message: 'ok', counts: { followers: 10, following: 3 } });
    const accepted = await pending;

    expect(accepted).toBe(true);

    expect(useFollowStore.getState().followingUsers.u1).toBe(true);
    expect(useFollowStore.getState().loadingUsers.u1).toBe(false);
    // Counts from the response were applied.
    expect(useFollowStore.getState().followerCounts.u1).toBe(10);
    expect(useFollowStore.getState().followingCounts['viewer-1']).toBe(3);
  });

  it('rolls back to the prior definite value on error', async () => {
    const { mock, services } = makeServices();
    mock.followUser.mockRejectedValueOnce(new Error('boom'));

    const store = useFollowStore.getState();
    store.setFollowStatuses({ u1: false });

    const accepted = await store.toggleFollowUser('u1', services, false);

    expect(accepted).toBe(false);
    expect(useFollowStore.getState().followingUsers.u1).toBe(false);
    expect(useFollowStore.getState().loadingUsers.u1).toBe(false);
    expect(useFollowStore.getState().errors.u1).toBe('boom');
  });

  it('rolls back to UNKNOWN when there was no prior value', async () => {
    const { mock, services } = makeServices();
    mock.followUser.mockRejectedValueOnce(new Error('nope'));

    const store = useFollowStore.getState();
    const accepted = await store.toggleFollowUser('u1', services, false);

    expect(accepted).toBe(false);
    // The key is removed → back to UNKNOWN (tri-state), not a definite false.
    expect(Object.prototype.hasOwnProperty.call(useFollowStore.getState().followingUsers, 'u1')).toBe(false);
  });
});

describe('resetFollowState', () => {
  it('clears store data and in-flight micro-batch coordination', async () => {
    const { mock, services } = makeServices();
    let resolveBatch: ((value: Record<string, boolean>) => void) | undefined;
    mock.getFollowStatuses.mockImplementation(
      () => new Promise<Record<string, boolean>>((resolve) => { resolveBatch = resolve; }),
    );

    const store = useFollowStore.getState();
    store.resolveFollowStatuses(['u1'], services);
    store.setFollowingStatus('u2', true);

    store.resetFollowState();

    expect(useFollowStore.getState().followingUsers).toEqual({});
    expect(useFollowStore.getState().fetchingUsers).toEqual({});

    resolveBatch?.({ u1: true });
    await flush();

    // A late batch must not repopulate a store that was reset.
    expect(useFollowStore.getState().followingUsers).toEqual({});
  });
});
