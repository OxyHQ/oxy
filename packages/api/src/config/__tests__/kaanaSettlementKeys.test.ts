import { generateKeyPairSync, sign, verify } from 'node:crypto';
import { parseKaanaSettlementKeys } from '../kaanaSettlementKeys';

jest.mock('../../utils/logger', () => ({
  logger: { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

function rawPublicKeyBase64(
  publicKey: ReturnType<typeof generateKeyPairSync>['publicKey'],
): string {
  const jwk = publicKey.export({ format: 'jwk' }) as { x: string };
  return Buffer.from(jwk.x, 'base64url').toString('base64');
}

describe('KAANA_SETTLEMENT_PUBLIC_KEYS', () => {
  const first = generateKeyPairSync('ed25519');
  const second = generateKeyPairSync('ed25519');

  it('is absent when unset or blank', () => {
    expect(parseKaanaSettlementKeys(undefined)).toEqual({ status: 'absent' });
    expect(parseKaanaSettlementKeys('  ')).toEqual({ status: 'absent' });
  });

  it('parses kid:base64 entries into keys that verify their own signatures', () => {
    const resolution = parseKaanaSettlementKeys(
      `settle-a:${rawPublicKeyBase64(first.publicKey)}, settle-b:${rawPublicKeyBase64(second.publicKey)}`,
    );
    expect(resolution.status).toBe('configured');
    if (resolution.status !== 'configured') return;
    expect([...resolution.keys.keys()]).toEqual(['settle-a', 'settle-b']);
    const message = Buffer.from('settlement');
    const signature = sign(null, message, second.privateKey);
    expect(
      verify(null, message, resolution.keys.get('settle-b') ?? first.publicKey, signature),
    ).toBe(true);
    expect(
      verify(null, message, resolution.keys.get('settle-a') ?? second.publicKey, signature),
    ).toBe(false);
  });

  it.each([
    ['no separator', 'settle-a'],
    ['an empty key id', `:${rawPublicKeyBase64(first.publicKey)}`],
    ['a key of the wrong length', 'settle-a:AAAA'],
    ['a key id with a forbidden character', `settle a:${rawPublicKeyBase64(first.publicKey)}`],
    [
      'a repeated key id',
      `k:${rawPublicKeyBase64(first.publicKey)},k:${rawPublicKeyBase64(second.publicKey)}`,
    ],
  ])('refuses the whole set for %s', (_name, raw) => {
    expect(parseKaanaSettlementKeys(raw).status).toBe('unreadable');
  });
});
