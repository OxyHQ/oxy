/**
 * `@oxy.so/core/crypto` — the self-custody identity: keys, signatures, the
 * recovery phrase, and the primitives under them.
 *
 * Its own entry so an app that never holds a key never ships secp256k1, bip39
 * or the AEAD cipher. The SDK's own namespaces (`oxy.auth`, `oxy.identity`,
 * `oxy.civic`, the identity-bound session) and `@oxy.so/services` load it with
 * `import()` on first use — all through THIS module, so a web bundler makes it
 * one lazy chunk. Two lazy roots over the same modules (this entry and a second
 * internal barrel) made Metro hoist the shared stack into the always-loaded
 * common chunk, which is the cost the lazy loading exists to avoid.
 */

// MUST stay the first import: the shim has to exist before any module below
// evaluates or draws randomness (see `./polyfill`).
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
export type { IdentitySignerStore } from './identitySigner';
// Organization keys on the device (docs/adr/0061-organization-identity-key.md D6)
export {
  generateOrganizationKey,
  organizationKeyFromPhrase,
  storeOrganizationKey,
  getOrganizationPublicKey,
  getOrganizationPrivateKey,
  getOrganizationRecoveryPhrase,
  listOrganizationKeys,
  deleteOrganizationKey,
  syncOrganizationKeys,
  isOrganizationAccountId,
  isHealthyOrganizationKeyPair,
} from './organizationKeys';
export type {
  OrganizationKeyPair,
  GeneratedOrganizationKey,
  StoredOrganizationKey,
} from './organizationKeys';
// iOS keychain access groups (docs/identity/ios-keychain-access-groups.md, ADR 0062)
export {
  KEYCHAIN_ACCESS_GROUPS,
  KeychainAccessUnavailableError,
  keychainGroupFor,
  mayHoldKeychainItem,
  mayWriteKeychainItem,
  DEV_KEYCHAIN_GROUP_SUFFIX,
  resolveKeychainAccess,
  keychainAccessGroupValue,
  keychainReadPlan,
  keychainDeletePlan,
  keychainWriteOption,
  ownKeychainItemPlan,
  readThroughPlan,
  deleteThroughPlan,
  groupedKeychainStore,
} from '../utils/keychainAccessGroups';
export type {
  KeychainAccess,
  KeychainAccessGroupName,
  KeychainGroup,
  KeychainGroupOption,
  KeychainItemClass,
  KeychainRole,
  KeychainStoreLike,
  OwnKeychainItemNames,
} from '../utils/keychainAccessGroups';
export {
  ensureKeychainGroupsMigrated,
  getPreSplitExposure,
} from './keychainGroupMigration';
export type {
  KeychainGroupMigrationReport,
  KeychainItemMigrationOutcome,
} from './keychainGroupMigration';
// Retired identity keys: kept for spending after a rotation or replacement
// (docs/adr/0061-organization-identity-key.md D7 as amended 2026-11-06)
export {
  retireIdentityKey,
  listRetiredIdentityKeys,
  forgetRetiredIdentityKey,
  forgetRetiredIdentityKeys,
  syncRetiredKeys,
  retiredKeyFromPhrase,
  retiredKeyFromPrivateKey,
  exportRetiredIdentityKeys,
  claimRetiredIdentityKeys,
  countQuarantinedRetiredKeys,
  unmirrorPersonalRetiredKeys,
  RetiredKeyRingUnreadableError,
} from './retiredKeys';
export type { RetiredIdentityKey, RetiredKeyPair, RetiredKeySelector } from './retiredKeys';
export { SignatureService } from './signatureService';
export type { SignedMessage, AuthChallenge } from './signatureService';
export { RecoveryPhraseService, BACKUP_KDF_ENCRYPTION_INFO } from './recoveryPhrase';
export type { RecoveryPhraseResult, PendingIdentityResult, BackupMaterial } from './recoveryPhrase';

// Low-level primitives (encrypted backup, device transfer)
export { hkdfSha256 } from './kdf';
export { encryptAead, decryptAead, AEAD_KEY_LENGTH, AEAD_NONCE_LENGTH } from './aead';
export type { AeadResult } from './aead';
export { deriveSharedSecret } from './ecdh';

// What the identity key computes without leaving its holder: the same functions
// Commons' identity host implements natively on Android. The social-receive
// CHILD private key (`deriveSocialReceiveKey`) is deliberately not here: the
// derivation is non-hardened under a chain code anyone can compute from the
// public key, so one leaked child private key reveals the identity key. Only
// signatures (`signSocialReceiveDigest`) leave this module.
export {
  SCOPED_SEED_KDF_SALT,
  SOCIAL_RECEIVE_CHAIN_CODE_KEY,
  MAX_SOCIAL_RECEIVE_INDEX,
  deriveScopedSeedFromKey,
  signSocialReceiveDigest,
  authChallengeDigest,
} from './identityDerivations';

// Identity proofs — the one signed format for operations on a personal root
// (docs/adr/0024-one-oxy-account-root-holders.md D7)
export { digestIdentityPayload, signIdentityProof } from './identityProof';
// Linking Commons to an account: the code both screens compare (ADR 0029 D3)
export { deriveIdentityLinkCode } from './identityLink';
// The registration proof-of-work and the protocol signing primitives the
// namespaces use, so they load with the rest of the identity stack.
export { solveRegistrationPow } from './registrationPow';
// Content addressing for direct-to-storage uploads (`oxy.assets.uploadLarge`).
export { createContentHasher } from './contentHash';
export type { ContentHasher } from './contentHash';
export { canonicalize, loadCommonsIdentityBridge } from '@oxy.so/protocol';
export { signMessage, verifySignature } from '@oxy.so/protocol/sign';
