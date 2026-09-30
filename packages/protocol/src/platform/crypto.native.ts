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
}

const LOWER_HEX = /^[0-9a-f]+$/;

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
async function ask<T>(call: () => Promise<unknown>, narrow: (value: unknown) => T | null): Promise<T | null> {
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
        describe: () => ask(() => m.describe(), narrowDescription),
        proveIdentity: (challenge: string) => ask(() => m.proveIdentity(challenge), narrowProof),
        deriveScopedSeed: (info: string) => ask(() => m.deriveScopedSeed(info), (v) => hexField(v, 64)),
        signSocialReceive: (index: number, digest: string) =>
          ask(() => m.signSocialReceive(index, digest), narrowSocialReceive),
      } satisfies CommonsIdentityBridge;
    });
  }
  return commonsIdentityBridgePromise;
}
