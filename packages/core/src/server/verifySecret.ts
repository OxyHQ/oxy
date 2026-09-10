/**
 * Constant-time secret comparison for Oxy backends.
 *
 * WHY THIS EXISTS
 * ---------------
 * Backends kept comparing secrets with `provided !== EXPECTED`. A plain `===`/
 * `!==` short-circuits on the first differing byte, leaking timing information
 * an attacker can use to recover a secret byte-by-byte. This helper performs a
 * constant-time comparison via `crypto.timingSafeEqual`, guarded by a length
 * check, and never throws — replacing the `token !== SECRET` pattern (Alia
 * docker-host / integrations webhook secrets, internal webhook bearers, etc.).
 *
 * Node-only (`node:crypto`); exported solely from `@oxy.so/core/server`.
 */

import { timingSafeEqual } from 'node:crypto';
import { Buffer } from 'node:buffer';

/**
 * Compare two secrets in constant time.
 *
 * Returns `true` iff both are non-empty strings of equal byte length with
 * identical contents. Returns `false` — without throwing — when either value is
 * not a string, when lengths differ, or when contents differ.
 *
 * The length-equality guard is required because `crypto.timingSafeEqual` throws
 * on unequal-length buffers; comparing lengths first leaks only the LENGTH of
 * the expected secret (already low-value / often public), never its bytes.
 *
 * @param provided - The untrusted, caller-supplied value (e.g. a request token).
 * @param expected - The trusted secret to compare against.
 */
export function verifySecret(provided: string, expected: string): boolean {
  if (typeof provided !== 'string' || typeof expected !== 'string') {
    return false;
  }
  if (provided.length === 0 || expected.length === 0) {
    return false;
  }

  const providedBuf = Buffer.from(provided, 'utf8');
  const expectedBuf = Buffer.from(expected, 'utf8');

  // timingSafeEqual requires equal byte length. A mismatch here is itself a
  // (length-only) early return — acceptable, since the secret's length is not
  // the sensitive part; its bytes are, and those are compared in constant time.
  if (providedBuf.length !== expectedBuf.length) {
    return false;
  }

  return timingSafeEqual(providedBuf, expectedBuf);
}
