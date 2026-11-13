import { QueryClient } from '@tanstack/react-query';
import {
  accountQueryOwnership,
  createAccountQueryPersistence,
} from '../../src/ui/hooks/accountQueryPersistence';
import { snapshot } from '../../src/ui/hooks/persistedQueryCache';
import { createPlatformStorage, type StorageInterface } from '../../src/ui/utils/storageHelpers';

const mockNativeStorage = {
  getItem: jest.fn(),
  setItem: jest.fn(),
  removeItem: jest.fn(),
  clear: jest.fn(),
};
jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: mockNativeStorage,
}));

const key = 'oxy_account_queries:alice';
const config = { roots: ['saved-searches'] };
function seed() {
  const client = new QueryClient();
  client.setQueryData(['saved-searches'], ['synthetic-prior']);
  const owner = accountQueryOwnership(config);
  const blob = snapshot(client, {
    persistsQuery: owner.persistsQuery,
    shouldDehydrateMutation: () => false,
  });
  client.clear();
  return blob;
}
function mount(storage: StorageInterface) {
  const client = new QueryClient();
  const persistence = createAccountQueryPersistence(client, config);
  persistence.setStorage(storage);
  persistence.attach();
  return { client, persistence };
}
function fixture() {
  const values = new Map([[key, seed()]]);
  let fail = true;
  const getItem = jest.fn(async (k: string) => {
    if (k === key && fail) throw new Error('synthetic read failure');
    return values.get(k) ?? null;
  });
  const setItem = jest.fn(async (k: string, value: string) => {
    values.set(k, value);
  });
  const removeItem = jest.fn(async (k: string) => {
    values.delete(k);
  });
  const storage: StorageInterface = {
    getItem,
    setItem,
    removeItem,
    clear: async () => values.clear(),
  };
  return {
    storage,
    values,
    getItem,
    setItem,
    removeItem,
    recover: () => {
      fail = false;
    },
  };
}

it('does not write after read failure across detach and restores after a later account transition', async () => {
  const f = fixture();
  const original = f.values.get(key);
  const { client, persistence } = mount(f.storage);
  persistence.activate('alice');
  await persistence.whenReady();
  expect(persistence.isReadFailed()).toBe(true);
  expect(client.getQueryData(['saved-searches'])).toBeUndefined();
  client.setQueryData(['saved-searches'], ['synthetic-new']);
  persistence.detach();
  persistence.attach();
  await persistence.whenReady();
  expect(persistence.isReadFailed()).toBe(true);
  expect(f.getItem).toHaveBeenCalledTimes(1);
  persistence.activate('bob');
  await persistence.whenReady();
  expect(f.values.get(key)).toBe(original);
  expect(f.setItem).not.toHaveBeenCalled();
  f.recover();
  persistence.activate('alice');
  await persistence.whenReady();
  expect(persistence.isReadFailed()).toBe(false);
  expect(client.getQueryData(['saved-searches'])).toEqual(['synthetic-prior']);
  persistence.detach();
  client.clear();
});

it('keeps the sign-out deletion request even after a read failure', async () => {
  const f = fixture();
  let removed!: () => void;
  const done = new Promise<void>((resolve) => {
    removed = resolve;
  });
  const remove = f.storage.removeItem;
  f.storage.removeItem = async (k) => {
    await remove(k);
    removed();
  };
  const { client, persistence } = mount(f.storage);
  persistence.activate('alice');
  await persistence.whenReady();
  client.setQueryData(['saved-searches'], ['synthetic-new']);
  persistence.activate(null);
  await done;
  expect(f.setItem).not.toHaveBeenCalled();
  expect(f.values.has(key)).toBe(false);
  expect(persistence.isReadFailed()).toBe(false);
  persistence.detach();
  client.clear();
});

it('does not apply a late failed read to a different account', async () => {
  const f = fixture();
  let reject!: (error: Error) => void;
  let started!: () => void;
  const begun = new Promise<void>((resolve) => {
    started = resolve;
  });
  const get = f.storage.getItem;
  f.storage.getItem = (k) =>
    k === key
      ? new Promise((_resolve, fail) => {
          reject = fail;
          started();
        })
      : get(k);
  const { client, persistence } = mount(f.storage);
  persistence.activate('alice');
  await begun;
  persistence.activate('bob');
  reject(new Error('synthetic read failure'));
  await persistence.whenReady();
  expect(persistence.isReadFailed()).toBe(false);
  expect(client.getQueryData(['saved-searches'])).toBeUndefined();
  expect(f.values.has(key)).toBe(true);
  persistence.detach();
  client.clear();
});

it('detects a web localStorage read failure while preserving the legacy getItem contract', async () => {
  const get = jest.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
    throw new Error('synthetic denied read');
  });
  const set = jest.spyOn(Storage.prototype, 'setItem');
  try {
    const storage = await createPlatformStorage();
    expect(await storage.getItem('synthetic')).toBeNull();
    const { client, persistence } = mount(storage);
    persistence.activate('alice');
    await persistence.whenReady();
    expect(persistence.isReadFailed()).toBe(true);
    client.setQueryData(['saved-searches'], ['synthetic-new']);
    persistence.detach();
    await Promise.resolve();
    await Promise.resolve();
    expect(set).not.toHaveBeenCalled();
    client.clear();
  } finally {
    get.mockRestore();
    set.mockRestore();
  }
});

it('disables writes when the native AsyncStorage adapter reports a read error', async () => {
  const product = Object.getOwnPropertyDescriptor(navigator, 'product');
  Object.defineProperty(navigator, 'product', { value: 'ReactNative', configurable: true });
  mockNativeStorage.getItem.mockRejectedValue(new Error('synthetic native read failure'));
  try {
    const storage = await createPlatformStorage();
    const { client, persistence } = mount(storage);
    persistence.activate('alice');
    await persistence.whenReady();
    expect(persistence.isReadFailed()).toBe(true);
    client.setQueryData(['saved-searches'], ['synthetic-new']);
    persistence.detach();
    await Promise.resolve();
    expect(mockNativeStorage.setItem).not.toHaveBeenCalled();
    client.clear();
  } finally {
    if (product) Object.defineProperty(navigator, 'product', product);
    else Reflect.deleteProperty(navigator, 'product');
  }
});

it('shows why an unrestricted retry cannot distinguish queued copies of the same action', () => {
  const { hydrateSnapshot } = require('../../src/ui/hooks/persistedQueryCache');
  const old = new QueryClient();
  const key = ['app', 'synthetic-action'];
  const pending = old.getMutationCache().build(old, { mutationKey: key });
  pending.state = {
    ...pending.state,
    status: 'pending',
    isPaused: true,
    variables: { id: 'same' },
  };
  const blob = snapshot(old, {
    persistsQuery: () => false,
    shouldDehydrateMutation: (m) => m.state.isPaused,
  });
  const current = new QueryClient();
  const live = current.getMutationCache().build(current, { mutationKey: key });
  live.state = { ...live.state, status: 'pending', isPaused: true, variables: { id: 'same' } };
  expect(hydrateSnapshot(current, blob, 60_000)).toBe(true);
  expect(
    current
      .getMutationCache()
      .getAll()
      .map((m) => m.state.variables),
  ).toEqual([{ id: 'same' }, { id: 'same' }]);
  old.clear();
  current.clear();
});

it('does not imply deletion when the web adapter hides a sign-out remove failure', async () => {
  const synthetic = new Map([[key, seed()]]);
  let attempted!: () => void;
  const attemptedRemoval = new Promise<void>((resolve) => {
    attempted = resolve;
  });
  const get = jest.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
    throw new Error('synthetic read failure');
  });
  const remove = jest.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {
    attempted();
    throw new Error('synthetic remove failure');
  });
  try {
    const storage = await createPlatformStorage();
    const { client, persistence } = mount(storage);
    persistence.activate('alice');
    await persistence.whenReady();
    persistence.activate(null);
    await attemptedRemoval;
    expect(synthetic.has(key)).toBe(true);
    expect(remove).toHaveBeenCalledWith(key);
    persistence.detach();
    client.clear();
  } finally {
    get.mockRestore();
    remove.mockRestore();
  }
});

it('documents that switching after a failed read currently removes new paused mutations', async () => {
  const f = fixture();
  const client = new QueryClient();
  const mutationKey = ['app', 'synthetic-offline-action'];
  const persistence = createAccountQueryPersistence(client, {
    ...config,
    mutationKeys: [mutationKey],
  });
  persistence.setStorage(f.storage);
  persistence.attach();
  persistence.activate('alice');
  await persistence.whenReady();
  const mutation = client.getMutationCache().build(client, { mutationKey });
  mutation.state = {
    ...mutation.state,
    status: 'pending',
    isPaused: true,
    variables: { id: 'synthetic-action' },
  };
  expect(client.getMutationCache().getAll()).toContain(mutation);
  persistence.activate('bob');
  await persistence.whenReady();
  expect(client.getMutationCache().getAll()).not.toContain(mutation);
  expect(f.values.get(key)).not.toContain('synthetic-action');
  expect(f.setItem).not.toHaveBeenCalled();
  persistence.detach();
  client.clear();
});

it('audit: synchronous query-cache subscriber can switch owners during hydration', async () => {
  const old = new QueryClient();
  old.setQueryData(['saved-searches', 'first'], ['synthetic-A-first']);
  old.setQueryData(['saved-searches', 'second'], ['synthetic-A-second']);
  const ownership = accountQueryOwnership(config);
  const raw = snapshot(old, {
    persistsQuery: ownership.persistsQuery,
    shouldDehydrateMutation: () => false,
  });
  const values = new Map([[key, raw]]);
  const storage: StorageInterface = {
    getItem: async (k) => values.get(k) ?? null,
    setItem: async (k, v) => {
      values.set(k, v);
    },
    removeItem: async (k) => {
      values.delete(k);
    },
    clear: async () => {
      values.clear();
    },
  };
  const { client, persistence } = mount(storage);
  let switched = false;
  const off = client.getQueryCache().subscribe((event) => {
    if (!switched && event.type === 'added' && event.query.queryKey[1] === 'first') {
      switched = true;
      persistence.activate('bob');
    }
  });
  persistence.activate('alice');
  await new Promise<void>((resolve) => {
    const dispose = persistence.subscribe(() => {
      if (switched && persistence.isReady()) {
        dispose();
        resolve();
      }
    });
  });
  expect(switched).toBe(true);
  expect(client.getQueryData(['saved-searches', 'second'])).toEqual(['synthetic-A-second']);
  off();
  persistence.detach();
  client.clear();
  old.clear();
});
