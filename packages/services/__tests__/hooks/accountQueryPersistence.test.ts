import { QueryClient } from '@tanstack/react-query';
import {
  ACCOUNT_QUERY_CACHE_KEY,
  createAccountQueryPersistence,
  type AccountQueryPersistence,
} from '../../src/ui/hooks/accountQueryPersistence';
import { attachQueryPersistence } from '../../src/ui/hooks/queryClient';
import { createMemoryStorage, type StorageInterface } from '../../src/ui/utils/storageHelpers';

const CONFIG = { roots: ['thread'], memoryOnlyRoots: ['search'], mutationKeys: [['app', 'star']] };
const THREAD = ['thread', 'm1'];

// The persister writes behind a 1s throttle.
const flushWrites = () => new Promise((resolve) => setTimeout(resolve, 1_100));

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

async function writeFor(storage: StorageInterface, accountId: string, data: unknown): Promise<void> {
  const client = new QueryClient();
  const persistence = createAccountQueryPersistence(client, CONFIG);
  persistence.setStorage(storage);
  persistence.activate(accountId);
  await until(persistence);
  client.setQueryData(THREAD, data);
  await flushWrites();
  persistence.dispose();
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
    await writeFor(storage, 'alice', { messages: ['hi alice'] });

    const client = new QueryClient();
    const persistence = createAccountQueryPersistence(client, CONFIG);
    persistence.activate('alice');
    expect(persistence.isReady()).toBe(false);
    persistence.setStorage(storage);
    await until(persistence);

    expect(client.getQueryData(THREAD)).toEqual({ messages: ['hi alice'] });
  });

  it("never shows the previous account's rows after a switch", async () => {
    const storage = createMemoryStorage();
    await writeFor(storage, 'alice', { messages: ['hi alice'] });

    const client = new QueryClient();
    const persistence = createAccountQueryPersistence(client, CONFIG);
    persistence.setStorage(storage);
    persistence.activate('alice');
    await until(persistence);
    client.setQueryData(['accounts'], ['not account-scoped']);
    client.setQueryData(['search', 'q'], ['alice result']);
    await flushWrites();
    const aliceBlob = (await storage.getItem(`${ACCOUNT_QUERY_CACHE_KEY}:alice`)) ?? '';
    expect(aliceBlob).toContain('hi alice');
    expect(aliceBlob).not.toContain('alice result');

    persistence.activate('bob');
    // Synchronous: nothing woken by the switch can read Alice's data.
    expect(client.getQueryData(THREAD)).toBeUndefined();
    expect(client.getQueryData(['search', 'q'])).toBeUndefined();
    expect(client.getQueryData(['accounts'])).toEqual(['not account-scoped']);
    expect(persistence.isReady()).toBe(false);
    await until(persistence);
    expect(client.getQueryData(THREAD)).toBeUndefined();
    // Alice's cache stays for her next offline start.
    expect(await storage.getItem(`${ACCOUNT_QUERY_CACHE_KEY}:alice`)).not.toBeNull();
  });

  it('discards a cache written by another build', async () => {
    const storage = createMemoryStorage();
    await writeFor(storage, 'alice', ['an old shape']);

    process.env.OXY_BUILD_ID = 'build-2';
    const client = new QueryClient();
    const persistence = createAccountQueryPersistence(client, CONFIG);
    persistence.setStorage(storage);
    persistence.activate('alice');
    await until(persistence);

    expect(client.getQueryData(THREAD)).toBeUndefined();
  });

  it("deletes the signed-out account's cache", async () => {
    const storage = createMemoryStorage();
    const client = new QueryClient();
    const persistence = createAccountQueryPersistence(client, CONFIG);
    persistence.setStorage(storage);
    persistence.activate('alice');
    await until(persistence);
    client.setQueryData(THREAD, { messages: ['hi alice'] });
    await flushWrites();
    expect(await storage.getItem(`${ACCOUNT_QUERY_CACHE_KEY}:alice`)).not.toBeNull();

    persistence.activate(null);
    expect(persistence.isReady()).toBe(true);
    expect(client.getQueryData(THREAD)).toBeUndefined();
    await flushWrites();
    expect(await storage.getItem(`${ACCOUNT_QUERY_CACHE_KEY}:alice`)).toBeNull();
  });

  it('keeps account mutations out of the shared cache and in the account one', async () => {
    const storage = createMemoryStorage();
    const client = new QueryClient();
    const shared = attachQueryPersistence(client, storage, CONFIG.mutationKeys);
    await shared.restored;
    const persistence = createAccountQueryPersistence(client, CONFIG);
    persistence.setStorage(storage);
    persistence.activate('alice');
    await until(persistence);

    const cache = client.getMutationCache();
    for (const mutationKey of [['app', 'star'], ['other']]) {
      const mutation = cache.build(client, { mutationKey, mutationFn: async () => undefined });
      mutation.state.isPaused = true;
      client.setQueryData(['accounts'], [mutationKey.join('.')]); // any change triggers a write
    }
    await flushWrites();

    const keysIn = async (key: string) => {
      const blob = JSON.parse((await storage.getItem(key)) ?? '{}');
      return (blob.clientState?.mutations ?? []).map((m: { mutationKey: unknown }) => m.mutationKey);
    };
    expect(await keysIn('oxy_query_cache_v3')).toEqual([['other']]);
    expect(await keysIn(`${ACCOUNT_QUERY_CACHE_KEY}:alice`)).toEqual([['app', 'star']]);
    shared.unsubscribe();
    persistence.dispose();
  });

  it("with roots 'all', owns every app query but not the SDK's own", async () => {
    const storage = createMemoryStorage();
    const client = new QueryClient();
    const persistence = createAccountQueryPersistence(client, { roots: 'all', memoryOnlyRoots: ['search'] });
    persistence.setStorage(storage);
    persistence.activate('alice');
    await until(persistence);
    client.setQueryData(['library', 'liked'], ['alice track']);
    client.setQueryData(['search', 'q'], ['alice result']);
    client.setQueryData(['accounts'], ['sdk data']);
    client.setQueryData(['assetDownloadUrls', 'f1'], ['signed url']);
    await flushWrites();

    const blob = (await storage.getItem(`${ACCOUNT_QUERY_CACHE_KEY}:alice`)) ?? '';
    expect(blob).toContain('alice track');
    expect(blob).not.toContain('alice result');
    expect(blob).not.toContain('sdk data');
    expect(blob).not.toContain('signed url');

    persistence.activate('bob');
    expect(client.getQueryData(['library', 'liked'])).toBeUndefined();
    expect(client.getQueryData(['search', 'q'])).toBeUndefined();
    expect(client.getQueryData(['accounts'])).toEqual(['sdk data']);
    persistence.dispose();
  });
});
