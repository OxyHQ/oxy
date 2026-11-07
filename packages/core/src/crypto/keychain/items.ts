/**
 * Items (ADR 0063 D7, D8). An item's plaintext is the JCS of its object,
 * padded with trailing spaces (0x20) to a multiple of 256 bytes, encrypted
 * under one vault-key generation:
 *
 *   aad        = "oxy.keychain.item.v1" ‖ 0x00 ‖ vaultId ‖ 0x00 ‖ itemId ‖ 0x00 ‖ g
 *   ciphertext = XChaCha20-Poly1305(VK_g, random 24-byte nonce, padded JCS, aad)
 *
 * Every type's schema is closed: every field is present, none other is. A
 * reader refuses a plaintext that is not exactly JCS plus spaces.
 */

import '../polyfill';
import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import {
  ITEM_DOMAIN,
  ITEM_PADDING_BLOCK,
  MAX_ITEM_PLAINTEXT,
  NONCE_LENGTH,
  VAULT_KEY_LENGTH,
} from './constants';
import {
  assertUuid,
  concatBytes,
  fromBase64Url,
  fromUtf8,
  isKeychainTimestamp,
  jcs,
  parseCanonicalJson,
  randomBytes,
  toBase64Url,
  utf8,
  zeroize,
} from './encoding';
import { KeychainCryptoError, KeychainFormatError } from './errors';
import { assertExactKeys } from './roster';
import { parseOtpauthUri } from './totp';
import { type Keyring, vaultKeyOf } from './wrap';

interface ItemBase {
  /** The server-visible uuid, repeated inside. */
  id: string;
  v: 1;
  createdAt: string;
  modifiedAt: string;
  /** Incremented by every write; a device refuses a lower one. */
  counter: number;
}

export interface LoginItem extends ItemBase {
  type: 'login';
  title: string;
  username: string;
  password: string;
  urls: { url: string }[];
  apps: string[];
  /** An `otpauth://totp/` URI, or null. */
  totp: string | null;
  notes: string;
  /** Newest first, at most 10. */
  passwordHistory: { password: string; changedAt: string }[];
}

export interface PasskeyItem extends ItemBase {
  type: 'passkey';
  rpId: string;
  rpName: string;
  /** base64url */
  userHandle: string;
  userName: string;
  userDisplayName: string;
  /** base64url, 16 bytes */
  credentialId: string;
  /** COSE ES256 */
  algorithm: -7;
  /** PKCS #8, base64url */
  privateKey: string;
  apps: string[];
}

export interface TotpItem extends ItemBase {
  type: 'totp';
  title: string;
  issuer: string;
  account: string;
  uri: string;
  notes: string;
}

export interface NoteItem extends ItemBase {
  type: 'note';
  title: string;
  body: string;
}

export const WIFI_SECURITY = ['wpa2-psk', 'wpa3-sae', 'wep', 'open'] as const;
export type WifiSecurity = (typeof WIFI_SECURITY)[number];

export interface WifiItem extends ItemBase {
  type: 'wifi';
  ssid: string;
  password: string;
  security: WifiSecurity;
  hidden: boolean;
}

export type KeychainItem = LoginItem | PasskeyItem | TotpItem | NoteItem | WifiItem;
export type KeychainItemType = KeychainItem['type'];

/** An encrypted item as the server keeps it (without its revision). */
export interface EncryptedItem {
  generation: number;
  nonce: string;
  ciphertext: string;
}

// ─── Schema ──────────────────────────────────────────────────────────────────

const BASE_KEYS = ['id', 'v', 'type', 'createdAt', 'modifiedAt', 'counter'];
const TYPE_KEYS: Record<KeychainItemType, string[]> = {
  login: ['title', 'username', 'password', 'urls', 'apps', 'totp', 'notes', 'passwordHistory'],
  passkey: [
    'rpId',
    'rpName',
    'userHandle',
    'userName',
    'userDisplayName',
    'credentialId',
    'algorithm',
    'privateKey',
    'apps',
  ],
  totp: ['title', 'issuer', 'account', 'uri', 'notes'],
  note: ['title', 'body'],
  wifi: ['ssid', 'password', 'security', 'hidden'],
};
const MAX_PASSWORD_HISTORY = 10;

function fail(message: string): never {
  throw new KeychainFormatError(message);
}

function str(value: unknown, what: string, nonEmpty = false): string {
  if (typeof value !== 'string') fail(`${what} must be text`);
  if (nonEmpty && value.length === 0) fail(`${what} must not be empty`);
  return value;
}

function strList(value: unknown, what: string): string[] {
  if (!Array.isArray(value)) fail(`${what} must be a list`);
  return value.map((v, i) => str(v, `${what}[${i}]`, true));
}

function timestamp(value: unknown, what: string): string {
  if (!isKeychainTimestamp(value))
    fail(`${what} must be an ISO 8601 UTC timestamp with milliseconds`);
  return value;
}

function otpauth(value: unknown, what: string): string {
  const uri = str(value, what);
  try {
    parseOtpauthUri(uri).secret.fill(0);
  } catch {
    fail(`${what} must be an otpauth://totp/ URI`);
  }
  return uri;
}

function b64(value: unknown, what: string, min: number, max: number): string {
  const bytes = fromBase64Url(str(value, what), undefined, what);
  if (bytes.length < min || bytes.length > max) fail(`${what} must be ${min} to ${max} bytes`);
  return value as string;
}

/** Validate an item strictly (closed schema per type); returns a fresh copy. */
export function validateItem(value: unknown): KeychainItem {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    fail('an item must be an object');
  const type = (value as { type?: unknown }).type as KeychainItemType;
  if (typeof type !== 'string' || !Object.prototype.hasOwnProperty.call(TYPE_KEYS, type)) {
    fail('an item has an unknown type');
  }
  assertExactKeys(value, [...BASE_KEYS, ...TYPE_KEYS[type]], `${type} item`);
  const v = value as Record<string, unknown>;
  assertUuid(v.id, 'item id');
  if (v.v !== 1) fail('item version must be 1');
  const createdAt = timestamp(v.createdAt, 'createdAt');
  const modifiedAt = timestamp(v.modifiedAt, 'modifiedAt');
  if (modifiedAt < createdAt) fail('modifiedAt must not be before createdAt');
  if (typeof v.counter !== 'number' || !Number.isSafeInteger(v.counter) || v.counter < 1) {
    fail('counter must be an integer ≥ 1');
  }
  const base = { id: v.id, v: 1 as const, createdAt, modifiedAt, counter: v.counter };

  switch (type) {
    case 'login': {
      if (!Array.isArray(v.urls)) fail('urls must be a list');
      const urls = v.urls.map((u, i) => {
        assertExactKeys(u, ['url'], `urls[${i}]`);
        return { url: str(u.url, `urls[${i}].url`, true) };
      });
      if (!Array.isArray(v.passwordHistory)) fail('passwordHistory must be a list');
      if (v.passwordHistory.length > MAX_PASSWORD_HISTORY) fail('passwordHistory holds at most 10');
      const passwordHistory = v.passwordHistory.map((h, i) => {
        assertExactKeys(h, ['password', 'changedAt'], `passwordHistory[${i}]`);
        return {
          password: str(h.password, `passwordHistory[${i}].password`),
          changedAt: timestamp(h.changedAt, `passwordHistory[${i}].changedAt`),
        };
      });
      for (let i = 1; i < passwordHistory.length; i += 1) {
        if (passwordHistory[i].changedAt > passwordHistory[i - 1].changedAt) {
          fail('passwordHistory is newest first');
        }
      }
      return {
        ...base,
        type,
        title: str(v.title, 'title'),
        username: str(v.username, 'username'),
        password: str(v.password, 'password'),
        urls,
        apps: strList(v.apps, 'apps'),
        totp: v.totp === null ? null : otpauth(v.totp, 'totp'),
        notes: str(v.notes, 'notes'),
        passwordHistory,
      };
    }
    case 'passkey': {
      if (v.algorithm !== -7) fail('a passkey algorithm is -7 (ES256)');
      return {
        ...base,
        type,
        rpId: str(v.rpId, 'rpId', true),
        rpName: str(v.rpName, 'rpName'),
        userHandle: b64(v.userHandle, 'userHandle', 1, 64),
        userName: str(v.userName, 'userName'),
        userDisplayName: str(v.userDisplayName, 'userDisplayName'),
        credentialId: b64(v.credentialId, 'credentialId', 16, 16),
        algorithm: -7,
        privateKey: b64(v.privateKey, 'privateKey', 1, 1024),
        apps: strList(v.apps, 'apps'),
      };
    }
    case 'totp':
      return {
        ...base,
        type,
        title: str(v.title, 'title'),
        issuer: str(v.issuer, 'issuer'),
        account: str(v.account, 'account'),
        uri: otpauth(v.uri, 'uri'),
        notes: str(v.notes, 'notes'),
      };
    case 'note':
      return { ...base, type, title: str(v.title, 'title'), body: str(v.body, 'body') };
    case 'wifi': {
      const ssid = str(v.ssid, 'ssid', true);
      if (utf8(ssid).length > 32) fail('an SSID is at most 32 bytes');
      const security = v.security as WifiSecurity;
      if (!(WIFI_SECURITY as readonly string[]).includes(security as string))
        fail('unknown wifi security');
      const password = str(v.password, 'password');
      if ((security === 'open') !== (password === ''))
        fail('an open network has no password, any other one has');
      if (typeof v.hidden !== 'boolean') fail('hidden must be true or false');
      return { ...base, type, ssid, password, security, hidden: v.hidden };
    }
  }
  return fail('an item has an unknown type');
}

// ─── Plaintext ───────────────────────────────────────────────────────────────

/** Pad with spaces to the next multiple of 256 bytes (none when already one). */
export function padItemPlaintext(json: Uint8Array): Uint8Array {
  const length = Math.max(
    ITEM_PADDING_BLOCK,
    Math.ceil(json.length / ITEM_PADDING_BLOCK) * ITEM_PADDING_BLOCK,
  );
  const out = new Uint8Array(length).fill(0x20);
  out.set(json);
  return out;
}

/** The item's padded plaintext: JCS plus spaces. The caller zeroizes it. */
export function encodeItemPlaintext(item: KeychainItem): Uint8Array {
  const json = utf8(jcs(validateItem(item)));
  const padded = padItemPlaintext(json);
  zeroize(json);
  if (padded.length > MAX_ITEM_PLAINTEXT) {
    zeroize(padded);
    throw new KeychainFormatError('the item is too large');
  }
  return padded;
}

/** Read a padded plaintext: length a multiple of 256, JCS, then only spaces. */
export function decodeItemPlaintext(padded: Uint8Array): KeychainItem {
  if (
    padded.length === 0 ||
    padded.length % ITEM_PADDING_BLOCK !== 0 ||
    padded.length > MAX_ITEM_PLAINTEXT
  ) {
    throw new KeychainFormatError('an item plaintext is a multiple of 256 bytes');
  }
  let end = padded.length;
  while (end > 0 && padded[end - 1] === 0x20) end -= 1;
  // JCS never ends in a space, so the padding is exactly the trailing spaces.
  const text = fromUtf8(padded.subarray(0, end));
  return validateItem(parseCanonicalJson(text, 'item'));
}

// ─── Encryption ──────────────────────────────────────────────────────────────

/** `"oxy.keychain.item.v1" ‖ 0x00 ‖ vaultId ‖ 0x00 ‖ itemId ‖ 0x00 ‖ g`. */
export function itemAad(vaultId: string, itemId: string, generation: number): Uint8Array {
  assertUuid(vaultId, 'vaultId');
  assertUuid(itemId, 'itemId');
  if (!Number.isSafeInteger(generation) || generation < 1)
    fail('generation must be an integer ≥ 1');
  const zero = new Uint8Array([0]);
  return concatBytes(
    utf8(ITEM_DOMAIN),
    zero,
    utf8(vaultId),
    zero,
    utf8(itemId),
    zero,
    utf8(String(generation)),
  );
}

/**
 * Encrypt under a given generation and nonce. Deterministic, for the test
 * vectors only. Not exported from the public barrel.
 */
export function encryptItemDeterministic(
  vaultId: string,
  item: KeychainItem,
  keyring: Keyring,
  generation: number,
  nonce: Uint8Array,
): EncryptedItem {
  if (nonce.length !== NONCE_LENGTH) throw new KeychainCryptoError('nonce must be 24 bytes');
  const key = vaultKeyOf(keyring, generation);
  if (key.length !== VAULT_KEY_LENGTH) throw new KeychainCryptoError('vault key must be 32 bytes');
  const plaintext = encodeItemPlaintext(item);
  try {
    const ciphertext = xchacha20poly1305(key, nonce, itemAad(vaultId, item.id, generation)).encrypt(
      plaintext,
    );
    return { generation, nonce: toBase64Url(nonce), ciphertext: toBase64Url(ciphertext) };
  } finally {
    zeroize(plaintext);
  }
}

/** Encrypt an item under the keyring's newest generation. */
export function encryptItem(vaultId: string, item: KeychainItem, keyring: Keyring): EncryptedItem {
  return encryptItemDeterministic(
    vaultId,
    item,
    keyring,
    keyring.generation,
    randomBytes(NONCE_LENGTH),
  );
}

/**
 * Decrypt an item. Throws when the ciphertext, the generation, the vault or
 * item id do not match, or when the plaintext is not a valid item of that id.
 */
export function decryptItem(
  vaultId: string,
  itemId: string,
  encrypted: EncryptedItem,
  keyring: Keyring,
): KeychainItem {
  const key = vaultKeyOf(keyring, encrypted.generation);
  const nonce = fromBase64Url(encrypted.nonce, NONCE_LENGTH, 'nonce');
  const ciphertext = fromBase64Url(encrypted.ciphertext, undefined, 'ciphertext');
  let plaintext: Uint8Array;
  try {
    plaintext = xchacha20poly1305(
      key,
      nonce,
      itemAad(vaultId, itemId, encrypted.generation),
    ).decrypt(ciphertext);
  } catch {
    throw new KeychainCryptoError('the item does not decrypt');
  }
  try {
    const item = decodeItemPlaintext(plaintext);
    if (item.id !== itemId) throw new KeychainCryptoError('the item is not the one asked for');
    return item;
  } finally {
    zeroize(plaintext);
  }
}

// ─── Counter ─────────────────────────────────────────────────────────────────

/**
 * Whether a device may accept an item whose counter is `incoming` when the
 * highest it has seen for that item is `known`. Equal is the same write read
 * again; lower is a rollback and is refused.
 */
export function isItemCounterAcceptable(known: number | undefined, incoming: number): boolean {
  if (!Number.isSafeInteger(incoming) || incoming < 1) return false;
  return known === undefined || incoming >= known;
}

/** The counter of the next write after `known` (1 for a new item). */
export function nextItemCounter(known: number | undefined): number {
  return known === undefined ? 1 : known + 1;
}
