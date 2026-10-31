import { createExperimentalBoundDeviceName } from '../experimentalBoundDeviceName';
import type { NativeKeyValueStorage } from '../authStateStore';

const alice = {
  deviceSessionId: 'incarnation',
  revision: 1,
  contextId: 'ctx-alice',
  actorId: 'alice',
  accountId: 'org',
  sessionId: 's-alice',
};
const nate = { ...alice, revision: 2, contextId: 'ctx-nate', actorId: 'nate', sessionId: 's-nate' };

function memory() {
  const values = new Map<string, string>([['oxy_device_info', 'legacy']]);
  const storage: NativeKeyValueStorage = {
    getItem: async (key) => values.get(key) ?? null,
    setItem: async (key, value) => {
      values.set(key, value);
    },
    removeItem: async (key) => {
      values.delete(key);
    },
  };
  return { values, storage };
}

it('recovers the same verified binding without a mutable current pointer', async () => {
  const { values, storage } = memory();
  const extended = { ...alice, fixtureBearer: 'fixture-bearer' };
  const first = createExperimentalBoundDeviceName(storage, extended, () => true);
  expect(await first.write('Desk')).toBe('written');
  const restarted = createExperimentalBoundDeviceName(storage, alice, () => true);
  expect(await restarted.read()).toBe('Desk');
  const keys = [...values.keys()].filter((key) => key !== 'oxy_device_info');
  expect(keys).toHaveLength(1);
  expect(keys[0]).toMatch(/^oxy\.device-name\.v2\.[a-f0-9]{64}$/);
  expect(keys[0]).not.toContain('fixture-bearer');
  expect([...values.values()].join(' ')).not.toContain('fixture-bearer');
  expect(values.get('oxy_device_info')).toBe('legacy');
});

it('isolates an old owner write and a same-actor ABA at a later revision', async () => {
  const { values, storage: base } = memory();
  let release!: () => void;
  let observed!: () => void;
  const started = new Promise<void>((resolve) => {
    observed = resolve;
  });
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  let first = true;
  const storage: NativeKeyValueStorage = {
    ...base,
    setItem: async (key, value) => {
      if (first) {
        first = false;
        observed();
        await wait;
      }
      await base.setItem(key, value);
    },
  };
  let revision = 1;
  const old = createExperimentalBoundDeviceName(storage, alice, () => revision === 1);
  const next = createExperimentalBoundDeviceName(storage, nate, () => revision === 2);
  const again = createExperimentalBoundDeviceName(
    storage,
    { ...alice, revision: 3 },
    () => revision === 3,
  );
  const pending = old.write('Old name');
  await started;
  revision = 2;
  expect(await next.write('Nate name')).toBe('written');
  revision = 3;
  expect(await again.write('Alice new name')).toBe('written');
  release();
  expect(await pending).toBe('superseded');
  expect(await again.read()).toBe('Alice new name');
  expect(values.get('oxy_device_info')).toBe('legacy');
});

it('does not recover a prior name merely because the owner matches at another revision', async () => {
  const { storage } = memory();
  expect(await createExperimentalBoundDeviceName(storage, alice, () => true).write('Desk')).toBe(
    'written',
  );
  expect(
    await createExperimentalBoundDeviceName(storage, { ...alice, revision: 2 }, () => true).read(),
  ).toBeNull();
});

it('baseline: two writers of the identical binding can still reorder', async () => {
  const { storage: base } = memory();
  let release!: () => void;
  let observed!: () => void;
  const started = new Promise<void>((resolve) => {
    observed = resolve;
  });
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  let first = true;
  const storage: NativeKeyValueStorage = {
    ...base,
    setItem: async (key, value) => {
      if (first) {
        first = false;
        observed();
        await wait;
      }
      await base.setItem(key, value);
    },
  };
  const old = createExperimentalBoundDeviceName(storage, alice, () => true);
  const newer = createExperimentalBoundDeviceName(storage, alice, () => true);
  const pending = old.write('Old name');
  await started;
  expect(await newer.write('New name')).toBe('written');
  release();
  expect(await pending).toBe('written');
  expect(await newer.read()).toBe('Old name');
});
