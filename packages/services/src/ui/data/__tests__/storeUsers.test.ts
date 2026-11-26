/**
 * `storeUsers` — every person a read returns joins the one `User` record held
 * for them, MERGED, so a sparse source can never strip a field an
 * authoritative read stored:
 *  - a sparse user merged over a full record KEEPS relationship / createdAt / counts
 *  - null / empty / undefined incoming fields never strip or degrade
 *  - nested name / _count / relationship merge field-by-field
 *  - anti-degradation (empty username, 'Unknown user', null avatar)
 *  - the handle finds the record whatever its casing (`username` index)
 *  - a batch accumulates the slices of one person
 */
import { setActiveStore, Store } from '@oxy.so/bloom-data';
import { storeUsers, User } from '../user';
import type { CacheableUser } from '../userRecord';

beforeEach(() => {
  setActiveStore(new Store());
});

const read = (id: string) => User.get(id);

describe('storeUsers — a person not held yet', () => {
  it('stores the full object', () => {
    storeUsers({
      id: 'u1',
      username: 'Alice',
      name: { displayName: 'Alice A' },
      avatar: 'file_a',
      relationship: { isFollowing: true, followsYou: false },
    });
    expect(read('u1')).toMatchObject({
      id: 'u1',
      username: 'Alice',
      avatar: 'file_a',
      relationship: { isFollowing: true },
    });
  });

  it('resolves the id from _id when id is absent', () => {
    storeUsers({ _id: 'legacy1', username: 'bob' });
    expect(read('legacy1')).toMatchObject({ id: 'legacy1', username: 'bob' });
  });

  it('is a no-op when no id can be resolved', () => {
    storeUsers({ username: 'ghost' });
    expect(User.ids()).toEqual([]);
  });

  it('normalizes a plain-string name into { displayName }', () => {
    storeUsers({ id: 'u1', username: 'alice', name: 'Alice Display' });
    expect(read('u1')?.name).toEqual({ displayName: 'Alice Display' });
  });
});

describe('storeUsers — merge over a full record', () => {
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

  beforeEach(() => storeUsers(full));

  it('keeps relationship + createdAt + _count when a SPARSE feed user arrives', () => {
    storeUsers({ id: 'u1', username: 'alice', name: { displayName: 'Alice A' }, avatar: 'file_a' });
    expect(read('u1')).toMatchObject({
      createdAt: '2020-01-01T00:00:00Z',
      _count: { followers: 10, following: 5 },
      verified: true,
      relationship: { isFollowing: true, followsYou: true },
    });
  });

  it('null / empty / undefined incoming fields never strip a held field', () => {
    storeUsers({
      id: 'u1',
      username: '',
      avatar: null,
      createdAt: '',
      _count: undefined,
      relationship: null,
    });
    expect(read('u1')).toMatchObject({
      username: 'alice',
      avatar: 'file_a',
      createdAt: '2020-01-01T00:00:00Z',
      _count: { followers: 10, following: 5 },
      relationship: { isFollowing: true, followsYou: true },
    });
  });

  it('updates the fields the incoming user DOES carry', () => {
    storeUsers({ id: 'u1', username: 'alice', bio: 'new bio', avatar: 'file_new' });
    expect(read('u1')).toMatchObject({
      bio: 'new bio',
      avatar: 'file_new',
      createdAt: '2020-01-01T00:00:00Z',
    });
  });

  it('a defined boolean/number (verified:false, _count.followers:0) DOES override', () => {
    storeUsers({ id: 'u1', username: 'alice', verified: false, _count: { followers: 0 } });
    expect(read('u1')?.verified).toBe(false);
    expect(read('u1')?._count).toEqual({ followers: 0, following: 5 });
  });

  it('a partial name never replaces a fuller name; displayName upgrades', () => {
    storeUsers({ id: 'u1', username: 'alice', name: { displayName: 'Alice Adams' } });
    expect(read('u1')?.name).toEqual({ first: 'Alice', displayName: 'Alice Adams' });
  });

  it('a partial relationship never nulls out the other field', () => {
    storeUsers({ id: 'u1', username: 'alice', relationship: { followsYou: false } });
    expect(read('u1')?.relationship).toEqual({ isFollowing: true, followsYou: false });
  });
});

describe('storeUsers — anti-degradation', () => {
  it('never overwrites a good displayName with the "Unknown user" sentinel', () => {
    storeUsers({ id: 'u1', username: 'alice', name: { displayName: 'Alice A' } });
    storeUsers({ id: 'u1', username: 'alice', name: { displayName: 'Unknown user' } });
    expect(read('u1')?.name).toEqual({ displayName: 'Alice A' });
  });

  it('never overwrites a good username with an empty one', () => {
    storeUsers({ id: 'u1', username: 'alice' });
    storeUsers({ id: 'u1', username: '   ' });
    expect(read('u1')?.username).toBe('alice');
  });

  it('never nulls out a good avatar', () => {
    storeUsers({ id: 'u1', username: 'alice', avatar: 'file_a' });
    storeUsers({ id: 'u1', username: 'alice', avatar: null });
    expect(read('u1')?.avatar).toBe('file_a');
  });

  it('upgrades a degraded displayName when a real one arrives', () => {
    storeUsers({ id: 'u1', username: 'alice', name: { displayName: 'Unknown user' } });
    storeUsers({ id: 'u1', username: 'alice', name: { displayName: 'Alice A' } });
    expect(read('u1')?.name).toEqual({ displayName: 'Alice A' });
  });
});

describe('the username index', () => {
  it('finds a person by handle whatever its casing or padding', () => {
    storeUsers({ id: 'u1', username: 'AlIcE' });
    expect(User.lookup('username', 'alice')).toBe('u1');
  });

  it('follows a handle change', () => {
    storeUsers({ id: 'u1', username: 'alice' });
    storeUsers({ id: 'u1', username: 'alicia' });
    expect(User.lookup('username', 'alice')).toBeUndefined();
    expect(User.lookup('username', 'alicia')).toBe('u1');
  });
});

describe('storeUsers — a batch', () => {
  it('stores every person', () => {
    storeUsers([
      { id: 'u1', username: 'alice' },
      { id: 'u2', username: 'bob' },
    ]);
    expect(read('u1')).toMatchObject({ username: 'alice' });
    expect(read('u2')).toMatchObject({ username: 'bob' });
  });

  it('accumulates the slices of a person who appears twice', () => {
    storeUsers([
      { id: 'u1', username: 'alice', avatar: 'file_a' },
      { id: 'u1', username: 'alice', bio: 'hello' },
    ]);
    expect(read('u1')).toMatchObject({ avatar: 'file_a', bio: 'hello' });
  });

  it('ignores null / empty input', () => {
    storeUsers(null);
    storeUsers([]);
    expect(User.ids()).toEqual([]);
  });
});
