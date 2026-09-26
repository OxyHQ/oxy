/**
 * `@oxy.so/core/crypto` — the self-custody identity: keys, signatures, the
 * recovery phrase, and the primitives under them.
 *
 * Its own entry so an app that never holds a key never ships secp256k1, bip39
 * or the AEAD cipher. The `oxy.identity` / `oxy.civic` namespaces load what they
 * need from here on first use.
 */

// MUST stay the first import: `@noble/hashes` captures `globalThis.crypto` when
// it is evaluated, so the shim has to exist before anything below reaches it.
import './polyfill';

export {
    KeyManager,
    IdentityAlreadyExistsError,
    IdentityPersistError,
    IdentityUnavailableError,
} from './keyManager';
export type { KeyPair, IdentityStatus, IdentityRecoveryResult } from './keyManager';
export { readIdentityMarker, updateIdentityMarker } from './identityMarker';
export type { IdentityMarker } from './identityMarker';
export type { IdentityDeviceBackupStore } from './deviceBackup';
export { SignatureService } from './signatureService';
export type { SignedMessage, AuthChallenge } from './signatureService';
export { RecoveryPhraseService } from './recoveryPhrase';
export type { RecoveryPhraseResult, PendingIdentityResult, BackupMaterial } from './recoveryPhrase';

// Low-level primitives (encrypted backup, device transfer)
export { hkdfSha256 } from './kdf';
export { encryptAead, decryptAead, AEAD_KEY_LENGTH, AEAD_NONCE_LENGTH } from './aead';
export type { AeadResult } from './aead';
export { deriveSharedSecret } from './ecdh';

// Identity proofs — the one signed format for operations on a personal root
// (docs/adr/0024-one-oxy-account-root-holders.md D7)
export { digestIdentityPayload, signIdentityProof } from './identityProof';
// Linking Commons to an account: the code both screens compare (ADR 0029 D3)
export { deriveIdentityLinkCode } from './identityLink';
