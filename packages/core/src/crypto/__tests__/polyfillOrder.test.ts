/**
 * The crypto polyfill must be installed before ANY module evaluates.
 *
 * Hermes has no `globalThis.crypto` at startup, and without the shim every
 * random draw throws `crypto.getRandomValues must be defined` — which is how
 * identity creation once broke on Android: the polyfill imported
 * `@oxy.so/protocol`'s root entry, whose envelope signer reached
 * `@noble/curves` → `@noble/hashes`, and `@noble/hashes` 1.x captured the
 * absent global when it evaluated, before the polyfill body ran. Noble 2.x
 * reads `globalThis.crypto` on every call instead, so that capture is gone; the
 * order is kept so the shim (and `Buffer`) exist before any module body that
 * reads them runs.
 *
 * The suites below remove `globalThis.crypto` the way a Hermes host starts and
 * load core in a fresh module registry.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

type RandomBytes = (length?: number) => Uint8Array;

const ORIGINAL_CRYPTO_DESCRIPTOR = Object.getOwnPropertyDescriptor(globalThis, 'crypto');

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

/** Run `body` in a fresh module registry with no host `globalThis.crypto`. */
function withNoHostCrypto(body: () => void): void {
  removeHostCrypto();
  try {
    jest.isolateModules(() => {
      // expo-crypto, as the RN variant of `@oxy.so/protocol/random` reaches it.
      jest.doMock('@oxy.so/protocol/random', () => ({
        ...jest.requireActual('@oxy.so/protocol/random'),
        getRandomBytesRN: (length: number) =>
          new Uint8Array(require('node:crypto').randomBytes(length)),
      }));
      body();
    });
  } finally {
    restoreHostCrypto();
  }
}

describe('crypto polyfill evaluation order', () => {
  it('importing @oxy.so/core installs the shim noble draws randomness through', () => {
    withNoHostCrypto(() => {
      require('../../index');
      const { randomBytes } = require('@noble/hashes/utils.js') as { randomBytes: RandomBytes };

      const bytes = randomBytes(32);
      expect(bytes).toHaveLength(32);
      expect(bytes.some((byte) => byte !== 0)).toBe(true);
    });
  });

  it('generates an identity (key pair + recovery mnemonic) through @oxy.so/core/crypto', () => {
    withNoHostCrypto(() => {
      const core = require('../index') as typeof import('../index');
      const { generateMnemonic } = require('@scure/bip39') as typeof import('@scure/bip39');
      const { wordlist } = require('@scure/bip39/wordlists/english.js') as {
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

  it.each([
    ['index.ts', './crypto/polyfill'],
    ['crypto/index.ts', './polyfill'],
    ['session/index.ts', '../crypto/polyfill'],
    ['civic/index.ts', '../crypto/polyfill'],
  ])('%s imports the polyfill before anything else', (entry, polyfill) => {
    const source = readFileSync(resolve(__dirname, '..', '..', entry), 'utf8');
    const firstModuleReference = source.match(/^(?:import|export)\s[^;]*?['"]([^'"]+)['"]/m);
    expect(firstModuleReference?.[1]).toBe(polyfill);
  });
});
