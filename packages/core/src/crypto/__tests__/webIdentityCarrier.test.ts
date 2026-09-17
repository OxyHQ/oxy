/**
 * Web identity carrier — the envelope must carry EXACTLY the Commons identity,
 * open only with a registered passkey's PRF output, and refuse (with a reason a
 * UI can act on) anything else.
 */

import { webIdentityEnvelopeSchema } from '@oxy.so/contracts';
import { RecoveryPhraseService } from '../recoveryPhrase';
import {
  addWrap,
  deriveIdentityFromMnemonic,
  generateWebIdentity,
  openWebIdentity,
  removeWrap,
  sealWebIdentity,
  unlockWebIdentity,
  unwrapDataKey,
  WEB_IDENTITY_PRF_INPUT,
  WebIdentityUnlockError,
  wipeBytes,
} from '../webIdentityCarrier';

/** The BIP-39 reference mnemonic (all-zero entropy). */
const MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

const prf = (fill: number): Uint8Array => new Uint8Array(32).fill(fill);
const CREDENTIAL_A = 'credential-aaaaaaaaaaaaaaaa';
const CREDENTIAL_B = 'credential-bbbbbbbbbbbbbbbb';

const failureOf = (fn: () => unknown): string | undefined => {
  try {
    fn();
  } catch (error) {
    return error instanceof WebIdentityUnlockError ? error.failure : 'other';
  }
  return undefined;
};

describe('the identity itself', () => {
  it('derives the SAME key Commons derives from a phrase — one identity, not a second kind', async () => {
    const identity = deriveIdentityFromMnemonic(MNEMONIC);

    expect(identity.privateKey).toBe(await RecoveryPhraseService.derivePrivateKeyFromPhrase(MNEMONIC));
    expect(identity.publicKey).toBe(await RecoveryPhraseService.derivePublicKeyFromPhrase(MNEMONIC));
  });

  it('normalizes case and spacing the way a person types a phrase', () => {
    const typed = `  ${MNEMONIC.toUpperCase().split(' ').join('   ')} `;
    expect(deriveIdentityFromMnemonic(typed).publicKey).toBe(deriveIdentityFromMnemonic(MNEMONIC).publicKey);
  });

  it('rejects an invalid phrase', () => {
    expect(() => deriveIdentityFromMnemonic('abandon abandon abandon')).toThrow('Invalid recovery phrase');
  });

  it('generates a fresh 12-word identity in canonical public-key form', () => {
    const identity = generateWebIdentity();
    expect(identity.mnemonic.split(' ')).toHaveLength(12);
    expect(identity.publicKey).toMatch(/^04[0-9a-f]{128}$/);
    expect(generateWebIdentity().publicKey).not.toBe(identity.publicKey);
  });

  it('uses a fixed 32-byte PRF input', () => {
    expect(WEB_IDENTITY_PRF_INPUT).toHaveLength(32);
  });
});

describe('sealing and unlocking', () => {
  it('round-trips: the passkey that sealed it opens it into the same identity', () => {
    const identity = deriveIdentityFromMnemonic(MNEMONIC);
    const { envelope, dataKey } = sealWebIdentity(identity, { prfOutput: prf(7), credentialId: CREDENTIAL_A, rpId: 'oxy.so' });
    wipeBytes(dataKey);

    // The stored shape is exactly the published contract.
    expect(webIdentityEnvelopeSchema.parse(envelope)).toEqual(envelope);
    // Nothing identifying the secret is visible in the envelope.
    expect(JSON.stringify(envelope)).not.toContain(identity.privateKey);

    const opened = unlockWebIdentity(envelope, prf(7), CREDENTIAL_A);
    expect(opened).toEqual(identity);
  });

  it('refuses to seal a phrase under a public key it does not belong to', () => {
    const other = generateWebIdentity();
    expect(() =>
      sealWebIdentity({ ...deriveIdentityFromMnemonic(MNEMONIC), publicKey: other.publicKey }, { prfOutput: prf(1), credentialId: CREDENTIAL_A, rpId: 'oxy.so' }),
    ).toThrow('does not belong');
  });

  it('reports an unregistered passkey as unknown-credential', () => {
    const { envelope } = sealWebIdentity(deriveIdentityFromMnemonic(MNEMONIC), { prfOutput: prf(7), credentialId: CREDENTIAL_A, rpId: 'oxy.so' });
    expect(failureOf(() => unlockWebIdentity(envelope, prf(7), CREDENTIAL_B))).toBe('unknown-credential');
  });

  it('reports a registered passkey returning a different PRF value as prf-mismatch (recoverable)', () => {
    const { envelope } = sealWebIdentity(deriveIdentityFromMnemonic(MNEMONIC), { prfOutput: prf(7), credentialId: CREDENTIAL_A, rpId: 'oxy.so' });
    expect(failureOf(() => unlockWebIdentity(envelope, prf(8), CREDENTIAL_A))).toBe('prf-mismatch');
  });

  it('refuses a wrap transplanted onto another credential id', () => {
    const { envelope } = sealWebIdentity(deriveIdentityFromMnemonic(MNEMONIC), { prfOutput: prf(7), credentialId: CREDENTIAL_A, rpId: 'oxy.so' });
    const transplanted = { ...envelope, wraps: [{ ...envelope.wraps[0], credentialId: CREDENTIAL_B }] };
    // The associated data binds each wrap to its credential.
    expect(failureOf(() => unlockWebIdentity(transplanted, prf(7), CREDENTIAL_B))).toBe('prf-mismatch');
  });

  it('refuses an envelope re-labelled with another identity public key', () => {
    const { envelope, dataKey } = sealWebIdentity(deriveIdentityFromMnemonic(MNEMONIC), {
      prfOutput: prf(7),
      credentialId: CREDENTIAL_A,
      rpId: 'oxy.so',
    });
    const relabelled = { ...envelope, publicKey: generateWebIdentity().publicKey };
    expect(failureOf(() => openWebIdentity(relabelled, dataKey))).toBe('corrupt');
  });

  it('treats a tampered sealed secret as corrupt, never as a different identity', () => {
    const { envelope, dataKey } = sealWebIdentity(deriveIdentityFromMnemonic(MNEMONIC), {
      prfOutput: prf(7),
      credentialId: CREDENTIAL_A,
      rpId: 'oxy.so',
    });
    const flipped = envelope.sealedSecret.startsWith('0') ? `1${envelope.sealedSecret.slice(1)}` : `0${envelope.sealedSecret.slice(1)}`;
    expect(failureOf(() => openWebIdentity({ ...envelope, sealedSecret: flipped }, dataKey))).toBe('corrupt');
  });
});

describe('more than one passkey', () => {
  it('opens with every registered passkey and keeps a single sealed identity', () => {
    const identity = deriveIdentityFromMnemonic(MNEMONIC);
    const sealed = sealWebIdentity(identity, { prfOutput: prf(1), credentialId: CREDENTIAL_A, rpId: 'oxy.so' });
    const withTwo = addWrap(sealed.envelope, sealed.dataKey, { prfOutput: prf(2), credentialId: CREDENTIAL_B, rpId: 'oxy.so' });

    expect(withTwo.wraps.map((wrap) => wrap.credentialId)).toEqual([CREDENTIAL_A, CREDENTIAL_B]);
    expect(withTwo.sealedSecret).toBe(sealed.envelope.sealedSecret);
    expect(unlockWebIdentity(withTwo, prf(1), CREDENTIAL_A).publicKey).toBe(identity.publicKey);
    expect(unlockWebIdentity(withTwo, prf(2), CREDENTIAL_B).publicKey).toBe(identity.publicKey);
  });

  it('replaces a passkey’s wrap instead of duplicating it', () => {
    const sealed = sealWebIdentity(deriveIdentityFromMnemonic(MNEMONIC), { prfOutput: prf(1), credentialId: CREDENTIAL_A, rpId: 'oxy.so' });
    const rewrapped = addWrap(sealed.envelope, sealed.dataKey, { prfOutput: prf(9), credentialId: CREDENTIAL_A, rpId: 'oxy.so' });
    expect(rewrapped.wraps).toHaveLength(1);
    expect(failureOf(() => unlockWebIdentity(rewrapped, prf(1), CREDENTIAL_A))).toBe('prf-mismatch');
    expect(unlockWebIdentity(rewrapped, prf(9), CREDENTIAL_A).mnemonic).toBe(MNEMONIC);
  });

  it('will not add a wrap with a data key from a different envelope', () => {
    const first = sealWebIdentity(deriveIdentityFromMnemonic(MNEMONIC), { prfOutput: prf(1), credentialId: CREDENTIAL_A, rpId: 'oxy.so' });
    const second = sealWebIdentity(generateWebIdentity(), { prfOutput: prf(1), credentialId: CREDENTIAL_A, rpId: 'oxy.so' });
    expect(() => addWrap(first.envelope, second.dataKey, { prfOutput: prf(2), credentialId: CREDENTIAL_B, rpId: 'oxy.so' })).toThrow();
  });

  it('removes a passkey, but never the last one', () => {
    const sealed = sealWebIdentity(deriveIdentityFromMnemonic(MNEMONIC), { prfOutput: prf(1), credentialId: CREDENTIAL_A, rpId: 'oxy.so' });
    const withTwo = addWrap(sealed.envelope, sealed.dataKey, { prfOutput: prf(2), credentialId: CREDENTIAL_B, rpId: 'oxy.so' });
    const withOne = removeWrap(withTwo, CREDENTIAL_A);

    expect(withOne.wraps.map((wrap) => wrap.credentialId)).toEqual([CREDENTIAL_B]);
    expect(() => removeWrap(withOne, CREDENTIAL_B)).toThrow('at least one passkey');
  });

  it('keeps the data key usable only until it is wiped', () => {
    const sealed = sealWebIdentity(deriveIdentityFromMnemonic(MNEMONIC), { prfOutput: prf(1), credentialId: CREDENTIAL_A, rpId: 'oxy.so' });
    const recovered = unwrapDataKey(sealed.envelope, prf(1), CREDENTIAL_A);
    wipeBytes(recovered);
    expect(failureOf(() => openWebIdentity(sealed.envelope, recovered))).toBe('corrupt');
  });
});
