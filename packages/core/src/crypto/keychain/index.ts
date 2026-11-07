/**
 * The Oxy Keychain's cryptography (ADR 0063 D8): the formats every client and
 * the OxyOS keychain service share, byte for byte, checked against
 * `__tests__/vectors.json`.
 *
 * Reached only through `@oxy.so/core/crypto`. The deterministic variants that
 * take an ephemeral key or a nonce (`sealDeterministic`,
 * `createWrapDeterministic`, `encryptItemDeterministic`) exist for the test
 * vectors and are deliberately not exported here.
 */

export {
  KeychainConflictError,
  KeychainCryptoError,
  KeychainFormatError,
  KeychainIntegrityError,
  KeychainRosterError,
  KeychainStateError,
} from './errors';
export type {
  KeychainIntegrityReason,
  KeychainRosterErrorReason,
  KeychainStateReason,
} from './errors';
export {
  RECOVERY as KEYCHAIN_RECOVERY,
  ITEM_PADDING_BLOCK as KEYCHAIN_ITEM_PADDING_BLOCK,
  MAX_ITEM_PLAINTEXT as KEYCHAIN_MAX_ITEM_PLAINTEXT,
} from './constants';
export {
  toBase64Url as keychainToBase64Url,
  fromBase64Url as keychainFromBase64Url,
  jcs as keychainJcs,
  zeroize,
  keychainTimestamp,
  isKeychainTimestamp,
} from './encoding';
export {
  generateDeviceKeys,
  deviceKeysFromSecrets,
  exportPublicKeys,
  zeroizeKeyPairs,
} from './keys';
export type { KeychainKeyPairs, KeychainPublicKeys } from './keys';
export { seal as keychainSeal, openSealed as keychainOpenSealed } from './seal';
export type { SealedBox } from './seal';
export {
  generateRecoveryKey,
  formatRecoveryKey,
  parseRecoveryKey,
  deriveRecoveryKeys,
  recoveryKeyMatches,
} from './recoveryKey';
export {
  KEYCHAIN_PLATFORMS,
  rosterSigningInput,
  rosterEntryHash,
  parseRosterBody,
  validateRosterBody,
  parseMember,
  genesisBody,
  addBody,
  removeBody,
  generationBody,
  recoveryBody,
  signRosterBody,
  rosterHeadOf,
  verifyRoster,
  findMember,
  currentSigningKey,
  currentBoxKey,
} from './roster';
export type {
  KeychainPlatform,
  KeychainMember,
  KeychainRecoveryPublicKeys,
  RosterBody,
  RosterOp,
  RosterEntry,
  RosterSignature,
  RosterHead,
  RosterSigner,
  VerifiedRoster,
  VerifyRosterOptions,
} from './roster';
export {
  createKeyring,
  rotateKeyring,
  zeroizeKeyring,
  vaultKeyOf,
  encodeKeyring,
  decodeKeyring,
  wrapAad,
  wrapSigningInput,
  parseWrap,
  createWrap,
  verifyWrap,
  openWrap,
} from './wrap';
export type { Keyring, KeychainWrap, CreateWrapInput } from './wrap';
export {
  generateEnrollmentNonce,
  enrollmentCommitInput,
  enrollmentCommitment,
  verifyEnrollmentCommitment,
  enrollmentCodeInput,
  enrollmentComparisonCode,
} from './enrollment';
export {
  WIFI_SECURITY,
  validateItem,
  padItemPlaintext,
  encodeItemPlaintext,
  decodeItemPlaintext,
  itemAad,
  encryptItem,
  decryptItem,
  isItemCounterAcceptable,
  nextItemCounter,
} from './items';
export type {
  KeychainItem,
  KeychainItemType,
  LoginItem,
  PasskeyItem,
  TotpItem,
  NoteItem,
  WifiItem,
  WifiSecurity,
  EncryptedItem,
} from './items';
export { generateStrongPassword, isStrongPasswordShape } from './password';
export {
  decodeBase32Secret,
  encodeBase32Secret,
  hotpCode,
  totpCounter,
  totpCode,
  totpSecondsRemaining,
  parseOtpauthUri,
} from './totp';
export type { TotpAlgorithm, TotpParameters, OtpauthTotp } from './totp';
export { KeychainClient } from './client';
export type {
  KeychainClientOptions,
  KeychainDeleteResult,
  KeychainDeviceRecord,
  KeychainDeviceStore,
  KeychainItemCursor,
  KeychainItemDraft,
  KeychainJoiningRecord,
  KeychainJoinProgress,
  KeychainJoinRequest,
  KeychainMemberRecord,
  KeychainMemberSummary,
  KeychainStatus,
  KeychainSyncResult,
  KeychainWriteResult,
} from './client';
