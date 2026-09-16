/**
 * Envelope version 2 (ADR 0024 D2, D5): one root, whatever material it came
 * from — a 12- or 24-word phrase, or a raw key that must never gain a phrase —
 * and wraps bound to the RP ID their passkey lives under. Version 1 envelopes
 * keep opening unchanged.
 */

import { webIdentityEnvelopeSchema } from '@oxy.so/contracts';
import { mnemonicToSeedSync } from '@scure/bip39';
import { bytesToHex } from '@noble/hashes/utils';
import { deriveSecp256k1PublicKey } from '@oxy.so/protocol/secp256k1';
import {
  addWrap,
  deriveIdentityFromMnemonic,
  deriveIdentityFromPrivateKey,
  deriveIdentityFromRecoveryMaterial,
  isUsablePrfOutput,
  markWrapVerified,
  parseRecoveryMaterial,
  sealWebIdentity,
  unlockWebIdentity,
  unwrapDataKey,
  WebIdentityUnlockError,
  wipeBytes,
} from '../webIdentityCarrier';

const MNEMONIC_12 = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
/** BIP-39 reference vector: 32 bytes of zero entropy. */
const MNEMONIC_24 =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon art';
const RAW_KEY = '1f'.repeat(32);
const prf = (fill: number): Uint8Array => new Uint8Array(32).fill(fill);
const CREDENTIAL = 'credential-aaaaaaaaaaaaaaaa';

const failureOf = (fn: () => unknown): string | undefined => {
  try {
    fn();
  } catch (error) {
    return error instanceof WebIdentityUnlockError ? error.failure : 'other';
  }
  return undefined;
};

describe('recovery material', () => {
  it('derives a 24-word root exactly as seed[0:32], unchanged from the 12-word rule', () => {
    const identity = deriveIdentityFromMnemonic(MNEMONIC_24);
    const expected = bytesToHex(mnemonicToSeedSync(MNEMONIC_24).slice(0, 32));
    expect(identity.kind).toBe('mnemonic');
    expect(identity.privateKey).toBe(expected);
    expect(identity.publicKey).toBe(deriveSecp256k1PublicKey(expected));
  });

  it('reads a phrase or a raw key, and nothing else', () => {
    expect(parseRecoveryMaterial(`  ${MNEMONIC_24.toUpperCase()} `)).toEqual({ kind: 'mnemonic', mnemonic: MNEMONIC_24 });
    expect(parseRecoveryMaterial(`0x${RAW_KEY.toUpperCase()}`)).toEqual({ kind: 'raw-key', privateKey: `0x${RAW_KEY.toUpperCase()}` });
    expect(() => parseRecoveryMaterial('abandon abandon')).toThrow('Invalid recovery material');
    expect(() => parseRecoveryMaterial('zz'.repeat(32))).toThrow('Invalid recovery material');
  });

  it('keeps a raw key a raw key: no phrase is ever derived for it', () => {
    const identity = deriveIdentityFromRecoveryMaterial({ kind: 'raw-key', privateKey: `0x${RAW_KEY}` });
    expect(identity).toEqual({ kind: 'raw-key', mnemonic: null, privateKey: RAW_KEY, publicKey: deriveSecp256k1PublicKey(RAW_KEY) });
    expect(() => deriveIdentityFromPrivateKey('00'.repeat(32))).toThrow('Invalid private key');
  });

  it('treats only an actual 32-byte PRF output as usable', () => {
    expect(isUsablePrfOutput(prf(1))).toBe(true);
    expect(isUsablePrfOutput(new Uint8Array(31))).toBe(false);
    expect(isUsablePrfOutput(null)).toBe(false);
  });
});

describe('version 2 envelopes', () => {
  it.each([
    ['12 words', () => deriveIdentityFromMnemonic(MNEMONIC_12)],
    ['24 words', () => deriveIdentityFromMnemonic(MNEMONIC_24)],
    ['a raw key', () => deriveIdentityFromPrivateKey(RAW_KEY)],
  ])('seals and reopens the same root from %s', (_label, make) => {
    const identity = make();
    const { envelope, dataKey } = sealWebIdentity(identity, { prfOutput: prf(7), credentialId: CREDENTIAL, rpId: 'oxy.so' }, new Date(), { version: 2 });
    wipeBytes(dataKey);

    expect(webIdentityEnvelopeSchema.safeParse(envelope).success).toBe(true);
    expect(envelope.version).toBe(2);
    expect(envelope.wraps[0].rpId).toBe('oxy.so');
    const opened = unlockWebIdentity(envelope, prf(7), CREDENTIAL);
    expect(opened).toEqual(make());
  });

  it('refuses to put anything but a 12-word phrase in a version-1 envelope', () => {
    expect(() => sealWebIdentity(deriveIdentityFromMnemonic(MNEMONIC_24), { prfOutput: prf(1), credentialId: CREDENTIAL }, new Date(), { version: 1 })).toThrow('version-1');
    expect(() => sealWebIdentity(deriveIdentityFromPrivateKey(RAW_KEY), { prfOutput: prf(1), credentialId: CREDENTIAL }, new Date(), { version: 1 })).toThrow('version-1');
  });

  it('binds the RP ID into a version-2 wrap, so a relabelled wrap does not open', () => {
    const { envelope, dataKey } = sealWebIdentity(deriveIdentityFromMnemonic(MNEMONIC_12), { prfOutput: prf(3), credentialId: CREDENTIAL, rpId: 'oxy.so' }, new Date(), { version: 2 });
    wipeBytes(dataKey);
    const relabelled = { ...envelope, wraps: envelope.wraps.map((wrap) => ({ ...wrap, rpId: 'auth.oxy.so' })) };
    expect(failureOf(() => unwrapDataKey(relabelled, prf(3), CREDENTIAL))).toBe('prf-mismatch');
  });

  it('refuses a secret kind that was swapped after sealing', () => {
    const { envelope, dataKey } = sealWebIdentity(deriveIdentityFromMnemonic(MNEMONIC_24), { prfOutput: prf(3), credentialId: CREDENTIAL }, new Date(), { version: 2 });
    const swapped = { ...envelope, secretKind: 'raw-private-key' as const };
    expect(failureOf(() => unlockWebIdentity(swapped, prf(3), CREDENTIAL))).toBe('corrupt');
    wipeBytes(dataKey);
  });

  it('adds a second passkey and records which wraps have proven they open the root', () => {
    const identity = deriveIdentityFromMnemonic(MNEMONIC_12);
    const { envelope, dataKey } = sealWebIdentity(identity, { prfOutput: prf(1), credentialId: CREDENTIAL, rpId: 'oxy.so' }, new Date(), { version: 2 });
    const second = 'credential-bbbbbbbbbbbbbbbb';
    const both = addWrap(envelope, dataKey, { prfOutput: prf(2), credentialId: second, rpId: 'oxy.so' });
    wipeBytes(dataKey);

    expect(unlockWebIdentity(both, prf(2), second).publicKey).toBe(identity.publicKey);
    const verified = markWrapVerified(both, second, new Date('2026-09-16T00:00:00.000Z'));
    expect(verified.wraps.find((wrap) => wrap.credentialId === second)?.verifiedAt).toBe('2026-09-16T00:00:00.000Z');
    expect(verified.wraps.find((wrap) => wrap.credentialId === CREDENTIAL)?.verifiedAt).toBeUndefined();
    // Holder metadata is not part of the AEAD: marking does not change what opens.
    expect(unlockWebIdentity(verified, prf(1), CREDENTIAL).publicKey).toBe(identity.publicKey);
  });
});
