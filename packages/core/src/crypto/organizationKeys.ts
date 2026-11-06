/**
 * Organization keys on the device (ADR 0061 D6).
 *
 * An organization's identity key is created in Commons by one of its owners or
 * admins, from a fresh 24-word phrase (`seed[0:32]`, the personal-root
 * derivation), and is published as the organization's DID `#key-1`. Commons
 * holds it beside the person's own root, under the organization's account id;
 * other Oxy apps reach it the way they reach the personal identity, by
 * derivation and never by the key:
 *
 * - iOS: the pair in the wallet keychain group (`<TEAM>.so.oxy.wallet`), which
 *   only Commons and the Peable wallet hold; the phrase and the index in the
 *   identity group, Commons only (docs/identity/ios-keychain-access-groups.md).
 *   Only Commons writes them; every other app reads nothing.
 * - Android: Commons' own expo-secure-store slot, mirrored into the identity
 *   signer store (`./identitySigner`) that Commons' identity host answers
 *   `accountId` requests from. Every other app asks Commons over IPC
 *   (`loadCommonsIdentityBridge`), and never gets the key.
 *
 * The phrase is kept only in Commons, on the device that created or imported
 * it, so an owner can show it to another owner (ADR 0061 D5); it never reaches
 * the wallet or shared group, an IPC answer or a log.
 *
 * This module imports nothing from `./keyManager` (which imports it): the
 * signer store comes from `./identitySigner`'s registry.
 */

import { generateMnemonic, mnemonicToSeed, validateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import {
  type ExpoSecureStoreLike,
  loadCommonsIdentityBridge,
  loadSecureStore,
} from '@oxy.so/protocol';
import {
  deriveSecp256k1PublicKey,
  isValidSecp256k1PrivateKey,
  isValidSecp256k1PublicKey,
  normalizeSecp256k1PrivateKey,
  normalizeSecp256k1PublicKey,
} from '@oxy.so/protocol/secp256k1';
import { logger } from '../logger';
import {
  type KeychainItemClass,
  groupedKeychainStore,
  resolveKeychainAccess,
} from '../utils/keychainAccessGroups';
import { isAndroid, isIOS, isWeb } from '../utils/platform';
import { registeredIdentitySignerStore } from './identitySigner';
import { ensureKeychainGroupsMigrated } from './keychainGroupMigration';
import {
  ORGANIZATION_ANDROID_KEYCHAIN_SERVICE as ANDROID_KEYCHAIN_SERVICE,
  ORGANIZATION_INDEX_KEYCHAIN_SERVICE as INDEX_KEYCHAIN_SERVICE,
  ORGANIZATION_INDEX_STORAGE_KEY as INDEX_STORAGE_KEY,
  ORGANIZATION_MNEMONIC_KEYCHAIN_SERVICE as MNEMONIC_KEYCHAIN_SERVICE,
  isOrganizationAccountId,
  organizationMnemonicName as mnemonicName,
  organizationPrivateKeyName as privateKeyName,
  organizationPublicKeyName as publicKeyName,
  serializeOrganizationIndex,
} from './keychainItems';
import type { OxySecureStoreOptions as SecureStoreOptions } from './secureStoreOptions';

export { isOrganizationAccountId };

/** A secp256k1 pair: private key 64 hex, public key lowercase uncompressed (`04…`, 130 hex). */
export interface OrganizationKeyPair {
  privateKey: string;
  publicKey: string;
}

/** A new organization key and the 24-word phrase it derives from. */
export interface GeneratedOrganizationKey extends OrganizationKeyPair {
  mnemonic: string;
}

/** What {@link storeOrganizationKey} keeps: the pair, and the phrase when the device has it. */
export interface StoredOrganizationKey extends OrganizationKeyPair {
  mnemonic?: string;
}

const ORGANIZATION_PHRASE_WORDS = 24;

function assertAccountId(accountId: string): void {
  if (!isOrganizationAccountId(accountId)) {
    throw new Error('organization key: accountId must be a 24-hex or uuid account id');
  }
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Lowercase uncompressed public key of `privateKey`. */
function publicKeyOf(privateKey: string): string {
  return deriveSecp256k1PublicKey(normalizeSecp256k1PrivateKey(privateKey));
}

/** True only when both halves are well-formed AND the public key derives from the private one. */
export function isHealthyOrganizationKeyPair(
  privateKey: string | null | undefined,
  publicKey: string | null | undefined,
): boolean {
  if (!privateKey || !publicKey) return false;
  if (!isValidSecp256k1PrivateKey(privateKey) || !isValidSecp256k1PublicKey(publicKey)) {
    return false;
  }
  try {
    return publicKeyOf(privateKey) === normalizeSecp256k1PublicKey(publicKey);
  } catch {
    return false;
  }
}

function normalizePhrase(phrase: string): string {
  return phrase.trim().toLowerCase().split(/\s+/).join(' ');
}

async function pairFromPhrase(phrase: string): Promise<OrganizationKeyPair> {
  const normalized = normalizePhrase(phrase);
  if (
    normalized.split(' ').length !== ORGANIZATION_PHRASE_WORDS ||
    !validateMnemonic(normalized, wordlist)
  ) {
    throw new Error('organization key: not a valid 24-word recovery phrase');
  }
  const seed = await mnemonicToSeed(normalized);
  const privateKey = toHex(seed.subarray(0, 32));
  return { privateKey, publicKey: publicKeyOf(privateKey) };
}

/**
 * A fresh organization key: a 24-word phrase and the pair derived from it
 * exactly as a personal root is (`seed[0:32]`). Stores NOTHING: the caller shows
 * the phrase, links the key (`oxy.accounts.identityKey`), and only then calls
 * {@link storeOrganizationKey}.
 */
export async function generateOrganizationKey(): Promise<GeneratedOrganizationKey> {
  const mnemonic = generateMnemonic(wordlist, 256);
  return { mnemonic, ...(await pairFromPhrase(mnemonic)) };
}

/**
 * The pair a 24-word organization phrase derives. Stores nothing; the caller
 * checks the public key against the organization's DID `#key-1` before keeping
 * it (ADR 0061 D5).
 */
export async function organizationKeyFromPhrase(phrase: string): Promise<OrganizationKeyPair> {
  return pairFromPhrase(phrase);
}

/**
 * The secure store for one class of organization item: on iOS the pair is a
 * `spending-key` (wallet group), the phrase and the index `identity-secret`
 * (identity group); see `../utils/keychainAccessGroups`. In Commons every
 * access first awaits the access-group migration. Android is unchanged.
 */
async function secureStore(item: KeychainItemClass): Promise<ExpoSecureStoreLike> {
  const raw = await loadSecureStore();
  const access = await resolveKeychainAccess();
  if (access.mode === 'grouped' && access.role === 'holder') {
    await ensureKeychainGroupsMigrated();
  }
  return groupedKeychainStore(raw, access, item);
}

const pairStore = () => secureStore('spending-key');
const phraseStore = () => secureStore('identity-secret');
const indexStore = () => secureStore('identity-secret');

async function readIndex(store: ExpoSecureStoreLike): Promise<string[]> {
  const raw = await store.getItemAsync(INDEX_STORAGE_KEY, {
    keychainService: INDEX_KEYCHAIN_SERVICE,
  } satisfies SecureStoreOptions);
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((id): id is string => typeof id === 'string' && isOrganizationAccountId(id))
      : [];
  } catch (error) {
    logger.warn('Organization key index unreadable; treating as empty', {
      component: 'OrganizationKeys',
      error: error instanceof Error ? error.name : 'unknown',
    });
    return [];
  }
}

async function writeIndex(store: ExpoSecureStoreLike, ids: string[]): Promise<void> {
  await store.setItemAsync(INDEX_STORAGE_KEY, serializeOrganizationIndex(ids), {
    keychainService: INDEX_KEYCHAIN_SERVICE,
  } satisfies SecureStoreOptions);
}

/**
 * The options of the pair on this platform: on iOS no keychain service (the
 * wallet group comes from {@link pairStore}), on Android Commons' own slot.
 */
function pairOptions(store: ExpoSecureStoreLike, forPrivateWrite: boolean): SecureStoreOptions {
  if (isIOS()) {
    return forPrivateWrite ? { keychainAccessible: store.WHEN_UNLOCKED_THIS_DEVICE_ONLY } : {};
  }
  return forPrivateWrite
    ? {
        keychainAccessible: store.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
        keychainService: ANDROID_KEYCHAIN_SERVICE,
      }
    : { keychainService: ANDROID_KEYCHAIN_SERVICE };
}

/** The pair from this app's own storage (iOS group; Android Commons slot, then signer store). */
async function readLocalPair(accountId: string): Promise<OrganizationKeyPair | null> {
  if (isWeb()) return null;
  if (isAndroid()) {
    const signer = registeredIdentitySignerStore();
    if (!signer) return null; // Only Commons holds organization keys on Android.
    const store = await pairStore();
    const options = pairOptions(store, false);
    const privateKey = await store.getItemAsync(privateKeyName(accountId), options);
    const publicKey = await store.getItemAsync(publicKeyName(accountId), options);
    if (privateKey && publicKey && isHealthyOrganizationKeyPair(privateKey, publicKey)) {
      return {
        privateKey: normalizeSecp256k1PrivateKey(privateKey),
        publicKey: normalizeSecp256k1PublicKey(publicKey),
      };
    }
    // The signer store is a rung: a wiped expo-secure-store slot still has it.
    const mirrored = (await signer.readOrganization?.(accountId)) ?? null;
    return mirrored && isHealthyOrganizationKeyPair(mirrored.privateKey, mirrored.publicKey)
      ? mirrored
      : null;
  }
  if (!isIOS()) return null;
  // The wallet group: `null` without a keychain read in every app but Commons
  // and the Peable wallet.
  const store = await pairStore();
  const options = pairOptions(store, false);
  const privateKey = await store.getItemAsync(privateKeyName(accountId), options);
  const publicKey = await store.getItemAsync(publicKeyName(accountId), options);
  return privateKey && publicKey && isHealthyOrganizationKeyPair(privateKey, publicKey)
    ? {
        privateKey: normalizeSecp256k1PrivateKey(privateKey),
        publicKey: normalizeSecp256k1PublicKey(publicKey),
      }
    : null;
}

/**
 * Keep an organization key on this device. Commons only: on Android it needs
 * the identity signer store Commons registers, so the identity host can serve
 * it; on iOS only Commons holds the groups it writes (any other app throws).
 *
 * Refuses a pair whose public key does not derive from its private key, and a
 * phrase that does not derive the pair. Overwrites whatever this device held for
 * the organization (a replaced key is the caller's decision, ADR 0061 D7).
 */
export async function storeOrganizationKey(
  accountId: string,
  key: StoredOrganizationKey,
): Promise<void> {
  assertAccountId(accountId);
  if (isWeb()) throw new Error('organization key: only a native device holds one');
  if (!isHealthyOrganizationKeyPair(key.privateKey, key.publicKey)) {
    throw new Error('organization key: the public key does not derive from the private key');
  }
  const privateKey = normalizeSecp256k1PrivateKey(key.privateKey);
  const publicKey = normalizeSecp256k1PublicKey(key.publicKey);
  if (key.mnemonic !== undefined) {
    const fromPhrase = await pairFromPhrase(key.mnemonic);
    if (fromPhrase.publicKey !== publicKey) {
      throw new Error('organization key: the phrase derives a different key');
    }
  }

  const signer = isAndroid() ? registeredIdentitySignerStore() : null;
  if (isAndroid() && !signer?.writeOrganization) {
    throw new Error(
      'On Android only Commons holds organization keys; this app has no identity signer store for them.',
    );
  }
  const store = await pairStore();
  await store.setItemAsync(privateKeyName(accountId), privateKey, pairOptions(store, true));
  await store.setItemAsync(publicKeyName(accountId), publicKey, pairOptions(store, false));
  if (
    signer?.writeOrganization &&
    !(await signer.writeOrganization(accountId, privateKey, publicKey))
  ) {
    throw new Error(
      `The identity signer store (${signer.name}) did not confirm the organization key.`,
    );
  }
  const phrases = await phraseStore();
  if (key.mnemonic !== undefined) {
    await phrases.setItemAsync(mnemonicName(accountId), normalizePhrase(key.mnemonic), {
      keychainService: MNEMONIC_KEYCHAIN_SERVICE,
      keychainAccessible: phrases.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
    } satisfies SecureStoreOptions);
  } else {
    await phrases.deleteItemAsync(mnemonicName(accountId), {
      keychainService: MNEMONIC_KEYCHAIN_SERVICE,
    } satisfies SecureStoreOptions);
  }
  const index = await indexStore();
  await writeIndex(index, [...(await readIndex(index)), accountId]);
}

/**
 * The organization's public key as THIS device can reach it, or `null`.
 * iOS: the wallet keychain group (Commons, the Peable wallet). Android: Commons' own slot inside Commons, and
 * Commons' identity host (`describe` with `accountId`) everywhere else. Compare
 * it with the organization's DID `#key-1` before receiving (Peable ADR 0002).
 */
export async function getOrganizationPublicKey(accountId: string): Promise<string | null> {
  if (!isOrganizationAccountId(accountId) || isWeb()) return null;
  try {
    if (isAndroid() && !registeredIdentitySignerStore()) {
      const bridge = await loadCommonsIdentityBridge();
      const description = (await bridge?.describe(accountId)) ?? null;
      return description?.accountId === accountId ? description.publicKey : null;
    }
    return (await readLocalPair(accountId))?.publicKey ?? null;
  } catch (error) {
    logger.warn('Failed to read an organization public key', {
      component: 'OrganizationKeys',
      error: error instanceof Error ? error.name : 'unknown',
    });
    return null;
  }
}

/**
 * The organization's private key, where this app may hold it: Commons (both
 * platforms) and, on iOS, the Peable wallet through the wallet keychain group.
 * `null` everywhere else. Use it to sign within the app only; never transmit it.
 */
export async function getOrganizationPrivateKey(accountId: string): Promise<string | null> {
  if (!isOrganizationAccountId(accountId)) return null;
  try {
    return (await readLocalPair(accountId))?.privateKey ?? null;
  } catch (error) {
    logger.warn('Failed to read an organization private key', {
      component: 'OrganizationKeys',
      error: error instanceof Error ? error.name : 'unknown',
    });
    return null;
  }
}

/** The organization's phrase, if this device created or imported it with one. Commons only. */
export async function getOrganizationRecoveryPhrase(accountId: string): Promise<string | null> {
  if (!isOrganizationAccountId(accountId) || isWeb()) return null;
  const store = await phraseStore();
  return store.getItemAsync(mnemonicName(accountId), {
    keychainService: MNEMONIC_KEYCHAIN_SERVICE,
  } satisfies SecureStoreOptions);
}

/** The organizations this device keeps a key for (Commons' own index). */
export async function listOrganizationKeys(): Promise<string[]> {
  if (isWeb()) return [];
  return readIndex(await indexStore());
}

/** Forget an organization key on this device: its pair, its phrase, its signer copy and its index entry. */
export async function deleteOrganizationKey(accountId: string): Promise<void> {
  assertAccountId(accountId);
  if (isWeb()) return;
  const store = await pairStore();
  const options = pairOptions(store, false);
  await store.deleteItemAsync(privateKeyName(accountId), options);
  await store.deleteItemAsync(publicKeyName(accountId), options);
  await (await phraseStore()).deleteItemAsync(mnemonicName(accountId), {
    keychainService: MNEMONIC_KEYCHAIN_SERVICE,
  } satisfies SecureStoreOptions);
  const signer = isAndroid() ? registeredIdentitySignerStore() : null;
  await signer?.clearOrganization?.(accountId);
  const index = await indexStore();
  await writeIndex(
    index,
    (await readIndex(index)).filter((id) => id !== accountId),
  );
}

/**
 * Commons on Android: copy every held organization key into the identity
 * signer store again, so the identity host answers for it after that file was
 * rebuilt (its self-heal leaves it empty). Call on every boot, beside
 * `KeyManager.syncSharedIdentity`. Resolves how many it mirrored. Elsewhere 0.
 */
export async function syncOrganizationKeys(): Promise<number> {
  const signer = isAndroid() ? registeredIdentitySignerStore() : null;
  if (!signer?.writeOrganization || !signer.readOrganization) return 0;
  const store = await pairStore();
  let mirrored = 0;
  for (const accountId of await readIndex(await indexStore())) {
    const options = pairOptions(store, false);
    const privateKey = await store.getItemAsync(privateKeyName(accountId), options);
    const publicKey = await store.getItemAsync(publicKeyName(accountId), options);
    if (!privateKey || !publicKey || !isHealthyOrganizationKeyPair(privateKey, publicKey)) continue;
    const current = await signer.readOrganization(accountId);
    if (current?.publicKey.toLowerCase() === publicKey.toLowerCase()) continue;
    if (
      await signer.writeOrganization(
        accountId,
        normalizeSecp256k1PrivateKey(privateKey),
        publicKey.toLowerCase(),
      )
    ) {
      mirrored += 1;
    }
  }
  return mirrored;
}
