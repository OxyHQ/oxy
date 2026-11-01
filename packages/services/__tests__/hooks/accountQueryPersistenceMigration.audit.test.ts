/**
 * Diagnostic coverage of existing hazards, not desired persistence guarantees.
 * Reverse these assertions when a compatible migration protocol is implemented.
 * Storage and account identities here are synthetic.
 */
import { QueryClient } from '@tanstack/react-query';
import {
  accountQueryOwnership,
  createAccountQueryPersistence,
  type AccountQueriesConfig,
} from '../../src/ui/hooks/accountQueryPersistence';
import { snapshot } from '../../src/ui/hooks/persistedQueryCache';
import {
  createMemoryStorage,
  createPlatformStorage,
  type StorageInterface,
} from '../../src/ui/utils/storageHelpers';

const key = 'oxy_account_queries:alice';
const oldConfig: AccountQueriesConfig = { roots: ['saved-searches', 'mailboxes'] };
const newConfig: AccountQueriesConfig = {
  roots: ['mailboxes'],
  memoryOnlyRoots: ['saved-searches'],
};

function signal() {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve: () => resolve() };
}

function syntheticStorage(initial: string) {
  const base = createMemoryStorage();
  let nextWrite = signal();
  let nextRemoval = signal();
  const storage: StorageInterface = {
    ...base,
    async setItem(k, value) {
      await base.setItem(k, value);
      const completed = nextWrite;
      nextWrite = signal();
      completed.resolve();
    },
    async removeItem(k) {
      await base.removeItem(k);
      const completed = nextRemoval;
      nextRemoval = signal();
      completed.resolve();
    },
  };
  return {
    storage,
    base,
    seed: () => base.setItem(key, initial),
    written: () => nextWrite.promise,
    removed: () => nextRemoval.promise,
  };
}

function seed(): string {
  const client = new QueryClient();
  client.setQueryData(['saved-searches'], ['synthetic-legacy-search']);
  client.setQueryData(['mailboxes'], ['synthetic-original-mailbox']);
  const ownership = accountQueryOwnership(oldConfig);
  const blob = snapshot(client, {
    persistsQuery: ownership.persistsQuery,
    shouldDehydrateMutation: () => false,
  });
  client.clear();
  return blob;
}

function mount(storage: StorageInterface, config: AccountQueriesConfig) {
  const client = new QueryClient();
  const persistence = createAccountQueryPersistence(client, config);
  persistence.setStorage(storage);
  persistence.attach();
  persistence.activate('alice');
  return { client, persistence };
}

describe('account cache migration: current limitations', () => {
  it('documents that the web adapter hides localStorage failures', async () => {
    const fail = () => {
      throw new Error('synthetic storage failure');
    };
    const get = jest.spyOn(Storage.prototype, 'getItem').mockImplementation(fail);
    const set = jest.spyOn(Storage.prototype, 'setItem').mockImplementation(fail);
    const remove = jest.spyOn(Storage.prototype, 'removeItem').mockImplementation(fail);
    try {
      const storage = await createPlatformStorage();
      await expect(storage.getItem('synthetic')).resolves.toBeNull();
      await expect(storage.setItem('synthetic', 'value')).resolves.toBeUndefined();
      await expect(storage.removeItem('synthetic')).resolves.toBeUndefined();
      expect(get).toHaveBeenCalled();
      expect(set).toHaveBeenCalled();
      expect(remove).toHaveBeenCalled();
    } finally {
      get.mockRestore();
      set.mockRestore();
      remove.mockRestore();
    }
  });
  it('documents that a changed filter can overwrite an un-restored root', async () => {
    const fixture = syntheticStorage(seed());
    await fixture.seed();
    const owner = mount(fixture.storage, newConfig);
    await owner.persistence.whenReady();
    expect(owner.client.getQueryData(['saved-searches'])).toBeUndefined();
    expect(owner.client.getQueryData(['mailboxes'])).toEqual(['synthetic-original-mailbox']);
    owner.client.setQueryData(['mailboxes'], ['synthetic-new-mailbox']);
    const written = fixture.written();
    owner.persistence.detach();
    await written;
    const blob = await fixture.base.getItem(key);
    expect(blob).toContain('synthetic-new-mailbox');
    expect(blob).not.toContain('synthetic-legacy-search');
    owner.client.clear();
  });

  it('documents that a failed read can be followed by overwriting the unread blob', async () => {
    const fixture = syntheticStorage(seed());
    await fixture.seed();
    let failed = false;
    const storage: StorageInterface = {
      ...fixture.storage,
      async getItem(k) {
        if (!failed) {
          failed = true;
          throw new Error('synthetic read failure');
        }
        return fixture.storage.getItem(k);
      },
    };
    const owner = mount(storage, oldConfig);
    await owner.persistence.whenReady();
    expect(owner.client.getQueryData(['saved-searches'])).toBeUndefined();
    owner.client.setQueryData(['mailboxes'], ['synthetic-new-mailbox']);
    const written = fixture.written();
    owner.persistence.detach();
    await written;
    expect(await fixture.base.getItem(key)).not.toContain('synthetic-legacy-search');
    owner.client.clear();
  });

  it('documents a second writer restoring a blob after another instance signs out', async () => {
    const fixture = syntheticStorage(seed());
    await fixture.seed();
    const a = mount(fixture.storage, oldConfig);
    const b = mount(fixture.storage, oldConfig);
    await Promise.all([a.persistence.whenReady(), b.persistence.whenReady()]);
    const removed = fixture.removed();
    a.persistence.activate(null);
    await removed;
    expect(await fixture.base.getItem(key)).toBeNull();
    const written = fixture.written();
    b.persistence.detach();
    await written;
    expect(await fixture.base.getItem(key)).toContain('synthetic-legacy-search');
    a.persistence.detach();
    a.client.clear();
    b.client.clear();
  });

  it('documents a stale writer replacing another instance’s newer root', async () => {
    const fixture = syntheticStorage(seed());
    await fixture.seed();
    const old = mount(fixture.storage, oldConfig);
    const next = mount(fixture.storage, newConfig);
    await Promise.all([old.persistence.whenReady(), next.persistence.whenReady()]);
    next.client.setQueryData(['mailboxes'], ['synthetic-new-mailbox']);
    let written = fixture.written();
    next.persistence.detach();
    await written;
    expect(await fixture.base.getItem(key)).toContain('synthetic-new-mailbox');
    written = fixture.written();
    old.persistence.detach();
    await written;
    const blob = await fixture.base.getItem(key);
    expect(blob).toContain('synthetic-original-mailbox');
    expect(blob).not.toContain('synthetic-new-mailbox');
    old.client.clear();
    next.client.clear();
  });
});
