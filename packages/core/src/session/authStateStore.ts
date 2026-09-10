/**
 * Persisted auth state — ONE shape, web + native.
 *
 * The zero-cookie device transport persists the device credential per ORIGIN so
 * a reload restores the session locally without a redirect: `deviceId` +
 * `deviceSecret` mint a fresh access token via `POST /session/device/token`.
 * This module is the storage seam: a tiny `load / save / clear` interface plus
 * platform factories, so the cold boot (`sessionColdBoot`) and the unified re-mint
 * handler (`refresh.ts`) never touch a platform storage API directly.
 *
 * Platform-agnostic — the native factory takes an INJECTED key/value store
 * (`@oxy.so/services` passes a SecureStore-backed adapter) so `@oxy.so/core`
 * never imports `expo-secure-store`. The web factory is self-contained
 * (`localStorage`) and degrades to in-memory when storage is unavailable
 * (sandboxed iframe `SecurityError`, private-mode quota, SSR).
 *
 * ESM-safe (no `require()`).
 */

import { logger } from '../logger';

/**
 * The persisted session credential set for a single origin.
 *
 * `sessionId` + `userId` identify the owning device session and active account.
 * `deviceId` + `deviceSecret` are the zero-cookie mint credential: the client
 * presents BOTH at `POST /session/device/token` — the secret is the proof, the
 * deviceId selects the device doc. The secret is rotated in-use: the mint returns
 * `nextDeviceSecret`, which the cold boot / re-mint handler persist BEFORE
 * planting the minted access token (multi-tab anti-loss).
 *
 * `accessToken` + `expiresAt` are OPTIONAL warm-boot fields. Persisting them lets
 * the cold boot plant a still-valid access token on the very first paint WITHOUT
 * a blocking mint round-trip — the proactive scheduler then rotates it in the
 * background. They are a strict optimization: the store is fully functional (via
 * `deviceSecret`) when they are absent or stale, and the access token is
 * short-lived, so persisting it adds no exposure the already-persisted
 * `deviceSecret` does not.
 */
export interface PersistedAuthState {
  sessionId: string;
  userId: string;
  /**
   * The stable device identifier this session is bound to (zero-cookie
   * transport). Persisted alongside {@link deviceSecret} because the
   * `POST /session/device/token` mint presents BOTH. Sourced from every login
   * lane (password / 2FA / QR claim / challenge verify) via the response's
   * `deviceId`.
   */
  deviceId?: string;
  /**
   * The rotating device secret (zero-cookie transport). Possession of it mints a
   * short access token for the device's active account via
   * `POST /session/device/token`. Rotated in-use.
   */
  deviceSecret?: string;
  /** Optional warm-boot access token (short-lived; see interface docs). */
  accessToken?: string;
  /** Optional warm-boot access-token expiry, ISO-8601. */
  expiresAt?: string;
}

/**
 * The storage seam consumed by the cold boot and the re-mint handler. Async
 * throughout so one interface fits both synchronous web `localStorage` and
 * asynchronous native SecureStore/AsyncStorage. `clear()` (sign-out) wipes the
 * per-sign-in credential blob.
 */
export interface AuthStateStore {
  load(): Promise<PersistedAuthState | null>;
  /**
   * Persist the credential blob and report whether it durably landed.
   *
   * Resolves `true` when the state is retained consistent with this store's
   * durability guarantee — a durable backing whose read-back matched, or a
   * degraded/in-memory store that held it in memory. Resolves `false` when a
   * DURABLE backing was expected but the write did NOT land (read-back mismatch
   * or a thrown write); the in-memory mirror still keeps the session live for
   * this process, but it will be lost on reload.
   *
   * A lane persisting a ROTATED device secret (the mint's `nextDeviceSecret`)
   * MUST treat `false` as fatal for that mint: it must NOT plant/advertise a
   * session built on a secret that will not survive a reload.
   */
  save(state: PersistedAuthState): Promise<boolean>;
  clear(): Promise<void>;
}

/**
 * The minimal async key/value surface a native store must provide. Matches
 * both `expo-secure-store` (wrapped) and `@react-native-async-storage`.
 */
export interface NativeKeyValueStorage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}

/**
 * Versioned DURABLE storage key. Holds ONLY the small, re-mint-critical fields
 * (`sessionId`, `userId`, `deviceId`, `deviceSecret`) — never the large JWT
 * `accessToken`. Keeping this blob small (<2KB) matters on Android
 * `expo-secure-store`, whose backing store can silently fail to persist an
 * oversize value; bundling the token here previously took the mint credential
 * down with it on every write, losing the session on cold restart.
 *
 * The `.v1` suffix lets a future shape change ship a `.v2` key without reading a
 * stale/incompatible `.v1` blob. Distinct from the `oxy_shared_*` keychain keys
 * in `KeyManager`, so it never collides.
 *
 * BACK-COMPAT: pre-split builds wrote the WHOLE state (including `accessToken` /
 * `expiresAt`) into this single key. `load()` still reads those token fields
 * from here when the warm key ({@link AUTH_STATE_TOKEN_STORAGE_KEY}) is absent,
 * so upgrading users are not signed out; the next `save()` splits them apart.
 */
export const AUTH_STATE_STORAGE_KEY = 'oxy.auth.v1';

/**
 * Versioned BEST-EFFORT warm-token storage key. Holds the short-lived
 * `{ accessToken, expiresAt }` pair only. Its write is genuinely non-fatal — a
 * failure (quota / oversize keychain value) is swallowed because the session is
 * fully re-mintable from the durable `deviceSecret`. Kept separate from
 * {@link AUTH_STATE_STORAGE_KEY} so a failed token write can NEVER abort or
 * corrupt the durable credential write.
 */
export const AUTH_STATE_TOKEN_STORAGE_KEY = 'oxy.auth.token.v1';

/**
 * Parse + shape-validate a stored blob. Returns `null` for anything that is
 * not a well-formed {@link PersistedAuthState} (absent, malformed JSON, wrong
 * types) so a corrupt entry degrades to "signed out" rather than throwing.
 */
function deserialize(raw: string | null): PersistedAuthState | null {
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
  const hasDeviceCredential =
    typeof candidate.deviceId === 'string' &&
    candidate.deviceId.length > 0 &&
    typeof candidate.deviceSecret === 'string' &&
    candidate.deviceSecret.length > 0;

  const hasSessionIdentity =
    typeof candidate.sessionId === 'string' &&
    typeof candidate.userId === 'string' &&
    candidate.sessionId.length > 0 &&
    candidate.userId.length > 0;

  // Device-only bootstrap (post join, pre-sign-in): durable credential without session.
  if (!hasSessionIdentity && !hasDeviceCredential) {
    return null;
  }

  const state: PersistedAuthState = {
    sessionId: hasSessionIdentity ? (candidate.sessionId as string) : '',
    userId: hasSessionIdentity ? (candidate.userId as string) : '',
  };
  if (typeof candidate.deviceId === 'string' && candidate.deviceId.length > 0) {
    state.deviceId = candidate.deviceId;
  }
  if (typeof candidate.deviceSecret === 'string' && candidate.deviceSecret.length > 0) {
    state.deviceSecret = candidate.deviceSecret;
  }
  if (typeof candidate.accessToken === 'string' && candidate.accessToken.length > 0) {
    state.accessToken = candidate.accessToken;
  }
  if (typeof candidate.expiresAt === 'string' && candidate.expiresAt.length > 0) {
    state.expiresAt = candidate.expiresAt;
  }
  return state;
}

/** The parsed warm-token blob: the short-lived optimization fields only. */
interface WarmToken {
  accessToken?: string;
  expiresAt?: string;
}

/**
 * Parse the best-effort warm-token blob. Returns `null` for anything not a
 * well-formed object so a corrupt warm entry simply forgoes the warm-boot
 * optimization (the durable credential re-mints a fresh token).
 */
function parseWarmToken(raw: string | null): WarmToken | null {
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
  const warm: WarmToken = {};
  if (typeof candidate.accessToken === 'string' && candidate.accessToken.length > 0) {
    warm.accessToken = candidate.accessToken;
  }
  if (typeof candidate.expiresAt === 'string' && candidate.expiresAt.length > 0) {
    warm.expiresAt = candidate.expiresAt;
  }
  return warm;
}

/** Serialize ONLY the small, re-mint-critical fields for the durable key. */
function serializeDurable(state: PersistedAuthState): string {
  const durable: Record<string, string> = {
    sessionId: state.sessionId,
    userId: state.userId,
  };
  if (state.deviceId) {
    durable.deviceId = state.deviceId;
  }
  if (state.deviceSecret) {
    durable.deviceSecret = state.deviceSecret;
  }
  return JSON.stringify(durable);
}

/**
 * Serialize the warm-token blob, or `null` when there is no token to persist
 * (so the caller clears the warm key rather than writing an empty object).
 */
function serializeWarmToken(state: PersistedAuthState): string | null {
  const warm: WarmToken = {};
  if (state.accessToken) {
    warm.accessToken = state.accessToken;
  }
  if (state.expiresAt) {
    warm.expiresAt = state.expiresAt;
  }
  if (!warm.accessToken && !warm.expiresAt) {
    return null;
  }
  return JSON.stringify(warm);
}

/**
 * Compose the unchanged {@link PersistedAuthState} return shape from the two
 * on-disk keys. `accessToken` / `expiresAt` come from the warm key when it is
 * present; when the warm key is ABSENT the token fields fall back to whatever
 * the durable blob carried — the pre-split combined `oxy.auth.v1` blob (BACK-COMPAT).
 */
function composeState(durableRaw: string | null, warmRaw: string | null): PersistedAuthState | null {
  const state = deserialize(durableRaw);
  if (!state) {
    return null;
  }
  if (warmRaw !== null) {
    // New split layout: the warm key is authoritative for the token fields.
    // Drop anything the durable blob may have carried, then overlay the warm
    // values (a warm key with no token → the session simply has no warm token).
    delete state.accessToken;
    delete state.expiresAt;
    const warm = parseWarmToken(warmRaw);
    if (warm?.accessToken) {
      state.accessToken = warm.accessToken;
    }
    if (warm?.expiresAt) {
      state.expiresAt = warm.expiresAt;
    }
  }
  // else: BACK-COMPAT — the warm key is absent, so `deserialize` already applied
  // any `accessToken` / `expiresAt` from the old combined blob.
  return state;
}

/**
 * A process-lifetime, in-memory {@link AuthStateStore}. Used directly for
 * tests/SSR and as the degraded fallback of the web store when `localStorage`
 * is unreachable. Not durable across reloads — that is acceptable for the
 * fallback because the alternative (throwing) would break cold boot entirely.
 */
export function createMemoryAuthStateStore(): AuthStateStore {
  let current: PersistedAuthState | null = null;
  return {
    load: async () => current,
    save: async (state) => {
      // Memory IS this store's durability backing — the write always lands.
      current = state;
      return true;
    },
    clear: async () => {
      current = null;
    },
  };
}

/**
 * Read the ambient `localStorage`, tolerating the case where merely ACCESSING
 * `window.localStorage` throws. In a sandboxed / cross-origin iframe the getter
 * itself raises `SecurityError` (not the method calls), so the access must be
 * inside the try. Returns `null` when storage is unavailable.
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
 * A `localStorage`-backed {@link AuthStateStore} split across the durable
 * {@link AUTH_STATE_STORAGE_KEY} (mint credential) and the best-effort
 * {@link AUTH_STATE_TOKEN_STORAGE_KEY} (warm access token).
 *
 * Resilience:
 *  - If `localStorage` is unreachable (sandboxed-iframe `SecurityError`, SSR),
 *    the whole store degrades to an in-memory {@link createMemoryAuthStateStore}
 *    for this page's lifetime — never throws on construction.
 *  - Individual `getItem`/`setItem`/`removeItem` are each wrapped: a read that
 *    throws yields `null`; a write that throws (quota, private mode) is
 *    swallowed. The re-mint lane treats a failed persist as "no durable state"
 *    rather than crashing.
 */
export function createWebAuthStateStore(): AuthStateStore {
  const storage = safeGetLocalStorage();
  if (!storage) {
    return createMemoryAuthStateStore();
  }
  // In-memory mirror so a FAILED persist (quota / private mode / locked store)
  // does not silently lose the session for this page's lifetime. `undefined`
  // means "never written this session" → fall back to storage; any set value
  // (including `null` after clear) is authoritative and preferred over storage.
  let sessionMirror: PersistedAuthState | null | undefined;
  return {
    load: async () => {
      if (sessionMirror !== undefined) {
        return sessionMirror;
      }
      try {
        return composeState(
          storage.getItem(AUTH_STATE_STORAGE_KEY),
          storage.getItem(AUTH_STATE_TOKEN_STORAGE_KEY),
        );
      } catch {
        return null;
      }
    },
    save: async (state) => {
      sessionMirror = state; // mirror FIRST — authoritative even if persist fails
      // Durable credential FIRST, then VERIFY it landed. The in-memory mirror
      // keeps the session live for this page, but a failed DURABLE write means
      // the mint credential will NOT survive a reload — surface it, never swallow.
      let durablePersisted = false;
      try {
        const durableJson = serializeDurable(state);
        storage.setItem(AUTH_STATE_STORAGE_KEY, durableJson);
        durablePersisted = storage.getItem(AUTH_STATE_STORAGE_KEY) === durableJson;
        if (!durablePersisted) {
          logger.error(
            '[authStateStore] durable credential read-back mismatch after save — the device credential did not persist; the session survives this process via the in-memory mirror but will be lost on reload',
            undefined,
            { component: 'authStateStore' },
          );
        }
      } catch (error) {
        logger.error(
          '[authStateStore] durable credential persist threw — the device credential did not persist; the session survives this process via the in-memory mirror but will be lost on reload',
          error,
          { component: 'authStateStore' },
        );
      }
      // Warm token AFTER, best-effort. Its failure is genuinely non-fatal (the
      // durable credential re-mints a fresh token) and must never abort or
      // corrupt the durable write above.
      try {
        const warmJson = serializeWarmToken(state);
        if (warmJson) {
          storage.setItem(AUTH_STATE_TOKEN_STORAGE_KEY, warmJson);
        } else {
          storage.removeItem(AUTH_STATE_TOKEN_STORAGE_KEY);
        }
      } catch {
        // Quota / private-mode / disabled storage — non-fatal warm-boot loss only.
      }
      // Report ONLY the durable-credential landing; the warm-token outcome above
      // is intentionally excluded (it is a best-effort optimization).
      return durablePersisted;
    },
    clear: async () => {
      sessionMirror = null;
      try {
        storage.removeItem(AUTH_STATE_STORAGE_KEY);
      } catch {
        // Non-fatal — see save().
      }
      try {
        storage.removeItem(AUTH_STATE_TOKEN_STORAGE_KEY);
      } catch {
        // Non-fatal — see save().
      }
    },
  };
}

/**
 * A native {@link AuthStateStore} over an injected async key/value store.
 *
 * `@oxy.so/core` never imports `expo-secure-store`; `@oxy.so/services` constructs
 * the SecureStore-backed adapter and passes it here. Persistence is split across
 * the durable {@link AUTH_STATE_STORAGE_KEY} (mint credential) and the
 * best-effort {@link AUTH_STATE_TOKEN_STORAGE_KEY} (warm access token) — the
 * durable write is read-back-verified and its failure surfaced (not swallowed),
 * while the warm-token write and all reads degrade gracefully exactly like the
 * web store.
 */
export function createNativeAuthStateStore(storage: NativeKeyValueStorage): AuthStateStore {
  // Same in-memory mirror as the web store — a locked/failed SecureStore write
  // must not silently lose the session for the app's lifetime.
  let sessionMirror: PersistedAuthState | null | undefined;
  return {
    load: async () => {
      if (sessionMirror !== undefined) {
        return sessionMirror;
      }
      try {
        const [durableRaw, warmRaw] = await Promise.all([
          storage.getItem(AUTH_STATE_STORAGE_KEY),
          storage.getItem(AUTH_STATE_TOKEN_STORAGE_KEY),
        ]);
        return composeState(durableRaw, warmRaw);
      } catch {
        return null;
      }
    },
    save: async (state) => {
      sessionMirror = state;
      // Durable credential FIRST, then VERIFY. On Android SecureStore an
      // oversize/failed write can resolve WITHOUT throwing, so a read-back is the
      // only reliable proof. The mirror keeps the session live for this app run,
      // but a failed DURABLE write means the mint credential will NOT survive a
      // cold restart — surface it, never swallow.
      let durablePersisted = false;
      try {
        const durableJson = serializeDurable(state);
        await storage.setItem(AUTH_STATE_STORAGE_KEY, durableJson);
        durablePersisted = (await storage.getItem(AUTH_STATE_STORAGE_KEY)) === durableJson;
        if (!durablePersisted) {
          logger.error(
            '[authStateStore] durable credential read-back mismatch after save — the device credential did not persist (likely oversize SecureStore value); the session survives this app run via the in-memory mirror but will be lost on cold restart',
            undefined,
            { component: 'authStateStore' },
          );
        }
      } catch (error) {
        logger.error(
          '[authStateStore] durable credential persist threw — the device credential did not persist; the session survives this app run via the in-memory mirror but will be lost on cold restart',
          error,
          { component: 'authStateStore' },
        );
      }
      // Warm token AFTER, best-effort. Its failure is genuinely non-fatal (the
      // durable credential re-mints a fresh token) and must never abort or
      // corrupt the durable write above.
      try {
        const warmJson = serializeWarmToken(state);
        if (warmJson) {
          await storage.setItem(AUTH_STATE_TOKEN_STORAGE_KEY, warmJson);
        } else {
          await storage.removeItem(AUTH_STATE_TOKEN_STORAGE_KEY);
        }
      } catch {
        // Locked / oversize keychain — non-fatal warm-boot loss only.
      }
      // Report ONLY the durable-credential landing; the warm-token outcome above
      // is intentionally excluded (it is a best-effort optimization).
      return durablePersisted;
    },
    clear: async () => {
      sessionMirror = null;
      try {
        await storage.removeItem(AUTH_STATE_STORAGE_KEY);
      } catch {
        // Non-fatal.
      }
      try {
        await storage.removeItem(AUTH_STATE_TOKEN_STORAGE_KEY);
      } catch {
        // Non-fatal.
      }
    },
  };
}
