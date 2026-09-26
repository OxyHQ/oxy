/**
 * The one module the API namespaces load crypto through, with `import()`.
 *
 * It installs the polyfill FIRST: on Hermes `@noble/hashes` captures
 * `globalThis.crypto` when it is evaluated, so a namespace that dynamically
 * imported `./keyManager` directly — before anything installed the shim —
 * would hand noble `undefined` and every random draw would throw. Loading
 * through here makes the order a property of the module graph, not of which
 * entry an app happened to import first.
 */
import './polyfill';

export { KeyManager } from './keyManager';
export { SignatureService } from './signatureService';
export { RecoveryPhraseService, BACKUP_KDF_ENCRYPTION_INFO } from './recoveryPhrase';
export { encryptAead, decryptAead, AEAD_KEY_LENGTH, AEAD_NONCE_LENGTH } from './aead';
export { digestIdentityPayload, signIdentityProof } from './identityProof';
export { deriveIdentityLinkCode } from './identityLink';
export { solveRegistrationPow } from './registrationPow';
export { canonicalize, signMessage, verifySignature } from '@oxy.so/protocol';
