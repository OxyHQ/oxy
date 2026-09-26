import type { AuthStateStore } from '@oxy.so/core/session';

/**
 * True when the persisted store holds a device credential FOR A SESSION — the
 * credential plus the account it last minted for. A web origin that joined the
 * browser's device while nobody was signed in, or whose device answered
 * `no_active_session`, keeps its credential without an account (ADR 0029 D2):
 * it can mint again once someone signs in, but it cannot bring back a session
 * that ended, so a lost-token recovery must not wait on it.
 */
export async function hasPersistedSessionCredential(store: AuthStateStore): Promise<boolean> {
  const persisted = await store.load();
  return Boolean(persisted?.deviceId && persisted?.deviceSecret && persisted?.userId);
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
