import { Store } from '@oxy.so/bloom-data';
import { createDeviceStorage } from '../deviceStorage';

function legacyWith(entries: Record<string, string>) {
  const values = new Map(Object.entries(entries));
  const reads: string[] = [];
  return {
    values,
    reads,
    storage: async () => ({
      getItem: async (key: string) => {
        reads.push(key);
        return values.get(key) ?? null;
      },
      removeItem: async (key: string) => {
        values.delete(key);
      },
      getAllKeys: async () => [...values.keys()],
    }),
  };
}

describe('device storage', () => {
  it('moves a key off the old storage the first time it is read, and only that key', async () => {
    const legacy = legacyWith({ mention_language: '"es"', app_own_key: 'kept' });
    const storage = createDeviceStorage(new Store(), legacy.storage);
    expect(await storage.getItem('mention_language')).toBe('"es"');
    expect(legacy.values.has('mention_language')).toBe(false);
    expect(legacy.values.get('app_own_key')).toBe('kept');
    expect(await storage.getItem('mention_language')).toBe('"es"');
    expect(legacy.reads.filter((key) => key === 'mention_language')).toHaveLength(1);
  });

  it('deletes the SDK dead keys once, without copying them', async () => {
    const legacy = legacyWith({
      mention_session_ids: '[]',
      mention_active_session_id: 's',
      mention_boot_account: '{"v":1}',
    });
    const storage = createDeviceStorage(new Store(), legacy.storage);
    expect(await storage.getItem('mention_session_ids')).toBeNull();
    expect([...legacy.values.keys()]).toEqual(['mention_boot_account']);
  });

  it('never lets an old value override one written since', async () => {
    const legacy = legacyWith({ theme_source: 'old' });
    const storage = createDeviceStorage(new Store(), legacy.storage);
    await storage.setItem('theme_source', 'new');
    expect(await storage.getItem('theme_source')).toBe('new');
  });

  it('removes a key from both, so a removed value never comes back', async () => {
    const legacy = legacyWith({ history_u1: '["a"]' });
    const storage = createDeviceStorage(new Store(), legacy.storage);
    await storage.removeItem('history_u1');
    expect(legacy.values.has('history_u1')).toBe(false);
    expect(await storage.getItem('history_u1')).toBeNull();
  });

  it('works with no old storage installed', async () => {
    const storage = createDeviceStorage(new Store(), async () => null);
    expect(await storage.getItem('anything')).toBeNull();
    await storage.setItem('anything', '1');
    expect(await storage.getItem('anything')).toBe('1');
  });
});
