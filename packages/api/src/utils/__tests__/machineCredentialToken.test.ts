/**
 * The `oxy_sk_…` token format — pure, no database.
 *
 * The parse is the outermost gate of the machine credential lane: everything it
 * accepts becomes a query, and everything it rejects never reaches one. So the
 * assertions that matter here are the REFUSALS, and each one names a bearer
 * shape that really turns up — an OAuth public identifier, a JWT, a truncated
 * copy/paste, a value with the surrounding quotes still attached.
 */

import crypto from 'crypto';
import {
  MACHINE_TOKEN_PREFIX,
  generateMachineCredentialToken,
  hashMachineCredentialToken,
  looksLikeMachineCredentialToken,
  machineCredentialTokenPrefix,
} from '../machineCredentialToken';

describe('generateMachineCredentialToken', () => {
  it('emits the documented shape: prefix, 16-hex id, separator, 64-hex secret', () => {
    const { token, tokenPrefix } = generateMachineCredentialToken();
    expect(token).toMatch(/^oxy_sk_[0-9a-f]{16}_[0-9a-f]{64}$/);
    expect(tokenPrefix).toMatch(/^oxy_sk_[0-9a-f]{16}$/);
    expect(token.startsWith(`${tokenPrefix}_`)).toBe(true);
  });

  it('carries 256 bits in the secret half — the number the hash choice rests on', () => {
    // Not a style assertion. `applicationCredentials.ts` argues that plain
    // SHA-256 is correct here BECAUSE the secret is a uniform 256-bit value, so
    // shortening it would silently invalidate the reasoning rather than the
    // code. 64 hex characters is that number, stated where it can fail.
    const { token, tokenPrefix } = generateMachineCredentialToken();
    const secret = token.slice(tokenPrefix.length + 1);
    expect(secret).toHaveLength(64);
    expect(Buffer.from(secret, 'hex')).toHaveLength(32);
  });

  it('never repeats a prefix across a batch', () => {
    const prefixes = new Set<string>();
    for (let index = 0; index < 500; index += 1) {
      prefixes.add(generateMachineCredentialToken().tokenPrefix);
    }
    expect(prefixes.size).toBe(500);
  });

  it('hashes the WHOLE token, not just its secret half', () => {
    // The property that binds a stored digest to the one prefix it was minted
    // for: hashing the secret alone would let a `token_hash` copied onto another
    // row still verify.
    const { token, tokenPrefix, tokenHash } = generateMachineCredentialToken();
    const secret = token.slice(tokenPrefix.length + 1);
    expect(tokenHash).toBe(hashMachineCredentialToken(token));
    expect(tokenHash).not.toBe(crypto.createHash('sha256').update(secret).digest('hex'));
  });

  it('never stores the token itself', () => {
    const { token, tokenPrefix, tokenHash } = generateMachineCredentialToken();
    expect(tokenHash).not.toBe(token);
    expect(tokenHash).not.toContain(token.slice(tokenPrefix.length + 1));
  });
});

describe('machineCredentialTokenPrefix', () => {
  it('returns the lookup half of a well-formed token', () => {
    const { token, tokenPrefix } = generateMachineCredentialToken();
    expect(machineCredentialTokenPrefix(token)).toBe(tokenPrefix);
  });

  it.each([
    ['an OAuth public identifier', `oxy_dk_${'a'.repeat(48)}`],
    ['a JWT', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2ln'],
    ['the prefix alone', `${MACHINE_TOKEN_PREFIX}${'a'.repeat(16)}`],
    ['a truncated secret half', `${MACHINE_TOKEN_PREFIX}${'a'.repeat(16)}_${'b'.repeat(63)}`],
    ['an over-long secret half', `${MACHINE_TOKEN_PREFIX}${'a'.repeat(16)}_${'b'.repeat(65)}`],
    ['uppercase hex', `${MACHINE_TOKEN_PREFIX}${'A'.repeat(16)}_${'B'.repeat(64)}`],
    ['a trailing newline', `${MACHINE_TOKEN_PREFIX}${'a'.repeat(16)}_${'b'.repeat(64)}\n`],
    ['a leading space', ` ${MACHINE_TOKEN_PREFIX}${'a'.repeat(16)}_${'b'.repeat(64)}`],
    ['quotes left on from a shell', `"${MACHINE_TOKEN_PREFIX}${'a'.repeat(16)}_${'b'.repeat(64)}"`],
    ['the empty string', ''],
  ])('refuses %s', (_label, value) => {
    expect(machineCredentialTokenPrefix(value)).toBeNull();
  });

  it('refuses a token with the right shape but the wrong scheme', () => {
    const { token } = generateMachineCredentialToken();
    expect(machineCredentialTokenPrefix(token.replace('oxy_sk_', 'oxy_pk_'))).toBeNull();
  });
});

describe('looksLikeMachineCredentialToken', () => {
  it('claims the scheme even when the rest is malformed', () => {
    // The whole point of this predicate: a caller who typed an Oxy API key badly
    // must be answered by the machine lane, not handed the session lane's
    // "token must be session-based" and sent looking for a JWT.
    expect(looksLikeMachineCredentialToken(`${MACHINE_TOKEN_PREFIX}nonsense`)).toBe(true);
    expect(machineCredentialTokenPrefix(`${MACHINE_TOKEN_PREFIX}nonsense`)).toBeNull();
  });

  it('does not claim an OAuth public identifier or a session token', () => {
    expect(looksLikeMachineCredentialToken(`oxy_dk_${'a'.repeat(48)}`)).toBe(false);
    expect(looksLikeMachineCredentialToken('eyJhbGciOiJIUzI1NiJ9.e30.sig')).toBe(false);
  });
});
