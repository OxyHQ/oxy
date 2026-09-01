/**
 * Platform Crypto / Storage — React Native Variant
 *
 * Companion to `./crypto.ts`. See the doc-comment at the top of that file for
 * the full design.
 *
 * Metro auto-selects this file in any non-web build (`preferNativePlatform`
 * is `true` for iOS / Android, so `*.native.js` shadows `*.js` during
 * source-extension resolution inside `node_modules/@oxyhq/protocol/dist/`). On
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
 * bundle. Because `@oxyhq/core`'s `crypto/polyfill` imports `@oxyhq/protocol`
 * from its root entry, this file is in the eager graph of EVERY React Native
 * app on `@oxyhq/core` — so a single undeclared optional peer broke the native
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
 *     `globalThis.crypto.getRandomValues` in `@oxyhq/core`'s polyfill, which
 *     cannot await anything.
 *
 * `expo-modules-core` is a NON-optional peer (every RN app has it via `expo`),
 * so it stays a plain static import.
 */

import { requireOptionalNativeModule } from 'expo-modules-core';
import type { ExpoCryptoLike, ExpoSecureStoreLike, SharedIdentityBridge } from './expoTypes';

// Re-export the interfaces so consumers can import them from the same
// entry-point they use for the loaders (mirrors the default variant).
export type { ExpoCryptoLike, ExpoSecureStoreLike, SharedIdentityBridge };

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

let expoCryptoModule: ExpoCryptoLike | null = null;
let expoCryptoError: unknown;
try {
  expoCryptoModule = require('expo-crypto') as ExpoCryptoLike;
} catch (error) {
  expoCryptoError = error;
}

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

/**
 * Actionable error for a missing optional peer. Carries the underlying Metro
 * resolution message so the failure is never silent — the `catch` above only
 * defers the report to the point where the capability is actually needed.
 */
function missingOptionalPeerError(packageName: string, capability: string, cause: unknown): Error {
  const sentences = [
    `[oxy.protocol.crypto] '${packageName}' is not installed, so ${capability} is unavailable in this app.`,
    'It is an optional peer dependency of @oxyhq/protocol that the React Native runtime needs —',
    `install it with \`npx expo install ${packageName}\`.`,
  ];
  if (cause instanceof Error) {
    sentences.push(`Underlying error: ${cause.message}`);
  }
  return new Error(sentences.join(' '));
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
  if (!expoCryptoModule) {
    throw missingOptionalPeerError('expo-crypto', 'React Native cryptography', expoCryptoError);
  }
  return expoCryptoModule;
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

/**
 * Synchronous random-bytes via `expo-crypto.getRandomBytes`.
 *
 * Synchronous by contract: `@oxyhq/core`'s crypto polyfill uses this to back
 * `globalThis.crypto.getRandomValues`, which cannot await. That is why
 * `expo-crypto` is resolved with a synchronous `require` at module scope rather
 * than a dynamic `import()`.
 */
export function getRandomBytesRN(byteCount: number): Uint8Array {
  if (!expoCryptoModule) {
    throw missingOptionalPeerError(
      'expo-crypto',
      'the React Native CSPRNG (crypto.getRandomValues)',
      expoCryptoError,
    );
  }
  return expoCryptoModule.getRandomBytes(byteCount);
}

// ---------------------------------------------------------------------------
// Shared identity bridge — `@oxyhq/expo-oxy-identity` (native-only, OPTIONAL).
//
// `@oxyhq/expo-oxy-identity` is the in-repo Expo module autolinked into the
// identity apps (Commons + the reader RPs). We resolve its NATIVE module
// directly via expo-modules-core's `requireOptionalNativeModule('OxyIdentity')`
// — a static import Metro always resolves — instead of dynamically importing the
// module's JS wrapper. A runtime-computed `import(moduleName)` compiled to a
// `require(variable)` in the CJS build, which Metro cannot resolve in a consuming
// repo (the bridge silently resolved `null` there — the cross-app SSO bug). Since
// the native module is what actually holds the shared identity, going through the
// native registry is both correct and Metro-safe. `requireOptionalNativeModule`
// returns `null` (never throws) when the module is not autolinked (web, or apps
// that don't ship it), so `@oxyhq/core`'s `KeyManager` cleanly falls back to its
// package-private store.
// ---------------------------------------------------------------------------

let sharedIdentityBridgePromise: Promise<SharedIdentityBridge | null> | null = null;

export function loadSharedIdentityBridge(): Promise<SharedIdentityBridge | null> {
  if (!sharedIdentityBridgePromise) {
    sharedIdentityBridgePromise = Promise.resolve().then(() => {
      const native = requireOptionalNativeModule<Partial<SharedIdentityBridge>>('OxyIdentity');
      if (
        native &&
        typeof native.getShared === 'function' &&
        typeof native.putShared === 'function' &&
        typeof native.hasShared === 'function' &&
        typeof native.clearShared === 'function'
      ) {
        return {
          getShared: native.getShared.bind(native),
          putShared: native.putShared.bind(native),
          hasShared: native.hasShared.bind(native),
          clearShared: native.clearShared.bind(native),
        } satisfies SharedIdentityBridge;
      }
      return null;
    });
  }
  return sharedIdentityBridgePromise;
}
