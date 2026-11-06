/**
 * Platform Crypto / Storage — React Native Variant
 *
 * Companion to `./crypto.ts`. See the doc-comment at the top of that file for
 * the full design.
 *
 * Metro auto-selects this file in any non-web build (`preferNativePlatform`
 * is `true` for iOS / Android, so `*.native.js` shadows `*.js` during
 * source-extension resolution inside `node_modules/@oxy.so/protocol/dist/`). On
 * iOS / Android `<base>.ios.js` / `<base>.android.js` would shadow this file
 * if they existed, but they don't — `.native.js` is the shared RN variant.
 *
 *   - The default variant references Node's `'crypto'` and would crash Metro
 *     if bundled into an RN app.
 *   - This variant references the RN-only modules (`expo-crypto`,
 *     `expo-secure-store`, `@react-native-async-storage/async-storage`),
 *     each behind Metro's optional-dependency mechanism (see below).
 *
 * Both variants expose the same surface; importers don't care which one
 * they got.
 *
 * # Why `try { require('literal') } catch` and not a static import?
 *
 * Those three RN modules are declared OPTIONAL peer dependencies in
 * `package.json`. A static `import` contradicts that: an optional peer that is
 * omitted does not degrade, it fails to RESOLVE, and Metro aborts the whole
 * bundle. Because `@oxy.so/core` imports `@oxy.so/protocol`
 * from its root entry, this file is in the eager graph of EVERY React Native
 * app on `@oxy.so/core` — so a single undeclared optional peer broke the native
 * bundle of every app that did not happen to install it, with a resolution
 * error pointing at a dependency the app never mentions.
 *
 * Metro treats a `require()` of a STRING LITERAL that sits inside a `try`
 * block as an optional dependency: it resolves it when present, and when
 * absent emits a stub that throws on evaluation instead of failing the build.
 * The `catch` turns that into a `null` module handle, and the loader below
 * throws an actionable error naming the missing package the first time the
 * capability is actually used. Bundle-time hard failure becomes a
 * capability-scoped runtime failure — which is exactly what "optional peer"
 * is supposed to mean.
 *
 * Two constraints this shape has to respect, both learned the hard way:
 *
 *   - The specifier MUST be a literal. A runtime-computed `require(variable)`
 *     is unresolvable for Metro (that is the bug the shared-identity bridge
 *     below documents) and silently yields nothing in a consuming repo.
 *   - The load MUST stay synchronous. `getRandomBytesRN` backs
 *     `globalThis.crypto.getRandomValues` in `@oxy.so/core`'s polyfill, which
 *     cannot await anything.
 *
 * `expo-modules-core` is a NON-optional peer (every RN app has it via `expo`),
 * so it stays a plain static import.
 */

import { requireOptionalNativeModule } from 'expo-modules-core';
import type {
  CommonsIdentityBridge,
  CommonsIdentityDescription,
  CommonsIdentityProof,
  CommonsSocialReceiveSignature,
  ExpoCryptoLike,
  ExpoSecureStoreLike,
  KeychainApplicationAccessGroup,
  KeychainDefaultAccessGroup,
  KeychainReadWithoutInteraction,
} from './expoTypes';
import { missingOptionalPeerError } from './optionalPeer';
import { requireExpoCrypto } from './random.native';

// Re-export the interfaces so consumers can import them from the same
// entry-point they use for the loaders (mirrors the default variant).
export type {
  CommonsIdentityBridge,
  CommonsIdentityDescription,
  CommonsIdentityProof,
  CommonsSocialReceiveSignature,
  ExpoCryptoLike,
  ExpoSecureStoreLike,
  KeychainApplicationAccessGroup,
  KeychainDefaultAccessGroup,
  KeychainReadWithoutInteraction,
};

// ---------------------------------------------------------------------------
// Optional peer resolution.
//
// `require` is declared locally rather than pulled from `@types/node`'s global:
// this file only ever runs under Metro, and the local declaration returns
// `unknown` so every module handle is narrowed explicitly instead of leaking
// `any` from `NodeRequire`.
// ---------------------------------------------------------------------------

declare const require: (moduleName: string) => unknown;

/** Persistent KV storage surface used from `@react-native-async-storage/async-storage`. */
type AsyncStorageLike = {
  getItem: (key: string) => Promise<string | null>;
  setItem: (key: string, value: string) => Promise<void>;
  removeItem: (key: string) => Promise<void>;
};

let secureStoreModule: ExpoSecureStoreLike | null = null;
let secureStoreError: unknown;
try {
  secureStoreModule = require('expo-secure-store') as ExpoSecureStoreLike;
} catch (error) {
  secureStoreError = error;
}

let asyncStorageModule: AsyncStorageLike | null = null;
let asyncStorageError: unknown;
try {
  // Babel's default-import interop unwraps `.default` for us on a static
  // import; a raw `require` has to do it by hand. The `?? namespace` fallback
  // covers a host that hands back a real ESM namespace with no `default`.
  const namespace = require('@react-native-async-storage/async-storage') as AsyncStorageLike & {
    default?: AsyncStorageLike;
  };
  asyncStorageModule = namespace.default ?? namespace;
} catch (error) {
  asyncStorageError = error;
}

// ---------------------------------------------------------------------------
// Node `crypto` — never available in RN.
// ---------------------------------------------------------------------------

export async function loadNodeCrypto(): Promise<typeof import('crypto')> {
  // Unreachable in practice: every caller gates with `isNodeJS()` before
  // invoking this. If it somehow does fire, throw immediately with a clear
  // diagnostic rather than letting Metro / Hermes attempt to find a
  // non-existent module at runtime.
  throw new Error(
    "[oxy.protocol.crypto] Node's built-in 'crypto' module is not available " +
      'in a React Native runtime. Use the RN-specific helpers ' +
      '(loadExpoCrypto, getRandomBytesRN) or the Web Crypto API (`globalThis.crypto`).',
  );
}

// ---------------------------------------------------------------------------
// expo-crypto — RN cryptographic primitives.
//
// The real module satisfies `ExpoCryptoLike` structurally; the structural
// interface narrows the surface so consumers never pull expo's own types into
// their compilation (see expoTypes.ts).
// ---------------------------------------------------------------------------

export async function loadExpoCrypto(): Promise<ExpoCryptoLike> {
  return requireExpoCrypto('React Native cryptography');
}

// ---------------------------------------------------------------------------
// expo-secure-store — RN keychain / keystore.
// ---------------------------------------------------------------------------

export async function loadSecureStore(): Promise<ExpoSecureStoreLike> {
  if (!secureStoreModule) {
    throw missingOptionalPeerError(
      'expo-secure-store',
      'on-device identity storage',
      secureStoreError,
    );
  }
  return secureStoreModule;
}

// ---------------------------------------------------------------------------
// @react-native-async-storage/async-storage — RN persistent KV storage.
// ---------------------------------------------------------------------------

export async function loadAsyncStorage(): Promise<{ default: AsyncStorageLike }> {
  if (!asyncStorageModule) {
    throw missingOptionalPeerError(
      '@react-native-async-storage/async-storage',
      'device/session persistence',
      asyncStorageError,
    );
  }
  // Mirror the shape callers historically used (`module.default.<method>`)
  // so the call sites don't have to know whether the underlying module
  // ships ESM or CJS-with-default.
  return { default: asyncStorageModule };
}

// Synchronous random bytes (and the single `expo-crypto` resolution) live in
// the dependency-free `./random.native` module, so `@oxy.so/core`'s crypto
// polyfill can load them through `@oxy.so/protocol/random` without evaluating
// any crypto library first. The explicit `.native` specifier keeps tsc and
// Metro pointed at the same file.
export { getRandomBytesRN } from './random.native';

// ---------------------------------------------------------------------------
// Commons identity bridge — the `OxyIdentity` native module in
// `@oxy.so/services` (native-only, OPTIONAL).
//
// Resolved through expo-modules-core's `requireOptionalNativeModule`, a static
// import Metro always resolves, never through a runtime-computed
// `import(moduleName)`: that compiles to `require(variable)` in the CJS build,
// which Metro cannot resolve in a consuming repo (the bridge silently resolved
// `null` there once). `requireOptionalNativeModule` returns `null` when the
// module is not autolinked (web, or an app without `@oxy.so/services`).
//
// Everything the native side returns is UNTRUSTED here: it crossed a process
// boundary. Each answer is narrowed to its exact shape, and anything else is
// `null` ("Commons could not help"), never a partial value.
// ---------------------------------------------------------------------------

interface OxyIdentityNativeModule {
  describe(): Promise<unknown>;
  proveIdentity(challenge: string): Promise<unknown>;
  deriveScopedSeed(info: string): Promise<unknown>;
  signSocialReceive(index: number, digest: string): Promise<unknown>;
  /**
   * Organization keys (ADR 0061 D6), added in `@oxy.so/services` after the four
   * above: an older native module lacks them, and every organization request
   * then answers `null`, never the personal identity. Each answer echoes the
   * `accountId` Commons answered for.
   */
  describeOrganization?(accountId: string): Promise<unknown>;
  deriveOrganizationScopedSeed?(info: string, accountId: string): Promise<unknown>;
  signOrganizationSocialReceive?(
    index: number,
    digest: string,
    accountId: string,
  ): Promise<unknown>;
  /**
   * iOS only, added with the keychain access-group split: the access group a
   * probe item written WITHOUT a group landed in (the app's default group).
   * Older native modules and Android lack it.
   */
  keychainDefaultAccessGroup?(): Promise<unknown>;
  /**
   * iOS only, added after the default-group probe (ADR 0062 D6): writes a
   * probe item into `<prefix><bundle id>` explicitly and answers that group,
   * or `null` when the keychain refused it as not entitled. Older native
   * modules and Android lack it.
   */
  keychainApplicationAccessGroup?(prefix: string): Promise<unknown>;
  /**
   * iOS only, added in round 5 (R5-9): read one expo-secure-store item without
   * user interaction, never its `:auth` copy. Older native modules and Android
   * lack it.
   */
  readKeychainItemWithoutInteraction?(
    key: string,
    service: string | null,
    accessGroup: string,
  ): Promise<unknown>;
  /**
   * Retired keys (Commons protocol 4), added after the organization methods and
   * just as absent on an older native module. `accountId` is `null` for the
   * person. Each answer echoes the `keyPublicKey` (and the `accountId`) Commons
   * answered for.
   */
  listRetiredKeys?(accountId: string | null): Promise<unknown>;
  deriveRetiredScopedSeed?(
    info: string,
    publicKey: string,
    accountId: string | null,
  ): Promise<unknown>;
  signRetiredSocialReceive?(
    index: number,
    digest: string,
    publicKey: string,
    accountId: string | null,
  ): Promise<unknown>;
}

const LOWER_HEX = /^[0-9a-f]+$/;
/** A lowercase uncompressed SEC1 public key, as Commons names every key it holds. */
const PUBLIC_KEY = /^04[0-9a-f]{128}$/;

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

function hexField(value: unknown, length?: number): string | null {
  if (typeof value !== 'string' || !LOWER_HEX.test(value)) return null;
  if (length !== undefined && value.length !== length) return null;
  return value;
}

function narrowDescription(value: unknown): CommonsIdentityDescription | null {
  const r = record(value);
  const publicKey = hexField(r?.publicKey, 130);
  const v = typeof r?.v === 'number' ? r.v : Number(r?.v);
  if (!publicKey || !Number.isInteger(v)) return null;
  return { v, publicKey };
}

/**
 * The organization answer must name the organization asked for. A Commons that
 * predates organization keys ignores the `accountId` extra and answers for the
 * PERSONAL identity, without an echo; that answer is refused here, because a
 * personal key taken for an organization's is money sent to the wrong person.
 */
function echoes(value: unknown, accountId: string): Record<string, unknown> | null {
  const r = record(value);
  return r && r.accountId === accountId ? r : null;
}

function narrowOrganizationDescription(
  value: unknown,
  accountId: string,
): CommonsIdentityDescription | null {
  const description = narrowDescription(echoes(value, accountId));
  return description ? { ...description, accountId } : null;
}

/**
 * A retired-key answer must name the key asked for, and the scope asked for:
 * the organization's `accountId`, or none for the person. A Commons before
 * protocol 4 ignores `keyPublicKey` and answers with the CURRENT key, without
 * the echo; that answer is refused here.
 */
function echoesRetired(
  value: unknown,
  publicKey: string,
  accountId: string | undefined,
): Record<string, unknown> | null {
  const r = record(value);
  if (!r || r.keyPublicKey !== publicKey) return null;
  return (r.accountId ?? undefined) === accountId ? r : null;
}

/**
 * The list must be every entry a well-formed public key: one malformed entry
 * means an answer this side does not understand, and the whole answer is
 * `null` rather than a list missing a key the wallet would then never sweep.
 */
function narrowRetiredKeys(value: unknown, accountId: string | undefined): string[] | null {
  const r = record(value);
  if (!r || (r.accountId ?? undefined) !== accountId) return null;
  const keys = r.publicKeys;
  if (!Array.isArray(keys)) return null;
  const out: string[] = [];
  for (const key of keys) {
    if (typeof key !== 'string' || !PUBLIC_KEY.test(key)) return null;
    if (!out.includes(key)) out.push(key);
  }
  return out;
}

function narrowProof(value: unknown): CommonsIdentityProof | null {
  const r = record(value);
  const publicKey = hexField(r?.publicKey, 130);
  const signature = hexField(r?.signature);
  const timestamp = typeof r?.timestamp === 'number' ? r.timestamp : Number(r?.timestamp);
  if (!publicKey || !signature || !Number.isSafeInteger(timestamp) || timestamp <= 0) return null;
  return { publicKey, signature, timestamp };
}

function narrowSocialReceive(value: unknown): CommonsSocialReceiveSignature | null {
  const r = record(value);
  const signature = hexField(r?.signature);
  const publicKey = hexField(r?.publicKey, 66);
  if (!signature || !publicKey) return null;
  return { signature, publicKey };
}

/** Run one native call; a rejection or an unexpected shape is `null`. */
async function ask<T>(
  call: () => Promise<unknown>,
  narrow: (value: unknown) => T | null,
): Promise<T | null> {
  try {
    return narrow(await call());
  } catch {
    return null;
  }
}

let commonsIdentityBridgePromise: Promise<CommonsIdentityBridge | null> | null = null;

export function loadCommonsIdentityBridge(): Promise<CommonsIdentityBridge | null> {
  if (!commonsIdentityBridgePromise) {
    commonsIdentityBridgePromise = Promise.resolve().then(() => {
      const native = requireOptionalNativeModule<Partial<OxyIdentityNativeModule>>('OxyIdentity');
      if (
        !native ||
        typeof native.describe !== 'function' ||
        typeof native.proveIdentity !== 'function' ||
        typeof native.deriveScopedSeed !== 'function' ||
        typeof native.signSocialReceive !== 'function'
      ) {
        return null;
      }
      const m = native as OxyIdentityNativeModule;
      return {
        describe: (accountId?: string) => {
          if (accountId === undefined) return ask(() => m.describe(), narrowDescription);
          const describeOrganization = m.describeOrganization;
          if (typeof describeOrganization !== 'function') return Promise.resolve(null);
          return ask(
            () => describeOrganization.call(m, accountId),
            (v) => narrowOrganizationDescription(v, accountId),
          );
        },
        proveIdentity: (challenge: string) => ask(() => m.proveIdentity(challenge), narrowProof),
        deriveScopedSeed: (info: string, accountId?: string) => {
          if (accountId === undefined) {
            return ask(
              () => m.deriveScopedSeed(info),
              (v) => hexField(v, 64),
            );
          }
          const derive = m.deriveOrganizationScopedSeed;
          if (typeof derive !== 'function') return Promise.resolve(null);
          return ask(
            () => derive.call(m, info, accountId),
            (v) => hexField(echoes(v, accountId)?.seed, 64),
          );
        },
        signSocialReceive: (index: number, digest: string, accountId?: string) => {
          if (accountId === undefined) {
            return ask(() => m.signSocialReceive(index, digest), narrowSocialReceive);
          }
          const sign = m.signOrganizationSocialReceive;
          if (typeof sign !== 'function') return Promise.resolve(null);
          return ask(
            () => sign.call(m, index, digest, accountId),
            (v) => narrowSocialReceive(echoes(v, accountId)),
          );
        },
        listRetiredKeys: (accountId?: string) => {
          const list = m.listRetiredKeys;
          if (typeof list !== 'function') return Promise.resolve(null);
          return ask(
            () => list.call(m, accountId ?? null),
            (v) => narrowRetiredKeys(v, accountId),
          );
        },
        deriveRetiredScopedSeed: (info: string, publicKey: string, accountId?: string) => {
          const derive = m.deriveRetiredScopedSeed;
          if (typeof derive !== 'function' || !PUBLIC_KEY.test(publicKey)) {
            return Promise.resolve(null);
          }
          return ask(
            () => derive.call(m, info, publicKey, accountId ?? null),
            (v) => hexField(echoesRetired(v, publicKey, accountId)?.seed, 64),
          );
        },
        signRetiredSocialReceive: (
          index: number,
          digest: string,
          publicKey: string,
          accountId?: string,
        ) => {
          const sign = m.signRetiredSocialReceive;
          if (typeof sign !== 'function' || !PUBLIC_KEY.test(publicKey)) {
            return Promise.resolve(null);
          }
          return ask(
            () => sign.call(m, index, digest, publicKey, accountId ?? null),
            (v) => narrowSocialReceive(echoesRetired(v, publicKey, accountId)),
          );
        },
      } satisfies CommonsIdentityBridge;
    });
  }
  return commonsIdentityBridgePromise;
}

// ---------------------------------------------------------------------------
// iOS keychain default access group (docs/identity/ios-keychain-access-groups.md).
//
// Resolved once the native module answers; an `unavailable` probe (a thrown
// call: before first unlock, or the keychain refused) is not memoized, so the
// next caller asks again. The answer is narrowed to a plain string — it crossed
// the native boundary.
// ---------------------------------------------------------------------------

/** `<prefix>.<group>`: an App ID prefix (no dots) then a non-empty group. */
const ACCESS_GROUP = /^[A-Za-z0-9]+\.[A-Za-z0-9.-]+$/;

let keychainDefaultAccessGroup: KeychainDefaultAccessGroup | null = null;

export async function loadKeychainDefaultAccessGroup(): Promise<KeychainDefaultAccessGroup> {
  if (keychainDefaultAccessGroup) {
    return keychainDefaultAccessGroup;
  }
  const native = requireOptionalNativeModule<Partial<OxyIdentityNativeModule>>('OxyIdentity');
  const probe = native?.keychainDefaultAccessGroup;
  if (!native || typeof probe !== 'function') {
    keychainDefaultAccessGroup = { state: 'unsupported' };
    return keychainDefaultAccessGroup;
  }
  let answer: unknown;
  try {
    answer = await probe.call(native);
  } catch (cause) {
    return { state: 'unavailable', cause };
  }
  if (answer === null || answer === undefined) {
    // The native side runs only on iOS; anything else answers nothing.
    keychainDefaultAccessGroup = { state: 'unsupported' };
    return keychainDefaultAccessGroup;
  }
  if (typeof answer !== 'string' || !ACCESS_GROUP.test(answer)) {
    return {
      state: 'unavailable',
      cause: new Error('keychain probe answered something that is not an access group'),
    };
  }
  keychainDefaultAccessGroup = { state: 'resolved', accessGroup: answer };
  return keychainDefaultAccessGroup;
}

// ---------------------------------------------------------------------------
// iOS keychain application access group (ADR 0062 D6): `<prefix><bundle id>`,
// the group every app is a member of and no other app can name — where an app
// keeps the items that are its alone. Same caching as the default group: a
// resolved or unsupported answer is constant for the binary; a thrown probe is
// asked again.
// ---------------------------------------------------------------------------

/** A team prefix as the default group carries it: no dots, then one dot. */
const KEYCHAIN_PREFIX = /^[A-Za-z0-9]+\.$/;

let keychainApplicationAccessGroup: KeychainApplicationAccessGroup | null = null;

export async function loadKeychainApplicationAccessGroup(
  prefix: string,
): Promise<KeychainApplicationAccessGroup> {
  if (keychainApplicationAccessGroup) {
    return keychainApplicationAccessGroup;
  }
  if (!KEYCHAIN_PREFIX.test(prefix)) {
    return {
      state: 'unavailable',
      cause: new Error('keychain application group probe needs a team prefix'),
    };
  }
  const native = requireOptionalNativeModule<Partial<OxyIdentityNativeModule>>('OxyIdentity');
  const probe = native?.keychainApplicationAccessGroup;
  if (!native || typeof probe !== 'function') {
    keychainApplicationAccessGroup = { state: 'unsupported' };
    return keychainApplicationAccessGroup;
  }
  let answer: unknown;
  try {
    answer = await probe.call(native, prefix);
  } catch (cause) {
    return { state: 'unavailable', cause };
  }
  if (answer === null || answer === undefined) {
    // Not entitled (or not iOS): this binary keeps the placement it was built for.
    keychainApplicationAccessGroup = { state: 'unsupported' };
    return keychainApplicationAccessGroup;
  }
  if (typeof answer !== 'string' || !answer.startsWith(prefix) || !ACCESS_GROUP.test(answer)) {
    // A native bug, not a locked keychain: asking again would answer the same,
    // and `unavailable` would leave the app without storage. Keep the
    // placement this build had before the probe existed.
    return { state: 'unsupported' };
  }
  keychainApplicationAccessGroup = { state: 'resolved', accessGroup: answer };
  return keychainApplicationAccessGroup;
}

// ---------------------------------------------------------------------------
// iOS keychain read without user interaction (R5-9). `null` when the native
// module predates it (or off iOS): the caller then reads through
// expo-secure-store, as before. The answer crossed the native boundary, so only
// a string or `null` is accepted.
// ---------------------------------------------------------------------------

export async function loadKeychainReadWithoutInteraction(): Promise<KeychainReadWithoutInteraction | null> {
  const native = requireOptionalNativeModule<Partial<OxyIdentityNativeModule>>('OxyIdentity');
  const read = native?.readKeychainItemWithoutInteraction;
  if (!native || typeof read !== 'function') return null;
  return async (key, service, accessGroup) => {
    const answer: unknown = await read.call(native, key, service ?? null, accessGroup);
    if (answer === null || answer === undefined) return null;
    if (typeof answer !== 'string') {
      throw new Error('keychain read answered something that is not a string');
    }
    return answer;
  };
}
