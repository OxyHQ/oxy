/**
 * The crypto polyfill must be installed before ANY `@noble/*` module evaluates.
 *
 * `@noble/hashes` 1.x's `crypto.js` captures `globalThis.crypto` once, at module
 * evaluation, and `randomBytes` uses that captured binding forever. Hermes has
 * no `globalThis.crypto` at startup, so if noble is evaluated before
 * `./polyfill` installs the shim, every random draw throws
 * `crypto.getRandomValues must be defined` — which is exactly how identity
 * creation broke on Android: the polyfill imported `@oxy.so/protocol`'s root
 * entry, whose envelope signer reaches `@noble/curves` → `@noble/hashes`, and
 * imports are evaluated before the polyfill body.
 *
 * Node's resolver picks noble's `cryptoNode.js` (the `node` export condition),
 * which never captures the global, so a plain Node run cannot see the bug. The
 * suites below substitute the REAL `crypto.js` that Metro resolves for React
 * Native, remove `globalThis.crypto`, and load core in a fresh module registry.
 */

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

type RandomBytes = (length?: number) => Uint8Array;

const ORIGINAL_CRYPTO_DESCRIPTOR = Object.getOwnPropertyDescriptor(globalThis, 'crypto');

/** noble's browser / React Native `crypto.js`: the variant that captures the global. */
const NOBLE_CAPTURING_CRYPTO = join(dirname(require.resolve('@noble/hashes/utils')), 'crypto.js');

/** Remove `globalThis.crypto` the way a Hermes host starts: no property at all. */
function removeHostCrypto(): void {
  if (!Reflect.deleteProperty(globalThis, 'crypto') || 'crypto' in globalThis) {
    Object.defineProperty(globalThis, 'crypto', {
      value: undefined,
      configurable: true,
      writable: true,
    });
  }
}

function restoreHostCrypto(): void {
  Reflect.deleteProperty(globalThis, 'crypto');
  if (ORIGINAL_CRYPTO_DESCRIPTOR) {
    Object.defineProperty(globalThis, 'crypto', ORIGINAL_CRYPTO_DESCRIPTOR);
  }
}

/**
 * Run `body` in a fresh module registry that resolves `@noble/hashes/crypto` as
 * a React Native bundle does, with no host `globalThis.crypto`.
 */
function withReactNativeNobleAndNoHostCrypto(body: () => void): void {
  removeHostCrypto();
  try {
    jest.isolateModules(() => {
      jest.doMock('@noble/hashes/crypto', () => jest.requireActual(NOBLE_CAPTURING_CRYPTO));
      body();
    });
  } finally {
    restoreHostCrypto();
  }
}

describe('crypto polyfill evaluation order', () => {
  it('reproduces the capture: noble evaluated before the polyfill has no randomness', () => {
    // Guards the harness itself — if this ever stops throwing, the substitution
    // no longer models the capturing variant and the suites below prove nothing.
    withReactNativeNobleAndNoHostCrypto(() => {
      const { randomBytes } = require('@noble/hashes/utils') as { randomBytes: RandomBytes };
      require('../polyfill');
      expect(() => randomBytes(32)).toThrow('crypto.getRandomValues must be defined');
    });
  });

  it('importing @oxy.so/core installs the shim before noble captures the global', () => {
    withReactNativeNobleAndNoHostCrypto(() => {
      require('../../index');
      const { randomBytes } = require('@noble/hashes/utils') as { randomBytes: RandomBytes };

      const bytes = randomBytes(32);
      expect(bytes).toHaveLength(32);
      expect(bytes.some((byte) => byte !== 0)).toBe(true);
    });
  });

  it('generates an identity (key pair + recovery mnemonic) through core', () => {
    withReactNativeNobleAndNoHostCrypto(() => {
      const core = require('../../index') as typeof import('../../index');
      const { generateMnemonic } = require('@scure/bip39') as typeof import('@scure/bip39');
      const { wordlist } = require('@scure/bip39/wordlists/english') as {
        wordlist: string[];
      };

      // The two random draws `RecoveryPhraseService.generateIdentityWithRecovery`
      // and `KeyManager.generateKeyPairSync` make — the ones Commons failed on.
      expect(generateMnemonic(wordlist, 128).split(' ')).toHaveLength(12);
      const keyPair = core.KeyManager.generateKeyPairSync();
      expect(keyPair.privateKey).toMatch(/^[0-9a-f]{64}$/);
    });
  });

  it('the polyfill imports nothing that can reach a crypto library', () => {
    const source = readFileSync(resolve(__dirname, '..', 'polyfill.ts'), 'utf8');
    const specifiers = [...source.matchAll(/^import\s+[^'"]*?['"]([^'"]+)['"]/gm)].map(
      (match) => match[1],
    );
    expect(specifiers.sort()).toEqual(['@oxy.so/protocol/random', 'buffer']);
  });

  it('the core entry imports the polyfill before anything else', () => {
    const source = readFileSync(resolve(__dirname, '..', '..', 'index.ts'), 'utf8');
    const firstModuleReference = source.match(/^(?:import|export)\s[^;]*?['"]([^'"]+)['"]/m);
    expect(firstModuleReference?.[1]).toBe('./crypto/polyfill');
  });
});
