/**
 * The primitives under sign-in without a passkey: the password hash, RFC 6238
 * TOTP, and the sealed box the TOTP secret is stored in.
 */

process.env.DEVICE_ID_SALT = 'sign-in-crypto-test-salt-0123456789abcdefghij';

import { hashPassword, needsRehash, verifyPassword, verifyPasswordOrDummy } from '../password.service';
import { base32Decode, base32Encode, hotp, isAuthenticatorCode, matchTotpStep, newBackupCode, totpCodeAt, totpStep } from '../totp.service';
import { _setScryptConcurrencyForTests } from '../password.service';
import { SERVER_KEY_LABELS, derivedServerKey, serverHmacHex } from '../../utils/serverKey';
import { openSecret, sealSecret } from '../../utils/secretBox';

describe('password hashing', () => {
  it('stores a versioned scrypt hash with its own salt, and verifies only the password', async () => {
    const first = await hashPassword('correct horse battery staple');
    const second = await hashPassword('correct horse battery staple');
    expect(first).toMatch(/^\$scrypt\$v=1\$ln=15,r=8,p=3\$[A-Za-z0-9_-]{22}\$[A-Za-z0-9_-]{43}$/);
    expect(first).not.toBe(second);
    expect(await verifyPassword('correct horse battery staple', first)).toBe(true);
    expect(await verifyPassword('correct horse battery stapl', first)).toBe(false);
    expect(needsRehash(first)).toBe(false);
  });

  it('treats the same characters typed two ways as one password (NFKC)', async () => {
    const stored = await hashPassword('ﬁle password');
    expect(await verifyPassword('file password', stored)).toBe(true);
  });

  it('refuses a malformed or hostile row instead of throwing or burning memory', async () => {
    const stored = await hashPassword('password password');
    expect(await verifyPassword('password password', 'plain')).toBe(false);
    expect(await verifyPassword('password password', stored.replace('ln=15', 'ln=30'))).toBe(false);
    expect(await verifyPassword('password password', stored.replace('v=1', 'v=9'))).toBe(false);
    expect(needsRehash('garbage')).toBe(true);
  });

  it('spends the work and answers false when there is nothing to verify', async () => {
    expect(await verifyPasswordOrDummy('anything at all', null)).toBe(false);
  });
});

describe('TOTP (RFC 6238, SHA-1)', () => {
  // RFC 6238 Appendix B: secret "12345678901234567890", T=59 → 94287082 (8 digits).
  const rfcSecret = Buffer.from('12345678901234567890');

  it('matches the RFC test vectors truncated to 6 digits', () => {
    expect(hotp(rfcSecret, totpStep(new Date(59_000)))).toBe('287082');
    expect(hotp(rfcSecret, totpStep(new Date(1111111109_000)))).toBe('081804');
    expect(hotp(rfcSecret, totpStep(new Date(2000000000_000)))).toBe('279037');
  });

  it('round-trips base32', () => {
    const encoded = base32Encode(rfcSecret);
    expect(encoded).toBe('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
    expect(base32Decode(encoded).equals(rfcSecret)).toBe(true);
  });

  it('accepts one step either side, never an older step than the last one used', () => {
    const secret = base32Encode(rfcSecret);
    const now = new Date(1_800_000_000_000);
    const step = totpStep(now);
    expect(matchTotpStep(rfcSecret, totpCodeAt(secret, now), now, null)).toBe(step);
    expect(matchTotpStep(rfcSecret, totpCodeAt(secret, new Date(now.getTime() - 30_000)), now, null)).toBe(step - 1);
    expect(matchTotpStep(rfcSecret, totpCodeAt(secret, new Date(now.getTime() + 30_000)), now, null)).toBe(step + 1);
    expect(matchTotpStep(rfcSecret, totpCodeAt(secret, new Date(now.getTime() - 90_000)), now, null)).toBeNull();
    // Replay: the step was already used.
    expect(matchTotpStep(rfcSecret, totpCodeAt(secret, now), now, step)).toBeNull();
    expect(matchTotpStep(rfcSecret, 'abcdef', now, null)).toBeNull();
    expect(matchTotpStep(rfcSecret, '12345', now, null)).toBeNull();
  });
});

describe('the sealed box', () => {
  it('opens only for the context it was sealed for, and refuses tampering', () => {
    const sealed = sealSecret('JBSWY3DPEHPK3PXP', 'totp|user-1');
    expect(sealed).toMatch(/^v1\./);
    expect(sealed).not.toContain('JBSWY3DPEHPK3PXP');
    expect(sealSecret('JBSWY3DPEHPK3PXP', 'totp|user-1')).not.toBe(sealed);
    expect(openSecret(sealed, 'totp|user-1')).toBe('JBSWY3DPEHPK3PXP');
    expect(() => openSecret(sealed, 'totp|user-2')).toThrow();
    const [version, iv, body, tag] = sealed.split('.');
    const flipped = `${body.startsWith('A') ? 'B' : 'A'}${body.slice(1)}`;
    expect(() => openSecret([version, iv, flipped, tag].join('.'), 'totp|user-1')).toThrow();
  });

  it('refuses to work without the server secret', () => {
    const saved = process.env.DEVICE_ID_SALT;
    delete process.env.DEVICE_ID_SALT;
    try {
      expect(() => sealSecret('x', 'y')).toThrow(/DEVICE_ID_SALT/);
    } finally {
      process.env.DEVICE_ID_SALT = saved;
    }
  });
});

describe('backup codes never pass for authenticator codes', () => {
  it('always carry a letter, so no backup code is six digits typed without its dash', () => {
    for (let index = 0; index < 500; index += 1) {
      const code = newBackupCode();
      expect(code).toMatch(/^[a-z2-9]{5}-[a-z2-9]{5}$/);
      expect(code).toMatch(/[a-z]/);
      expect(isAuthenticatorCode(code.replace('-', ''))).toBe(false);
    }
    expect(isAuthenticatorCode('123456')).toBe(true);
    // Ten digits is not an authenticator code: it is tried as a backup code.
    expect(isAuthenticatorCode('2345623456')).toBe(false);
  });
});

describe('scrypt concurrency', () => {
  afterEach(() => _setScryptConcurrencyForTests(null));

  it('fails fast with a 503 instead of queueing without bound', async () => {
    _setScryptConcurrencyForTests(1);
    const outcomes = await Promise.all(
      Array.from({ length: 40 }, () => hashPassword('parallel password').then(() => 'hashed', (error: { statusCode?: number }) => error.statusCode)),
    );
    expect(outcomes.filter((outcome) => outcome === 503).length).toBeGreaterThan(0);
    expect(outcomes.filter((outcome) => outcome === 'hashed').length).toBeGreaterThan(0);
    expect(outcomes.every((outcome) => outcome === 'hashed' || outcome === 503)).toBe(true);
  });
});

describe('server keys', () => {
  it('derive one key per label, and fail closed without the server secret', () => {
    expect(derivedServerKey(SERVER_KEY_LABELS.emailCode).equals(derivedServerKey(SERVER_KEY_LABELS.totpBackupCode))).toBe(false);
    const saved = process.env.DEVICE_ID_SALT;
    delete process.env.DEVICE_ID_SALT;
    try {
      expect(() => serverHmacHex(SERVER_KEY_LABELS.emailCode, 'x')).toThrow(/DEVICE_ID_SALT/);
    } finally {
      process.env.DEVICE_ID_SALT = saved;
    }
  });
});
