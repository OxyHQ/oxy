/**
 * Global jest setup for the commons package.
 *
 * Keeps test output clean by silencing intentional console.error calls in
 * paths that test error handling, and provides a `__DEV__` global that
 * mirrors the runtime React Native flag so utility modules that gate
 * debug logs behind it don't blow up under Node.
 */

import { TextDecoder, TextEncoder } from 'node:util';

declare global {
  // eslint-disable-next-line no-var
  var __DEV__: boolean;
}

(globalThis as { __DEV__?: boolean }).__DEV__ = false;
Object.assign(globalThis, { TextDecoder, TextEncoder });

// Silence expected error logs (e.g. useOnboardingStatus catches KeyManager
// failures and console.errors them). Tests that want to assert on these
// can override with their own spy.
beforeEach(() => {
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  jest.restoreAllMocks();
});

export {};
