/**
 * One-time codes for `login.totp` and `totp` items: RFC 6238 TOTP over RFC 4226
 * HOTP, HMAC-SHA-1/256/512 from `@noble/hashes`, and the `otpauth://totp/…`
 * URI those items keep (the Google Authenticator key-URI format).
 *
 * The URI is read by hand, not with `URL`: React Native's `URL` is incomplete
 * on Hermes, and a parser the Rust side can mirror exactly matters more.
 */

import { hmac } from '@noble/hashes/hmac.js';
import { sha1 } from '@noble/hashes/legacy.js';
import { sha256, sha512 } from '@noble/hashes/sha2.js';
import { KeychainFormatError } from './errors';

export type TotpAlgorithm = 'SHA1' | 'SHA256' | 'SHA512';

export interface TotpParameters {
  /** The shared secret (the caller zeroizes it). */
  secret: Uint8Array;
  algorithm: TotpAlgorithm;
  /** 6, 7 or 8. */
  digits: number;
  /** The time step in seconds. */
  period: number;
}

export interface OtpauthTotp extends TotpParameters {
  /** The `issuer` parameter, else the label's prefix, else `''`. */
  issuer: string;
  /** The label's account part. */
  account: string;
}

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const MAX_SECRET_BYTES = 128;

/**
 * Decode an RFC 4648 base32 TOTP secret. Ignores case, spaces, hyphens and
 * trailing `=` padding; drops trailing bits that do not fill a byte, as
 * authenticator apps do. Refuses any other character and an empty secret.
 */
export function decodeBase32Secret(text: string): Uint8Array {
  let normalized = '';
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === ' ' || ch === '-') continue;
    if (ch.charCodeAt(0) > 0x7f) throw new KeychainFormatError('a TOTP secret is base32');
    normalized += ch.toUpperCase();
  }
  normalized = normalized.replace(/=+$/, '');
  const out: number[] = [];
  let acc = 0;
  let bits = 0;
  for (let i = 0; i < normalized.length; i += 1) {
    const v = BASE32.indexOf(normalized[i]);
    if (v < 0) throw new KeychainFormatError('a TOTP secret is base32');
    acc = ((acc << 5) | v) & 0xfff;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out.push((acc >> bits) & 0xff);
    }
  }
  if (out.length === 0) throw new KeychainFormatError('a TOTP secret must not be empty');
  if (out.length > MAX_SECRET_BYTES)
    throw new KeychainFormatError('a TOTP secret is at most 128 bytes');
  return Uint8Array.from(out);
}

/** Encode a secret as unpadded upper-case base32 (for writing a URI). */
export function encodeBase32Secret(secret: Uint8Array): string {
  let out = '';
  let acc = 0;
  let bits = 0;
  for (let i = 0; i < secret.length; i += 1) {
    acc = ((acc << 8) | secret[i]) & 0xfff;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += BASE32[(acc >> bits) & 0x1f];
    }
  }
  if (bits > 0) out += BASE32[(acc << (5 - bits)) & 0x1f];
  return out;
}

function hashFor(algorithm: TotpAlgorithm) {
  switch (algorithm) {
    case 'SHA1':
      return sha1;
    case 'SHA256':
      return sha256;
    case 'SHA512':
      return sha512;
  }
  throw new KeychainFormatError('unknown TOTP algorithm');
}

/** HOTP (RFC 4226) of a counter. */
export function hotpCode(
  secret: Uint8Array,
  counter: number,
  algorithm: TotpAlgorithm = 'SHA1',
  digits = 6,
): string {
  if (!Number.isSafeInteger(counter) || counter < 0)
    throw new KeychainFormatError('counter must be a non-negative integer');
  if (!Number.isInteger(digits) || digits < 6 || digits > 8)
    throw new KeychainFormatError('digits must be 6, 7 or 8');
  const message = new Uint8Array(8);
  const high = Math.floor(counter / 0x1_0000_0000);
  const low = counter >>> 0;
  new DataView(message.buffer).setUint32(0, high);
  new DataView(message.buffer).setUint32(4, low);
  const mac = hmac(hashFor(algorithm), secret, message);
  const offset = mac[mac.length - 1] & 0x0f;
  const binary =
    (((mac[offset] & 0x7f) << 24) |
      (mac[offset + 1] << 16) |
      (mac[offset + 2] << 8) |
      mac[offset + 3]) >>>
    0;
  mac.fill(0);
  return String(binary % 10 ** digits).padStart(digits, '0');
}

/** The RFC 6238 time step of `timeMs` (Unix milliseconds) for `period` seconds. */
export function totpCounter(timeMs: number, period = 30): number {
  if (!Number.isInteger(period) || period < 1)
    throw new KeychainFormatError('period must be a positive integer');
  return Math.floor(Math.floor(timeMs / 1000) / period);
}

/** The TOTP code at `timeMs` (Unix milliseconds; now by default). */
export function totpCode(
  params: Partial<TotpParameters> & { secret: Uint8Array },
  timeMs: number = Date.now(),
): string {
  const period = params.period ?? 30;
  return hotpCode(
    params.secret,
    totpCounter(timeMs, period),
    params.algorithm ?? 'SHA1',
    params.digits ?? 6,
  );
}

/** Seconds left before the code at `timeMs` changes. */
export function totpSecondsRemaining(timeMs: number = Date.now(), period = 30): number {
  return period - (Math.floor(timeMs / 1000) % period);
}

function percentDecode(text: string, plusIsSpace: boolean): string {
  try {
    return decodeURIComponent(plusIsSpace ? text.replace(/\+/g, ' ') : text);
  } catch {
    throw new KeychainFormatError('the otpauth URI is not valid percent-encoding');
  }
}

const SCHEME = 'otpauth://totp/';

/**
 * Read an `otpauth://totp/LABEL?secret=…&issuer=…&algorithm=…&digits=…&period=…`
 * URI. The scheme and type are case-insensitive; `hotp` is refused (an item
 * keeps time-based codes only). `secret` is required; `algorithm` defaults to
 * SHA1, `digits` to 6, `period` to 30; unknown parameters (`image`, …) are
 * ignored and a repeated one is refused. Query values read `+` as a space.
 */
export function parseOtpauthUri(uri: string): OtpauthTotp {
  if (typeof uri !== 'string' || uri.length > 4096)
    throw new KeychainFormatError('not an otpauth URI');
  if (uri.slice(0, SCHEME.length).toLowerCase() !== SCHEME) {
    throw new KeychainFormatError('not an otpauth://totp/ URI');
  }
  if (uri.includes('#')) throw new KeychainFormatError('an otpauth URI has no fragment');
  const rest = uri.slice(SCHEME.length);
  const q = rest.indexOf('?');
  const rawLabel = q < 0 ? rest : rest.slice(0, q);
  const query = q < 0 ? '' : rest.slice(q + 1);

  const label = percentDecode(rawLabel, false);
  const colon = label.indexOf(':');
  const labelIssuer = colon < 0 ? '' : label.slice(0, colon);
  const account = (colon < 0 ? label : label.slice(colon + 1)).replace(/^ +/, '');

  const params = new Map<string, string>();
  for (const pair of query.split('&')) {
    if (pair === '') continue;
    const eq = pair.indexOf('=');
    const key = percentDecode(eq < 0 ? pair : pair.slice(0, eq), true).toLowerCase();
    const value = eq < 0 ? '' : percentDecode(pair.slice(eq + 1), true);
    if (params.has(key)) throw new KeychainFormatError('an otpauth parameter is repeated');
    params.set(key, value);
  }

  const secretText = params.get('secret');
  if (secretText === undefined) throw new KeychainFormatError('an otpauth URI needs a secret');
  const algorithmText = (params.get('algorithm') ?? 'SHA1').toUpperCase();
  if (algorithmText !== 'SHA1' && algorithmText !== 'SHA256' && algorithmText !== 'SHA512') {
    throw new KeychainFormatError('algorithm must be SHA1, SHA256 or SHA512');
  }
  const digitsText = params.get('digits') ?? '6';
  if (!/^[678]$/.test(digitsText)) throw new KeychainFormatError('digits must be 6, 7 or 8');
  const periodText = params.get('period') ?? '30';
  if (!/^[1-9][0-9]{0,3}$/.test(periodText) || Number(periodText) > 3600) {
    throw new KeychainFormatError('period must be 1 to 3600 seconds');
  }
  return {
    secret: decodeBase32Secret(secretText),
    algorithm: algorithmText,
    digits: Number(digitsText),
    period: Number(periodText),
    issuer: params.get('issuer') ?? labelIssuer,
    account,
  };
}
