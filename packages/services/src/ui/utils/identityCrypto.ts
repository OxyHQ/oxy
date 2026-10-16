/**
 * The self-custody identity (`@oxy.so/core/crypto`: secp256k1, bip39, the AEAD
 * cipher — ~32 KB gzipped on web), loaded where a key or signature is used.
 *
 * Importing it statically put it in every app's startup JavaScript, although a
 * reader without an identity key never touches it before first paint. Core's
 * `crypto` entry installs its polyfill before anything else, so loading it
 * late keeps the order every key operation relies on.
 */
export const loadIdentityCrypto = () => import('@oxy.so/core/crypto');
