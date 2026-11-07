/**
 * The strong password the keychain suggests: 20 characters from [a-zA-Z0-9] in
 * four groups of five joined by hyphens (`abcde-FGHIJ-k1m2n-OPq3r`), with at
 * least one lower-case letter, one upper-case letter and one digit. About 119
 * bits of entropy; easy to read aloud and to type on a phone.
 *
 * Each character is drawn without modulo bias: a random byte is used only when
 * it is below 248 (4 × 62), and the password is drawn again whole when it
 * lacks a class.
 */

import { randomBytes } from './encoding';

const ALPHABET = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
const LIMIT = 248; // the largest multiple of 62 that fits in a byte
const LENGTH = 20;
const GROUP = 5;

function drawCharacters(count: number, random: (n: number) => Uint8Array): string {
  let out = '';
  while (out.length < count) {
    const bytes = random(count * 2);
    for (let i = 0; i < bytes.length && out.length < count; i += 1) {
      if (bytes[i] < LIMIT) out += ALPHABET[bytes[i] % ALPHABET.length];
    }
    bytes.fill(0);
  }
  return out;
}

/** Whether a 20-character draw holds every class. */
function hasEveryClass(chars: string): boolean {
  return /[a-z]/.test(chars) && /[A-Z]/.test(chars) && /[0-9]/.test(chars);
}

/**
 * A new strong password. `random` defaults to the platform CSPRNG; tests pass
 * their own to check the sampling.
 */
export function generateStrongPassword(random: (n: number) => Uint8Array = randomBytes): string {
  for (;;) {
    const chars = drawCharacters(LENGTH, random);
    if (!hasEveryClass(chars)) continue;
    const groups: string[] = [];
    for (let i = 0; i < LENGTH; i += GROUP) groups.push(chars.slice(i, i + GROUP));
    return groups.join('-');
  }
}

const STRONG_PASSWORD_RE = /^[a-zA-Z0-9]{5}-[a-zA-Z0-9]{5}-[a-zA-Z0-9]{5}-[a-zA-Z0-9]{5}$/;

/** Whether `password` has the shape of a generated strong password. */
export function isStrongPasswordShape(password: string): boolean {
  return STRONG_PASSWORD_RE.test(password) && hasEveryClass(password);
}
