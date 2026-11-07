/**
 * The keychain's byte encodings (ADR 0063 D8): base64url without padding,
 * lowercase hex, UTF-8, strict RFC 8785 JCS, and the uuid shape every id has.
 *
 * Every decoder here is strict: a value that does not re-encode to exactly the
 * text it was read from is refused, so one value has one spelling and a Rust
 * reader and this one agree on what is valid.
 *
 * ESM/CJS safe: static `import` only, no `require()`. No `\p{…}` regex (Hermes).
 */

import { canonicalize } from '@oxy.so/protocol';
import { KeychainFormatError } from './errors';

const BASE64URL_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const BASE64URL_LOOKUP: Record<string, number> = {};
for (let i = 0; i < BASE64URL_ALPHABET.length; i += 1) {
  BASE64URL_LOOKUP[BASE64URL_ALPHABET[i]] = i;
}

/** Encode bytes as base64url without padding (RFC 4648 §5). */
export function toBase64Url(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i];
    const has1 = i + 1 < bytes.length;
    const has2 = i + 2 < bytes.length;
    const b1 = has1 ? bytes[i + 1] : 0;
    const b2 = has2 ? bytes[i + 2] : 0;
    out += BASE64URL_ALPHABET[b0 >> 2];
    out += BASE64URL_ALPHABET[((b0 & 0x03) << 4) | (b1 >> 4)];
    if (has1) out += BASE64URL_ALPHABET[((b1 & 0x0f) << 2) | (b2 >> 6)];
    if (has2) out += BASE64URL_ALPHABET[b2 & 0x3f];
  }
  return out;
}

/**
 * Decode base64url without padding. Refuses padding, any character outside the
 * alphabet, an impossible length and non-zero trailing bits (a non-canonical
 * spelling). With `length`, also refuses any other decoded length.
 */
export function fromBase64Url(text: string, length?: number, what = 'value'): Uint8Array {
  if (typeof text !== 'string') throw new KeychainFormatError(`${what} must be base64url text`);
  if (text.length % 4 === 1) throw new KeychainFormatError(`${what} is not valid base64url`);
  const out = new Uint8Array(Math.floor((text.length * 6) / 8));
  let acc = 0;
  let bits = 0;
  let o = 0;
  for (let i = 0; i < text.length; i += 1) {
    const v = BASE64URL_LOOKUP[text[i]];
    if (v === undefined) throw new KeychainFormatError(`${what} is not valid base64url`);
    acc = ((acc << 6) | v) & 0xffff;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[o] = (acc >> bits) & 0xff;
      o += 1;
    }
  }
  // Leftover bits must be zero: "AB" and "AC" must not both decode to 0x00.
  if (bits > 0 && (acc & ((1 << bits) - 1)) !== 0) {
    throw new KeychainFormatError(`${what} is not canonical base64url`);
  }
  if (length !== undefined && out.length !== length) {
    throw new KeychainFormatError(`${what} must be ${length} bytes`);
  }
  return out;
}

/** Lowercase hex. */
export function toHex(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 1) out += bytes[i].toString(16).padStart(2, '0');
  return out;
}

const HEX_RE = /^(?:[0-9a-f]{2})*$/;

/** Lowercase hex only. */
export function fromHex(text: string, what = 'value'): Uint8Array {
  if (typeof text !== 'string' || !HEX_RE.test(text)) {
    throw new KeychainFormatError(`${what} must be lowercase hex`);
  }
  const out = new Uint8Array(text.length / 2);
  for (let i = 0; i < out.length; i += 1)
    out[i] = Number.parseInt(text.slice(i * 2, i * 2 + 2), 16);
  return out;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

/** UTF-8 of a well-formed string. */
export function utf8(text: string): Uint8Array {
  assertWellFormed(text, 'text');
  return encoder.encode(text);
}

/** Strict UTF-8 decoding: malformed input throws. */
export function fromUtf8(bytes: Uint8Array): string {
  try {
    return decoder.decode(bytes);
  } catch {
    throw new KeychainFormatError('not valid UTF-8');
  }
}

/** Concatenate byte arrays. */
export function concatBytes(...parts: Uint8Array[]): Uint8Array {
  let length = 0;
  for (const p of parts) length += p.length;
  const out = new Uint8Array(length);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

/** Overwrite every given buffer with zeros. */
export function zeroize(...buffers: Array<Uint8Array | null | undefined>): void {
  for (const b of buffers) b?.fill(0);
}

/** Constant-time equality of two byte arrays (length is not secret). */
export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a[i] ^ b[i];
  return diff === 0;
}

/** True when every UTF-16 surrogate in `text` is part of a pair. */
export function isWellFormed(text: string): boolean {
  for (let i = 0; i < text.length; i += 1) {
    const c = text.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = i + 1 < text.length ? text.charCodeAt(i + 1) : 0;
      if (next < 0xdc00 || next > 0xdfff) return false;
      i += 1;
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function assertWellFormed(text: string, what: string): void {
  if (!isWellFormed(text)) throw new KeychainFormatError(`${what} contains a lone surrogate`);
}

/**
 * Strict RFC 8785 JCS of a keychain value. Only what the keychain's formats
 * hold is accepted: plain objects, arrays, well-formed strings, booleans,
 * `null` and safe integers. A float, a lone surrogate, `undefined` or any other
 * value throws instead of being silently dropped or approximated, so the
 * serialization a Rust implementation has to reproduce is integer-and-string
 * JCS only.
 */
export function jcs(value: unknown): string {
  assertJcsValue(value, 0);
  return canonicalize(value);
}

/** UTF-8 bytes of {@link jcs}. */
export function jcsBytes(value: unknown): Uint8Array {
  return encoder.encode(jcs(value));
}

function assertJcsValue(value: unknown, depth: number): void {
  if (depth > 32) throw new KeychainFormatError('value is nested too deeply');
  if (value === null || typeof value === 'boolean') return;
  if (typeof value === 'string') {
    assertWellFormed(value, 'string');
    return;
  }
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value))
      throw new KeychainFormatError('numbers must be safe integers');
    // JCS writes -0 as 0; one spelling per value.
    if (Object.is(value, -0)) throw new KeychainFormatError('numbers must not be -0');
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) assertJcsValue(item, depth + 1);
    return;
  }
  if (typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    for (const [key, member] of Object.entries(value as Record<string, unknown>)) {
      assertWellFormed(key, 'key');
      assertJcsValue(member, depth + 1);
    }
    return;
  }
  throw new KeychainFormatError(`a ${typeof value} is not a keychain value`);
}

/**
 * Parse JSON text that must be exactly the JCS of what it holds: any other
 * spelling (whitespace, key order, escapes, duplicate keys) is refused.
 */
export function parseCanonicalJson(text: string, what = 'JSON'): unknown {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new KeychainFormatError(`${what} is not valid JSON`);
  }
  let canonical: string;
  try {
    canonical = jcs(value);
  } catch {
    throw new KeychainFormatError(`${what} holds a value outside the keychain's JSON`);
  }
  if (canonical !== text) throw new KeychainFormatError(`${what} is not canonical (RFC 8785)`);
  return value;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** A lowercase uuid in its 8-4-4-4-12 form (any version). */
export function isLowercaseUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}

export function assertUuid(value: unknown, what: string): asserts value is string {
  if (!isLowercaseUuid(value)) throw new KeychainFormatError(`${what} must be a lowercase uuid`);
}

/** Read `byteLength` random bytes from the platform CSPRNG. */
export function randomBytes(byteLength: number): Uint8Array {
  const out = new Uint8Array(byteLength);
  globalThis.crypto.getRandomValues(out);
  return out;
}

const TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/**
 * A timestamp in its one spelling: UTC with milliseconds, as
 * `Date.prototype.toISOString` writes it (`2026-11-07T12:00:00.000Z`).
 */
export function isKeychainTimestamp(value: unknown): value is string {
  if (typeof value !== 'string' || !TIMESTAMP_RE.test(value)) return false;
  const ms = Date.parse(value);
  return Number.isFinite(ms) && new Date(ms).toISOString() === value;
}

/** The current time as a keychain timestamp. */
export function keychainTimestamp(date: Date = new Date()): string {
  return date.toISOString();
}
