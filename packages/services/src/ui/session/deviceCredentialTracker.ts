/**
 * A synchronous answer to "does this origin hold a device credential?".
 *
 * The browser bridge (ADR 0029 D2) must decide INSIDE the sign-in press whether
 * to open its window — a window opened after an `await` is blocked by every
 * browser — but the auth store is async. This wrapper remembers the credential
 * every load, save and clear passes through, so the press can read it at once.
 * The cold boot loads the store on mount, long before anyone presses sign-in.
 */
import type { AuthStateStore } from '@oxy.so/core/session';

export interface HeldDeviceCredential {
  deviceId: string;
  deviceSecret: string;
}

export interface CredentialTrackingAuthStateStore extends AuthStateStore {
  /**
   * The credential last seen through this store; `undefined` until the store has
   * been read at least once (unknown — the caller should not guess).
   */
  heldDeviceCredential(): HeldDeviceCredential | null | undefined;
}

function credentialOf(state: { deviceId?: string; deviceSecret?: string } | null): HeldDeviceCredential | null {
  return state?.deviceId && state.deviceSecret
    ? { deviceId: state.deviceId, deviceSecret: state.deviceSecret }
    : null;
}

export function trackDeviceCredential(store: AuthStateStore): CredentialTrackingAuthStateStore {
  let held: HeldDeviceCredential | null | undefined;
  return {
    load: async () => {
      const state = await store.load();
      held = credentialOf(state);
      return state;
    },
    save: async (state) => {
      held = credentialOf(state);
      return store.save(state);
    },
    clear: async () => {
      held = null;
      await store.clear();
    },
    heldDeviceCredential: () => held,
  };
}
