import { verifySecret } from '../verifySecret';

describe('@oxy.so/core/server verifySecret', () => {
  it('returns true for equal secrets', () => {
    expect(verifySecret('s3cr3t-token', 's3cr3t-token')).toBe(true);
    expect(verifySecret('a', 'a')).toBe(true);
    const long = 'x'.repeat(256);
    expect(verifySecret(long, long)).toBe(true);
  });

  it('returns false for unequal same-length secrets', () => {
    expect(verifySecret('s3cr3t-token', 's3cr3t-tokeN')).toBe(false);
    expect(verifySecret('abcd', 'abce')).toBe(false);
  });

  it('returns false on length mismatch without throwing', () => {
    expect(() => verifySecret('short', 'a-much-longer-secret')).not.toThrow();
    expect(verifySecret('short', 'a-much-longer-secret')).toBe(false);
    expect(verifySecret('a-much-longer-secret', 'short')).toBe(false);
    expect(verifySecret('abc', 'abcd')).toBe(false);
  });

  it('returns false for empty inputs', () => {
    expect(verifySecret('', '')).toBe(false);
    expect(verifySecret('', 'x')).toBe(false);
    expect(verifySecret('x', '')).toBe(false);
  });

  it('returns false for non-string inputs without throwing', () => {
    expect(() => verifySecret(undefined as unknown as string, 'x')).not.toThrow();
    expect(verifySecret(undefined as unknown as string, 'x')).toBe(false);
    expect(verifySecret('x', null as unknown as string)).toBe(false);
    expect(verifySecret(123 as unknown as string, 123 as unknown as string)).toBe(false);
  });

  it('handles multi-byte UTF-8 content correctly', () => {
    expect(verifySecret('clé-secrète-🔐', 'clé-secrète-🔐')).toBe(true);
    expect(verifySecret('clé-secrète-🔐', 'cle-secrete-🔐')).toBe(false);
  });
});
