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
import { signMessage } from '@oxy.so/protocol/sign';
import { logger } from '../logger';
import { groupedKeychainStore, resolveKeychainAccess } from '../utils/keychainAccessGroups';
import { isAndroid, isIOS, isWeb } from '../utils/platform';
import { registeredIdentitySignerStore } from './identitySigner';
import { isOrganizationAccountId } from './keychainItems';
import { prepareKeychainAccess } from './keychainGroupMigration';
import type { OxySecureStoreOptions as SecureStoreOptions } from './secureStoreOptions';

/**
 * Whose ring: the person's (`accountId` absent) or an organization's.
 *
 * The personal ring is BOUND TO ITS OWNER (R5-2): every personal entry records
 * the Oxy account id of the person whose key it was, and a personal read
 * reaches only the entries of `ownerAccountId`. A phone outlives the person on
 * it ("Start over" keeps the ring: it is money, recoverable from that account's
 * backup), so the next person on the phone must never list, derive from or
 * sign with a previous person's keys. A personal read without `ownerAccountId`
 * reaches nothing. An entry whose owner is not known (a key the access-group
 * migration kept, an entry written before 7.33.0) is QUARANTINED: invisible to
 * every reader until Commons binds it with {@link claimRetiredIdentityKeys},
 * which requires the account's key history to name it.
 */
export interface RetiredKeySelector {
  /** An organization's account id; absent for the personal ring. */
  accountId?: string;
  /**
   * The person's Oxy account id, for the PERSONAL ring: whose entries are
   * reached. Ignored for an organization's ring (its owner is `accountId`).
   */
  ownerAccountId?: string;
}

/** Thrown when the ring's index cannot be read as the ring: never treated as empty (R5-9). */
export class RetiredKeyRingUnreadableError extends Error {
  constructor(reason: string) {
    super(`retired key ring: ${reason}`);
    this.name = 'RetiredKeyRingUnreadableError';
  }
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
  // The ring never lived in the shared group (R6-12): no read falls back to
  // it, not even the Peable wallet's before Commons' migration finished. Any
  // Oxy app can write that group, so a ring index or key found there is never
  // one Commons wrote.
  return groupedKeychainStore(raw, access, 'spending-key', { ownGroupOnly: true });
}

/**
 * How many QUARANTINED entries the ring keeps at most, personal and
 * organization ones together (R6-14). Every Oxy app can write the shared
 * group, and every valid key found there is kept quarantined (R5-3), so
 * without a bound a planted shared group grows the ring (and the work of
 * every reader and of Commons' launch-time claims) without end. A real phone
 * holds a handful. Past the bound a new quarantined key is refused
 * ({@link RetiredKeyQuarantineFullError}) and its shared copy is LEFT where it
 * is: never lost, never trusted.
 */
export const MAX_QUARANTINED_RING_ENTRIES = 64;

/** Thrown when the ring already holds {@link MAX_QUARANTINED_RING_ENTRIES} quarantined entries. */
export class RetiredKeyQuarantineFullError extends Error {
  constructor() {
    super('retired key ring: the quarantine is full');
    this.name = 'RetiredKeyQuarantineFullError';
  }
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
  /**
   * Personal entries: the Oxy account id of the person whose key it was.
   * Absent: quarantined (never listed, derived from or signed with).
   */
  owner?: string;
  /**
   * Organization entries: `true` while the key's provenance is unknown (a copy
   * the access-group migration found in the shared group, which every Oxy app
   * could write; R5-3, R5-7). Never listed, derived from or signed with until
   * {@link claimRetiredOrganizationKeys} binds it against the organization's
   * own key history. The organization counterpart of a personal entry without
   * an `owner`.
   */
  quarantined?: true;
}

const ACCOUNT_ID =
  /^(?:[0-9a-f]{24}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

/** A well-formed Oxy account id (24-hex or uuid), else `null`. */
function ownerOf(ownerAccountId: string | undefined): string | null {
  return ownerAccountId !== undefined && ACCOUNT_ID.test(ownerAccountId)
    ? ownerAccountId.toLowerCase()
    : null;
}

/**
 * Whether `entry` may be reached by a reader of `scope` acting for `owner`: an
 * organization's entries by its own scope, a personal entry only by its owner.
 */
function isVisible(entry: IndexEntry, scope: string, owner: string | null): boolean {
  if (entry.scope !== scope) return false;
  if (scope !== PERSONAL_SCOPE) return entry.quarantined !== true;
  return owner !== null && entry.owner === owner;
}

/** Whether nobody may reach `entry` yet: a personal one without an owner, a quarantined organization one. */
function isQuarantined(entry: IndexEntry): boolean {
  return entry.scope === PERSONAL_SCOPE ? entry.owner === undefined : entry.quarantined === true;
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
    Number.isFinite(entry.retiredAt) &&
    (entry.owner === undefined ||
      (typeof entry.owner === 'string' && ACCOUNT_ID.test(entry.owner))) &&
    (entry.quarantined === undefined || entry.quarantined === true)
  );
}

/**
 * The ring's index. STRICT (R5-6, R5-9): an index that does not parse, or that
 * holds an entry this version cannot read, THROWS
 * {@link RetiredKeyRingUnreadableError} instead of reading as empty, so no
 * writer overwrites it (losing every entry) and no backup is sealed without
 * the keys it names. A thrown keychain read propagates.
 */
async function readIndex(store: ExpoSecureStoreLike): Promise<IndexEntry[]> {
  const raw = await store.getItemAsync(INDEX_STORAGE_KEY, indexOptions());
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new RetiredKeyRingUnreadableError('the index does not parse');
  }
  if (!Array.isArray(parsed) || !parsed.every(isIndexEntry)) {
    throw new RetiredKeyRingUnreadableError('the index holds an entry this version cannot read');
  }
  return parsed.map((entry: IndexEntry) =>
    entry.owner === undefined ? entry : { ...entry, owner: entry.owner.toLowerCase() },
  );
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
  // The owner is the reader's own id; it is not repeated.
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
 * Whether this app holds a retired ring at all (R5-6): Commons on Android (the
 * signer store it registers) and on iOS (keychain role `holder`, or a build
 * without the split). `false` only when this app DEFINITELY holds none (web,
 * every other app), so a caller can tell "no ring here" from "a ring that
 * cannot be read" without catching every error. A keychain that cannot say
 * which role this app has answers `true`: the caller then reads the ring and
 * meets the real error. Never throws.
 */
export async function holdsRetiredRing(): Promise<boolean> {
  if (isWeb()) return false;
  if (isAndroid()) return Boolean(registeredIdentitySignerStore()?.writeRetired);
  if (!isIOS()) return false;
  try {
    const access = await resolveKeychainAccess();
    return access.mode !== 'grouped' || access.role === 'holder';
  } catch {
    return true;
  }
}

/**
 * Keep `key` in the ring of `selector`'s account. Commons only. A PERSONAL key
 * needs `selector.ownerAccountId`, the person whose key it was (R5-2): the
 * signed-in account at a rotation, the account whose key history or backup
 * named it. Idempotent: a key already kept stays, with its first date; a
 * quarantined entry of the same key is bound to that owner; an entry bound to
 * a DIFFERENT owner is refused. Refuses a pair whose public key does not
 * derive from its private key. Resolves once every copy confirmed it
 * (Android: the signer store's read-back too), and throws otherwise, so a
 * caller about to replace the key can stop before anything is lost.
 */
export async function retireIdentityKey(
  key: RetiredKeyPair,
  selector?: RetiredKeySelector,
): Promise<void> {
  const scope = retiredKeyScope(selector);
  if (scope === PERSONAL_SCOPE && ownerOf(selector?.ownerAccountId) === null) {
    throw new Error('retired key: a personal key needs ownerAccountId, the account it belongs to');
  }
  await keepRetired(key, selector, true);
}

/**
 * {@link retireIdentityKey} from inside the iOS access-group migration (and a
 * Commons secret write that finds a different copy in the shared group),
 * which keeps a pre-split copy before deleting it from the shared group and
 * cannot await the migration. A personal key without `ownerAccountId` is kept
 * QUARANTINED: held (it may be money) but reached by nobody until
 * {@link claimRetiredIdentityKeys} binds it. An organization key with
 * `quarantine` is kept the same way until {@link claimRetiredOrganizationKeys}
 * binds it (R5-3, R5-7). @internal
 */
export async function retireIdentityKeyDuringMigration(
  key: RetiredKeyPair,
  selector?: RetiredKeySelector,
  options?: { quarantine?: boolean },
): Promise<void> {
  await keepRetired(key, selector, false, options?.quarantine === true);
}

/**
 * Keep `key` in `selector`'s ring QUARANTINED (security review R6-10): held,
 * because it may be money, but reached by nobody until the account's own key
 * history names it ({@link claimRetiredIdentityKeys} for the person,
 * {@link claimRetiredOrganizationKeys} for an organization). Commons only. For
 * a key whose owner nothing has proven yet: one an older identity left in a
 * slot, one a backup carried that the history does not name, or an
 * organization pair the organization does not publish. A key the ring already
 * holds keeps its binding. Throws {@link RetiredKeyQuarantineFullError} past
 * the bound.
 */
export async function quarantineRetiredIdentityKey(
  key: RetiredKeyPair,
  selector?: Pick<RetiredKeySelector, 'accountId'>,
): Promise<void> {
  await keepRetired(
    key,
    selector?.accountId === undefined ? {} : { accountId: selector.accountId },
    true,
    true,
  );
}

async function keepRetired(
  key: RetiredKeyPair,
  selector: RetiredKeySelector | undefined,
  gate: boolean,
  quarantine = false,
): Promise<void> {
  const scope = retiredKeyScope(selector);
  if (!scope) throw new Error('retired key: accountId must be a 24-hex or uuid account id');
  const owner = scope === PERSONAL_SCOPE ? ownerOf(selector?.ownerAccountId) : null;
  // An organization key is quarantined only when its provenance is unknown;
  // a known one (Commons replacing the key it held) binds a quarantined entry.
  const orgQuarantine = scope !== PERSONAL_SCOPE && quarantine;
  await assertMayWrite();
  if (!isHealthyPair(key.privateKey, key.publicKey)) {
    throw new Error('retired key: the public key does not derive from the private key');
  }
  const privateKey = normalizeSecp256k1PrivateKey(key.privateKey);
  const publicKey = normalizeSecp256k1PublicKey(key.publicKey);
  const store = await ringStore(gate);
  // Strict: an unreadable index stops the write before the key is touched.
  const before = await readIndex(store);
  const existing = before.find((entry) => entry.scope === scope && entry.publicKey === publicKey);
  if (existing?.owner !== undefined && owner !== null && existing.owner !== owner) {
    throw new Error('retired key: this key is kept for a different account');
  }
  // A NEW quarantined entry counts against the bound (R6-14); binding or
  // re-keeping an entry the ring already has never does.
  const entersQuarantine = scope === PERSONAL_SCOPE ? owner === null : orgQuarantine;
  if (
    !existing &&
    entersQuarantine &&
    before.filter(isQuarantined).length >= MAX_QUARANTINED_RING_ENTRIES
  ) {
    throw new RetiredKeyQuarantineFullError();
  }
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
  const index = await readIndex(store);
  const kept = index.find((entry) => entry.scope === scope && entry.publicKey === publicKey);
  let stored: IndexEntry;
  if (!kept) {
    stored =
      owner !== null
        ? { scope, publicKey, retiredAt: Date.now(), owner }
        : orgQuarantine
          ? { scope, publicKey, retiredAt: Date.now(), quarantined: true }
          : { scope, publicKey, retiredAt: Date.now() };
    await writeIndex(store, [...index, stored]);
  } else if (kept.owner === undefined && owner !== null) {
    stored = { ...kept, owner };
    await writeIndex(
      store,
      index.map((entry) => (entry === kept ? stored : entry)),
    );
  } else if (kept.quarantined && !orgQuarantine && scope !== PERSONAL_SCOPE) {
    const { quarantined: _bound, ...rest } = kept;
    stored = rest;
    await writeIndex(
      store,
      index.map((entry) => (entry === kept ? stored : entry)),
    );
  } else {
    stored = kept;
  }
  // The identity host answers only from the signer store, which holds the
  // organizations' rings and the CURRENT person's personal entries; a
  // quarantined entry is never mirrored.
  const signer = isAndroid() ? registeredIdentitySignerStore() : null;
  if (
    signer?.writeRetired &&
    !isQuarantined(stored) &&
    !(await signer.writeRetired(scope, privateKey, publicKey))
  ) {
    throw new Error(`The identity signer store (${signer.name}) did not confirm the retired key.`);
  }
}

/**
 * Bind the QUARANTINED personal entries whose public key `publicKeys` names to
 * `ownerAccountId` (R5-2, R5-3). Commons only, with the signed-in person's
 * account id and that account's key history from Oxy
 * (`oxy.identity.keyHistory()`: retired and current public keys): a key the
 * account's own history names is that account's. Entries bound to anyone, and
 * keys the history does not name, are left as they are. Resolves how many it
 * bound; call {@link syncRetiredKeys} after it on Android.
 */
export async function claimRetiredIdentityKeys(
  ownerAccountId: string,
  publicKeys: readonly string[],
): Promise<number> {
  const owner = ownerOf(ownerAccountId);
  if (owner === null) throw new Error('retired key: ownerAccountId must be an account id');
  if (isWeb()) return 0;
  await assertMayWrite();
  const named = new Set(
    publicKeys.map((key) => canonicalPublicKey(key)).filter((key): key is string => key !== null),
  );
  const store = await ringStore();
  const index = await readIndex(store);
  let bound = 0;
  const next = index.map((entry) => {
    if (entry.scope !== PERSONAL_SCOPE || entry.owner !== undefined) return entry;
    if (!named.has(entry.publicKey)) return entry;
    bound += 1;
    return { ...entry, owner };
  });
  if (bound > 0) await writeIndex(store, next);
  return bound;
}

/**
 * Bind the QUARANTINED entries of `accountId`'s organization ring whose public
 * key `publicKeys` names (R5-3, R5-7). Commons only, with that organization's
 * key history from Oxy (`oxy.accounts.identityKey.get(accountId).keys`: every
 * key it has had, current included): a key the organization's own history
 * names was the organization's. Keys the history does not name stay
 * quarantined. Resolves how many it bound; on Android call
 * {@link syncRetiredKeys} after it.
 */
export async function claimRetiredOrganizationKeys(
  accountId: string,
  publicKeys: readonly string[],
): Promise<number> {
  const scope = retiredKeyScope({ accountId });
  if (!scope || scope === PERSONAL_SCOPE) {
    throw new Error('retired key: accountId must be an organization account id');
  }
  if (isWeb()) return 0;
  await assertMayWrite();
  const named = new Set(
    publicKeys.map((key) => canonicalPublicKey(key)).filter((key): key is string => key !== null),
  );
  const store = await ringStore();
  const index = await readIndex(store);
  let bound = 0;
  const next = index.map((entry) => {
    if (entry.scope !== scope || !entry.quarantined || !named.has(entry.publicKey)) return entry;
    bound += 1;
    const { quarantined: _bound, ...rest } = entry;
    return rest;
  });
  if (bound > 0) await writeIndex(store, next);
  return bound;
}

/**
 * The organization entries that are quarantined, as `{ accountId, publicKey }`
 * (public data only): Commons asks each organization's key history for them
 * and binds the ones it names ({@link claimRetiredOrganizationKeys}). Empty
 * where this app holds no ring. Strict: an unreadable ring throws.
 */
export async function listQuarantinedOrganizationKeys(): Promise<
  Array<{ accountId: string; publicKey: string }>
> {
  if (!(await holdsRetiredRing())) return [];
  const store = await ringStore();
  return (await readIndex(store))
    .filter((entry) => entry.scope !== PERSONAL_SCOPE && entry.quarantined === true)
    .map((entry) => ({ accountId: entry.scope, publicKey: entry.publicKey }));
}

/**
 * The personal entries that are quarantined (no known owner), as public keys,
 * oldest first. Commons asks Oxy to prove them for the signed-in account
 * (`oxy.identity.claimQuarantinedKeys`, R6-5) and binds the ones the history
 * then names. Empty where this app holds no ring. Strict: an unreadable ring
 * throws.
 */
export async function listQuarantinedIdentityKeys(): Promise<string[]> {
  if (!(await holdsRetiredRing())) return [];
  const store = await ringStore();
  return (await readIndex(store))
    .filter((entry) => entry.scope === PERSONAL_SCOPE && entry.owner === undefined)
    .map((entry) => entry.publicKey);
}

/**
 * Sign `message` with a QUARANTINED personal key (R6-5): the possession half
 * of `POST /identity/key-history/claim`, where Oxy binds the key to the
 * signed-in account only when its own records prove the key was that
 * account's root. Commons only. The private key never leaves this function;
 * `null` when the ring holds no such quarantined key. @internal
 */
export async function signWithQuarantinedIdentityKey(
  publicKey: string,
  message: string,
): Promise<string | null> {
  const canonical = canonicalPublicKey(publicKey);
  if (!canonical || isWeb()) return null;
  await assertMayWrite();
  const store = await ringStore();
  const quarantined = (await readIndex(store)).some(
    (entry) =>
      entry.scope === PERSONAL_SCOPE && entry.owner === undefined && entry.publicKey === canonical,
  );
  if (!quarantined) return null;
  const privateKey = await readRetiredStrict(canonical, PERSONAL_SCOPE);
  return signMessage(message, privateKey);
}

/**
 * How many personal entries are quarantined (no known owner). Commons shows
 * them as "keys from before" the person can claim by adding the phrase, and
 * {@link claimRetiredIdentityKeys} binds the ones the account's history names.
 */
export async function countQuarantinedRetiredKeys(): Promise<number> {
  if (isWeb() || (isAndroid() && !registeredIdentitySignerStore())) return 0;
  const store = await ringStore();
  return (await readIndex(store)).filter(
    (entry) => entry.scope === PERSONAL_SCOPE && entry.owner === undefined,
  ).length;
}

/**
 * The retired keys of `selector`'s account this app can reach, oldest first.
 * The personal ring answers only `selector.ownerAccountId`'s entries (none
 * without it; R5-2). iOS and Commons: the ring's index. Android elsewhere:
 * Commons' identity host (the wallet only), which holds only the personal
 * entries of the person Commons is signed in as and leaves out the scope's
 * current key. After an interrupted rotation the local list can include the
 * current key: compare with the DID's `#key-1` before treating an entry as
 * retired, and check every entry against the account's key history.
 *
 * STRICT (R5-6): a ring that cannot be read throws (the keychain's error, or
 * {@link RetiredKeyRingUnreadableError}); it never reads as empty.
 */
export async function listRetiredIdentityKeys(
  selector?: RetiredKeySelector,
): Promise<RetiredIdentityKey[]> {
  const scope = retiredKeyScope(selector);
  if (!scope || isWeb()) return [];
  const owner = ownerOf(selector?.ownerAccountId);
  if (scope === PERSONAL_SCOPE && owner === null) return [];
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
  return (await readIndex(store)).filter((entry) => isVisible(entry, scope, owner)).map(toListed);
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
  const owner = ownerOf(selector?.ownerAccountId);
  if (scope === PERSONAL_SCOPE && owner === null) return null;
  try {
    if (isAndroid()) {
      const signer = registeredIdentitySignerStore();
      if (!signer) return null;
      const store = await ringStore();
      if (
        !(await readIndex(store)).some(
          (entry) => isVisible(entry, scope, owner) && entry.publicKey === canonical,
        )
      ) {
        return null;
      }
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
    // The index decides who may reach a key (R5-2); a key it does not list for
    // this reader is not theirs, whatever item exists.
    if (
      !(await readIndex(store)).some(
        (entry) => isVisible(entry, scope, owner) && entry.publicKey === canonical,
      )
    ) {
      return null;
    }
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
  const owner = ownerOf(selector?.ownerAccountId);
  await assertMayWrite();
  const store = await ringStore();
  const visible = (await readIndex(store)).some(
    (entry) => isVisible(entry, scope, owner) && entry.publicKey === canonical,
  );
  if (!visible) throw new Error('retired key: not a key of this account');
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
  const owner = ownerOf(selector?.ownerAccountId);
  if (scope === PERSONAL_SCOPE && owner === null) return 0;
  const store = await ringStore();
  const index = await readIndex(store);
  const signer = isAndroid() ? registeredIdentitySignerStore() : null;
  let removed = 0;
  for (const entry of index) {
    if (!isVisible(entry, scope, owner)) continue;
    await store.deleteItemAsync(
      privateKeyName(scope, entry.publicKey),
      privateOptions(store, false),
    );
    await signer?.clearRetired?.(scope, entry.publicKey);
    removed += 1;
  }
  await writeIndex(
    store,
    index.filter((entry) => !isVisible(entry, scope, owner)),
  );
  return removed;
}

/**
 * Commons on Android: make the identity signer store hold exactly what the
 * identity host may answer — every organization ring, and the personal entries
 * of `ownerAccountId` (the person Commons is signed in as) — so the host
 * answers for them after that file was rebuilt (its self-heal leaves it
 * empty), and never for a previous person's keys (R5-2): every other personal
 * entry is removed from the signer store (its own slot keeps it). Without
 * `ownerAccountId` no personal entry is mirrored. Call on every boot and after
 * every sign-in, beside `syncOrganizationKeys`. Resolves how many it mirrored.
 * Elsewhere 0.
 */
export async function syncRetiredKeys(ownerAccountId?: string): Promise<number> {
  const signer = isAndroid() ? registeredIdentitySignerStore() : null;
  if (!signer?.writeRetired || !signer.readRetired) return 0;
  const owner = ownerOf(ownerAccountId);
  const store = await ringStore();
  const index = await readIndex(store);
  const allowed = new Set(
    index.filter((entry) => isVisible(entry, PERSONAL_SCOPE, owner)).map((e) => e.publicKey),
  );
  await clearPersonalMirror(signer, index, allowed);
  let mirrored = 0;
  for (const entry of index) {
    // A previous person's entries and quarantined ones are never mirrored.
    if (!isVisible(entry, entry.scope, owner)) continue;
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
 * Every retired key of `selector`'s ring (personal: `ownerAccountId`'s entries)
 * WITH its private half, for the encrypted identity backup
 * (`oxy.identity.backup.create`), which carries them under the CURRENT phrase
 * so a lost phone costs no more than the current phrase does (R4-4). Commons
 * only. STRICT (R5-6): an unreadable ring, or a listed entry whose private
 * half is missing or does not derive its public key, THROWS — a backup is
 * never sealed without a key the ring says it holds. Never log or transmit the
 * result except inside that encrypted envelope.
 */
export async function exportRetiredIdentityKeys(
  selector?: RetiredKeySelector,
): Promise<Array<RetiredKeyPair & { retiredAt: number }>> {
  const scope = retiredKeyScope(selector);
  if (!scope || isWeb()) return [];
  await assertMayWrite();
  const out: Array<RetiredKeyPair & { retiredAt: number }> = [];
  for (const entry of await listRetiredIdentityKeys(selector)) {
    const privateKey = await readRetiredStrict(entry.publicKey, scope);
    out.push({ privateKey, publicKey: entry.publicKey, retiredAt: entry.retiredAt });
  }
  return out;
}

/** A listed entry's private half, or a throw: Commons' own slot, then (Android) the signer copy. */
async function readRetiredStrict(publicKey: string, scope: string): Promise<string> {
  const store = await ringStore();
  const local = await store.getItemAsync(
    privateKeyName(scope, publicKey),
    privateOptions(store, false),
  );
  if (local && isHealthyPair(local, publicKey)) return normalizeSecp256k1PrivateKey(local);
  const signer = isAndroid() ? registeredIdentitySignerStore() : null;
  const mirrored = (await signer?.readRetired?.(scope, publicKey)) ?? null;
  if (mirrored && isHealthyPair(mirrored.privateKey, publicKey)) {
    return normalizeSecp256k1PrivateKey(mirrored.privateKey);
  }
  throw new RetiredKeyRingUnreadableError('a listed key has no readable private half');
}

/**
 * Commons on Android, when the identity leaves this device ("Start over", a
 * forced delete): remove every PERSONAL entry from the identity signer store,
 * so the identity host answers no other app with them before the next person
 * signs in (R5-2). Commons' own slot and index keep them (money, bound to
 * their owner). Elsewhere a no-op.
 */
export async function unmirrorPersonalRetiredKeys(): Promise<void> {
  const signer = isAndroid() ? registeredIdentitySignerStore() : null;
  if (!signer?.clearRetired) return;
  let index: IndexEntry[] = [];
  try {
    index = await readIndex(await ringStore());
  } catch {
    // The signer store's own list below still reaches every mirrored entry.
  }
  await clearPersonalMirror(signer, index, new Set());
}

/** Remove from the signer store every personal entry not in `allowed`: the index's and the store's own list. */
async function clearPersonalMirror(
  signer: NonNullable<ReturnType<typeof registeredIdentitySignerStore>>,
  index: readonly IndexEntry[],
  allowed: ReadonlySet<string>,
): Promise<void> {
  if (!signer.clearRetired) return;
  const mirrored = new Set(
    index.filter((entry) => entry.scope === PERSONAL_SCOPE).map((entry) => entry.publicKey),
  );
  for (const publicKey of (await signer.listRetired?.(PERSONAL_SCOPE)) ?? []) {
    mirrored.add(publicKey.toLowerCase());
  }
  for (const publicKey of mirrored) {
    if (!allowed.has(publicKey)) await signer.clearRetired(PERSONAL_SCOPE, publicKey);
  }
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
