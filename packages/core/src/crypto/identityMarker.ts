/**
 * Identity marker — a NON-secret, AndroidKeyStore-independent record that an
 * identity exists (or existed) on this device.
 *
 * WHY THIS EXISTS: the identity private/public keys live in expo-secure-store,
 * whose Android backing (a single `key_v1` AndroidKeyStore key by default) can be
 * invalidated by an OS/vendor keystore event. When that happens SDK 57's
 * expo-secure-store DELETES the undecryptable ciphertext on the read path and
 * returns `null` — indistinguishable, from the keys alone, from a genuinely
 * fresh install. That ambiguity is what lets a real identity get silently
 * replaced by the onboarding "create" flow.
 *
 * The marker breaks the tie. It is written to AsyncStorage (RN) / localStorage
 * (web) — storage that is NOT protected by the identity's AndroidKeyStore key —
 * so it SURVIVES a keystore death. `getIdentityStatus()` reads it: keys empty +
 * marker present ⇒ `lost` (route to recovery, NEVER welcome/create); keys empty
 * + no marker ⇒ `absent` (the only path to fresh onboarding).
 *
 * It holds only the PUBLIC key plus provenance metadata — never any secret — so
 * persisting it in plain KV storage adds no exposure.
 *
 * Every operation fails OPEN (returns null / false / resolves): the marker is a
 * best-effort disambiguation signal layered on top of the authoritative
 * secure-store reads, never a gate that can itself lock the user out.
 *
 * ESM-safe (no `require()`); zero React/RN static imports — the RN AsyncStorage
 * module is reached only through `@oxy.so/protocol`'s per-platform dynamic loader.
 */

import { loadAsyncStorage } from '@oxy.so/protocol';
import { createLogger } from '../logger';

const log = createLogger('IdentityMarker');

/**
 * AsyncStorage / localStorage key holding the serialized {@link IdentityMarker}.
 * `.v1` lets a future shape change ship a `.v2` key without misreading a stale
 * blob. Distinct from every `oxy_identity_*` secure-store key so it never
 * collides with the keychain material it disambiguates.
 */
export const IDENTITY_MARKER_STORAGE_KEY = 'oxy_identity_marker_v1';

/**
 * A durable, non-secret record that an identity was provisioned on this device.
 *
 * `publicKey` is the identity's public key (NOT secret) — it lets recovery
 * validate that whatever it restores is the SAME account this marker records,
 * never a silent account switch. `origin` records how the identity came to be.
 * `onboardingComplete` mirrors the onboarding milestone (Workstream 3.4) so a
 * lost SecureStore milestone flag cannot re-route a real identity into the
 * onboarding wizard.
 */
export interface IdentityMarker {
  v: 1;
  /** The identity's PUBLIC key — never secret. */
  publicKey: string;
  createdAt: number;
  origin: 'create' | 'import' | 'restore' | 'backfill';
  /** Milestone mirror: `true` once onboarding has completed for this identity. */
  onboardingComplete?: boolean;
}

/** Minimal async KV surface the marker needs (AsyncStorage + localStorage both satisfy it). */
interface MarkerKeyValueStorage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}

/** RN detection identical to `DeviceManager` — chooses AsyncStorage vs localStorage. */
function isReactNative(): boolean {
  return typeof navigator !== 'undefined' && navigator.product === 'ReactNative';
}

/**
 * Resolve the platform KV store, or `null` when none is reachable (SSR, a
 * sandboxed iframe whose `localStorage` getter throws, AsyncStorage not linked).
 * A `null` store makes every marker operation a no-op that fails open.
 */
async function getStorage(): Promise<MarkerKeyValueStorage | null> {
  try {
    if (isReactNative()) {
      // `loadAsyncStorage` is per-platform: the RN variant statically imports
      // @react-native-async-storage/async-storage; the default variant throws
      // (never reached here because of the `isReactNative()` gate).
      const asyncStorageModule = await loadAsyncStorage();
      const storage = asyncStorageModule.default;
      return {
        getItem: storage.getItem.bind(storage),
        setItem: storage.setItem.bind(storage),
        removeItem: storage.removeItem.bind(storage),
      };
    }
    // Web: read `localStorage` through a try — merely ACCESSING it can throw a
    // `SecurityError` in a sandboxed/cross-origin iframe.
    if (typeof globalThis !== 'undefined') {
      const ls = (globalThis as { localStorage?: Storage }).localStorage;
      if (ls) {
        return {
          getItem: async (key: string) => ls.getItem(key),
          setItem: async (key: string, value: string) => {
            ls.setItem(key, value);
          },
          removeItem: async (key: string) => {
            ls.removeItem(key);
          },
        };
      }
    }
    return null;
  } catch (error) {
    log.warn('Identity marker storage is unavailable', undefined, error);
    return null;
  }
}

/**
 * Parse + shape-validate a stored blob. Returns `null` for anything that is not
 * a well-formed {@link IdentityMarker} so a corrupt/foreign entry degrades to
 * "no marker" rather than throwing.
 */
function deserialize(raw: string | null): IdentityMarker | null {
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
  if (candidate.v !== 1) {
    return null;
  }
  if (typeof candidate.publicKey !== 'string' || candidate.publicKey.length === 0) {
    return null;
  }
  if (typeof candidate.createdAt !== 'number' || !Number.isFinite(candidate.createdAt)) {
    return null;
  }
  const origin = candidate.origin;
  if (origin !== 'create' && origin !== 'import' && origin !== 'restore' && origin !== 'backfill') {
    return null;
  }
  const marker: IdentityMarker = {
    v: 1,
    publicKey: candidate.publicKey,
    createdAt: candidate.createdAt,
    origin,
  };
  if (typeof candidate.onboardingComplete === 'boolean') {
    marker.onboardingComplete = candidate.onboardingComplete;
  }
  return marker;
}

/** Fields accepted when creating a marker; `createdAt` defaults to now. */
export interface WriteIdentityMarkerInput {
  publicKey: string;
  origin: IdentityMarker['origin'];
  createdAt?: number;
  onboardingComplete?: boolean;
}

/**
 * Read the identity marker. Fails OPEN: returns `null` on any storage error,
 * missing entry, or malformed blob — the caller treats "no marker" as the safe
 * default (fresh install), and the authoritative secure-store read decides the
 * rest.
 */
export async function readIdentityMarker(): Promise<IdentityMarker | null> {
  const storage = await getStorage();
  if (!storage) {
    return null;
  }
  try {
    return deserialize(await storage.getItem(IDENTITY_MARKER_STORAGE_KEY));
  } catch (error) {
    log.warn('Failed to read identity marker', undefined, error);
    return null;
  }
}

/**
 * Write (create/replace) the marker. Returns `true` when it durably landed,
 * `false` when storage was unavailable or the write threw. Callers treat a
 * `false` as non-fatal — the marker is best-effort and a subsequent read
 * re-backfills it from the healthy key pair.
 */
export async function writeIdentityMarker(input: WriteIdentityMarkerInput): Promise<boolean> {
  const storage = await getStorage();
  if (!storage) {
    return false;
  }
  const marker: IdentityMarker = {
    v: 1,
    publicKey: input.publicKey,
    createdAt: input.createdAt ?? Date.now(),
    origin: input.origin,
  };
  if (typeof input.onboardingComplete === 'boolean') {
    marker.onboardingComplete = input.onboardingComplete;
  }
  try {
    await storage.setItem(IDENTITY_MARKER_STORAGE_KEY, JSON.stringify(marker));
    return true;
  } catch (error) {
    log.warn('Failed to write identity marker', undefined, error);
    return false;
  }
}

/**
 * Merge a partial update into the existing marker, preserving every field the
 * caller does not override (notably `createdAt` and `onboardingComplete`). When
 * no marker exists yet, a partial carrying at least `publicKey` + `origin`
 * creates one; otherwise the update is a no-op returning `false`.
 *
 * Used to (a) mirror the onboarding milestone (`{ onboardingComplete: true }`)
 * without disturbing provenance, and (b) refresh `origin` on a same-identity
 * re-persist without resetting `createdAt`.
 */
export async function updateIdentityMarker(
  partial: Partial<Omit<IdentityMarker, 'v'>>,
): Promise<boolean> {
  const storage = await getStorage();
  if (!storage) {
    return false;
  }
  let existing: IdentityMarker | null = null;
  try {
    existing = deserialize(await storage.getItem(IDENTITY_MARKER_STORAGE_KEY));
  } catch (error) {
    log.warn('Failed to read identity marker before update', undefined, error);
    existing = null;
  }

  if (!existing) {
    if (typeof partial.publicKey === 'string' && partial.publicKey.length > 0 && partial.origin) {
      return writeIdentityMarker({
        publicKey: partial.publicKey,
        origin: partial.origin,
        createdAt: partial.createdAt,
        onboardingComplete: partial.onboardingComplete,
      });
    }
    return false;
  }

  const nextOnboarding =
    partial.onboardingComplete !== undefined ? partial.onboardingComplete : existing.onboardingComplete;
  const next: IdentityMarker = {
    v: 1,
    publicKey: partial.publicKey ?? existing.publicKey,
    createdAt: partial.createdAt ?? existing.createdAt,
    origin: partial.origin ?? existing.origin,
  };
  if (typeof nextOnboarding === 'boolean') {
    next.onboardingComplete = nextOnboarding;
  }
  try {
    await storage.setItem(IDENTITY_MARKER_STORAGE_KEY, JSON.stringify(next));
    return true;
  } catch (error) {
    log.warn('Failed to update identity marker', undefined, error);
    return false;
  }
}

/**
 * Remove the marker. Called ONLY after the identity's keys have been
 * successfully deleted (`KeyManager.deleteIdentity`), so a marker never outlives
 * the identity it records. Fails open (swallows errors) — a leftover marker
 * simply routes a truly-absent identity to `recovery` instead of `welcome`,
 * which is the safe direction.
 */
export async function clearIdentityMarker(): Promise<void> {
  const storage = await getStorage();
  if (!storage) {
    return;
  }
  try {
    await storage.removeItem(IDENTITY_MARKER_STORAGE_KEY);
  } catch (error) {
    log.warn('Failed to clear identity marker', undefined, error);
  }
}
