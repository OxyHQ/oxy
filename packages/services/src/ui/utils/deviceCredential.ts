import type { AuthStateStore } from '@oxy.so/core';

/** True when the persisted store holds a device credential. */
export async function hasPersistedDeviceCredential(store: AuthStateStore): Promise<boolean> {
  const persisted = await store.load();
  return Boolean(persisted?.deviceId && persisted?.deviceSecret);
}

export async function loadPersistedDeviceCredential(
  store: AuthStateStore,
): Promise<{ deviceId: string; deviceSecret: string } | null> {
  const persisted = await store.load();
  if (!persisted?.deviceId || !persisted?.deviceSecret) {
    return null;
  }
  return { deviceId: persisted.deviceId, deviceSecret: persisted.deviceSecret };
}
