/**
 * Platform Crypto / Storage — Default Variant (Node.js, Browser, generic bundlers)
 *
 * Provides lazy access to platform-specific crypto and storage modules.
 *
 * # Variants
 *
 * This module ships in two physical variants on disk, selected per consumer
 * by the bundler / runtime:
 *
 * - `crypto.js`           — this file. Used by Node.js, Vite, webpack,
 *                           Rollup, esbuild, and anything that does not match
 *                           Metro's `*.native.js` source-extension preference.
 * - `crypto.native.js`    — sibling file. Picked up automatically by Metro's
 *                           resolver (which prefers `*.<platform>.js` and
 *                           `*.native.js` over plain `*.js` when
 *                           `preferNativePlatform` is true — Expo sets this for
 *                           all non-web builds).
 *
 * The `package.json#exports` map also declares a `"react-native"` condition
 * pointing at the same `dist/esm/index.js` entry — that entry transitively
 * imports `./platform/crypto`, and Metro's per-file source-extension lookup
 * substitutes the `.native.js` sibling automatically inside `dist/`. The
 * package's top-level `"react-native"` map additionally pins the built
 * `platform/crypto.js` (under both `dist/cjs` and `dist/esm`) to its
 * `crypto.native.js` sibling belt-and-braces. This means consumers never have
 * to add resolver shims; Metro Just Works.
 *
 * Both variants expose the EXACT same public API; importers don't need to know
 * which one they got. The variant difference is purely about which underlying
 * native modules each one references:
 *
 *   ┌──────────────────┬───────────────────────┬───────────────────────────────┐
 *   │ Function         │ Default variant       │ React Native variant          │
 *   ├──────────────────┼───────────────────────┼───────────────────────────────┤
 *   │ loadNodeCrypto   │ `await import('crypto')` (Node built-in)              │
 *   │                  │                       │ throws — Node crypto is not   │
 *   │                  │                       │ available on Hermes/RN        │
 *   ├──────────────────┼───────────────────────┼───────────────────────────────┤
 *   │ loadExpoCrypto   │ throws — expo-crypto  │ optional `require('expo-      │
 *   │                  │ is not part of a      │ crypto')`                     │
 *   │                  │ Node/Vite bundle      │                               │
 *   ├──────────────────┼───────────────────────┼───────────────────────────────┤
 *   │ loadSecureStore  │ throws (web/Node have │ optional `require('expo-      │
 *   │                  │ their own storage)    │ secure-store')`               │
 *   ├──────────────────┼───────────────────────┼───────────────────────────────┤
 *   │ loadAsyncStorage │ throws (web/Node have │ optional `require('@react-    │
 *   │                  │ their own storage)    │ native-async-storage/...')`   │
 *   ├──────────────────┼───────────────────────┼───────────────────────────────┤
 *   │ getRandomBytesRN │ throws (RN-only)      │ direct call into expo-crypto  │
 *   └──────────────────┴───────────────────────┴───────────────────────────────┘
 *
 * Crucially, the default variant references ONLY Node's `'crypto'`. It never
 * mentions `expo-*` or `@react-native-async-storage/*` — so Vite, webpack,
 * esbuild, Rollup, and Node itself can bundle / require it without ever
 * attempting to resolve those RN-only packages.
 *
 * The React Native variant references ONLY the RN packages, each behind
 * Metro's optional-dependency mechanism (a literal `require()` inside a `try`)
 * because they are declared OPTIONAL peer dependencies. It never mentions
 * `'crypto'` — so Metro and Hermes have nothing to choke on.
 *
 * # Why not a single file with dynamic import?
 *
 * A previous iteration used a "bundler-opaque" `new Function('s', 'return
 * import(s)')` trick so a single file could service every platform. It
 * bundled cleanly on Metro but Hermes refused to PARSE the resulting
 * `import()` expression inside a Function-constructor body
 * (`SyntaxError: Invalid expression encountered` at the `(` of `import(`).
 * The platform-extension split is the only approach that lets each runtime
 * see a file containing only specifiers it can understand — no tricks, no
 * runtime parsing risks.
 */

import { isReactNative } from './platform';
import type { ExpoCryptoLike, ExpoSecureStoreLike, SharedIdentityBridge } from './expoTypes';

// Re-export the interfaces so consumers can import them from the same
// entry-point they use for the loaders.
export type { ExpoCryptoLike, ExpoSecureStoreLike, SharedIdentityBridge };

// ---------------------------------------------------------------------------
// Node `crypto` — Node built-in
//
// `await import('crypto')` here is a real, static-from-tsc's-perspective
// dynamic import. Node ESM, Vite, webpack, and esbuild all resolve it fine.
// Metro never sees this file because the `.native.js` sibling shadows
// it, so Metro never tries to resolve `'crypto'`.
// ---------------------------------------------------------------------------

let cachedNodeCrypto: typeof import('crypto') | null = null;

export async function loadNodeCrypto(): Promise<typeof import('crypto')> {
  if (cachedNodeCrypto) {
    return cachedNodeCrypto;
  }
  cachedNodeCrypto = await import('node:crypto');
  return cachedNodeCrypto;
}

// ---------------------------------------------------------------------------
// RN-only modules — never called from this variant.
//
// These throw a clear error if anything ever reaches them outside RN. In
// practice every caller gates with `isReactNative()` before calling, so
// these are belt-and-braces.
//
// Return types use the structural interfaces from expoTypes.ts rather than
// `typeof import('expo-crypto')` / `typeof import('expo-secure-store')`.
// This prevents TypeScript from traversing into expo-modules-core under
// NodeNext module resolution, which would otherwise pollute the global type
// environment in server/Node consumers (TS2322 on NodeJS.Timeout vs number).
// ---------------------------------------------------------------------------

function notReactNativeError(module: string): Error {
  return new Error(
    `[oxy.protocol.crypto] Tried to load '${module}' outside React Native. This module is only available in a React Native runtime; bundling routed this consumer to the default (Node/web) variant. This indicates a missing platform gate (\`isReactNative()\`) in the calling code.`,
  );
}

export async function loadExpoCrypto(): Promise<ExpoCryptoLike> {
  if (isReactNative()) {
    // Should be unreachable: when running on RN, Metro / the `react-native`
    // exports condition serves the sibling variant. If we got here, the
    // package-exports map is misconfigured for this host. Throw with a
    // helpful diagnostic rather than fall back to a broken dynamic import.
    throw new Error(
      '[oxy.protocol.crypto] React Native runtime resolved the default ' +
        '(non-RN) variant of @oxyhq/protocol/platform/crypto. Check the ' +
        "consumer's bundler resolution — Metro should pick the sibling " +
        '.native.js file via package exports.',
    );
  }
  throw notReactNativeError('expo-crypto');
}

export async function loadSecureStore(): Promise<ExpoSecureStoreLike> {
  throw notReactNativeError('expo-secure-store');
}

export async function loadAsyncStorage(): Promise<{
  default: {
    getItem: (key: string) => Promise<string | null>;
    setItem: (key: string, value: string) => Promise<void>;
    removeItem: (key: string) => Promise<void>;
  };
}> {
  throw notReactNativeError('@react-native-async-storage/async-storage');
}

/**
 * Synchronous random-bytes via `expo-crypto.getRandomBytes`. Only available
 * in the React Native variant. The default variant throws because Node and
 * browsers have their own native CSPRNGs (`crypto.randomBytes` and
 * `crypto.getRandomValues` respectively) — callers should use those.
 */
export function getRandomBytesRN(_byteCount: number): Uint8Array {
  throw notReactNativeError('expo-crypto.getRandomBytes (sync)');
}

// ---------------------------------------------------------------------------
// Shared identity bridge — `@oxyhq/expo-oxy-identity` (native-only).
//
// The default (web / Node) variant has no cross-app identity channel, so this
// always resolves to `null`. `@oxyhq/core`'s `KeyManager` treats `null` as "no
// bridge" and falls back to its package-private store — which is correct on web
// (there is no shared identity there).
// ---------------------------------------------------------------------------

export function loadSharedIdentityBridge(): Promise<SharedIdentityBridge | null> {
  return Promise.resolve(null);
}
