import { create } from 'zustand';
import { Platform } from 'react-native';
import { readIdentityMarker, updateIdentityMarker } from '@oxy.so/core';

/**
 * Minimal async key/value storage surface used by the identity store.
 *
 * The identity store only persists two NON-SECRET boolean flags
 * (serialized as the strings `'true'` / `'false'`):
 *   - {@link IDENTITY_SYNC_STORAGE_KEY}
 *   - {@link RECOVERY_PHRASE_ACK_STORAGE_KEY}
 *
 * The recovery PHRASE itself is never stored here — only the
 * acknowledgement flag — so a non-secret backing store is appropriate.
 */
interface KeyValueStorage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
}

/**
 * Web storage adapter backed by `localStorage`.
 *
 * `expo-secure-store` is unusable on web: its `getItemAsync` /
 * `setItemAsync` exist as functions (so a `typeof === 'function'` guard
 * passes) but internally call the iOS/Android-native
 * `getValueWithKeyAsync` / `setValueWithKeyAsync`, which do not exist in
 * the web build (`ExpoSecureStore.web` is an empty object). They throw
 * `TypeError: ...getValueWithKeyAsync is not a function` at call time.
 *
 * Since the only data persisted here is two non-secret flags,
 * `localStorage` is the correct web backing store.
 */
class WebKeyValueStorage implements KeyValueStorage {
  getItem(key: string): Promise<string | null> {
    try {
      return Promise.resolve(globalThis.localStorage?.getItem(key) ?? null);
    } catch (error) {
      // localStorage can throw in private-mode / sandboxed iframes. Treat
      // an unreadable store as "no value" rather than crashing.
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
  }

  setItem(key: string, value: string): Promise<void> {
    try {
      globalThis.localStorage?.setItem(key, value);
      return Promise.resolve();
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
  }
}

/**
 * Native storage adapter backed by `expo-secure-store`.
 *
 * Loaded lazily so the web bundle never pulls the native module in, and
 * so a missing/broken module degrades gracefully (reads resolve to
 * `null`, writes no-op) instead of throwing during module evaluation.
 */
class SecureStoreKeyValueStorage implements KeyValueStorage {
  private modulePromise: Promise<typeof import('expo-secure-store') | null> | null = null;

  private loadModule(): Promise<typeof import('expo-secure-store') | null> {
    if (!this.modulePromise) {
      this.modulePromise = import('expo-secure-store')
        .then((module) => module)
        .catch((error: unknown) => {
          if (__DEV__) {
            console.warn('[IdentityStore] Failed to load expo-secure-store', error);
          }
          return null;
        });
    }
    return this.modulePromise;
  }

  async getItem(key: string): Promise<string | null> {
    const module = await this.loadModule();
    if (!module) {
      return null;
    }
    return module.getItemAsync(key);
  }

  async setItem(key: string, value: string): Promise<void> {
    const module = await this.loadModule();
    if (!module) {
      return;
    }
    await module.setItemAsync(key, value);
  }
}

/**
 * Platform-selected storage adapter.
 *
 * - Web  → `localStorage` (secure-store throws on web; see above).
 * - Native → `expo-secure-store`.
 */
const storage: KeyValueStorage =
  Platform.OS === 'web' ? new WebKeyValueStorage() : new SecureStoreKeyValueStorage();

/** Storage key for identity sync state. */
export const IDENTITY_SYNC_STORAGE_KEY = 'oxy_identity_synced';
/**
 * Storage key for "user has acknowledged their recovery phrase" flag.
 *
 * Set to `'true'` once the user has tapped "I have written down my
 * recovery phrase" during onboarding. Used by the security screen to
 * surface a high-priority recommendation when the user has not yet
 * confirmed they have a backup of their phrase.
 *
 * The phrase itself is NEVER stored — only this acknowledgement flag.
 */
export const RECOVERY_PHRASE_ACK_STORAGE_KEY = 'oxy_recovery_phrase_acknowledged';
/**
 * Storage key for the monotonic "this device finished Commons onboarding for the
 * current identity" milestone.
 *
 * Set to `'true'` exactly once — when onboarding genuinely completes (a live
 * server session whose user has a username). It is read on EVERY cold start so a
 * RETURNING user who has a local identity routes straight to the vault even with
 * ZERO network: the local keystore + this flag are the authority, and session
 * restore/mint is a background concern that must never hide the local identity.
 *
 * Reset to `'false'` whenever a NEW identity is created or imported (see
 * `useIdentity`), so the milestone can never leak across a delete → re-onboard on
 * the same device. The identity-presence check in `useOnboardingStatus` gates
 * BEFORE this flag anyway, so a stale `'true'` after deletion can never route a
 * keyless device into the vault — the reset is belt-and-suspenders for the
 * delete-then-import-on-the-same-device case.
 *
 * Offline-safe: a plain local secure-store read, never a network call.
 */
export const ONBOARDING_COMPLETE_STORAGE_KEY = 'oxy_onboarding_complete';
/**
 * Which onboarding wizard the user started (`create` vs `import`).
 * Used on resume so an in-progress import is not mis-routed into the
 * create-identity flow (which has no offline username skip).
 */
export const ONBOARDING_FLOW_STORAGE_KEY = 'oxy_onboarding_flow';

export type OnboardingFlow = 'create' | 'import';

/** Canonical serialized truthy value. Only this literal is treated as set. */
const STORED_TRUE = 'true';
const STORED_FALSE = 'false';

export interface IdentityState {
  /** Whether identity is synced with server */
  isSynced: boolean;
  /** Whether sync is currently in progress */
  isSyncing: boolean;
  /** Whether the user has acknowledged writing down their recovery phrase */
  recoveryPhraseAcknowledged: boolean;
}

export interface IdentityStore extends IdentityState {
  /** Set sync status atomically */
  setSynced: (synced: boolean) => void;
  /** Set syncing status */
  setSyncing: (syncing: boolean) => void;
  /** Mark the recovery phrase as acknowledged (persists). */
  setRecoveryPhraseAcknowledged: (acknowledged: boolean) => void;
  /** Initialize store from persistent storage */
  hydrate: () => Promise<void>;
  /** Reset store state */
  reset: () => void;
}

const defaultState: IdentityState = {
  isSynced: false, // Not synced until confirmed by server registration
  isSyncing: false,
  recoveryPhraseAcknowledged: false,
};

/**
 * Identity store - single source of truth for identity sync state.
 *
 * In-memory zustand state mirrored to platform storage (`localStorage`
 * on web, `expo-secure-store` on native). Persistence of the sync flag
 * is driven explicitly by the caller via {@link persistIdentitySyncState};
 * the acknowledgement flag persists from {@link IdentityStore.setRecoveryPhraseAcknowledged}.
 */
export const useIdentityStore = create<IdentityStore>((set: (state: Partial<IdentityState>) => void, get: () => IdentityStore) => ({
  ...defaultState,

  setSynced: (synced: boolean) => {
    set({ isSynced: synced });
    // Note: Persistence is handled via persistIdentitySyncState in the caller
  },

  setSyncing: (syncing: boolean) => {
    set({ isSyncing: syncing });
  },

  setRecoveryPhraseAcknowledged: (acknowledged: boolean) => {
    set({ recoveryPhraseAcknowledged: acknowledged });
    // Fire-and-forget persistence. Errors are logged but never block
    // the UI — losing this flag is safe (it just means we re-nag the
    // user on the next launch).
    void persistRecoveryPhraseAcknowledged(acknowledged).catch((error) => {
      console.error('[IdentityStore] Failed to persist recovery phrase acknowledgement', error);
    });
  },

  hydrate: async () => {
    try {
      const [synced, ack] = await Promise.all([
        storage.getItem(IDENTITY_SYNC_STORAGE_KEY),
        storage.getItem(RECOVERY_PHRASE_ACK_STORAGE_KEY),
      ]);
      // Only consider synced / acknowledged if explicitly stored as 'true'.
      set({
        isSynced: synced === STORED_TRUE,
        recoveryPhraseAcknowledged: ack === STORED_TRUE,
      });
    } catch (error) {
      console.error('[IdentityStore] Failed to hydrate identity state from storage', error);
      set({ isSynced: defaultState.isSynced, recoveryPhraseAcknowledged: defaultState.recoveryPhraseAcknowledged });
    }
  },

  reset: () => {
    set(defaultState);
  },
}));

/**
 * Persist sync state to platform storage.
 */
export const persistIdentitySyncState = async (isSynced: boolean): Promise<void> => {
  try {
    await storage.setItem(IDENTITY_SYNC_STORAGE_KEY, isSynced ? STORED_TRUE : STORED_FALSE);
  } catch (error) {
    console.error('[IdentityStore] Failed to persist sync state', error);
  }
};

/**
 * Persist the "user has acknowledged their recovery phrase" flag.
 */
export const persistRecoveryPhraseAcknowledged = async (acknowledged: boolean): Promise<void> => {
  try {
    await storage.setItem(RECOVERY_PHRASE_ACK_STORAGE_KEY, acknowledged ? STORED_TRUE : STORED_FALSE);
  } catch (error) {
    console.error('[IdentityStore] Failed to persist recovery phrase acknowledgement', error);
  }
};

/**
 * Get sync state from storage directly (for non-reactive reads).
 * Returns false (not synced) by default - only true if explicitly stored as 'true'.
 */
export const getIdentitySyncStateFromStorage = async (): Promise<boolean> => {
  try {
    const synced = await storage.getItem(IDENTITY_SYNC_STORAGE_KEY);
    // Only consider synced if explicitly stored as 'true'.
    return synced === STORED_TRUE;
  } catch (error) {
    console.error('[IdentityStore] Failed to read sync state', error);
    return false; // Not synced on error
  }
};

/**
 * The SINGLE place the onboarding-complete flag is written to SecureStore — its
 * one canonical storage location. `persistOnboardingComplete` (which ALSO mirrors
 * into the identity marker) and the marker-derived self-heal in
 * `getOnboardingCompleteFromStorage` both funnel through here so the flag's home
 * is defined once.
 */
const writeOnboardingCompleteFlag = async (complete: boolean): Promise<void> => {
  try {
    await storage.setItem(ONBOARDING_COMPLETE_STORAGE_KEY, complete ? STORED_TRUE : STORED_FALSE);
  } catch (error) {
    console.error('[IdentityStore] Failed to persist onboarding-complete flag', error);
  }
};

/**
 * Persist the monotonic onboarding-complete milestone (see
 * {@link ONBOARDING_COMPLETE_STORAGE_KEY}).
 *
 * Writes the SecureStore flag AND mirrors the value into the AndroidKeyStore-
 * independent identity marker (`{ onboardingComplete }`). The mirror is what
 * lets a milestone survive a SecureStore reset that leaves the marker
 * (AsyncStorage) intact — see {@link getOnboardingCompleteFromStorage}.
 * `updateIdentityMarker` fails open and is a no-op when no marker exists yet
 * (a pre-identity device has nothing to mirror), so this can never throw or
 * spuriously create a marker.
 */
export const persistOnboardingComplete = async (complete: boolean): Promise<void> => {
  await writeOnboardingCompleteFlag(complete);
  await updateIdentityMarker({ onboardingComplete: complete });
};

/**
 * Read the onboarding-complete milestone directly (offline-safe local read).
 * Returns `false` by default — only `true` when explicitly stored as `'true'`.
 *
 * ROBUSTNESS: the SecureStore flag can be lost independently of the identity
 * (e.g. a keystore reset that wipes SecureStore but not AsyncStorage). When the
 * flag is missing/false we fall back to the identity marker's mirrored
 * `onboardingComplete`; if the marker says onboarding DID complete, we self-heal
 * the SecureStore flag (fire-and-forget) so subsequent reads are fast and the
 * flag and marker reconverge. A lost flag alone can therefore no longer re-route
 * a fully-onboarded identity back into the wizard.
 */
export const getOnboardingCompleteFromStorage = async (): Promise<boolean> => {
  let flag: string | null = null;
  try {
    flag = await storage.getItem(ONBOARDING_COMPLETE_STORAGE_KEY);
  } catch (error) {
    console.error('[IdentityStore] Failed to read onboarding-complete flag', error);
  }
  if (flag === STORED_TRUE) {
    return true;
  }

  const marker = await readIdentityMarker();
  if (marker?.onboardingComplete === true) {
    void writeOnboardingCompleteFlag(true);
    return true;
  }
  return false;
};

/**
 * Read the recovery-phrase-acknowledged flag directly.
 */
export const getRecoveryPhraseAcknowledgedFromStorage = async (): Promise<boolean> => {
  try {
    const ack = await storage.getItem(RECOVERY_PHRASE_ACK_STORAGE_KEY);
    return ack === STORED_TRUE;
  } catch (error) {
    console.error('[IdentityStore] Failed to read recovery phrase acknowledgement', error);
    return false;
  }
};

/**
 * Persist which onboarding wizard the user chose (create vs import).
 * Cleared when a new identity is created/imported or onboarding resets.
 */
export const persistOnboardingFlow = async (flow: OnboardingFlow | null): Promise<void> => {
  try {
    if (flow === null) {
      await storage.setItem(ONBOARDING_FLOW_STORAGE_KEY, '');
      return;
    }
    await storage.setItem(ONBOARDING_FLOW_STORAGE_KEY, flow);
  } catch (error) {
    console.error('[IdentityStore] Failed to persist onboarding flow', error);
  }
};

/**
 * Read the persisted onboarding flow (offline-safe local read).
 */
export const getOnboardingFlowFromStorage = async (): Promise<OnboardingFlow | null> => {
  try {
    const flow = await storage.getItem(ONBOARDING_FLOW_STORAGE_KEY);
    return flow === 'create' || flow === 'import' ? flow : null;
  } catch (error) {
    console.error('[IdentityStore] Failed to read onboarding flow', error);
    return null;
  }
};
