/**
 * Items (ADR 0063 D7): strict per-type schemas, padding, encryption under a
 * keyring generation, every tamper, and the counter that refuses rollbacks.
 */
import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { fromBase64Url, jcs, toBase64Url } from '../encoding';
import { KeychainCryptoError, KeychainFormatError } from '../errors';
import {
  decodeItemPlaintext,
  decryptItem,
  encodeItemPlaintext,
  encryptItem,
  isItemCounterAcceptable,
  itemAad,
  type KeychainItem,
  nextItemCounter,
  padItemPlaintext,
  validateItem,
} from '../items';
import { createKeyring, rotateKeyring } from '../wrap';

const VAULT = '11111111-2222-4333-8444-555555555555';
const ID = '2222aaaa-3333-4444-8555-66666666ffff';
const T = '2026-11-07T12:00:00.000Z';
const base = { id: ID, v: 1 as const, createdAt: T, modifiedAt: T, counter: 1 };

const items: Record<KeychainItem['type'], KeychainItem> = {
  login: {
    ...base,
    type: 'login',
    title: 'Mail',
    username: 'ana',
    password: 'pw',
    urls: [{ url: 'https://mail.example.com' }],
    apps: ['so.oxy.mail'],
    totp: 'otpauth://totp/Mail:ana?secret=JBSWY3DPEHPK3PXP',
    notes: '',
    passwordHistory: [{ password: 'old', changedAt: T }],
  },
  passkey: {
    ...base,
    type: 'passkey',
    rpId: 'example.com',
    rpName: 'Example',
    userHandle: toBase64Url(new Uint8Array(16).fill(1)),
    userName: 'ana',
    userDisplayName: 'Ana',
    credentialId: toBase64Url(new Uint8Array(16).fill(2)),
    algorithm: -7,
    privateKey: toBase64Url(new Uint8Array(138).fill(3)),
    apps: [],
  },
  totp: {
    ...base,
    type: 'totp',
    title: 'GitHub',
    issuer: 'GitHub',
    account: 'ana',
    uri: 'otpauth://totp/GitHub:ana?secret=JBSWY3DPEHPK3PXP',
    notes: '',
  },
  note: { ...base, type: 'note', title: 'n', body: 'b' },
  wifi: {
    ...base,
    type: 'wifi',
    ssid: 'Home',
    password: 'secret123',
    security: 'wpa2-psk',
    hidden: false,
  },
};

describe('item schemas', () => {
  it.each(Object.keys(items))(
    '%s validates and round-trips through its padded plaintext',
    (type) => {
      const item = items[type as KeychainItem['type']];
      expect(validateItem(item)).toEqual(item);
      const padded = encodeItemPlaintext(item);
      expect(padded.length % 256).toBe(0);
      expect(decodeItemPlaintext(padded)).toEqual(item);
    },
  );

  it.each(Object.keys(items))('%s is closed: a missing or extra field is refused', (type) => {
    const item = items[type as KeychainItem['type']] as unknown as Record<string, unknown>;
    for (const key of Object.keys(item)) {
      const { [key]: _dropped, ...missing } = item;
      expect(() => validateItem(missing)).toThrow(KeychainFormatError);
    }
    expect(() => validateItem({ ...item, extra: '' })).toThrow(KeychainFormatError);
  });

  it('refuses values outside each schema', () => {
    const bad: unknown[] = [
      { ...items.note, type: 'card' },
      { ...items.note, v: 2 },
      { ...items.note, id: ID.toUpperCase() },
      { ...items.note, counter: 0 },
      { ...items.note, counter: 1.5 },
      { ...items.note, modifiedAt: '2026-11-06T12:00:00.000Z' },
      { ...items.note, title: 7 },
      { ...items.login, totp: 'https://example.com' },
      { ...items.login, urls: [{ url: '' }] },
      { ...items.login, urls: [{ url: 'https://x', extra: 1 }] },
      { ...items.login, apps: [''] },
      {
        ...items.login,
        passwordHistory: Array.from({ length: 11 }, () => ({ password: 'x', changedAt: T })),
      },
      {
        ...items.login,
        passwordHistory: [
          { password: 'a', changedAt: '2026-11-01T00:00:00.000Z' },
          { password: 'b', changedAt: '2026-11-02T00:00:00.000Z' },
        ],
      },
      { ...items.passkey, algorithm: -8 },
      { ...items.passkey, credentialId: toBase64Url(new Uint8Array(15)) },
      { ...items.passkey, userHandle: '' },
      { ...items.passkey, rpId: '' },
      { ...items.totp, uri: 'otpauth://hotp/x?secret=JBSWY3DPEHPK3PXP' },
      { ...items.wifi, security: 'wpa' },
      { ...items.wifi, security: 'open' },
      { ...items.wifi, password: '' },
      { ...items.wifi, ssid: 'x'.repeat(33) },
      { ...items.wifi, hidden: 'no' },
    ];
    for (const value of bad) expect(() => validateItem(value)).toThrow(KeychainFormatError);
    expect(validateItem({ ...items.wifi, security: 'open', password: '' })).toBeTruthy();
    expect(validateItem({ ...items.login, totp: null })).toBeTruthy();
  });
});

describe('padding', () => {
  it('pads with spaces to the next multiple of 256, none when already one', () => {
    expect(padItemPlaintext(new Uint8Array(1))).toHaveLength(256);
    expect(padItemPlaintext(new Uint8Array(256))).toHaveLength(256);
    expect(padItemPlaintext(new Uint8Array(257))).toHaveLength(512);
    const padded = padItemPlaintext(new TextEncoder().encode('{}'));
    expect(padded.subarray(2).every((x) => x === 0x20)).toBe(true);
  });

  it('refuses a plaintext that is not JCS plus spaces', () => {
    const json = jcs(items.note);
    const enc = (s: string) => padItemPlaintext(new TextEncoder().encode(s));
    expect(decodeItemPlaintext(enc(json))).toEqual(items.note);
    expect(() => decodeItemPlaintext(enc(JSON.stringify(items.note, null, 1)))).toThrow(
      KeychainFormatError,
    );
    expect(() => decodeItemPlaintext(new TextEncoder().encode(json))).toThrow(KeychainFormatError);
    const nul = enc(json);
    nul[nul.length - 1] = 0;
    expect(() => decodeItemPlaintext(nul)).toThrow(KeychainFormatError);
    const tab = enc(json);
    tab[tab.length - 1] = 0x09;
    expect(() => decodeItemPlaintext(tab)).toThrow(KeychainFormatError);
  });

  it('refuses an item too large for the server', () => {
    expect(() =>
      encodeItemPlaintext({ ...items.note, body: 'x'.repeat(49_000) } as KeychainItem),
    ).toThrow(KeychainFormatError);
  });
});

describe('item encryption', () => {
  const keyring = rotateKeyring(createKeyring());

  it('encrypts under the newest generation and decrypts older ones', () => {
    const enc = encryptItem(VAULT, items.login, keyring);
    expect(enc.generation).toBe(2);
    expect(decryptItem(VAULT, ID, enc, keyring)).toEqual(items.login);
    const g1 = encryptItem(VAULT, items.note, createKeyringWith(keyring, 1));
    expect(g1.generation).toBe(1);
    expect(decryptItem(VAULT, ID, g1, keyring)).toEqual(items.note);
  });

  it('refuses every tamper: vault, item id, generation, nonce, ciphertext, key', () => {
    const enc = encryptItem(VAULT, items.login, keyring);
    const flip = (s: string) => {
      const bytes = fromBase64Url(s);
      bytes[5] ^= 1;
      return toBase64Url(bytes);
    };
    expect(() => decryptItem('99999999-2222-4333-8444-555555555555', ID, enc, keyring)).toThrow(
      KeychainCryptoError,
    );
    expect(() => decryptItem(VAULT, '33333333-3333-4444-8555-666666666666', enc, keyring)).toThrow(
      KeychainCryptoError,
    );
    expect(() => decryptItem(VAULT, ID, { ...enc, generation: 1 }, keyring)).toThrow(
      KeychainCryptoError,
    );
    expect(() => decryptItem(VAULT, ID, { ...enc, generation: 3 }, keyring)).toThrow(
      KeychainCryptoError,
    );
    expect(() => decryptItem(VAULT, ID, { ...enc, nonce: flip(enc.nonce) }, keyring)).toThrow(
      KeychainCryptoError,
    );
    expect(() =>
      decryptItem(VAULT, ID, { ...enc, ciphertext: flip(enc.ciphertext) }, keyring),
    ).toThrow(KeychainCryptoError);
    expect(() => decryptItem(VAULT, ID, enc, createKeyring())).toThrow(KeychainCryptoError);
  });

  it('refuses an item whose inner id is not the one asked for', () => {
    const other = { ...items.note, id: '44444444-3333-4444-8555-666666666666' };
    // Encrypted honestly under the other id's AAD, then served as ID: the AAD catches it.
    const enc = encryptItem(VAULT, other, keyring);
    expect(() => decryptItem(VAULT, ID, enc, keyring)).toThrow(KeychainCryptoError);
    // Encrypted under ID's AAD by a member that put another id inside: the inner check catches it.
    const nonce = new Uint8Array(24).fill(9);
    const ciphertext = xchacha20poly1305(
      keyring.keys.get(2) as Uint8Array,
      nonce,
      itemAad(VAULT, ID, 2),
    ).encrypt(encodeItemPlaintext(other));
    const forged = {
      generation: 2,
      nonce: toBase64Url(nonce),
      ciphertext: toBase64Url(ciphertext),
    };
    expect(() => decryptItem(VAULT, ID, forged, keyring)).toThrow(KeychainCryptoError);
  });
});

function createKeyringWith(keyring: ReturnType<typeof createKeyring>, generation: number) {
  const keys = new Map([...keyring.keys].filter(([g]) => g <= generation));
  return { keys, generation };
}

describe('item counter', () => {
  it('accepts the same or a higher counter and refuses a rollback', () => {
    expect(isItemCounterAcceptable(undefined, 1)).toBe(true);
    expect(isItemCounterAcceptable(5, 5)).toBe(true);
    expect(isItemCounterAcceptable(5, 6)).toBe(true);
    expect(isItemCounterAcceptable(5, 4)).toBe(false);
    expect(isItemCounterAcceptable(undefined, 0)).toBe(false);
    expect(isItemCounterAcceptable(undefined, Number.NaN)).toBe(false);
    expect(nextItemCounter(undefined)).toBe(1);
    expect(nextItemCounter(7)).toBe(8);
  });
});
