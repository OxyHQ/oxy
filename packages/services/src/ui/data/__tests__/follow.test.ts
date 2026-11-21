/**
 * Follows on bloom-data (`data/follow.ts`): the follow status and counts live
 * on the person (`User`), writes are actions with optimistic layers, and each
 * account's store keeps its own.
 *
 * Covers:
 *  - seeding only where the status is UNKNOWN;
 *  - one micro-batched status read per tick, skipping known ids;
 *  - the optimistic follow (before the await), its settle (counts on `User`)
 *    and its rollback (to the prior value, or back to UNKNOWN);
 *  - a refusal for one target of a bulk follow rolls back that target only;
 *  - a late answer for an account since left changes nothing in the next one;
 *  - the counts read: its staleness and its retry rule.
 */
import { Store, setActiveStore, withStore } from '@oxy.so/bloom-data';
import type { FollowMutationResult, OxyServices } from '@oxy.so/core';
import { User } from '../user';
import {
  followCounts,
  followMany,
  FollowActivity,
  isFollowingOf,
  resolveFollowStatuses,
  seedFollowStatuses,
  setFollowStatus,
  toggleFollow,
} from '../follow';

// `resolveFollowStatuses` reads on the next microtask and the mocked read
// resolves on the microtask queue, so one macrotask turn drains both.
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

let store: Store;
beforeEach(() => {
  store = new Store();
  setActiveStore(store);
});

function makeServices() {
  const follows = {
    statuses: jest.fn(async (ids: string[]) => Object.fromEntries(ids.map((id) => [id, false]))),
    follow: jest.fn(async (): Promise<FollowMutationResult> => ({ message: 'ok' })),
    unfollow: jest.fn(async (): Promise<FollowMutationResult> => ({ message: 'ok' })),
    followMany: jest.fn(),
  };
  const users = { get: jest.fn() };
  const services = { follows, users, session: { userId: 'viewer-1' } };
  return { follows, users, services: services as unknown as OxyServices };
}

const following = (userId: string, on: Store = store) =>
  withStore(on, () => isFollowingOf(User.get(userId)));
const activity = (userId: string, on: Store = store) =>
  withStore(on, () => FollowActivity.get(userId));

describe('seedFollowStatuses', () => {
  it('seeds unknown ids and never replaces a definite value', () => {
    seedFollowStatuses({ u1: true });
    seedFollowStatuses({ u1: false, u2: true });
    expect(following('u1')).toBe(true);
    expect(following('u2')).toBe(true);
  });

  it('counts a relationship a profile read stored as known', () => {
    User.put({ id: 'u1', username: 'ada', relationship: { isFollowing: true, followsYou: true } });
    seedFollowStatuses({ u1: false });
    expect(User.get('u1')?.relationship).toEqual({ isFollowing: true, followsYou: true });
  });
});

describe('resolveFollowStatuses (micro-batched)', () => {
  it('reads every unknown id asked for in one tick in ONE call', async () => {
    const { follows, services } = makeServices();
    follows.statuses.mockImplementation(async (ids: string[]) =>
      Object.fromEntries(ids.map((id) => [id, id === 'u1'])),
    );
    resolveFollowStatuses(services, ['u1', 'u2']);
    resolveFollowStatuses(services, ['u3']);
    await flush();
    expect(follows.statuses).toHaveBeenCalledTimes(1);
    expect(follows.statuses).toHaveBeenCalledWith(['u1', 'u2', 'u3']);
    expect([following('u1'), following('u2'), following('u3')]).toEqual([true, false, false]);
  });

  it('skips known ids, and reads nothing when every id is known', async () => {
    const { follows, services } = makeServices();
    seedFollowStatuses({ u1: false });
    resolveFollowStatuses(services, ['u1', 'u2']);
    await flush();
    expect(follows.statuses).toHaveBeenCalledWith(['u2']);
    follows.statuses.mockClear();
    resolveFollowStatuses(services, ['u1', 'u2']);
    await flush();
    expect(follows.statuses).not.toHaveBeenCalled();
  });

  it('keeps a definite value a follow wrote while the read was in flight', async () => {
    const { follows, services } = makeServices();
    let answer: (statuses: Record<string, boolean>) => void = () => undefined;
    follows.statuses.mockReturnValueOnce(
      new Promise((resolve) => {
        answer = resolve;
      }),
    );
    resolveFollowStatuses(services, ['u1']);
    await flush();
    setFollowStatus('u1', true);
    answer({ u1: false });
    await flush();
    expect(following('u1')).toBe(true);
  });

  it('records a failed read as a code on each id', async () => {
    const { follows, services } = makeServices();
    follows.statuses.mockRejectedValueOnce(Object.assign(new Error('x'), { status: 429 }));
    resolveFollowStatuses(services, ['u1']);
    await flush();
    expect(activity('u1')?.error).toBe('rate_limited');
    expect(following('u1')).toBeUndefined();
  });
});

describe('toggleFollow (an action with an optimistic layer)', () => {
  it('shows the follow BEFORE the server answers, then writes the counts it answered', async () => {
    const { follows, services } = makeServices();
    let answer: (result: FollowMutationResult) => void = () => undefined;
    follows.follow.mockReturnValueOnce(
      new Promise((resolve) => {
        answer = resolve;
      }),
    );
    const pending = toggleFollow(services, 'u1', false);
    expect(following('u1')).toBe(true);
    expect(activity('u1')?.pending).toBe(true);

    answer({ message: 'ok', counts: { followers: 10, following: 3 } });
    expect(await pending).toBe(true);
    expect(following('u1')).toBe(true);
    expect(activity('u1')?.pending).toBe(false);
    expect(User.get('u1')?._count).toEqual({ followers: 10 });
    expect(User.get('viewer-1')?._count).toEqual({ following: 3 });
  });

  it('rolls back to the prior definite value, keeping the error code', async () => {
    const { follows, services } = makeServices();
    follows.follow.mockRejectedValueOnce(new Error('boom'));
    setFollowStatus('u1', false);
    expect(await toggleFollow(services, 'u1', false)).toBe(false);
    expect(following('u1')).toBe(false);
    expect(activity('u1')).toMatchObject({ pending: false, error: 'update_failed' });
  });

  it('rolls back to UNKNOWN when there was no prior value', async () => {
    const { follows, services } = makeServices();
    follows.follow.mockRejectedValueOnce(Object.assign(new Error('gone'), { status: 404 }));
    expect(await toggleFollow(services, 'u1', false)).toBe(false);
    expect(following('u1')).toBeUndefined();
    expect(activity('u1')?.error).toBe('not_found');
  });

  it('keeps the shown follow while a profile read lands beneath it, and both survive', async () => {
    const { follows, services } = makeServices();
    let answer: (result: FollowMutationResult) => void = () => undefined;
    follows.follow.mockReturnValueOnce(
      new Promise((resolve) => {
        answer = resolve;
      }),
    );
    User.put({ id: 'u1', username: 'ada', relationship: { isFollowing: false } });
    const pending = toggleFollow(services, 'u1', false);
    // A read answered before the write: it says "not following".
    User.put({ id: 'u1', username: 'ada', bio: 'new', relationship: { isFollowing: false } });
    expect(following('u1')).toBe(true);
    answer({ message: 'ok' });
    await pending;
    expect(User.get('u1')).toMatchObject({ bio: 'new', relationship: { isFollowing: true } });
  });
});

describe('followMany', () => {
  it('rolls back only the targets the server refused', async () => {
    const { follows, services } = makeServices();
    setFollowStatus('u2', false);
    follows.followMany.mockResolvedValueOnce({
      followedCount: 1,
      results: [
        { userId: 'u1', success: true, alreadyFollowing: false },
        { userId: 'u2', success: false, alreadyFollowing: false },
        { userId: 'u3', success: false, alreadyFollowing: false },
      ],
    });
    await followMany(services, ['u1', 'u2', 'u3']);
    expect([following('u1'), following('u2'), following('u3')]).toEqual([true, false, undefined]);
    expect(activity('u2')).toMatchObject({ pending: false, error: 'update_failed' });
    expect(activity('u1')).toMatchObject({ pending: false, error: null });
  });

  it('rolls every target back and rethrows when the whole call fails', async () => {
    const { follows, services } = makeServices();
    follows.followMany.mockRejectedValueOnce(new Error('offline'));
    await expect(followMany(services, ['u1', 'u2'])).rejects.toThrow('offline');
    expect([following('u1'), following('u2')]).toEqual([undefined, undefined]);
  });
});

describe('an answer for an account since left', () => {
  /** The session opens the next account's store; the previous one closes. */
  function switchAccount(): Store {
    void store.close();
    const next = new Store();
    setActiveStore(next);
    withStore(next, () => {
      setFollowStatus('u1', true);
    });
    return next;
  }

  it.each(['resolve', 'reject'] as const)(
    'is dropped when a follow %ss after the switch',
    async (outcome) => {
      const { follows, services } = makeServices();
      let resolve!: (result: FollowMutationResult) => void;
      let reject!: (error: Error) => void;
      follows.follow.mockReturnValueOnce(
        new Promise((res, rej) => {
          resolve = res;
          reject = rej;
        }),
      );
      const pending = toggleFollow(services, 'u1', false);
      const next = switchAccount();
      if (outcome === 'resolve')
        resolve({ message: 'ok', counts: { followers: 10, following: 3 } });
      else reject(new Error('old request failed'));
      expect(await pending).toBe(false);
      expect(following('u1', next)).toBe(true);
      expect(activity('u1', next)).toMatchObject({ pending: false, error: null });
      expect(withStore(next, () => User.get('u1')?._count)).toBeUndefined();
    },
  );

  it('is dropped when a status read answers after the switch', async () => {
    const { follows, services } = makeServices();
    let answer: (statuses: Record<string, boolean>) => void = () => undefined;
    follows.statuses.mockReturnValueOnce(
      new Promise((resolve) => {
        answer = resolve;
      }),
    );
    resolveFollowStatuses(services, ['u2']);
    await flush();
    const next = switchAccount();
    answer({ u2: true });
    await flush();
    expect(following('u2', next)).toBeUndefined();
  });

  it('rejects a bulk follow with the session-changed error', async () => {
    const { follows, services } = makeServices();
    let resolve!: (result: unknown) => void;
    follows.followMany.mockReturnValueOnce(
      new Promise((res) => {
        resolve = res;
      }),
    );
    const pending = followMany(services, ['u1']);
    const next = switchAccount();
    resolve({ followedCount: 0, results: [] });
    await expect(pending).rejects.toMatchObject({ code: 'AUTH_SESSION_CHANGED' });
    expect(following('u1', next)).toBe(true);
  });
});

describe('followCounts (the counts read)', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('is not read again while fresh (5 minutes), and is once stale', async () => {
    jest.useFakeTimers();
    const { users, services } = makeServices();
    users.get.mockResolvedValue({ id: 'u1', _count: { followers: 1, following: 2 } });
    await followCounts.fetch(services, 'u1');
    expect(User.get('u1')?._count).toEqual({ followers: 1, following: 2 });
    await followCounts.fetch(services, 'u1');
    expect(users.get).toHaveBeenCalledTimes(1);
    jest.advanceTimersByTime(5 * 60_000 + 1);
    await followCounts.fetch(services, 'u1');
    expect(users.get).toHaveBeenCalledTimes(2);
  });

  it('retries what another attempt can change (5xx), at most twice', async () => {
    jest.useFakeTimers();
    const { users, services } = makeServices();
    users.get.mockRejectedValue(Object.assign(new Error('down'), { status: 503 }));
    const read = followCounts.fetch(services, 'u1');
    await jest.advanceTimersByTimeAsync(10_000);
    await read;
    expect(users.get).toHaveBeenCalledTimes(3);
    expect(followCounts.state(services, 'u1').status).toBe('error');
  });

  it('does not retry a refusal another attempt cannot change (4xx)', async () => {
    const { users, services } = makeServices();
    users.get.mockRejectedValue(Object.assign(new Error('gone'), { status: 404 }));
    await followCounts.fetch(services, 'u1');
    expect(users.get).toHaveBeenCalledTimes(1);
    expect(followCounts.state(services, 'u1').status).toBe('error');
  });
});
