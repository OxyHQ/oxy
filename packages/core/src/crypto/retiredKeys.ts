/**
 * Retired identity keys: the keys an account HAD, kept on the device for
 * spending only (oxy ADR 0061 D7 as amended 2026-11-06, Peable ADR 0002).
 *
 * The Peable wallet derives from the account's identity key (`deriveScopedSeed`
 * for its HD wallet, `signSocialReceive` for its social-receive addresses), and
 * coins keep arriving under a key after it is replaced: payments already
 * broadcast settle against the key they were reserved under, and late payers
 * and `@username` senders hold old addresses. So a personal rotation
 * (`oxy.identity.rotateKey`) and an organization replacement keep the replaced
 * private key here, in a ring per account — `personal`, and one per
 * organization account id — instead of deleting it.
 *
 * A retired key is NEVER a way to sign in, publish, receive a new reservation or
 * rotate: nothing here signs a challenge, and the identity host refuses
 * `proveIdentity` / `describe` for one. It is reached exactly as the current key
 * is, by derivation and never by export, through the `publicKey` selector of
 * `KeyManager.deriveScopedSeed` / `signSocialReceive`:
 *
 * - iOS: the private key in the wallet keychain group (ADR 0062's
 *   `spending-key`: Commons and the Peable wallet only), beside the current
 *   private keys; the ring's index (public keys and dates only) in the same
 *   group, so the wallet can list it. Only Commons writes either.
 * - Android: Commons' own expo-secure-store slot, mirrored into the identity
 *   signer store (`./identitySigner`) that Commons' identity host answers
 *   `keyPublicKey` requests from (wallet only). Every other app asks over IPC
 *   (`loadCommonsIdentityBridge`) and never gets the key.
 *
 * A retired phrase is not kept: the person wrote it down, and a phrase is a
 * second copy of the key that buys the wallet nothing.
 *
 * A key enters the ring only from Commons: the key being replaced (rotation,
 * organization replacement), or a previous recovery phrase the person adds,
 * which Commons accepts only when Oxy's key history names it as one of the
 * account's retired keys. Never into the current slot.
 *
 * Security: a retired key that was compromised is also the attacker's. The
 * ring makes the coins under it spendable from Peable again; it cannot make
 * them safe. A rotation forced by a compromise must be followed at once by the
 * wallet's "move to your current key" sweep, which races the attacker.
 *
 * This module imports nothing from `./keyManager` (which imports it).
 */

import { mnemonicToSeed, validateMnemonic } from '@scure/bip39';
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
import { groupedKeychainStore, resolveKeychainAccess } from '../utils/keychainAccessGroups';
import { isAndroid, isIOS, isWeb } from '../utils/platform';
import { registeredIdentitySignerStore } from './identitySigner';
import { isOrganizationAccountId } from './keychainItems';
import { prepareKeychainAccess } from './keychainGroupMigration';
import type { OxySecureStoreOptions as SecureStoreOptions } from './secureStoreOptions';

/** Whose ring: the person's (`accountId` absent) or an organization's. */
export interface RetiredKeySelector {
  /** An organization's account id; absent for the personal ring. */
  accountId?: string;
}

/** One retired key as the ring lists it: public data only. */
export interface RetiredIdentityKey {
  /** Lowercase uncompressed secp256k1 public key (`04…`, 130 hex). */
  publicKey: string;
  /** The organization it was the key of; absent for a personal root. */
  accountId?: string;
  /** Unix milliseconds when this device kept it. */
  retiredAt: number;
}

/** A pair to keep in the ring. */
export interface RetiredKeyPair {
  privateKey: string;
  publicKey: string;
}

const PERSONAL_SCOPE = 'personal';
/** Android, Commons-local: its own Keystore-backed slot, shared with no other key. */
const ANDROID_KEYCHAIN_SERVICE = 'oxy_retired_identity';
const INDEX_KEYCHAIN_SERVICE = 'oxy_retired_identity_index';
const INDEX_STORAGE_KEY = 'oxy_retired_identity_index_v1';
const PUBLIC_KEY = /^04[0-9a-f]{128}$/;

/**
 * The secure store for the ring. On iOS every item is a `spending-key`
 * (ADR 0062): the private keys AND the index live in the wallet group, which
 * only Commons and the Peable wallet can read, never the shared one. In
 * Commons every access first awaits the access-group migration (`gate: false`
 * is the migration itself, keeping a pre-split copy). On Android the grouping
 * is a no-op and Commons' own services below apply.
 */
async function ringStore(gate = true): Promise<ExpoSecureStoreLike> {
  const raw = await loadSecureStore();
  const access = await resolveKeychainAccess();
  if (gate) await prepareKeychainAccess(access);
  return groupedKeychainStore(raw, access, 'spending-key');
}

/** The ring a selector names: `personal`, or the organization's account id. */
export function retiredKeyScope(selector?: RetiredKeySelector): string | null {
  const accountId = selector?.accountId;
  if (accountId === undefined) return PERSONAL_SCOPE;
  return isOrganizationAccountId(accountId) ? accountId : null;
}

function canonicalPublicKey(publicKey: string): string | null {
  try {
    const normalized = normalizeSecp256k1PublicKey(publicKey.trim());
    return PUBLIC_KEY.test(normalized) ? normalized : null;
  } catch {
    return null;
  }
}

function publicKeyOf(privateKey: string): string {
  return deriveSecp256k1PublicKey(normalizeSecp256k1PrivateKey(privateKey));
}

function isHealthyPair(privateKey: string, publicKey: string): boolean {
  if (!isValidSecp256k1PrivateKey(privateKey) || !isValidSecp256k1PublicKey(publicKey)) {
    return false;
  }
  try {
    return publicKeyOf(privateKey) === normalizeSecp256k1PublicKey(publicKey);
  } catch {
    return false;
  }
}

const privateKeyName = (scope: string, publicKey: string) =>
  `oxy_retired_identity_private_key.${scope}.${publicKey}`;

/** The options of a private half: on iOS none but accessibility (the group comes from {@link ringStore}). */
function privateOptions(store: ExpoSecureStoreLike, forWrite: boolean): SecureStoreOptions {
  if (isIOS()) {
    return forWrite ? { keychainAccessible: store.WHEN_UNLOCKED_THIS_DEVICE_ONLY } : {};
  }
  return forWrite
    ? {
        keychainAccessible: store.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
        keychainService: ANDROID_KEYCHAIN_SERVICE,
      }
    : { keychainService: ANDROID_KEYCHAIN_SERVICE };
}

/** The index: public keys and dates, beside the private halves. */
function indexOptions(): SecureStoreOptions {
  return isIOS() ? {} : { keychainService: INDEX_KEYCHAIN_SERVICE };
}

interface IndexEntry {
  scope: string;
  publicKey: string;
  retiredAt: number;
}

function isIndexEntry(value: unknown): value is IndexEntry {
  if (typeof value !== 'object' || value === null) return false;
  const entry = value as Record<string, unknown>;
  return (
    typeof entry.scope === 'string' &&
    (entry.scope === PERSONAL_SCOPE || isOrganizationAccountId(entry.scope)) &&
    typeof entry.publicKey === 'string' &&
    PUBLIC_KEY.test(entry.publicKey) &&
    typeof entry.retiredAt === 'number' &&
    Number.isFinite(entry.retiredAt)
  );
}

async function readIndex(store: ExpoSecureStoreLike): Promise<IndexEntry[]> {
  const raw = await store.getItemAsync(INDEX_STORAGE_KEY, indexOptions());
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(isIndexEntry) : [];
  } catch (error) {
    logger.warn('Retired key index unreadable; treating as empty', {
      component: 'RetiredKeys',
      error: error instanceof Error ? error.name : 'unknown',
    });
    return [];
  }
}

async function writeIndex(store: ExpoSecureStoreLike, entries: IndexEntry[]): Promise<void> {
  const unique = new Map<string, IndexEntry>();
  for (const entry of entries) {
    const id = `${entry.scope}.${entry.publicKey}`;
    if (!unique.has(id)) unique.set(id, entry);
  }
  const sorted = [...unique.values()].sort(
    (a, b) => a.retiredAt - b.retiredAt || a.publicKey.localeCompare(b.publicKey),
  );
  await store.setItemAsync(INDEX_STORAGE_KEY, JSON.stringify(sorted), indexOptions());
}

function toListed(entry: IndexEntry): RetiredIdentityKey {
  return entry.scope === PERSONAL_SCOPE
    ? { publicKey: entry.publicKey, retiredAt: entry.retiredAt }
    : { publicKey: entry.publicKey, accountId: entry.scope, retiredAt: entry.retiredAt };
}

/**
 * Whether this app writes the ring: Commons only (Android: the signer store it
 * registers; iOS: the keychain role `holder`). The Peable wallet holds the
 * wallet group too, but only reads, derives and signs: a key the wallet could
 * add to the ring is a key it could choose (R4-14).
 */
async function assertMayWrite(): Promise<void> {
  if (isWeb()) throw new Error('retired key: only a native device holds one');
  if (isAndroid() && !registeredIdentitySignerStore()?.writeRetired) {
    throw new Error(
      'On Android only Commons holds retired keys; this app has no identity signer store for them.',
    );
  }
  if (isIOS()) {
    const access = await resolveKeychainAccess();
    if (access.mode === 'grouped' && access.role !== 'holder') {
      throw new Error('On iOS only Commons writes retired keys; this app may only read them.');
    }
  }
}

/**
 * Keep `key` in the ring of `selector`'s account. Commons only. Idempotent: a
 * key already kept stays, with its first date. Refuses a pair whose public key
 * does not derive from its private key. Resolves once every copy confirmed it
 * (Android: the signer store's read-back too), and throws otherwise, so a
 * caller about to replace the key can stop before anything is lost.
 */
export async function retireIdentityKey(
  key: RetiredKeyPair,
  selector?: RetiredKeySelector,
): Promise<void> {
  await keepRetired(key, selector, true);
}

/**
 * {@link retireIdentityKey} from inside the iOS access-group migration, which
 * keeps a replaced pre-split copy before deleting it from the shared group and
 * cannot await itself. @internal
 */
export async function retireIdentityKeyDuringMigration(
  key: RetiredKeyPair,
  selector?: RetiredKeySelector,
): Promise<void> {
  await keepRetired(key, selector, false);
}

async function keepRetired(
  key: RetiredKeyPair,
  selector: RetiredKeySelector | undefined,
  gate: boolean,
): Promise<void> {
  const scope = retiredKeyScope(selector);
  if (!scope) throw new Error('retired key: accountId must be a 24-hex or uuid account id');
  await assertMayWrite();
  if (!isHealthyPair(key.privateKey, key.publicKey)) {
    throw new Error('retired key: the public key does not derive from the private key');
  }
  const privateKey = normalizeSecp256k1PrivateKey(key.privateKey);
  const publicKey = normalizeSecp256k1PublicKey(key.publicKey);
  const store = await ringStore(gate);
  await store.setItemAsync(
    privateKeyName(scope, publicKey),
    privateKey,
    privateOptions(store, true),
  );
  const readBack = await store.getItemAsync(
    privateKeyName(scope, publicKey),
    privateOptions(store, false),
  );
  if (readBack !== privateKey) {
    throw new Error('retired key: the keychain did not confirm the key');
  }
  const signer = isAndroid() ? registeredIdentitySignerStore() : null;
  if (signer?.writeRetired && !(await signer.writeRetired(scope, privateKey, publicKey))) {
    throw new Error(`The identity signer store (${signer.name}) did not confirm the retired key.`);
  }
  const index = await readIndex(store);
  if (!index.some((entry) => entry.scope === scope && entry.publicKey === publicKey)) {
    await writeIndex(store, [...index, { scope, publicKey, retiredAt: Date.now() }]);
  }
}

/**
 * The retired keys of `selector`'s account this app can reach, oldest first.
 * iOS and Commons: the ring's index. Android elsewhere: Commons' identity host
 * (the wallet only), which leaves out the scope's current key. After an
 * interrupted rotation the local list can include the current key: compare
 * with the DID's `#key-1` before treating an entry as retired.
 */
export async function listRetiredIdentityKeys(
  selector?: RetiredKeySelector,
): Promise<RetiredIdentityKey[]> {
  const scope = retiredKeyScope(selector);
  if (!scope || isWeb()) return [];
  try {
    if (isAndroid() && !registeredIdentitySignerStore()) {
      const bridge = await loadCommonsIdentityBridge();
      const keys = (await bridge?.listRetiredKeys?.(selector?.accountId)) ?? null;
      return (keys ?? []).map((publicKey) =>
        scope === PERSONAL_SCOPE
          ? { publicKey, retiredAt: 0 }
          : { publicKey, accountId: scope, retiredAt: 0 },
      );
    }
    if (!isIOS() && !isAndroid()) return [];
    const store = await ringStore();
    return (await readIndex(store)).filter((entry) => entry.scope === scope).map(toListed);
  } catch (error) {
    logger.warn('Failed to list retired keys', {
      component: 'RetiredKeys',
      error: error instanceof Error ? error.name : 'unknown',
    });
    return [];
  }
}

/**
 * The private half of a retired key, where this app may hold it: Commons (both
 * platforms) and, on iOS, the keychain group. `null` on Android outside Commons
 * (ask the identity host instead) and for a key not in the ring. Sign within
 * the app only; never transmit it. @internal — `KeyManager` reads it for the
 * `publicKey` selector.
 */
export async function getRetiredPrivateKey(
  publicKey: string,
  selector?: RetiredKeySelector,
): Promise<string | null> {
  const scope = retiredKeyScope(selector);
  const canonical = canonicalPublicKey(publicKey);
  if (!scope || !canonical || isWeb()) return null;
  try {
    if (isAndroid()) {
      const signer = registeredIdentitySignerStore();
      if (!signer) return null;
      const store = await ringStore();
      const local = await store.getItemAsync(
        privateKeyName(scope, canonical),
        privateOptions(store, false),
      );
      if (local && isHealthyPair(local, canonical)) return normalizeSecp256k1PrivateKey(local);
      // The signer store is a rung: a wiped expo-secure-store slot still has it.
      const mirrored = (await signer.readRetired?.(scope, canonical)) ?? null;
      return mirrored && isHealthyPair(mirrored.privateKey, canonical)
        ? normalizeSecp256k1PrivateKey(mirrored.privateKey)
        : null;
    }
    if (!isIOS()) return null;
    const store = await ringStore();
    const value = await store.getItemAsync(
      privateKeyName(scope, canonical),
      privateOptions(store, false),
    );
    return value && isHealthyPair(value, canonical) ? normalizeSecp256k1PrivateKey(value) : null;
  } catch (error) {
    logger.warn('Failed to read a retired key', {
      component: 'RetiredKeys',
      error: error instanceof Error ? error.name : 'unknown',
    });
    return null;
  }
}

/**
 * Forget a retired key on this device: its private half, its signer copy and
 * its index entry. Commons only, and only on the person's explicit request
 * (their coins under it are then spendable only with its phrase again).
 */
export async function forgetRetiredIdentityKey(
  publicKey: string,
  selector?: RetiredKeySelector,
): Promise<void> {
  const scope = retiredKeyScope(selector);
  const canonical = canonicalPublicKey(publicKey);
  if (!scope || !canonical) throw new Error('retired key: invalid selector or public key');
  await assertMayWrite();
  const store = await ringStore();
  await store.deleteItemAsync(privateKeyName(scope, canonical), privateOptions(store, false));
  const signer = isAndroid() ? registeredIdentitySignerStore() : null;
  await signer?.clearRetired?.(scope, canonical);
  await writeIndex(
    store,
    (await readIndex(store)).filter(
      (entry) => !(entry.scope === scope && entry.publicKey === canonical),
    ),
  );
}

/**
 * Forget every retired key of one ring (the person's, or an organization's).
 * Commons only, and only when the person deletes their Oxy ACCOUNT (Commons'
 * delete-account flow), which tells them the coins go with it. Deleting the
 * identity from this device — "Start over", a forced delete — never calls it:
 * the ring is money, and the same person restoring their identity later must
 * find it (R4-4). Resolves how many it removed.
 */
export async function forgetRetiredIdentityKeys(selector?: RetiredKeySelector): Promise<number> {
  const scope = retiredKeyScope(selector);
  if (!scope || isWeb()) return 0;
  if (isAndroid() && !registeredIdentitySignerStore()) return 0;
  const store = await ringStore();
  const index = await readIndex(store);
  const signer = isAndroid() ? registeredIdentitySignerStore() : null;
  let removed = 0;
  for (const entry of index) {
    if (entry.scope !== scope) continue;
    await store.deleteItemAsync(
      privateKeyName(scope, entry.publicKey),
      privateOptions(store, false),
    );
    await signer?.clearRetired?.(scope, entry.publicKey);
    removed += 1;
  }
  await writeIndex(
    store,
    index.filter((entry) => entry.scope !== scope),
  );
  return removed;
}

/**
 * Commons on Android: copy every retired key into the identity signer store
 * again, so the identity host answers for it after that file was rebuilt (its
 * self-heal leaves it empty). Call on every boot, beside `syncOrganizationKeys`.
 * Resolves how many it mirrored. Elsewhere 0.
 */
export async function syncRetiredKeys(): Promise<number> {
  const signer = isAndroid() ? registeredIdentitySignerStore() : null;
  if (!signer?.writeRetired || !signer.readRetired) return 0;
  const store = await ringStore();
  let mirrored = 0;
  for (const entry of await readIndex(store)) {
    const privateKey = await store.getItemAsync(
      privateKeyName(entry.scope, entry.publicKey),
      privateOptions(store, false),
    );
    if (!privateKey || !isHealthyPair(privateKey, entry.publicKey)) continue;
    const current = await signer.readRetired(entry.scope, entry.publicKey);
    if (current?.publicKey.toLowerCase() === entry.publicKey) continue;
    if (
      await signer.writeRetired(
        entry.scope,
        normalizeSecp256k1PrivateKey(privateKey),
        entry.publicKey,
      )
    ) {
      mirrored += 1;
    }
  }
  return mirrored;
}

/**
 * Every retired key of `selector`'s ring WITH its private half, for the
 * encrypted identity backup (`oxy.identity.backup.create`), which carries them
 * under the CURRENT phrase so a lost phone costs no more than the current
 * phrase does (R4-4). Commons only; an entry whose private half is missing or
 * does not derive its public key is left out. Never log or transmit the result
 * except inside that encrypted envelope.
 */
export async function exportRetiredIdentityKeys(
  selector?: RetiredKeySelector,
): Promise<Array<RetiredKeyPair & { retiredAt: number }>> {
  const scope = retiredKeyScope(selector);
  if (!scope || isWeb()) return [];
  await assertMayWrite();
  const out: Array<RetiredKeyPair & { retiredAt: number }> = [];
  for (const entry of await listRetiredIdentityKeys(selector)) {
    const privateKey = await getRetiredPrivateKey(entry.publicKey, selector);
    if (privateKey)
      out.push({ privateKey, publicKey: entry.publicKey, retiredAt: entry.retiredAt });
  }
  return out;
}

/**
 * The pair a previous key's raw PRIVATE KEY gives (64 hex, an optional `0x`),
 * for a person whose old identity was imported as a private key and so has no
 * phrase to re-enter. Stores nothing: the caller checks the public key against
 * the account's key history and only then calls {@link retireIdentityKey}.
 */
export function retiredKeyFromPrivateKey(privateKeyHex: string): RetiredKeyPair {
  const trimmed = privateKeyHex.trim().toLowerCase().replace(/^0x/, '');
  if (!/^[0-9a-f]{64}$/.test(trimmed) || !isValidSecp256k1PrivateKey(trimmed)) {
    throw new Error('retired key: not a valid private key');
  }
  const privateKey = normalizeSecp256k1PrivateKey(trimmed);
  return { privateKey, publicKey: publicKeyOf(privateKey) };
}

/**
 * The pair a previous recovery phrase derives (`seed[0:32]`, the personal-root
 * and organization-key derivation; 12–24 words). Stores nothing: the caller
 * checks the public key against the account's key history (personal:
 * `oxy.identity.keyHistory()`; organization: `oxy.accounts.identityKey.get`)
 * and only then calls {@link retireIdentityKey}.
 */
export async function retiredKeyFromPhrase(phrase: string): Promise<RetiredKeyPair> {
  const normalized = phrase.trim().toLowerCase().split(/\s+/).join(' ');
  const words = normalized.split(' ').length;
  if (words < 12 || words > 24 || words % 3 !== 0 || !validateMnemonic(normalized, wordlist)) {
    throw new Error('retired key: not a valid recovery phrase');
  }
  const seed = await mnemonicToSeed(normalized);
  const privateKey = Array.from(seed.subarray(0, 32), (b) => b.toString(16).padStart(2, '0')).join(
    '',
  );
  return { privateKey, publicKey: publicKeyOf(privateKey) };
}
