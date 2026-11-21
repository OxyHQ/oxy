import { QueryClient } from '@tanstack/react-query';
import { entity, setActiveStore, Store, withStore } from '@oxy.so/bloom-data';
import { upsertCachedUser, upsertCachedUsers } from '../../hooks/queries/userCache';
import { storeUsers, User, userWriter } from '../user';

let store: Store;
beforeEach(() => {
  store = new Store();
  setActiveStore(store);
});

const profile = {
  id: 'u1',
  username: 'ada',
  name: { displayName: 'Ada Lovelace' },
  avatar: 'file-1',
  bio: 'Mathematician',
  createdAt: '2020-01-01T00:00:00.000Z',
  _count: { followers: 10, following: 3 },
  relationship: { isFollowing: true, followsYou: true },
};

describe('User', () => {
  it('keeps what a sparse payload does not carry', () => {
    User.put(profile);
    User.put({ id: 'u1', username: 'ada', name: { displayName: 'Ada L.' } });
    expect(User.get('u1')).toEqual({ ...profile, name: { displayName: 'Ada L.' } });
  });

  it('never lets the unresolved-author placeholder replace a resolved person', () => {
    User.put(profile);
    User.put({ id: 'u1', username: '', name: { displayName: 'Unknown user' }, avatar: null });
    expect(User.get('u1')).toEqual(profile);
  });

  it('stores the placeholder when nothing better is held, and lets the real one replace it', () => {
    User.put({ id: 'u2', username: '', name: { displayName: 'Unknown user' } });
    User.put({ id: 'u2', username: 'grace', name: { displayName: 'Grace' } });
    expect(User.get('u2')).toEqual({ id: 'u2', username: 'grace', name: { displayName: 'Grace' } });
  });

  it('keeps the viewer relationship when a broadcast hydrated for no viewer arrives', () => {
    User.put(profile);
    User.put(
      { id: 'u1', username: 'ada', name: { displayName: 'Ada' }, relationship: null },
      { anonymous: true },
    );
    expect(User.get('u1')?.relationship).toEqual(profile.relationship);
  });

  it('reaches every record that refers to the person', () => {
    const Post = entity<{ id: string; user: { id: string } }>('test-post-with-user', {
      id: (post) => post.id,
      refs: { user: User },
    });
    Post.put([
      { id: 'p1', user: profile },
      { id: 'p2', user: { id: 'u1', username: 'ada', name: { displayName: 'Unknown user' } } },
    ]);
    storeUsers({ id: 'u1', avatar: 'file-2' });
    expect(Post.get('p1')?.user).toMatchObject({ avatar: 'file-2', bio: 'Mathematician' });
    expect(Post.get('p2')?.user).toMatchObject({ name: { displayName: 'Ada Lovelace' } });
  });
});

describe('User freshness', () => {
  const edited = { ...profile, avatar: 'file-new', updatedAt: '2026-11-20T10:00:00.000Z' };

  it('never lets a copy from before an edit put the old picture back', () => {
    User.put(edited);
    User.put({
      id: 'u1',
      username: 'ada',
      avatar: 'file-1',
      updatedAt: '2026-11-19T10:00:00.000Z',
    });
    expect(User.get('u1')?.avatar).toBe('file-new');
  });

  it('counts a copy without updatedAt as the oldest, yet keeps what only it carries', () => {
    User.put({ ...edited, bio: undefined });
    User.put({ id: 'u1', username: 'ada', avatar: 'file-1', bio: 'Mathematician' });
    expect(User.get('u1')).toMatchObject({ avatar: 'file-new', bio: 'Mathematician' });
  });

  it('lets a later copy win', () => {
    User.put(edited);
    User.put({
      id: 'u1',
      username: 'ada',
      avatar: 'file-3',
      updatedAt: '2026-11-21T10:00:00.000Z',
    });
    expect(User.get('u1')?.avatar).toBe('file-3');
  });
});

describe('storeUsers', () => {
  it('normalises loose actor objects (a raw _id, a string name)', () => {
    storeUsers([{ _id: 'u3', username: 'linus', name: 'Linus' }, null, { username: 'no-id' }]);
    expect(User.get('u3')).toEqual({
      _id: 'u3',
      id: 'u3',
      username: 'linus',
      name: { displayName: 'Linus' },
    });
    expect(User.ids()).toEqual(['u3']);
  });

  it('drops a field the write declared cleared, and only that one', () => {
    User.put(profile);
    storeUsers(
      { id: 'u1', username: 'ada', name: {} },
      { cleared: ['avatar', 'name.displayName'] },
    );
    const held = User.get('u1');
    expect(held?.avatar).toBeUndefined();
    expect(held?.name).toEqual({});
    expect(held?.bio).toBe('Mathematician');
  });

  it('stores a cleared write for a person not held yet', () => {
    storeUsers({ id: 'u4', username: 'new' }, { cleared: ['avatar'] });
    expect(User.get('u4')).toEqual({ id: 'u4', username: 'new' });
  });
});

describe('userWriter', () => {
  it('writes to the account that started the read, never the one active when it lands', async () => {
    const write = userWriter();
    const next = new Store();
    setActiveStore(next);
    await store.close();
    write({ id: 'u1', username: 'ada' });
    expect(withStore(next, () => User.has('u1'))).toBe(false);
    expect(withStore(store, () => User.has('u1'))).toBe(false);
  });

  it('writes to its account while that account is open', () => {
    const write = userWriter();
    setActiveStore(new Store());
    write({ id: 'u1', username: 'ada' });
    expect(withStore(store, () => User.has('u1'))).toBe(true);
  });
});

describe('upsertCachedUser', () => {
  it('writes the person into User as well as the query cache', () => {
    const queryClient = new QueryClient();
    upsertCachedUser(queryClient, profile, 'viewer');
    upsertCachedUsers(queryClient, [{ id: 'u5', username: 'kat', name: 'Kat' }], 'viewer');
    expect(User.get('u1')).toEqual(profile);
    expect(User.get('u5')).toEqual({ id: 'u5', username: 'kat', name: { displayName: 'Kat' } });
  });

  it('passes a declared clear to User', () => {
    const queryClient = new QueryClient();
    upsertCachedUser(queryClient, profile, 'viewer');
    upsertCachedUser(queryClient, { id: 'u1', username: 'ada' }, 'viewer', { cleared: ['bio'] });
    expect(User.get('u1')?.bio).toBeUndefined();
    expect(User.get('u1')?.avatar).toBe('file-1');
  });
});
