import type { NativeKeyValueStorage } from './authStateStore';

/**
 * Experimental append-only logout evidence, scoped by a unique local login
 * incarnation. The caller must generate a fresh random id for every sign-in,
 * persist it with that sign-in, and consult this marker before restoring it.
 * This is not connected to existing stores or logout flows.
 */
export function createExperimentalLogoutTombstones(storage: NativeKeyValueStorage) {
  function key(incarnation: string): string {
    if (!/^[a-f0-9]{32}$/.test(incarnation)) throw new Error('Invalid login incarnation');
    return `oxy.auth.logout.v1.${incarnation}`;
  }

  return {
    async mark(incarnation: string): Promise<boolean> {
      const marker = key(incarnation);
      try {
        await storage.setItem(marker, '1');
        return (await storage.getItem(marker)) === '1';
      } catch {
        return false;
      }
    },
    async status(incarnation: string): Promise<'marked' | 'unmarked' | 'unknown'> {
      const marker = key(incarnation);
      try {
        const value = await storage.getItem(marker);
        return value === null ? 'unmarked' : value === '1' ? 'marked' : 'unknown';
      } catch {
        return 'unknown';
      }
    },
  };
}
