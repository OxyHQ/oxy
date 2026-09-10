/**
 * Identity pin — the durable binding between THIS device's PRIMARY identity key
 * and the account that key authenticates as.
 *
 * An identity-bound client (Commons, the identity vault) must always act as the
 * owner of the local signing key — permanently. The `DeviceSession` it shares
 * with every other Oxy app on the same device tracks a MUTABLE `activeAccountId`
 * that any sibling app can switch; following it silently changes both the user
 * such a client renders and the bearer it sends. The pin is the client-side
 * record that breaks that coupling: `{ publicKey, accountId }`, written when an
 * identity-mode session is established (the only moment both facts are known
 * first-hand), read on every boot, and reconciled against the live
 * `KeyManager.getPublicKey()` before it is trusted (see
 * `resolveIdentityPin` in `identitySession.ts`).
 *
 * It holds NO secret — a public key and an account id, both already known to the
 * server — so it lives in the same per-origin storage as {@link PersistedAuthState}
 * (`authStateStore.ts`) rather than the keychain, and mirrors that module's
 * store shape: `load / save / clear`, an in-memory mirror, a read-back-verified
 * durable write, and graceful degradation when storage is unavailable.
 *
 * ESM-safe (no `require()`); no react/react-native/expo imports.
 */

import { logger } from '../logger';
import type { NativeKeyValueStorage } from './authStateStore';

/**
 * The persisted identity binding.
 *
 * `publicKey` is the device's PRIMARY identity public key (lower-case hex, as
 * `KeyManager` stores it) — never the cross-app shared-slot key, which may hold
 * a different identity. `accountId` is the account the server resolved for that
 * key when the session was established.
 */
export interface IdentityPin {
  publicKey: string;
  accountId: string;
}

/**
 * The storage seam for {@link IdentityPin}. Async throughout so one interface
 * fits both synchronous web `localStorage` and asynchronous native
 * SecureStore/AsyncStorage.
 */
export interface IdentityPinStore {
  load(): Promise<IdentityPin | null>;
  /**
   * Persist the pin and report whether it durably landed.
   *
   * `true` means the value is retained consistent with this store's durability
   * guarantee (a durable backing whose read-back matched, or a degraded/in-memory
   * store that held it in memory). `false` means a DURABLE backing was expected
   * but the write did not land — the in-memory mirror keeps this process pinned,
   * but the next cold boot will have to re-establish the identity session (which
   * rewrites the pin) instead of taking the fast pinned-mint lane.
   */
  save(pin: IdentityPin): Promise<boolean>;
  clear(): Promise<void>;
}

/**
 * Versioned storage key. Deliberately distinct from the `oxy.auth.*` keys so a
 * session sign-out (which clears the auth blob) and an identity change (which
 * clears the pin) can never take each other down.
 */
export const IDENTITY_PIN_STORAGE_KEY = 'oxy.identity.pin.v1';

/**
 * Structural check for a storable identity public key: `KeyManager` only ever
 * persists secp256k1 hex — compressed (66 chars) or uncompressed (130). A stored
 * value of any other shape is corrupt, so it is treated as "no pin" (fail
 * closed) rather than compared. Full curve validation belongs to `KeyManager`;
 * the pin's real authority is the reconcile against the live local key.
 */
function isStorablePublicKey(value: unknown): value is string {
  if (typeof value !== 'string') {
    return false;
  }
  if (value.length !== 66 && value.length !== 130) {
    return false;
  }
  return /^[0-9a-fA-F]+$/.test(value);
}

/**
 * Parse + shape-validate a stored blob. Returns `null` for anything that is not
 * a well-formed {@link IdentityPin} (absent, malformed JSON, wrong types, junk
 * public key) so a corrupt entry degrades to "not pinned" rather than throwing —
 * and, critically, never yields a pin that could bind a client to the wrong
 * account.
 */
function deserialize(raw: string | null): IdentityPin | null {
  if (!raw) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') {
    return null;
  }
  const candidate = parsed as Record<string, unknown>;
  if (!isStorablePublicKey(candidate.publicKey)) {
    return null;
  }
  if (typeof candidate.accountId !== 'string' || candidate.accountId.length === 0) {
    return null;
  }
  return {
    publicKey: candidate.publicKey.toLowerCase(),
    accountId: candidate.accountId,
  };
}

/**
 * Serialize a pin, or `null` when the caller handed over a value that would not
 * survive {@link deserialize} — writing it would produce an entry that silently
 * reads back as "not pinned".
 */
function serialize(pin: IdentityPin): string | null {
  if (!isStorablePublicKey(pin.publicKey) || pin.accountId.length === 0) {
    return null;
  }
  return JSON.stringify({ publicKey: pin.publicKey.toLowerCase(), accountId: pin.accountId });
}

/**
 * Whether `pin` still describes the identity currently on this device.
 *
 * `publicKey` comparison is case-insensitive (hex). A `null` local key is a
 * definitive "no identity here" and therefore never a match — the caller clears
 * the pin rather than binding to an account whose key is gone.
 */
export function identityPinMatches(pin: IdentityPin | null, localPublicKey: string | null): boolean {
  if (!pin || !localPublicKey) {
    return false;
  }
  return pin.publicKey.toLowerCase() === localPublicKey.toLowerCase();
}

/**
 * A process-lifetime, in-memory {@link IdentityPinStore}. Used directly for
 * tests/SSR and as the degraded fallback of the web store.
 */
export function createMemoryIdentityPinStore(): IdentityPinStore {
  let current: IdentityPin | null = null;
  return {
    load: async () => current,
    save: async (pin) => {
      if (!serialize(pin)) {
        return false;
      }
      // Memory IS this store's durability backing — the write always lands.
      current = { publicKey: pin.publicKey.toLowerCase(), accountId: pin.accountId };
      return true;
    },
    clear: async () => {
      current = null;
    },
  };
}

/**
 * Read the ambient `localStorage`, tolerating the case where merely ACCESSING
 * `window.localStorage` throws (sandboxed iframe `SecurityError`). Returns
 * `null` when storage is unavailable.
 */
function safeGetLocalStorage(): Storage | null {
  try {
    if (typeof globalThis === 'undefined') {
      return null;
    }
    const store = (globalThis as { localStorage?: Storage }).localStorage;
    return store ?? null;
  } catch {
    return null;
  }
}

/**
 * A `localStorage`-backed {@link IdentityPinStore}. Degrades to an in-memory
 * store when `localStorage` is unreachable, and keeps an in-memory mirror so a
 * failed persist still pins THIS page's lifetime.
 */
export function createWebIdentityPinStore(): IdentityPinStore {
  const storage = safeGetLocalStorage();
  if (!storage) {
    return createMemoryIdentityPinStore();
  }
  // `undefined` = never written this session → fall back to storage; any set
  // value (including `null` after clear) is authoritative.
  let sessionMirror: IdentityPin | null | undefined;
  return {
    load: async () => {
      if (sessionMirror !== undefined) {
        return sessionMirror;
      }
      try {
        return deserialize(storage.getItem(IDENTITY_PIN_STORAGE_KEY));
      } catch {
        return null;
      }
    },
    save: async (pin) => {
      const json = serialize(pin);
      if (!json) {
        logger.error(
          '[identityPin] refusing to persist a malformed identity pin',
          undefined,
          { component: 'identityPin' },
        );
        return false;
      }
      sessionMirror = { publicKey: pin.publicKey.toLowerCase(), accountId: pin.accountId };
      try {
        storage.setItem(IDENTITY_PIN_STORAGE_KEY, json);
        if (storage.getItem(IDENTITY_PIN_STORAGE_KEY) === json) {
          return true;
        }
        logger.error(
          '[identityPin] read-back mismatch after save — the identity pin did not persist; this process stays pinned via the in-memory mirror but the next boot must re-establish the identity session',
          undefined,
          { component: 'identityPin' },
        );
        return false;
      } catch (error) {
        logger.error(
          '[identityPin] persist threw — the identity pin did not persist; this process stays pinned via the in-memory mirror but the next boot must re-establish the identity session',
          error,
          { component: 'identityPin' },
        );
        return false;
      }
    },
    clear: async () => {
      sessionMirror = null;
      try {
        storage.removeItem(IDENTITY_PIN_STORAGE_KEY);
      } catch (error) {
        logger.debug('[identityPin] clear failed', { component: 'identityPin' }, error);
      }
    },
  };
}

/**
 * A native {@link IdentityPinStore} over an injected async key/value store —
 * the same seam `createNativeAuthStateStore` uses, so `@oxy.so/core` never
 * imports `expo-secure-store`.
 */
export function createNativeIdentityPinStore(storage: NativeKeyValueStorage): IdentityPinStore {
  let sessionMirror: IdentityPin | null | undefined;
  return {
    load: async () => {
      if (sessionMirror !== undefined) {
        return sessionMirror;
      }
      try {
        return deserialize(await storage.getItem(IDENTITY_PIN_STORAGE_KEY));
      } catch {
        return null;
      }
    },
    save: async (pin) => {
      const json = serialize(pin);
      if (!json) {
        logger.error(
          '[identityPin] refusing to persist a malformed identity pin',
          undefined,
          { component: 'identityPin' },
        );
        return false;
      }
      sessionMirror = { publicKey: pin.publicKey.toLowerCase(), accountId: pin.accountId };
      try {
        await storage.setItem(IDENTITY_PIN_STORAGE_KEY, json);
        // A native write can resolve WITHOUT throwing yet not land, so a
        // read-back is the only reliable proof.
        if ((await storage.getItem(IDENTITY_PIN_STORAGE_KEY)) === json) {
          return true;
        }
        logger.error(
          '[identityPin] read-back mismatch after save — the identity pin did not persist; this app run stays pinned via the in-memory mirror but the next cold start must re-establish the identity session',
          undefined,
          { component: 'identityPin' },
        );
        return false;
      } catch (error) {
        logger.error(
          '[identityPin] persist threw — the identity pin did not persist; this app run stays pinned via the in-memory mirror but the next cold start must re-establish the identity session',
          error,
          { component: 'identityPin' },
        );
        return false;
      }
    },
    clear: async () => {
      sessionMirror = null;
      try {
        await storage.removeItem(IDENTITY_PIN_STORAGE_KEY);
      } catch (error) {
        logger.debug('[identityPin] clear failed', { component: 'identityPin' }, error);
      }
    },
  };
}
