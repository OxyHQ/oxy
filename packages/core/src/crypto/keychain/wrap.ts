/**
 * The keyring and its wraps (ADR 0063 D2, D4, D8).
 *
 * Keyring plaintext: `JCS({ "generations": { "<g>": "<VK_g base64url>", … } })`,
 * every generation from 1 to the newest.
 *
 * A wrap is the keyring sealed to one recipient (a member id or `recovery`) and
 * signed by the member that sealed it (or the recovery key, for a device
 * admitted by recovery):
 *
 *   aad       = "oxy.keychain.wrap.v1" ‖ 0x00 ‖ vaultId ‖ 0x00 ‖ recipient ‖ 0x00 ‖ g
 *   signature = Ed25519("oxy.keychain.wrap.v1\n" ‖ JCS({ vaultId, recipient, generation, epk, nonce, ciphertext, signer }))
 *
 * `g` is the newest generation in the keyring, as decimal ASCII.
 */

import { RECOVERY, SIGNATURE_LENGTH, VAULT_KEY_LENGTH, WRAP_DOMAIN } from './constants';
import {
  assertUuid,
  concatBytes,
  fromBase64Url,
  fromUtf8,
  isLowercaseUuid,
  jcsBytes,
  parseCanonicalJson,
  randomBytes,
  toBase64Url,
  utf8,
  zeroize,
} from './encoding';
import { KeychainCryptoError, KeychainFormatError } from './errors';
import { signBytes, verifyBytes } from './keys';
import { assertExactKeys, currentBoxKey, currentSigningKey, type VerifiedRoster } from './roster';
import { openSealed, type SealedBox, sealDeterministic } from './seal';

/** Every generation of the vault key: generation → 32 bytes. */
export interface Keyring {
  keys: Map<number, Uint8Array>;
  /** The newest generation. */
  generation: number;
}

/** A wrap on the wire. */
export interface KeychainWrap {
  recipient: string;
  generation: number;
  epk: string;
  nonce: string;
  ciphertext: string;
  signer: string;
  signature: string;
}

// ─── Keyring ─────────────────────────────────────────────────────────────────

/** A new keyring holding generation 1. */
export function createKeyring(): Keyring {
  return { keys: new Map([[1, randomBytes(VAULT_KEY_LENGTH)]]), generation: 1 };
}

/** A copy of `keyring` with a fresh generation g + 1 (for a rotation). */
export function rotateKeyring(keyring: Keyring): Keyring {
  const keys = new Map<number, Uint8Array>();
  for (const [g, key] of keyring.keys) keys.set(g, key.slice());
  const generation = keyring.generation + 1;
  keys.set(generation, randomBytes(VAULT_KEY_LENGTH));
  return { keys, generation };
}

/** Overwrite every vault key in `keyring` with zeros. */
export function zeroizeKeyring(keyring: Keyring): void {
  for (const key of keyring.keys.values()) key.fill(0);
}

/** The vault key of generation `g`. Throws when the keyring does not hold it. */
export function vaultKeyOf(keyring: Keyring, generation: number): Uint8Array {
  const key = keyring.keys.get(generation);
  if (!key) throw new KeychainCryptoError('the keyring does not hold that generation');
  return key;
}

function assertKeyring(keyring: Keyring): void {
  const g = keyring.generation;
  if (!Number.isSafeInteger(g) || g < 1 || keyring.keys.size !== g) {
    throw new KeychainFormatError('a keyring holds every generation from 1 to the newest');
  }
  for (let i = 1; i <= g; i += 1) {
    const key = keyring.keys.get(i);
    if (!key || key.length !== VAULT_KEY_LENGTH) {
      throw new KeychainFormatError('a keyring holds every generation from 1 to the newest');
    }
  }
}

/** The keyring's plaintext bytes (JCS). The caller zeroizes them. */
export function encodeKeyring(keyring: Keyring): Uint8Array {
  assertKeyring(keyring);
  const generations: Record<string, string> = {};
  for (let g = 1; g <= keyring.generation; g += 1) {
    generations[String(g)] = toBase64Url(keyring.keys.get(g) as Uint8Array);
  }
  return jcsBytes({ generations });
}

const GENERATION_KEY_RE = /^[1-9][0-9]{0,8}$/;

/** Read a keyring's plaintext: canonical JCS, generations 1..n, 32-byte keys. */
export function decodeKeyring(bytes: Uint8Array): Keyring {
  const value = parseCanonicalJson(fromUtf8(bytes), 'keyring');
  assertExactKeys(value, ['generations'], 'keyring');
  const generations = value.generations;
  if (typeof generations !== 'object' || generations === null || Array.isArray(generations)) {
    throw new KeychainFormatError('keyring generations must be an object');
  }
  const keys = new Map<number, Uint8Array>();
  for (const [name, encoded] of Object.entries(generations as Record<string, unknown>)) {
    if (!GENERATION_KEY_RE.test(name))
      throw new KeychainFormatError('a generation is a decimal integer ≥ 1');
    if (typeof encoded !== 'string') throw new KeychainFormatError('a vault key must be base64url');
    keys.set(Number(name), fromBase64Url(encoded, VAULT_KEY_LENGTH, 'vault key'));
  }
  const keyring = { keys, generation: keys.size };
  assertKeyring(keyring);
  return keyring;
}

// ─── Wraps ───────────────────────────────────────────────────────────────────

function assertRecipient(value: unknown, what: string): asserts value is string {
  if (value !== RECOVERY && !isLowercaseUuid(value)) {
    throw new KeychainFormatError(`${what} must be a member id or recovery`);
  }
}

function assertGeneration(value: unknown): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new KeychainFormatError('generation must be an integer ≥ 1');
  }
}

/** `"oxy.keychain.wrap.v1" ‖ 0x00 ‖ vaultId ‖ 0x00 ‖ recipient ‖ 0x00 ‖ g`. */
export function wrapAad(vaultId: string, recipient: string, generation: number): Uint8Array {
  assertUuid(vaultId, 'vaultId');
  assertRecipient(recipient, 'recipient');
  assertGeneration(generation);
  const zero = new Uint8Array([0]);
  return concatBytes(
    utf8(WRAP_DOMAIN),
    zero,
    utf8(vaultId),
    zero,
    utf8(recipient),
    zero,
    utf8(String(generation)),
  );
}

/** `"oxy.keychain.wrap.v1\n" ‖ JCS({ vaultId, recipient, generation, epk, nonce, ciphertext, signer })`. */
export function wrapSigningInput(
  vaultId: string,
  wrap: Omit<KeychainWrap, 'signature'>,
): Uint8Array {
  assertUuid(vaultId, 'vaultId');
  const signed = {
    vaultId,
    recipient: wrap.recipient,
    generation: wrap.generation,
    epk: wrap.epk,
    nonce: wrap.nonce,
    ciphertext: wrap.ciphertext,
    signer: wrap.signer,
  };
  return concatBytes(utf8(`${WRAP_DOMAIN}\n`), jcsBytes(signed));
}

/** Validate a wrap's shape strictly; returns a fresh copy. */
export function parseWrap(value: unknown): KeychainWrap {
  assertExactKeys(
    value,
    ['recipient', 'generation', 'epk', 'nonce', 'ciphertext', 'signer', 'signature'],
    'wrap',
  );
  assertRecipient(value.recipient, 'wrap.recipient');
  assertRecipient(value.signer, 'wrap.signer');
  assertGeneration(value.generation);
  for (const field of ['epk', 'nonce', 'ciphertext', 'signature'] as const) {
    if (typeof value[field] !== 'string')
      throw new KeychainFormatError(`wrap.${field} must be base64url`);
  }
  fromBase64Url(value.epk as string, 32, 'wrap.epk');
  fromBase64Url(value.nonce as string, 24, 'wrap.nonce');
  fromBase64Url(value.ciphertext as string, undefined, 'wrap.ciphertext');
  fromBase64Url(value.signature as string, SIGNATURE_LENGTH, 'wrap.signature');
  return {
    recipient: value.recipient,
    generation: value.generation,
    epk: value.epk as string,
    nonce: value.nonce as string,
    ciphertext: value.ciphertext as string,
    signer: value.signer,
    signature: value.signature as string,
  };
}

export interface CreateWrapInput {
  vaultId: string;
  /** A member id or `recovery`. */
  recipient: string;
  /** The recipient's X25519 public key (base64url, from the roster). */
  recipientBoxKey: string;
  keyring: Keyring;
  /** The sealing member's id, or `recovery`. */
  signer: string;
  /** The signer's Ed25519 secret key. */
  signingSecretKey: Uint8Array;
}

/**
 * Wrap with a given ephemeral secret and nonce. Deterministic, for the test
 * vectors only. Not exported from the public barrel.
 */
export function createWrapDeterministic(
  input: CreateWrapInput,
  ephemeralSecretKey: Uint8Array,
  nonce: Uint8Array,
): KeychainWrap {
  assertRecipient(input.signer, 'signer');
  const generation = input.keyring.generation;
  const aad = wrapAad(input.vaultId, input.recipient, generation);
  const plaintext = encodeKeyring(input.keyring);
  let box: SealedBox;
  try {
    box = sealDeterministic(
      fromBase64Url(input.recipientBoxKey, 32, 'recipientBoxKey'),
      plaintext,
      aad,
      ephemeralSecretKey,
      nonce,
    );
  } finally {
    zeroize(plaintext);
  }
  const unsigned = { recipient: input.recipient, generation, ...box, signer: input.signer };
  const signature = toBase64Url(
    signBytes(input.signingSecretKey, wrapSigningInput(input.vaultId, unsigned)),
  );
  return { ...unsigned, signature };
}

/** Seal `keyring` to `recipient` and sign the wrap. */
export function createWrap(input: CreateWrapInput): KeychainWrap {
  const ephemeral = randomBytes(32);
  try {
    return createWrapDeterministic(input, ephemeral, randomBytes(24));
  } finally {
    zeroize(ephemeral);
  }
}

/**
 * Check a wrap against a verified roster: well formed, at the roster's newest
 * generation, for a current recipient, signed by a current member or the
 * current recovery key. Throws when any of that fails.
 */
export function verifyWrap(wrapValue: unknown, roster: VerifiedRoster): KeychainWrap {
  const wrap = parseWrap(wrapValue);
  if (wrap.generation !== roster.generation) {
    throw new KeychainCryptoError('the wrap is not at the newest generation of the roster');
  }
  if (currentBoxKey(roster, wrap.recipient) === undefined) {
    throw new KeychainCryptoError('the recipient of the wrap is not a current member');
  }
  const signerKey = currentSigningKey(roster, wrap.signer);
  if (signerKey === undefined)
    throw new KeychainCryptoError('the signer of the wrap is not a current member');
  const ok = verifyBytes(
    fromBase64Url(signerKey, 32),
    wrapSigningInput(roster.vaultId, wrap),
    fromBase64Url(wrap.signature, SIGNATURE_LENGTH),
  );
  if (!ok) throw new KeychainCryptoError('the signature of the wrap does not verify');
  return wrap;
}

/**
 * Verify a wrap against the roster and open it with the recipient's X25519
 * secret key. The keyring it returns holds generations 1 to the wrap's.
 * The caller zeroizes it (`zeroizeKeyring`).
 */
export function openWrap(
  wrapValue: unknown,
  roster: VerifiedRoster,
  recipientBoxSecretKey: Uint8Array,
): Keyring {
  const wrap = verifyWrap(wrapValue, roster);
  const plaintext = openSealed(
    recipientBoxSecretKey,
    wrap,
    wrapAad(roster.vaultId, wrap.recipient, wrap.generation),
  );
  try {
    const keyring = decodeKeyring(plaintext);
    if (keyring.generation !== wrap.generation) {
      zeroizeKeyring(keyring);
      throw new KeychainCryptoError('the keyring is not at the generation of the wrap');
    }
    return keyring;
  } finally {
    zeroize(plaintext);
  }
}
