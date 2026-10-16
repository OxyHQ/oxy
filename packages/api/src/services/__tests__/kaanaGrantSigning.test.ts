/**
 * The grant and settlement signatures (Kaana ADR 0002): the bytes Oxy signs are
 * the bytes Kaana's verifier rebuilds from `@kaana.ai/contracts`, and each
 * domain refuses the other's signature.
 */
import { generateKeyPairSync, sign, verify } from 'node:crypto';
import {
  GRANT_SIGNATURE_DOMAIN,
  SETTLEMENT_SIGNATURE_DOMAIN,
  signatureInput,
} from '@kaana.ai/contracts/internal';
import {
  KAANA_KEY_ID_HEADER,
  KAANA_SIGNATURE_HEADER,
  KAANA_TIMESTAMP_HEADER,
  SETTLEMENT_MAX_SKEW_MS,
  sha256Hex,
  signGrantBody,
  verifySettlementSignature,
} from '../kaanaGrantSigning';

const oxy = generateKeyPairSync('ed25519');
const kaana = generateKeyPairSync('ed25519');
const body = Buffer.from(JSON.stringify({ schemaVersion: 1, grantId: 'g-1' }), 'utf8');
const NOW = 1_792_000_000_000;

function signSettlement(
  bytes: Buffer,
  keyId: string,
  timestamp: number,
  domain = SETTLEMENT_SIGNATURE_DOMAIN,
) {
  const input = signatureInput(domain, keyId, timestamp, sha256Hex(bytes));
  return `v1=${sign(null, Buffer.from(input, 'utf8'), kaana.privateKey).toString('base64')}`;
}

describe('grant signature', () => {
  it('signs the contract signing input with the edge key under oxy-kaana-grant:v1', () => {
    const headers = signGrantBody({ keyId: 'oxy-edge-1', privateKey: oxy.privateKey }, body, NOW);
    expect(headers[KAANA_KEY_ID_HEADER]).toBe('oxy-edge-1');
    expect(headers[KAANA_TIMESTAMP_HEADER]).toBe(String(NOW));
    const signature = headers[KAANA_SIGNATURE_HEADER];
    expect(signature.startsWith('v1=')).toBe(true);
    const bytes = Buffer.from(signature.slice(3), 'base64');
    const input = signatureInput(GRANT_SIGNATURE_DOMAIN, 'oxy-edge-1', NOW, sha256Hex(body));
    expect(verify(null, Buffer.from(input, 'utf8'), oxy.publicKey, bytes)).toBe(true);
  });

  it('is not a valid signature over any other body, domain or timestamp', () => {
    const signature = Buffer.from(
      signGrantBody({ keyId: 'k', privateKey: oxy.privateKey }, body, NOW)[
        KAANA_SIGNATURE_HEADER
      ].slice(3),
      'base64',
    );
    const other = Buffer.from('{"schemaVersion":1,"grantId":"g-2"}', 'utf8');
    for (const input of [
      signatureInput(GRANT_SIGNATURE_DOMAIN, 'k', NOW, sha256Hex(other)),
      signatureInput('oxy-kaana-envelope:v1', 'k', NOW, sha256Hex(body)),
      signatureInput(GRANT_SIGNATURE_DOMAIN, 'k', NOW + 1, sha256Hex(body)),
    ]) {
      expect(verify(null, Buffer.from(input, 'utf8'), oxy.publicKey, signature)).toBe(false);
    }
  });
});

describe('settlement signature', () => {
  const keys = new Map([['kaana-settle-1', kaana.publicKey]]);
  const headers = (
    overrides: Partial<Record<'keyId' | 'timestamp' | 'signature', string | undefined>> = {},
  ) => ({
    keyId: 'kaana-settle-1',
    timestamp: String(NOW),
    signature: signSettlement(body, 'kaana-settle-1', NOW),
    ...overrides,
  });

  it('accepts Kaana’s signature over the exact bytes', () => {
    expect(verifySettlementSignature(headers(), body, keys, NOW)).toEqual({
      ok: true,
      keyId: 'kaana-settle-1',
    });
  });

  it.each([
    ['a missing header', { signature: undefined }, 'missing'],
    ['an unknown key id', { keyId: 'other' }, 'unknown-key'],
    ['a malformed timestamp', { timestamp: '12x' }, 'malformed'],
    ['a signature without its version prefix', { signature: 'abc' }, 'malformed'],
  ])('refuses %s', (_name, overrides, reason) => {
    expect(verifySettlementSignature(headers(overrides), body, keys, NOW)).toEqual({
      ok: false,
      reason,
    });
  });

  it('refuses a signature outside the five-minute window, either way', () => {
    const late = NOW + SETTLEMENT_MAX_SKEW_MS + 1;
    expect(verifySettlementSignature(headers(), body, keys, late)).toEqual({
      ok: false,
      reason: 'stale',
    });
    expect(
      verifySettlementSignature(headers(), body, keys, NOW - SETTLEMENT_MAX_SKEW_MS - 1),
    ).toEqual({
      ok: false,
      reason: 'stale',
    });
  });

  it('refuses a body that is not the one signed', () => {
    const tampered = Buffer.from(body.toString('utf8').replace('g-1', 'g-9'), 'utf8');
    expect(verifySettlementSignature(headers(), tampered, keys, NOW)).toEqual({
      ok: false,
      reason: 'bad-signature',
    });
  });

  it('refuses a grant-domain signature presented as a settlement', () => {
    const crossDomain = signSettlement(body, 'kaana-settle-1', NOW, GRANT_SIGNATURE_DOMAIN);
    expect(verifySettlementSignature(headers({ signature: crossDomain }), body, keys, NOW)).toEqual(
      {
        ok: false,
        reason: 'bad-signature',
      },
    );
  });
});
