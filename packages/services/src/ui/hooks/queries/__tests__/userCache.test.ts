/**
 * userCache — canonical merge-upsert into the SDK user query cache.
 *
 * Covers the merge semantics that eliminate the "sparse source strips a field an
 * authoritative fetch stored" class of bug:
 *  - cold slot seeds the full object STALE (so react-query refetches)
 *  - a sparse user merged over a full entry KEEPS relationship / createdAt / etc.
 *  - null / empty / undefined incoming fields never strip or degrade
 *  - nested name / _count / relationship merge field-by-field
 *  - anti-degradation (empty username, 'Unknown user', null avatar)
 *  - both cache keys written; by-username is viewer-scoped and case-insensitive
 *  - batch upsert; viewer id defaults from the auth store
 */

import { QueryClient } from '@tanstack/react-query';
import { upsertCachedUser, upsertCachedUsers } from '../userCache';
import { patchCachedUserRelationship } from '../userCacheRelationship';
import type { CacheableUser } from '../userCache';
import { queryKeys } from '../queryKeys';
import { bindAuthStoreToRuntime, useAuthStore } from '../../../stores/authStore';
import { createTestRuntime } from '../../../../../__tests__/helpers/runtimeHarness';

function makeClient(): QueryClient {
  return new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
}

/** Read the by-id cache entry. */
function readById(qc: QueryClient, id: string): CacheableUser | undefined {
  return qc.getQueryData<CacheableUser>(queryKeys.users.detail(id));
}

/** Read the viewer-scoped by-username cache entry. */
function readByUsername(qc: QueryClient, username: string, viewerId: string): CacheableUser | undefined {
  return qc.getQueryData<CacheableUser>(queryKeys.users.byUsername(username, viewerId));
}

// `useAuthStore` projects the runtime now, so the viewer these cases read has
// to live somewhere: bind a runtime per test and let the writes go through it.
let unbindAuthStore: (() => void) | null = null;

beforeEach(() => {
  unbindAuthStore = bindAuthStoreToRuntime(createTestRuntime());
  // Default to anonymous viewer unless a test sets one.
  useAuthStore.setState({ user: null });
});

afterEach(() => {
  unbindAuthStore?.();
  unbindAuthStore = null;
});

describe('upsertCachedUser — cold slot', () => {
  it('seeds the full object and marks it STALE (updatedAt: 0) under both keys', () => {
    const qc = makeClient();
    const user: CacheableUser = {
      id: 'u1',
      username: 'Alice',
      name: { displayName: 'Alice A' },
      avatar: 'file_a',
      createdAt: '2020-01-01T00:00:00Z',
      _count: { followers: 10, following: 5 },
      relationship: { isFollowing: true, followsYou: false },
    };

    upsertCachedUser(qc, user, 'viewer-1');

    // by-id
    expect(readById(qc, 'u1')).toMatchObject({ id: 'u1', username: 'Alice', avatar: 'file_a' });
    expect(qc.getQueryState(queryKeys.users.detail('u1'))?.dataUpdatedAt).toBe(0);

    // by-username (viewer-scoped, normalized to lowercase)
    const uname = readByUsername(qc, 'alice', 'viewer-1');
    expect(uname).toMatchObject({ id: 'u1', relationship: { isFollowing: true } });
    expect(qc.getQueryState(queryKeys.users.byUsername('alice', 'viewer-1'))?.dataUpdatedAt).toBe(0);
  });

  it('resolves the id from _id when id is absent', () => {
    const qc = makeClient();
    upsertCachedUser(qc, { _id: 'mongo1', username: 'bob' }, '');
    expect(readById(qc, 'mongo1')).toMatchObject({ id: 'mongo1', username: 'bob' });
  });

  it('is a no-op when no id can be resolved', () => {
    const qc = makeClient();
    upsertCachedUser(qc, { username: 'ghost' }, '');
    expect(qc.getQueryCache().getAll()).toHaveLength(0);
  });

  it('normalizes a plain-string name into { displayName }', () => {
    const qc = makeClient();
    upsertCachedUser(qc, { id: 'u1', username: 'alice', name: 'Alice Display' }, '');
    expect(readById(qc, 'u1')?.name).toEqual({ displayName: 'Alice Display' });
  });
});

describe('upsertCachedUser — merge over an existing full entry', () => {
  const full: CacheableUser = {
    id: 'u1',
    username: 'alice',
    name: { displayName: 'Alice A', first: 'Alice' },
    avatar: 'file_a',
    verified: true,
    badges: ['og'],
    createdAt: '2020-01-01T00:00:00Z',
    _count: { followers: 10, following: 5 },
    relationship: { isFollowing: true, followsYou: true },
  };

  function seedFull(qc: QueryClient): void {
    // Represents an authoritative single-profile fetch already in cache (fresh).
    qc.setQueryData(queryKeys.users.detail('u1'), full);
    qc.setQueryData(queryKeys.users.byUsername('alice', 'viewer-1'), full);
  }

  it('keeps relationship + createdAt + _count when a SPARSE feed user is upserted', () => {
    const qc = makeClient();
    seedFull(qc);

    // A feed author: no relationship, no createdAt, no counts.
    upsertCachedUser(qc, { id: 'u1', username: 'alice', name: { displayName: 'Alice A' }, avatar: 'file_a' }, 'viewer-1');

    const byId = readById(qc, 'u1');
    expect(byId?.createdAt).toBe('2020-01-01T00:00:00Z');
    expect(byId?._count).toEqual({ followers: 10, following: 5 });
    expect(byId?.verified).toBe(true);

    const byName = readByUsername(qc, 'alice', 'viewer-1');
    expect(byName?.relationship).toEqual({ isFollowing: true, followsYou: true });
    expect(byName?.createdAt).toBe('2020-01-01T00:00:00Z');
  });

  it('does NOT mark an existing entry stale', () => {
    const qc = makeClient();
    seedFull(qc);
    const before = qc.getQueryState(queryKeys.users.detail('u1'))?.dataUpdatedAt;
    expect(before).not.toBe(0);

    upsertCachedUser(qc, { id: 'u1', username: 'alice' }, 'viewer-1');

    const after = qc.getQueryState(queryKeys.users.detail('u1'))?.dataUpdatedAt;
    expect(after).toBe(before); // freshness preserved, not reset to 0
  });

  it('null / empty / undefined incoming fields never strip an existing field', () => {
    const qc = makeClient();
    seedFull(qc);

    upsertCachedUser(
      qc,
      { id: 'u1', username: '', avatar: null, createdAt: '', _count: undefined, relationship: null },
      'viewer-1',
    );

    const byId = readById(qc, 'u1');
    expect(byId?.username).toBe('alice');
    expect(byId?.avatar).toBe('file_a');
    expect(byId?.createdAt).toBe('2020-01-01T00:00:00Z');
    expect(byId?._count).toEqual({ followers: 10, following: 5 });

    const byName = readByUsername(qc, 'alice', 'viewer-1');
    expect(byName?.relationship).toEqual({ isFollowing: true, followsYou: true });
  });

  it('updates the fields the incoming user DOES carry', () => {
    const qc = makeClient();
    seedFull(qc);

    upsertCachedUser(qc, { id: 'u1', username: 'alice', bio: 'new bio', avatar: 'file_new' }, 'viewer-1');

    const byId = readById(qc, 'u1');
    expect(byId?.bio).toBe('new bio');
    expect(byId?.avatar).toBe('file_new');
    // untouched fields survive
    expect(byId?.createdAt).toBe('2020-01-01T00:00:00Z');
  });

  it('a defined boolean/number (verified:false, _count.followers:0) DOES override', () => {
    const qc = makeClient();
    seedFull(qc);

    upsertCachedUser(qc, { id: 'u1', username: 'alice', verified: false, _count: { followers: 0 } }, 'viewer-1');

    const byId = readById(qc, 'u1');
    expect(byId?.verified).toBe(false);
    // partial _count overrides only followers; following kept from existing
    expect(byId?._count).toEqual({ followers: 0, following: 5 });
  });
});

describe('upsertCachedUser — nested merge', () => {
  it('a partial name never replaces a fuller name; displayName upgrades', () => {
    const qc = makeClient();
    qc.setQueryData(queryKeys.users.detail('u1'), {
      id: 'u1',
      username: 'alice',
      name: { first: 'Alice', last: 'Adams', displayName: 'Alice A' },
    });

    upsertCachedUser(qc, { id: 'u1', username: 'alice', name: { displayName: 'Alice Adams' } }, '');

    expect(readById(qc, 'u1')?.name).toEqual({
      first: 'Alice',
      last: 'Adams',
      displayName: 'Alice Adams',
    });
  });

  it('a partial relationship never nulls out the other field', () => {
    const qc = makeClient();
    qc.setQueryData(queryKeys.users.byUsername('alice', 'v1'), {
      id: 'u1',
      username: 'alice',
      relationship: { isFollowing: true, followsYou: true },
    });

    upsertCachedUser(qc, { id: 'u1', username: 'alice', relationship: { followsYou: false } }, 'v1');

    expect(readByUsername(qc, 'alice', 'v1')?.relationship).toEqual({ isFollowing: true, followsYou: false });
  });
});

describe('upsertCachedUser — anti-degradation', () => {
  it('never overwrites a good displayName with the "Unknown user" sentinel', () => {
    const qc = makeClient();
    qc.setQueryData(queryKeys.users.detail('u1'), { id: 'u1', username: 'alice', name: { displayName: 'Alice A' } });

    upsertCachedUser(qc, { id: 'u1', username: 'alice', name: { displayName: 'Unknown user' } }, '');

    expect(readById(qc, 'u1')?.name).toEqual({ displayName: 'Alice A' });
  });

  it('never overwrites a good username with an empty one', () => {
    const qc = makeClient();
    qc.setQueryData(queryKeys.users.detail('u1'), { id: 'u1', username: 'alice' });

    upsertCachedUser(qc, { id: 'u1', username: '   ' }, '');

    expect(readById(qc, 'u1')?.username).toBe('alice');
  });

  it('never nulls out a good avatar', () => {
    const qc = makeClient();
    qc.setQueryData(queryKeys.users.detail('u1'), { id: 'u1', username: 'alice', avatar: 'file_a' });

    upsertCachedUser(qc, { id: 'u1', username: 'alice', avatar: null }, '');

    expect(readById(qc, 'u1')?.avatar).toBe('file_a');
  });

  it('upgrades a degraded existing displayName when a real one arrives', () => {
    const qc = makeClient();
    qc.setQueryData(queryKeys.users.detail('u1'), { id: 'u1', username: 'alice', name: { displayName: 'Unknown user' } });

    upsertCachedUser(qc, { id: 'u1', username: 'alice', name: { displayName: 'Alice A' } }, '');

    expect(readById(qc, 'u1')?.name).toEqual({ displayName: 'Alice A' });
  });
});

describe('upsertCachedUser — keys & viewer scoping', () => {
  it('writes ONLY the by-id key when no username is present', () => {
    const qc = makeClient();
    upsertCachedUser(qc, { id: 'u1' }, 'v1');
    expect(readById(qc, 'u1')).toBeDefined();
    // no username-derived entries
    const usernameEntries = qc
      .getQueryCache()
      .getAll()
      .filter((q) => (q.queryKey as unknown[]).includes('username'));
    expect(usernameEntries).toHaveLength(0);
  });

  it('viewer-scopes the by-username key (different viewers -> different entries)', () => {
    const qc = makeClient();
    upsertCachedUser(qc, { id: 'u1', username: 'alice', relationship: { isFollowing: true, followsYou: false } }, 'viewerA');

    expect(readByUsername(qc, 'alice', 'viewerA')).toBeDefined();
    expect(readByUsername(qc, 'alice', 'viewerB')).toBeUndefined();
  });

  it('never stores viewer-relative relationship on the viewer-independent by-id key', () => {
    const qc = makeClient();
    upsertCachedUser(
      qc,
      { id: 'u1', username: 'alice', relationship: { isFollowing: true, followsYou: true } },
      'viewerA',
    );

    expect(readById(qc, 'u1')?.relationship).toBeUndefined();
    expect(readByUsername(qc, 'alice', 'viewerA')?.relationship).toEqual({
      isFollowing: true,
      followsYou: true,
    });
  });

  it('strips a stale relationship from an existing by-id entry on merge', () => {
    const qc = makeClient();
    qc.setQueryData(queryKeys.users.detail('u1'), {
      id: 'u1',
      username: 'alice',
      relationship: { isFollowing: true, followsYou: true },
    });

    upsertCachedUser(qc, { id: 'u1', username: 'alice', avatar: 'file_a' }, 'viewerA');

    expect(readById(qc, 'u1')?.relationship).toBeUndefined();
    expect(readById(qc, 'u1')?.avatar).toBe('file_a');
  });

  it('is case-insensitive on username (byUsername normalization)', () => {
    const qc = makeClient();
    upsertCachedUser(qc, { id: 'u1', username: 'AlIcE' }, 'v1');
    // read with any casing resolves the same entry
    expect(readByUsername(qc, 'alice', 'v1')).toMatchObject({ id: 'u1' });
    expect(readByUsername(qc, 'ALICE', 'v1')).toMatchObject({ id: 'u1' });
  });

  it('defaults the viewer id from the auth store when omitted', () => {
    const qc = makeClient();
    useAuthStore.setState({ user: { id: 'store-viewer', username: 'me', name: { displayName: 'Me' }, publicKey: 'pk' } });

    upsertCachedUser(qc, { id: 'u1', username: 'alice' });

    expect(readByUsername(qc, 'alice', 'store-viewer')).toMatchObject({ id: 'u1' });
    expect(readByUsername(qc, 'alice', '')).toBeUndefined();
  });
});

describe('upsertCachedUsers — batch', () => {
  it('upserts every user under both keys', () => {
    const qc = makeClient();
    upsertCachedUsers(
      qc,
      [
        { id: 'u1', username: 'alice' },
        { id: 'u2', username: 'bob' },
      ],
      'v1',
    );

    expect(readById(qc, 'u1')).toMatchObject({ username: 'alice' });
    expect(readById(qc, 'u2')).toMatchObject({ username: 'bob' });
    expect(readByUsername(qc, 'alice', 'v1')).toBeDefined();
    expect(readByUsername(qc, 'bob', 'v1')).toBeDefined();
  });

  it('accumulates fields when the same user appears twice with different slices', () => {
    const qc = makeClient();
    // Seed a fresh (non-cold) authoritative entry first so both batch items merge.
    qc.setQueryData(queryKeys.users.detail('u1'), { id: 'u1', username: 'alice' });
    upsertCachedUsers(
      qc,
      [
        { id: 'u1', username: 'alice', avatar: 'file_a' },
        { id: 'u1', username: 'alice', bio: 'hello' },
      ],
      'v1',
    );

    const byId = readById(qc, 'u1');
    expect(byId?.avatar).toBe('file_a');
    expect(byId?.bio).toBe('hello');
  });

  it('ignores null / empty input', () => {
    const qc = makeClient();
    upsertCachedUsers(qc, null, 'v1');
    upsertCachedUsers(qc, [], 'v1');
    expect(qc.getQueryCache().getAll()).toHaveLength(0);
  });
});

describe('patchCachedUserRelationship', () => {
  it('updates relationship.isFollowing on the viewer-scoped by-username entry', () => {
    const qc = makeClient();
    upsertCachedUser(
      qc,
      {
        id: 'u1',
        username: 'alice',
        relationship: { isFollowing: false, followsYou: true },
      },
      'viewer-1',
    );

    patchCachedUserRelationship(qc, 'u1', true);

    expect(readByUsername(qc, 'alice', 'viewer-1')?.relationship).toEqual({
      isFollowing: true,
      followsYou: true,
    });
  });

  it('never writes relationship onto the viewer-independent by-id key', () => {
    const qc = makeClient();
    upsertCachedUser(
      qc,
      {
        id: 'u1',
        username: 'alice',
        relationship: { isFollowing: false, followsYou: true },
      },
      'viewer-1',
    );

    patchCachedUserRelationship(qc, 'u1', true);

    expect(readById(qc, 'u1')?.relationship).toBeUndefined();
  });

  it('updates viewer-scoped detailForViewer keys', () => {
    const qc = makeClient();
    qc.setQueryData(queryKeys.users.detailForViewer('u1', 'viewer-1'), {
      id: 'u1',
      username: 'alice',
      relationship: { isFollowing: false, followsYou: false },
    });

    patchCachedUserRelationship(qc, 'u1', true);

    expect(
      qc.getQueryData<CacheableUser>(queryKeys.users.detailForViewer('u1', 'viewer-1'))?.relationship,
    ).toEqual({ isFollowing: true, followsYou: false });
  });
});
