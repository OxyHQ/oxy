import { createExperimentalLogoutTombstones } from '../experimentalLogoutTombstone';
import { AUTH_STATE_STORAGE_KEY, type NativeKeyValueStorage } from '../authStateStore';

const oldLogin = 'a'.repeat(32);
const newLogin = 'b'.repeat(32);

it('marks an old incarnation without deleting a concurrent new login', async () => {
  const values = new Map<string, string>();
  let unblock!: () => void;
  let started!: () => void;
  const entered = new Promise<void>((resolve) => {
    started = resolve;
  });
  const wait = new Promise<void>((resolve) => {
    unblock = resolve;
  });
  const removeItem = jest.fn(async (key: string) => {
    values.delete(key);
  });
  const storage: NativeKeyValueStorage = {
    getItem: async (key) => values.get(key) ?? null,
    setItem: async (key, value) => {
      if (key.endsWith(oldLogin)) {
        started();
        await wait;
      }
      values.set(key, value);
    },
    removeItem,
  };
  const first = createExperimentalLogoutTombstones(storage);
  const second = createExperimentalLogoutTombstones(storage);
  const pending = first.mark(oldLogin);
  await entered;
  await storage.setItem(
    AUTH_STATE_STORAGE_KEY,
    JSON.stringify({ incarnation: newLogin, deviceSecret: 'new-holder' }),
  );
  unblock();
  expect(await pending).toBe(true);
  expect(await first.status(oldLogin)).toBe('marked');
  expect(await second.status(newLogin)).toBe('unmarked');
  expect(JSON.parse(values.get(AUTH_STATE_STORAGE_KEY) ?? '{}').incarnation).toBe(newLogin);
  expect(removeItem).not.toHaveBeenCalled();
});

it('refuses unverifiable writes and reports unreadable markers as unknown', async () => {
  const silent: NativeKeyValueStorage = {
    getItem: async () => null,
    setItem: async () => {},
    removeItem: async () => {},
  };
  expect(await createExperimentalLogoutTombstones(silent).mark(oldLogin)).toBe(false);
  const locked = {
    ...silent,
    getItem: async () => {
      throw new Error('locked');
    },
  };
  expect(await createExperimentalLogoutTombstones(locked).status(oldLogin)).toBe('unknown');
});

it('treats reused incarnation ids as the same logout and rejects malformed identifiers', async () => {
  const values = new Map<string, string>();
  const storage: NativeKeyValueStorage = {
    getItem: async (key) => values.get(key) ?? null,
    setItem: async (key, value) => {
      values.set(key, value);
    },
    removeItem: async (key) => {
      values.delete(key);
    },
  };
  const markers = createExperimentalLogoutTombstones(storage);
  expect(await markers.mark(oldLogin)).toBe(true);
  expect(await markers.status(oldLogin)).toBe('marked');
  await expect(markers.mark('credential-secret')).rejects.toThrow('Invalid login incarnation');
});
