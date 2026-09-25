/**
 * `@oxy.so/protocol/random` — the platform randomness source, and nothing else.
 *
 * `@oxy.so/core`'s crypto polyfill installs `globalThis.crypto.getRandomValues`
 * on hosts that lack it (React Native / Hermes). `@noble/hashes` 1.x captures
 * `globalThis.crypto` ONCE, when its `crypto.js` is evaluated, so the polyfill
 * has to be installed before any `@noble/*` module is evaluated. ES imports are
 * evaluated before the importing module's body, so whatever the polyfill
 * imports is evaluated first: importing the ROOT entry (which reaches
 * `@noble/curves` through the envelope signer) let noble capture `undefined`
 * and broke identity creation on Android.
 *
 * This entry therefore reaches no crypto library, no `@oxy.so/*` package and no
 * third-party module other than the optional `expo-crypto` peer (RN variant
 * only). `src/__tests__/randomEntry.test.ts` walks its module graph to keep it
 * that way.
 */

export { isNodeJS, isReactNative } from './platform/platform';
export { getRandomBytesRN } from './platform/random';
