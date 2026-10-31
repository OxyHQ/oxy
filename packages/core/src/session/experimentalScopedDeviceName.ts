import type { NativeKeyValueStorage } from './authStateStore';

interface Owner {
  actorId: string;
  accountId: string;
  sessionId: string;
}

/** Fail closed when no cryptographically secure random source is available. */
export function createExperimentalDeviceNameIncarnation(
  source: Pick<Crypto, 'getRandomValues'> | null | undefined = globalThis.crypto,
): string {
  if (!source || typeof source.getRandomValues !== 'function')
    throw new Error('Secure randomness unavailable');
  const bytes = new Uint8Array(16);
  source.getRandomValues(bytes);
  return Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('');
}

/**
 * An isolated experiment, not a DeviceManager replacement. Every staged
 * context must receive a fresh cryptographically random incarnation id; reusing
 * one lets an old writer overwrite a later name. No legacy key is read or
 * written and this class does not publish a current-incarnation pointer.
 */
export function createExperimentalScopedDeviceName(
  storage: NativeKeyValueStorage,
  owner: Owner,
  incarnation: string,
  isCurrent: () => boolean,
) {
  if (!/^[a-f0-9]{32}$/.test(incarnation) || !owner.actorId || !owner.accountId || !owner.sessionId)
    throw new Error('Invalid device-name scope');
  const scope = Object.freeze({
    actorId: owner.actorId,
    accountId: owner.accountId,
    sessionId: owner.sessionId,
  });
  const key = `oxy.device-name.v1.${incarnation}`;
  return {
    async write(deviceName: string): Promise<'written' | 'superseded' | 'storage_error'> {
      if (!isCurrent()) return 'superseded';
      if (typeof deviceName !== 'string') return 'storage_error';
      const value = JSON.stringify({ version: 1, owner: scope, deviceName });
      try {
        await storage.setItem(key, value);
        if ((await storage.getItem(key)) !== value) return 'storage_error';
      } catch {
        return 'storage_error';
      }
      return isCurrent() ? 'written' : 'superseded';
    },
    async read(): Promise<string | null> {
      if (!isCurrent()) return null;
      try {
        const raw = await storage.getItem(key);
        if (!isCurrent() || !raw) return null;
        const value: unknown = JSON.parse(raw);
        if (!value || typeof value !== 'object') return null;
        const item = value as { version?: unknown; owner?: Owner; deviceName?: unknown };
        if (
          item.version !== 1 ||
          item.owner?.actorId !== scope.actorId ||
          item.owner?.accountId !== scope.accountId ||
          item.owner?.sessionId !== scope.sessionId ||
          typeof item.deviceName !== 'string'
        )
          return null;
        return isCurrent() ? item.deviceName : null;
      } catch {
        return null;
      }
    },
  };
}
