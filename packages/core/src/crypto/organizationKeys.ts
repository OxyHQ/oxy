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
import {
  pendingOrganizationRevalidation,
  settleOrganizationRevalidations,
  prepareKeychainAccess,
  settleOrganizationRevalidation,
} from './keychainGroupMigration';
import {
  getRetiredPrivateKey,
  quarantineRetiredIdentityKey,
  retireIdentityKey,
} from './retiredKeys';
import {
  ORGANIZATION_ANDROID_KEYCHAIN_SERVICE as ANDROID_KEYCHAIN_SERVICE,
  ORGANIZATION_INDEX_KEYCHAIN_SERVICE as INDEX_KEYCHAIN_SERVICE,
  ORGANIZATION_INDEX_STORAGE_KEY as INDEX_STORAGE_KEY,
  ORGANIZATION_MNEMONIC_KEYCHAIN_SERVICE as MNEMONIC_KEYCHAIN_SERVICE,
  isOrganizationAccountId,
  organizationMnemonicName as mnemonicName,
  organizationPrivateKeyName as privateKeyName,
  organizationPublicKeyName as publicKeyName,
  parseOrganizationIndexStrict,
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
  await prepareKeychainAccess(access);
  return groupedKeychainStore(raw, access, item);
}

const pairStore = () => secureStore('spending-key');
const phraseStore = () => secureStore('identity-secret');
const indexStore = () => secureStore('identity-secret');

/**
 * Commons' organization index, STRICT (R5-9): an index that cannot be read as
 * one throws (`OrganizationKeyIndexUnreadableError`, or the keychain's own
 * error) instead of reading as empty, so no writer overwrites it and drops the
 * organizations it names.
 */
async function readIndex(store: ExpoSecureStoreLike): Promise<string[]> {
  return parseOrganizationIndexStrict(
    await store.getItemAsync(INDEX_STORAGE_KEY, {
      keychainService: INDEX_KEYCHAIN_SERVICE,
    } satisfies SecureStoreOptions),
  );
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
 * phrase that does not derive the pair. A DIFFERENT key this device already
 * held for the organization is first kept in the organization's retired ring
 * (ADR 0061 D7 as amended; R4-12): coins under it still need it. When that
 * cannot be confirmed nothing is overwritten and this throws.
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
  // Strict, and first: an unreadable index stops the write before anything changes.
  const index = await indexStore();
  await readIndex(index);
  const store = await pairStore();
  const previous = await heldPrivateKey(store, accountId);
  if (previous) {
    const previousPublic = deriveSecp256k1PublicKey(previous);
    if (previousPublic !== publicKey) {
      try {
        await retireIdentityKey({ privateKey: previous, publicKey: previousPublic }, { accountId });
      } catch (error) {
        throw new Error(
          `organization key: the key this device held could not be kept as a previous key, so it was not replaced (${error instanceof Error ? error.message : 'unknown'})`,
        );
      }
    }
  }
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
/**
 * {@link getOrganizationPrivateKey} that never turns a failed read into "no
 * key" (security review R7-4): `null` only when the read succeeded and found
 * none; a keychain error propagates. @internal — `KeyManager`'s `publicKey`
 * selector.
 */
export async function getOrganizationPrivateKeyStrict(accountId: string): Promise<string | null> {
  if (!isOrganizationAccountId(accountId)) return null;
  return (await readLocalPair(accountId))?.privateKey ?? null;
}

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

/**
 * The private key this device holds for `accountId`, whatever its public half
 * says (an unhealthy pair is still a key coins may sit under): the slot, then
 * on Android the signer store's copy. `null` when there is none.
 */
async function heldPrivateKey(
  store: ExpoSecureStoreLike,
  accountId: string,
): Promise<string | null> {
  const local = await store.getItemAsync(privateKeyName(accountId), pairOptions(store, false));
  if (local && isValidSecp256k1PrivateKey(local)) return normalizeSecp256k1PrivateKey(local);
  const signer = isAndroid() ? registeredIdentitySignerStore() : null;
  const mirrored = (await signer?.readOrganization?.(accountId)) ?? null;
  return mirrored && isValidSecp256k1PrivateKey(mirrored.privateKey)
    ? normalizeSecp256k1PrivateKey(mirrored.privateKey)
    : null;
}

/**
 * Commons (R5-7): make the organization's CURRENT key, `currentPublicKey` as
 * Oxy publishes it (`oxy.accounts.identityKey.get(accountId).publicKey`), the
 * live pair again from the organization's retired ring, when this device holds
 * no pair for it. The access-group migration keeps an organization key it
 * cannot vouch for quarantined in the ring instead of adopting it; once
 * {@link claimRetiredOrganizationKeys} has bound it against that history, this
 * puts it back where the wallet derives from. Never replaces a held pair.
 * Resolves whether it adopted one.
 */
export async function adoptOrganizationKeyFromRing(
  accountId: string,
  currentPublicKey: string,
): Promise<boolean> {
  assertAccountId(accountId);
  if (isWeb()) return false;
  if (await readLocalPair(accountId)) return false;
  let publicKey: string;
  try {
    publicKey = normalizeSecp256k1PublicKey(currentPublicKey.trim());
  } catch {
    return false;
  }
  const privateKey = await getRetiredPrivateKey(publicKey, { accountId });
  if (!privateKey) return false;
  await storeOrganizationKey(accountId, { privateKey, publicKey });
  return true;
}

/**
 * What Commons reads to re-validate a held organization pair: the
 * organization's published key (`oxy.accounts.identityKey.get(accountId)`).
 */
export type OrganizationPublishedKeyReader = (
  accountId: string,
) => Promise<{ publicKey: string | null }>;

/**
 * Commons, iOS (security review R6-3): check every organization pair a `v: 1`
 * access-group migration may have adopted without provenance against the key
 * the organization PUBLISHES. Core 7.32 adopted organization pairs from the
 * shared keychain group, which every Oxy app can write. A pair equal to the
 * published key stays. Any other pair (the organization publishes a different
 * key, or none) is kept QUARANTINED in that organization's ring, read back,
 * and only then removed as the live pair (its index entry and Android mirror
 * too; a phrase stays where only Commons reads it), so the wallet never
 * derives from it; `claimRetiredOrganizationKeys` binds it later if the
 * organization's history names it. An organization whose key cannot be read
 * now (offline, not an owner or admin) stays pending for a later launch. Call
 * at launch, before `bindQuarantinedOrganizationKeys`. Resolves how many pairs
 * it quarantined. No-op elsewhere.
 */
export async function revalidateHeldOrganizationKeys(
  readPublished: OrganizationPublishedKeyReader,
): Promise<number> {
  if (!isIOS()) return 0;
  const pending = await pendingOrganizationRevalidation();
  if (pending.length === 0) return 0;
  // First, with no network read (R7-11): an id that is not an organization's,
  // or for which this device holds no pair, has nothing to check. A planted
  // list of invented ids settles here, in one write.
  const store = await pairStore();
  const toCheck: string[] = [];
  const nothingToCheck: string[] = [];
  for (const accountId of pending) {
    if (!isOrganizationAccountId(accountId)) {
      nothingToCheck.push(accountId);
      continue;
    }
    let held: string | null;
    try {
      held = await heldPrivateKey(store, accountId);
    } catch {
      // Unreadable now: a later launch asks again.
      continue;
    }
    if (held) toCheck.push(accountId);
    else nothingToCheck.push(accountId);
  }
  if (nothingToCheck.length > 0) await settleOrganizationRevalidations(nothingToCheck);

  // Then at most MAX_REVALIDATIONS_PER_LAUNCH reads of the published key; the
  // rest wait for the next launch. One organization that fails (offline, not
  // an owner, a keychain error) stays pending and never stops the others.
  let quarantined = 0;
  for (const accountId of toCheck.slice(0, MAX_REVALIDATIONS_PER_LAUNCH)) {
    try {
      let published: string | null;
      try {
        const answer = (await readPublished(accountId)).publicKey;
        published = answer ? normalizeSecp256k1PublicKey(answer.trim()) : null;
      } catch {
        continue;
      }
      const held = await heldPrivateKey(store, accountId);
      const heldPublic = held ? deriveSecp256k1PublicKey(held) : null;
      if (held && heldPublic && heldPublic !== published) {
        // A pair this device held: kept whatever a planted shared group put
        // in the quarantine (R7-5).
        await quarantineRetiredIdentityKey(
          { privateKey: held, publicKey: heldPublic },
          { accountId },
          { exempt: true },
        );
        await removeLivePair(accountId);
        quarantined += 1;
      }
      await settleOrganizationRevalidation(accountId);
    } catch (error) {
      logger.warn('Could not re-validate a held organization key; it stays pending', {
        component: 'OrganizationKeys',
        error: error instanceof Error ? error.name : 'unknown',
      });
    }
  }
  return quarantined;
}

/**
 * How many organizations {@link revalidateHeldOrganizationKeys} asks Oxy about
 * in one launch (R7-11). A real device holds a handful of organization keys.
 */
export const MAX_REVALIDATIONS_PER_LAUNCH = 16;

/** Remove an organization's live pair, its Android mirror and its index entry; its phrase stays. */
async function removeLivePair(accountId: string): Promise<void> {
  const index = await indexStore();
  const ids = await readIndex(index);
  const store = await pairStore();
  const options = pairOptions(store, false);
  await store.deleteItemAsync(privateKeyName(accountId), options);
  await store.deleteItemAsync(publicKeyName(accountId), options);
  const signer = isAndroid() ? registeredIdentitySignerStore() : null;
  await signer?.clearOrganization?.(accountId);
  await writeIndex(
    index,
    ids.filter((id) => id !== accountId),
  );
}

/** Forget an organization key on this device: its pair, its phrase, its signer copy and its index entry. */
export async function deleteOrganizationKey(accountId: string): Promise<void> {
  assertAccountId(accountId);
  if (isWeb()) return;
  const index = await indexStore();
  const ids = await readIndex(index);
  const store = await pairStore();
  const options = pairOptions(store, false);
  await store.deleteItemAsync(privateKeyName(accountId), options);
  await store.deleteItemAsync(publicKeyName(accountId), options);
  await (await phraseStore()).deleteItemAsync(mnemonicName(accountId), {
    keychainService: MNEMONIC_KEYCHAIN_SERVICE,
  } satisfies SecureStoreOptions);
  const signer = isAndroid() ? registeredIdentitySignerStore() : null;
  await signer?.clearOrganization?.(accountId);
  await writeIndex(
    index,
    ids.filter((id) => id !== accountId),
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
