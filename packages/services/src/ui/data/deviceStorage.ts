/**
 * The SDK's key-value data that belongs to the device, not to an account: the
 * chosen language, the profile a cold start paints, the first-touch campaign,
 * the app attestation key id, the search history, the theme source. It lives
 * in a `@oxy.so/bloom-data` model in the device's own store
 * (`DEVICE_DATA_ACCOUNT`, its own file), behind the same `StorageInterface`
 * its readers have always used.
 *
 * Moving off AsyncStorage (localStorage on the web) is read-through: the first
 * time a key is asked for and the model has no value, the old storage is read
 * once, its value is written here and the old key is deleted. So exactly the
 * keys the SDK reads move, under whatever prefix the app gave them, and an
 * app's own AsyncStorage keys are never touched. The SDK's dead keys (its old
 * query caches, the session ids it wrote and never read) are deleted once.
 * AsyncStorage is an optional peer for this alone: once an app has run a
 * release with it, it can remove it.
 */
import { model, Store, withStore } from '@oxy.so/bloom-data';
import type { StorageInterface } from '../utils/storageHelpers';
import { dataPersister } from './persister';

/** The store key of the device's own data. Account ids never take this form. */
export const DEVICE_DATA_ACCOUNT = 'device';

interface KeyValueState {
  values: Readonly<Record<string, string>>;
  /** Whether the SDK's dead keys were deleted from the old storage. */
  legacySwept: boolean;
}

const KeyValues = model<KeyValueState>('oxy.device-key-values', { persist: true });

const EMPTY: KeyValueState = { values: {}, legacySwept: false };

/** The old storage, read once per key while it is installed. */
interface LegacyStorage {
  getItem(key: string): Promise<string | null>;
  removeItem(key: string): Promise<void>;
  getAllKeys(): Promise<readonly string[]>;
}

/** Old SDK keys nothing reads any more: deleted, never copied. */
const isDeadKey = (key: string) =>
  key.endsWith('_session_ids') || key.endsWith('_active_session_id');

async function loadLegacyStorage(): Promise<LegacyStorage | null> {
  if (typeof navigator !== 'undefined' && navigator.product === 'ReactNative') {
    try {
      const module = await import('@react-native-async-storage/async-storage');
      return module.default as unknown as LegacyStorage;
    } catch {
      return null;
    }
  }
  if (typeof window === 'undefined' || !window.localStorage) return null;
  const local = window.localStorage;
  return {
    getItem: async (key) => local.getItem(key),
    removeItem: async (key) => local.removeItem(key),
    getAllKeys: async () => Object.keys(local),
  };
}

export interface DeviceStorage extends StorageInterface {
  readonly store: Store;
}

/**
 * Device storage over `store` (the device's), migrating from `legacy` key by
 * key. Exposed for tests; the SDK uses `deviceStorage()`.
 */
export function createDeviceStorage(
  store: Store,
  legacy: () => Promise<LegacyStorage | null> = loadLegacyStorage,
): DeviceStorage {
  const state = () => withStore(store, () => KeyValues.get()) ?? EMPTY;
  const write = (change: (current: KeyValueState) => KeyValueState) =>
    withStore(store, () => KeyValues.set((current) => change(current ?? EMPTY)));
  /** Keys already looked for in the old storage this session. */
  const checked = new Set<string>();

  const ready = (async () => {
    await withStore(store, () => KeyValues.load());
    if (state().legacySwept) return;
    const old = await legacy().catch(() => null);
    if (old) {
      const keys = await old.getAllKeys().catch(() => [] as readonly string[]);
      await Promise.all(
        keys.filter(isDeadKey).map((key) => old.removeItem(key).catch(() => undefined)),
      );
    }
    write((current) => ({ ...current, legacySwept: true }));
  })();

  const migrate = async (key: string): Promise<void> => {
    if (checked.has(key) || key in state().values) return;
    checked.add(key);
    const old = await legacy().catch(() => null);
    const value = old ? await old.getItem(key).catch(() => null) : null;
    if (value === null) return;
    if (!(key in state().values)) {
      write((current) => ({ ...current, values: { ...current.values, [key]: value } }));
    }
    await old?.removeItem(key).catch(() => undefined);
  };

  return {
    store,
    async getItem(key) {
      await ready;
      await migrate(key);
      return state().values[key] ?? null;
    },
    async setItem(key, value) {
      await ready;
      checked.add(key);
      write((current) => ({ ...current, values: { ...current.values, [key]: value } }));
    },
    async removeItem(key) {
      await ready;
      await migrate(key);
      write((current) => {
        const { [key]: _removed, ...values } = current.values;
        return { ...current, values };
      });
    },
    async clear() {
      await ready;
      write((current) => ({ ...current, values: {} }));
    },
  };
}

let device: DeviceStorage | undefined;

/** The device's storage, one per app process. */
export function deviceStorage(): DeviceStorage {
  device ??= createDeviceStorage(new Store({ persister: dataPersister(DEVICE_DATA_ACCOUNT) }));
  return device;
}

/** @internal Drops the process's device storage, for tests that start from an empty device. */
export function resetDeviceStorage(): void {
  device = undefined;
}
