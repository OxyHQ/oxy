import {
  createExperimentalDeviceNameIncarnation,
  createExperimentalScopedDeviceName,
} from '../experimentalScopedDeviceName';
import type { NativeKeyValueStorage } from '../authStateStore';

const alice = { actorId: 'alice', accountId: 'org', sessionId: 's-alice' };
const nate = { actorId: 'nate', accountId: 'org', sessionId: 's-nate' };
const aliceIncarnation = 'a'.repeat(32);
const nateIncarnation = 'b'.repeat(32);

it('uses the provided cryptographic source and refuses an unavailable one', () => {
  const source = {
    getRandomValues: jest.fn((bytes: Uint8Array) => {
      bytes.forEach((_value, index) => {
        bytes[index] = index;
      });
      return bytes;
    }),
  } as unknown as Pick<Crypto, 'getRandomValues'>;
  expect(createExperimentalDeviceNameIncarnation(source)).toBe('000102030405060708090a0b0c0d0e0f');
  expect(source.getRandomValues).toHaveBeenCalledTimes(1);
  expect(() => createExperimentalDeviceNameIncarnation(null)).toThrow(
    'Secure randomness unavailable',
  );
});

it('keeps a newer owner name when an old instance completes its write late', async () => {
  const values = new Map([['oxy_device_info', 'legacy-device-info']]);
  let unblock!: () => void;
  let started!: () => void;
  const entered = new Promise<void>((resolve) => {
    started = resolve;
  });
  const wait = new Promise<void>((resolve) => {
    unblock = resolve;
  });
  const storage: NativeKeyValueStorage = {
    getItem: async (key) => values.get(key) ?? null,
    setItem: async (key, value) => {
      if (key.endsWith(aliceIncarnation)) {
        started();
        await wait;
      }
      values.set(key, value);
    },
    removeItem: async (key) => {
      values.delete(key);
    },
  };
  let current = 'alice';
  const old = createExperimentalScopedDeviceName(
    storage,
    alice,
    aliceIncarnation,
    () => current === 'alice',
  );
  const next = createExperimentalScopedDeviceName(
    storage,
    nate,
    nateIncarnation,
    () => current === 'nate',
  );
  const pending = old.write('Old actor name');
  await entered;
  current = 'nate';
  expect(await next.write('New actor name')).toBe('written');
  unblock();
  expect(await pending).toBe('superseded');
  expect(await old.read()).toBeNull();
  expect(await next.read()).toBe('New actor name');
  expect(values.get('oxy_device_info')).toBe('legacy-device-info');
});

it('baseline: reusing an incarnation allows a late old writer to overwrite the new record', async () => {
  const values = new Map<string, string>();
  let unblock!: () => void;
  let started!: () => void;
  const entered = new Promise<void>((resolve) => {
    started = resolve;
  });
  const wait = new Promise<void>((resolve) => {
    unblock = resolve;
  });
  let firstWrite = true;
  const storage: NativeKeyValueStorage = {
    getItem: async (key) => values.get(key) ?? null,
    setItem: async (key, value) => {
      if (firstWrite) {
        firstWrite = false;
        started();
        await wait;
      }
      values.set(key, value);
    },
    removeItem: async (key) => {
      values.delete(key);
    },
  };
  let current = 'alice';
  const old = createExperimentalScopedDeviceName(
    storage,
    alice,
    aliceIncarnation,
    () => current === 'alice',
  );
  const next = createExperimentalScopedDeviceName(
    storage,
    nate,
    aliceIncarnation,
    () => current === 'nate',
  );
  const pending = old.write('Old actor name');
  await entered;
  current = 'nate';
  expect(await next.write('New actor name')).toBe('written');
  unblock();
  expect(await pending).toBe('superseded');
  expect(await next.read()).toBeNull();
});

it('rejects wrong scopes, unreadable data and unverified writes', async () => {
  const storage: NativeKeyValueStorage = {
    getItem: async () => null,
    setItem: async () => {},
    removeItem: async () => {},
  };
  expect(() => createExperimentalScopedDeviceName(storage, alice, 'bad', () => true)).toThrow();
  const scoped = createExperimentalScopedDeviceName(storage, alice, aliceIncarnation, () => true);
  expect(await scoped.write('Name')).toBe('storage_error');
  expect(await scoped.read()).toBeNull();
});

it('does not return an old owner name after a delayed read crosses a transition', async () => {
  const key = `oxy.device-name.v1.${aliceIncarnation}`;
  const raw = JSON.stringify({ version: 1, owner: alice, deviceName: 'Old actor name' });
  let unblock!: () => void;
  let started!: () => void;
  const entered = new Promise<void>((resolve) => {
    started = resolve;
  });
  const wait = new Promise<void>((resolve) => {
    unblock = resolve;
  });
  const storage: NativeKeyValueStorage = {
    getItem: async (actual) => {
      started();
      await wait;
      return actual === key ? raw : null;
    },
    setItem: async () => {},
    removeItem: async () => {},
  };
  let current = true;
  const scoped = createExperimentalScopedDeviceName(
    storage,
    alice,
    aliceIncarnation,
    () => current,
  );
  const pending = scoped.read();
  await entered;
  current = false;
  unblock();
  expect(await pending).toBeNull();
});
