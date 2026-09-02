/**
 * Global jest setup for the inbox package.
 *
 * Provides the `__DEV__` global that mirrors the React Native runtime flag, so
 * modules that gate debug output behind it don't blow up under Node.
 *
 * Console output is NOT globally silenced here: the push-registration suites
 * assert on the diagnostic warnings a misconfigured build emits, and a blanket
 * spy would hide exactly the signal under test. Suites that produce expected
 * noise install their own spy.
 */

declare global {
  var __DEV__: boolean;
}

(globalThis as { __DEV__?: boolean }).__DEV__ = false;

export {};
