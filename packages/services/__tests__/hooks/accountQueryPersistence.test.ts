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
  write: (client: QueryClient) => void,
) {
  const client = new QueryClient();
  const persistence = mount(client, storage);
  persistence.activate(accountId);
  await until(persistence);
  write(client);
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
