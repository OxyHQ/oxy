import { QueryClient } from '@tanstack/react-query';
import {
  ACCOUNT_QUERY_CACHE_KEY,
  createAccountQueryPersistence,
  type AccountQueriesConfig,
  type AccountQueryPersistence,
} from '../../src/ui/hooks/accountQueryPersistence';
import { attachQueryPersistence } from '../../src/ui/hooks/queryClient';
import { createMemoryStorage, type StorageInterface } from '../../src/ui/utils/storageHelpers';

const CONFIG: AccountQueriesConfig = {
  roots: ['thread'],
  memoryOnlyRoots: ['search'],
  mutationKeys: [['app', 'star']],
};
const THREAD = ['thread', 'm1'];
const blobKey = (id: string) => `${ACCOUNT_QUERY_CACHE_KEY}:${id}`;

// Writes go out behind a 1s throttle.
const flushWrites = () => new Promise((resolve) => setTimeout(resolve, 1_100));
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

function until(persistence: AccountQueryPersistence): Promise<void> {
  return new Promise((resolve) => {
    if (persistence.isReady()) return resolve();
    const off = persistence.subscribe(() => {
      if (persistence.isReady()) {
        off();
        resolve();
      }
    });
  });
}

function mount(client: QueryClient, storage: StorageInterface | null, config = CONFIG) {
  const persistence = createAccountQueryPersistence(client, config);
  if (storage) persistence.setStorage(storage);
  persistence.attach();
  return persistence;
}

function pausedMutation(client: QueryClient, mutationKey: string[]) {
  const mutation = client
    .getMutationCache()
    .build(client, { mutationKey, mutationFn: async () => undefined });
  mutation.state.isPaused = true;
  return mutation;
}

async function writeFor(
  storage: StorageInterface,
  accountId: string,
  write: (client: QueryClient) => unknown,
) {
  const client = new QueryClient();
  const persistence = mount(client, storage);
  persistence.activate(accountId);
  await until(persistence);
  await write(client);
  await flushWrites();
  persistence.detach();
}

describe('account query persistence', () => {
  const originalBuildId = process.env.OXY_BUILD_ID;
  beforeEach(() => {
    process.env.OXY_BUILD_ID = 'build-1';
  });
  afterAll(() => {
    process.env.OXY_BUILD_ID = originalBuildId;
  });

  it('can keep all account queries in memory while isolating account switches', async () => {
    const storage = createMemoryStorage();
    const client = new QueryClient();
    const config: AccountQueriesConfig = {
      roots: [],
      memoryOnlyRoots: 'all',
      mutationKeys: [['app', 'star']],
    };
    const shared = attachQueryPersistence(client, storage, config);
    await shared.restored;
    const persistence = mount(client, storage, config);
    persistence.activate('alice');
    await until(persistence);
    client.setQueryData(['users', 'private'], 'alice private');
    client.setQueryData(['feed'], 'alice feed');
    client.setQueryData(['accounts'], 'device directory');
    client.setQueryDefaults(['accounts', 'private'], { meta: { persist: 'account' } });
    client.setQueryData(['accounts', 'private'], 'alice marked');
    pausedMutation(client, ['app', 'star']);
    await flushWrites();

    expect(await storage.getItem(blobKey('alice'))).not.toContain('alice private');
    expect(await storage.getItem(blobKey('alice'))).not.toContain('alice feed');
    expect(await storage.getItem(blobKey('alice'))).not.toContain('alice marked');
    expect(await storage.getItem('oxy_query_cache_v3')).not.toContain('alice private');
    expect(await storage.getItem('oxy_query_cache_v3')).not.toContain('alice marked');
    expect(await storage.getItem('oxy_query_cache_v3')).toContain('device directory');
    persistence.activate('bob');
    expect(client.getQueryData(['users', 'private'])).toBeUndefined();
    expect(client.getQueryData(['feed'])).toBeUndefined();
    expect(client.getQueryData(['accounts', 'private'])).toBeUndefined();
    expect(client.getQueryData(['accounts'])).toBe('device directory');
    await until(persistence);
    persistence.activate('alice');
    await until(persistence);
    expect(
      client
        .getMutationCache()
        .getAll()
        .map((m) => m.options.mutationKey),
    ).toEqual([['app', 'star']]);
    persistence.detach();
    shared.unsubscribe();
  });

  it('clears unregistered mutations on guest and account transitions while restoring registered ones', async () => {
    const storage = createMemoryStorage();
    const client = new QueryClient();
    const config: AccountQueriesConfig = {
      roots: [],
      memoryOnlyRoots: 'all',
      mutationKeys: [['app', 'star']],
      clearUnregisteredMutations: true,
    };
    const shared = attachQueryPersistence(client, storage, config);
    await shared.restored;
    const persistence = mount(client, storage, config);
    const guestMutation = pausedMutation(client, ['guest']);
    persistence.activate('alice');
    expect(client.getMutationCache().getAll()).not.toContain(guestMutation);
    await until(persistence);

    pausedMutation(client, ['app', 'star']);
    const unknown = pausedMutation(client, ['app', 'unregistered']);
    const unkeyed = client.getMutationCache().build(client, { mutationFn: async () => undefined });
    await flushWrites();
    expect(await storage.getItem('oxy_query_cache_v3')).not.toContain('unregistered');
    expect(await storage.getItem(blobKey('alice'))).not.toContain('unregistered');
    expect(await storage.getItem(blobKey('alice'))).toContain('star');
    persistence.activate('bob');
    expect(client.getMutationCache().getAll()).not.toContain(unknown);
    expect(client.getMutationCache().getAll()).not.toContain(unkeyed);
    expect(client.getMutationCache().getAll()).toHaveLength(0);
    await until(persistence);

    persistence.activate('alice');
    await until(persistence);
    expect(
      client
        .getMutationCache()
        .getAll()
        .map((m) => m.options.mutationKey),
    ).toEqual([['app', 'star']]);
    persistence.detach();
    shared.unsubscribe();
  });

  it('does not hydrate legacy shared data newly claimed by the account', async () => {
    const storage = createMemoryStorage();
    const oldClient = new QueryClient();
    const oldShared = attachQueryPersistence(oldClient, storage);
    await oldShared.restored;
    oldClient.setQueryData(['users', 'private'], 'old private');
    oldClient.setQueryData(['accounts'], 'device directory');
    pausedMutation(oldClient, ['old', 'mutation']);
    await flushWrites();
    oldShared.unsubscribe();

    const client = new QueryClient();
    const shared = attachQueryPersistence(client, storage, {
      roots: [],
      memoryOnlyRoots: 'all',
      clearUnregisteredMutations: true,
    });
    await shared.restored;
    expect(client.getQueryData(['users', 'private'])).toBeUndefined();
    expect(client.getQueryData(['accounts'])).toBe('device directory');
    expect(client.getMutationCache().getAll()).toHaveLength(0);
    shared.unsubscribe();
  });

  it('filters legacy account blobs against the current query and mutation policy', async () => {
    const storage = createMemoryStorage();
    const oldClient = new QueryClient();
    const old = mount(oldClient, storage, {
      roots: ['saved', 'search'],
      mutationKeys: [
        ['app', 'keep'],
        ['app', 'retired'],
      ],
    });
    old.activate('alice');
    await until(old);
    oldClient.setQueryData(['saved'], 'keep me');
    oldClient.setQueryData(['search'], 'private search');
    pausedMutation(oldClient, ['app', 'keep']);
    pausedMutation(oldClient, ['app', 'retired']);
    await flushWrites();
    old.detach();

    const client = new QueryClient();
    const current = mount(client, storage, {
      roots: ['saved'],
      memoryOnlyRoots: ['search'],
      mutationKeys: [['app', 'keep']],
    });
    current.activate('alice');
    await until(current);
    expect(client.getQueryData(['saved'])).toBe('keep me');
    expect(client.getQueryData(['search'])).toBeUndefined();
    expect(
      client
        .getMutationCache()
        .getAll()
        .map((m) => m.options.mutationKey),
    ).toEqual([['app', 'keep']]);
    current.detach();
  });

  it('does not restore newly account-registered mutations from the old shared blob', async () => {
    const storage = createMemoryStorage();
    const oldClient = new QueryClient();
    const old = attachQueryPersistence(oldClient, storage);
    await old.restored;
    pausedMutation(oldClient, ['app', 'account']);
    pausedMutation(oldClient, ['app', 'shared']);
    await flushWrites();
    old.unsubscribe();

    const client = new QueryClient();
    const current = attachQueryPersistence(client, storage, {
      roots: [],
      mutationKeys: [['app', 'account']],
    });
    await current.restored;
    expect(
      client
        .getMutationCache()
        .getAll()
        .map((m) => m.options.mutationKey),
    ).toEqual([['app', 'shared']]);
    current.unsubscribe();
  });

  it('keeps selected mutation records in memory without changing other offline queues', async () => {
    const storage = createMemoryStorage();
    const client = new QueryClient();
    const config: AccountQueriesConfig = {
      roots: [],
      mutationKeys: [
        ['app', 'offline'],
        ['app', 'private'],
      ],
      memoryOnlyMutationKeys: [['app', 'private']],
    };
    const shared = attachQueryPersistence(client, storage, config);
    await shared.restored;
    const account = mount(client, storage, config);
    account.activate('alice');
    await until(account);
    const privateMutation = pausedMutation(client, ['app', 'private']);
    const completed = client.getMutationCache().build(client, {
      mutationKey: ['app', 'private'],
      mutationFn: async (body: string) => `saved ${body}`,
    });
    await completed.execute('synthetic-private-draft');
    pausedMutation(client, ['app', 'offline']);
    const unrelated = pausedMutation(client, ['app', 'shared']);
    await flushWrites();

    expect(await storage.getItem(blobKey('alice'))).not.toContain('private');
    expect(await storage.getItem(blobKey('alice'))).toContain('offline');
    expect(await storage.getItem('oxy_query_cache_v3')).not.toContain('private');
    expect(await storage.getItem('oxy_query_cache_v3')).not.toContain('synthetic-private-draft');
    expect(await storage.getItem('oxy_query_cache_v3')).toContain('shared');
    account.activate('bob');
    expect(client.getMutationCache().getAll()).not.toContain(privateMutation);
    expect(client.getMutationCache().getAll()).toContain(unrelated);
    await until(account);
    account.activate('alice');
    await until(account);
    expect(
      client
        .getMutationCache()
        .getAll()
        .map((m) => m.options.mutationKey),
    ).toEqual([
      ['app', 'shared'],
      ['app', 'offline'],
    ]);
    account.detach();
    shared.unsubscribe();
  });

  it('does not restore newly memory-only mutation keys from either legacy blob', async () => {
    const storage = createMemoryStorage();
    const previous = new QueryClient();
    const shared = attachQueryPersistence(previous, storage);
    await shared.restored;
    pausedMutation(previous, ['app', 'private']);
    pausedMutation(previous, ['app', 'shared']);
    await flushWrites();
    shared.unsubscribe();
    const oldAccount = mount(previous, storage, { roots: [], mutationKeys: [['app', 'private']] });
    oldAccount.activate('alice');
    await until(oldAccount);
    pausedMutation(previous, ['app', 'private']);
    await flushWrites();
    expect(await storage.getItem(blobKey('alice'))).toContain('private');
    oldAccount.detach();

    const client = new QueryClient();
    const config: AccountQueriesConfig = {
      roots: [],
      memoryOnlyMutationKeys: [['app', 'private']],
    };
    const currentShared = attachQueryPersistence(client, storage, config);
    await currentShared.restored;
    const currentAccount = mount(client, storage, config);
    currentAccount.activate('alice');
    await until(currentAccount);
    expect(
      client
        .getMutationCache()
        .getAll()
        .map((m) => m.options.mutationKey),
    ).toEqual([['app', 'shared']]);
    currentAccount.detach();
    currentShared.unsubscribe();
  });

  it('does not cancel an in-flight mutation callback when removing its cache record', async () => {
    const storage = createMemoryStorage();
    const client = new QueryClient();
    const persistence = mount(client, storage, { roots: [], clearUnregisteredMutations: true });
    persistence.activate('alice');
    await until(persistence);
    let resolve!: () => void;
    const response = new Promise<void>((done) => {
      resolve = done;
    });
    const onSuccess = jest.fn();
    const mutation = client.getMutationCache().build(client, {
      mutationFn: () => response,
      onSuccess,
    });
    const execution = mutation.execute(undefined);
    persistence.activate('bob');
    expect(client.getMutationCache().getAll()).not.toContain(mutation);
    resolve();
    await execution;
    expect(onSuccess).toHaveBeenCalledTimes(1);
    persistence.detach();
  });

  it('can preserve explicitly marked account queries without persisting other data', async () => {
    const storage = createMemoryStorage();
    const client = new QueryClient();
    const persistence = mount(client, storage, {
      roots: [],
      memoryOnlyRoots: 'all',
      persistMarkedQueries: true,
    });
    persistence.activate('alice');
    await until(persistence);
    client.setQueryDefaults(['feedPreferences'], { meta: { persist: 'account' } });
    client.setQueryDefaults(['assetDownloadUrls'], { meta: { persist: 'account' } });
    client.setQueryData(['feedPreferences', 'alice'], 'alice pinned');
    client.setQueryData(['feed'], 'alice feed');
    client.setQueryData(['assetDownloadUrls'], 'signed URL');
    await flushWrites();

    const blob = (await storage.getItem(blobKey('alice'))) ?? '';
    expect(blob).toContain('alice pinned');
    expect(blob).not.toContain('alice feed');
    expect(blob).not.toContain('signed URL');
    persistence.activate('bob');
    expect(client.getQueryData(['feedPreferences', 'alice'])).toBeUndefined();
    await until(persistence);
    persistence.activate('alice');
    await until(persistence);
    expect(client.getQueryData(['feedPreferences', 'alice'])).toBe('alice pinned');
    expect(client.getQueryData(['feed'])).toBeUndefined();
    persistence.detach();
  });

  it('restores the signed-in account, and is not ready until it has', async () => {
    const storage = createMemoryStorage();
    await writeFor(storage, 'alice', (c) => c.setQueryData(THREAD, { messages: ['hi alice'] }));

    const client = new QueryClient();
    const persistence = mount(client, null);
    persistence.activate('alice');
    expect(persistence.isReady()).toBe(false);
    persistence.setStorage(storage);
    await until(persistence);

    expect(client.getQueryData(THREAD)).toEqual({ messages: ['hi alice'] });
  });

  it("never shows the previous account's rows after a switch", async () => {
    const storage = createMemoryStorage();
    const client = new QueryClient();
    const persistence = mount(client, storage);
    persistence.activate('alice');
    await until(persistence);
    client.setQueryData(THREAD, { messages: ['hi alice'] });
    client.setQueryData(['accounts'], ['device-level']);
    client.setQueryData(['search', 'q'], ['alice result']);
    await flushWrites();
    const aliceBlob = (await storage.getItem(blobKey('alice'))) ?? '';
    expect(aliceBlob).toContain('hi alice');
    expect(aliceBlob).not.toContain('alice result');

    persistence.activate('bob');
    // Synchronous: nothing woken by the switch can read Alice's data.
    expect(client.getQueryData(THREAD)).toBeUndefined();
    expect(client.getQueryData(['search', 'q'])).toBeUndefined();
    expect(client.getQueryData(['accounts'])).toEqual(['device-level']);
    expect(persistence.isReady()).toBe(false);
    await until(persistence);
    expect(client.getQueryData(THREAD)).toBeUndefined();
    // Alice's cache stays for her next offline start.
    expect(await storage.getItem(blobKey('alice'))).not.toBeNull();
  });

  it("keeps the leaving account's latest change, written inside the throttle", async () => {
    const storage = createMemoryStorage();
    const client = new QueryClient();
    const persistence = mount(client, storage);
    persistence.activate('alice');
    await until(persistence);
    client.setQueryData(THREAD, { messages: ['newest'] });
    persistence.activate('bob'); // before the throttled write
    await until(persistence);
    persistence.activate('alice');
    await until(persistence);

    expect(client.getQueryData(THREAD)).toEqual({ messages: ['newest'] });
  });

  it("drops queries another build wrote, but keeps that build's queued actions", async () => {
    const storage = createMemoryStorage();
    await writeFor(storage, 'alice', (c) => {
      c.setQueryData(THREAD, ['an old shape']);
      pausedMutation(c, ['app', 'star']);
      c.setQueryData(['thread', 'poke'], 1); // trigger a write
    });

    process.env.OXY_BUILD_ID = 'build-2';
    const client = new QueryClient();
    const persistence = mount(client, storage);
    persistence.activate('alice');
    await until(persistence);

    expect(client.getQueryData(THREAD)).toBeUndefined();
    expect(
      client
        .getMutationCache()
        .getAll()
        .map((m) => m.options.mutationKey),
    ).toEqual([['app', 'star']]);
  });

  it("deletes the signed-out account's cache", async () => {
    const storage = createMemoryStorage();
    const client = new QueryClient();
    const persistence = mount(client, storage);
    persistence.activate('alice');
    await until(persistence);
    client.setQueryData(THREAD, { messages: ['hi alice'] });
    await flushWrites();
    expect(await storage.getItem(blobKey('alice'))).not.toBeNull();

    persistence.activate(null);
    expect(persistence.isReady()).toBe(true);
    expect(client.getQueryData(THREAD)).toBeUndefined();
    await flushWrites();
    expect(await storage.getItem(blobKey('alice'))).toBeNull();
  });

  it('deletes it even when the sign-out came before storage was ready', async () => {
    const storage = createMemoryStorage();
    await writeFor(storage, 'alice', (c) => c.setQueryData(THREAD, { messages: ['hi alice'] }));

    const client = new QueryClient();
    const persistence = mount(client, null);
    persistence.activate('alice');
    persistence.activate(null);
    persistence.setStorage(storage);
    await settle();

    expect(await storage.getItem(blobKey('alice'))).toBeNull();
  });

  it('never hydrates a restore that finishes after its account was left', async () => {
    const storage = createMemoryStorage();
    await writeFor(storage, 'alice', (c) => c.setQueryData(THREAD, { messages: ['hi alice'] }));

    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const slow: StorageInterface = {
      ...storage,
      getItem: async (key) => {
        const value = await storage.getItem(key);
        await gate;
        return value;
      },
    };
    const client = new QueryClient();
    const seen: unknown[] = [];
    client.getQueryCache().subscribe((event) => {
      if (event.query.queryKey[0] === 'thread') seen.push(event.query.state.data);
    });
    const persistence = mount(client, slow);
    persistence.activate('alice');
    await settle();
    persistence.activate('bob');
    release();
    await until(persistence);
    await settle();

    expect(seen).toEqual([]);
    expect(client.getQueryData(THREAD)).toBeUndefined();
  });

  it('stops writing once detached', async () => {
    const storage = createMemoryStorage();
    const client = new QueryClient();
    const persistence = mount(client, storage);
    persistence.activate('alice');
    await until(persistence);
    persistence.detach();
    client.setQueryData(THREAD, { messages: ['after unmount'] });
    await flushWrites();

    expect((await storage.getItem(blobKey('alice'))) ?? '').not.toContain('after unmount');
  });

  it('keeps account rows and mutations out of the shared cache, even under an SDK root', async () => {
    const storage = createMemoryStorage();
    const client = new QueryClient();
    const config: AccountQueriesConfig = { roots: ['privacy'], mutationKeys: [['app', 'star']] };
    const shared = attachQueryPersistence(client, storage, config);
    await shared.restored;
    const persistence = mount(client, storage, config);
    persistence.activate('alice');
    await until(persistence);

    client.setQueryData(['privacy', 'settings'], ['alice private']);
    client.setQueryData(['users', 'u1'], ['public profile']);
    pausedMutation(client, ['app', 'star']);
    pausedMutation(client, ['other']);
    client.setQueryData(['users', 'poke'], 1); // trigger a write
    await flushWrites();

    const sharedBlob = JSON.parse((await storage.getItem('oxy_query_cache_v3')) ?? '{}');
    const accountBlob = JSON.parse((await storage.getItem(blobKey('alice'))) ?? '{}');
    const keys = (blob: { clientState?: { mutations?: { mutationKey: unknown }[] } }) =>
      (blob.clientState?.mutations ?? []).map((m) => m.mutationKey);
    expect(JSON.stringify(sharedBlob)).not.toContain('alice private');
    expect(JSON.stringify(sharedBlob)).toContain('public profile');
    expect(JSON.stringify(accountBlob)).toContain('alice private');
    expect(keys(sharedBlob)).toEqual([['other']]);
    expect(keys(accountBlob)).toEqual([['app', 'star']]);
    shared.unsubscribe();
    persistence.detach();
  });

  it("keeps a query marked persist: 'account' with no declared root, and only that one", async () => {
    const storage = createMemoryStorage();
    const prefs = ['viewer', 'alice', 'prefs'];
    const meta = { persist: 'account' };
    await writeFor(storage, 'alice', async (c) => {
      await c.fetchQuery({ queryKey: prefs, queryFn: async () => ['tabs'], meta });
      c.setQueryData(['viewer', 'alice', 'feed'], ['a post']);
    });
    expect(await storage.getItem(blobKey('alice'))).not.toContain('a post');

    const client = new QueryClient();
    const persistence = mount(client, storage, { roots: [] });
    persistence.activate('alice');
    await persistence.whenReady();
    expect(client.getQueryData(prefs)).toEqual(['tabs']);

    persistence.activate('bob');
    expect(client.getQueryData(prefs)).toBeUndefined();
    persistence.detach();
  });

  it('writes nothing while only queries it does not keep change', async () => {
    const storage = createMemoryStorage();
    const setItem = jest.spyOn(storage, 'setItem');
    const client = new QueryClient();
    const persistence = mount(client, storage);
    persistence.activate('alice');
    await persistence.whenReady();
    client.setQueryData(['feed', 'home'], ['a post']);
    await flushWrites();

    expect(setItem).not.toHaveBeenCalled();
    persistence.detach();
  });

  it('becomes ready when the stored cache cannot be read', async () => {
    const storage: StorageInterface = {
      ...createMemoryStorage(),
      getItem: () => Promise.reject(new Error('unreadable')),
    };
    const persistence = mount(new QueryClient(), storage);
    persistence.activate('alice');
    await persistence.whenReady();

    expect(persistence.isReady()).toBe(true);
    persistence.detach();
  });

  it("with roots 'all', owns every app query but not the SDK's device-level ones", async () => {
    const storage = createMemoryStorage();
    const client = new QueryClient();
    const persistence = mount(client, storage, { roots: 'all', memoryOnlyRoots: ['search'] });
    persistence.activate('alice');
    await until(persistence);
    client.setQueryData(['library', 'liked'], ['alice track']);
    client.setQueryData(['search', 'q'], ['alice result']);
    client.setQueryData(['users', 'suggestions'], ['alice suggestions']);
    client.setQueryData(['accounts'], ['device-level']);
    client.setQueryData(['assetDownloadUrls', 'f1'], ['signed url']);
    client.setQueryData(['avatarCropSource', 'f1'], ['signed crop url']);
    await flushWrites();

    const blob = (await storage.getItem(blobKey('alice'))) ?? '';
    expect(blob).toContain('alice track');
    for (const absent of ['alice result', 'device-level', 'signed url', 'signed crop url']) {
      expect(blob).not.toContain(absent);
    }

    persistence.activate('bob');
    expect(client.getQueryData(['library', 'liked'])).toBeUndefined();
    expect(client.getQueryData(['search', 'q'])).toBeUndefined();
    expect(client.getQueryData(['users', 'suggestions'])).toBeUndefined();
    expect(client.getQueryData(['accounts'])).toEqual(['device-level']);
    persistence.detach();
  });
});
