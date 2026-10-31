import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils';
import type { NativeKeyValueStorage } from './authStateStore';

interface Binding {
  deviceSessionId: string;
  revision: number;
  contextId: string;
  actorId: string;
  accountId: string;
  sessionId: string;
}

/**
 * An experimental deterministic slot for exactly one verified binding. The
 * digest is a key-format aid, not authorization or a proof that data is safe.
 * Different revisions use different slots; this does not recover names across
 * revision changes or order concurrent writes for the same binding.
 */
export function createExperimentalBoundDeviceName(
  storage: NativeKeyValueStorage,
  binding: Binding,
  isCurrent: () => boolean,
) {
  if (
    !binding.deviceSessionId ||
    !Number.isSafeInteger(binding.revision) ||
    binding.revision < 0 ||
    !binding.contextId ||
    !binding.actorId ||
    !binding.accountId ||
    !binding.sessionId
  )
    throw new Error('Invalid device-name binding');
  const fields = [
    binding.deviceSessionId,
    binding.revision,
    binding.contextId,
    binding.actorId,
    binding.accountId,
    binding.sessionId,
  ] as const;
  const digest = bytesToHex(sha256(utf8ToBytes(JSON.stringify(fields))));
  const key = `oxy.device-name.v2.${digest}`;
  return {
    async write(deviceName: string): Promise<'written' | 'superseded' | 'storage_error'> {
      if (!isCurrent()) return 'superseded';
      if (typeof deviceName !== 'string') return 'storage_error';
      const raw = JSON.stringify({ version: 2, binding: fields, deviceName });
      try {
        await storage.setItem(key, raw);
        if ((await storage.getItem(key)) !== raw) return 'storage_error';
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
        const record = value as { version?: unknown; binding?: unknown; deviceName?: unknown };
        if (
          record.version !== 2 ||
          JSON.stringify(record.binding) !== JSON.stringify(fields) ||
          typeof record.deviceName !== 'string'
        )
          return null;
        return isCurrent() ? record.deviceName : null;
      } catch {
        return null;
      }
    },
  };
}
