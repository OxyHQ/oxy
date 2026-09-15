/**
 * Web identity carrier — the envelope must carry EXACTLY the Commons identity,
 * open only with a registered passkey's PRF output, and refuse (with a reason a
 * UI can act on) anything else.
 */

import { webIdentityEnvelopeSchema } from '@oxy.so/contracts';
import { verifySignature } from '@oxy.so/protocol';
import { RecoveryPhraseService } from '../recoveryPhrase';
import {
  addWrap,
  buildIdentityActionMessage,
  deriveIdentityFromMnemonic,
  deriveTransferSas,
  generateWebIdentity,
  openWebIdentity,
  removeWrap,
  sealWebIdentity,
  signIdentityAction,
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
    const { envelope, dataKey } = sealWebIdentity(identity, { prfOutput: prf(7), credentialId: CREDENTIAL_A });
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
      sealWebIdentity({ mnemonic: MNEMONIC, publicKey: other.publicKey }, { prfOutput: prf(1), credentialId: CREDENTIAL_A }),
    ).toThrow('does not belong');
  });

  it('reports an unregistered passkey as unknown-credential', () => {
    const { envelope } = sealWebIdentity(deriveIdentityFromMnemonic(MNEMONIC), { prfOutput: prf(7), credentialId: CREDENTIAL_A });
    expect(failureOf(() => unlockWebIdentity(envelope, prf(7), CREDENTIAL_B))).toBe('unknown-credential');
  });

  it('reports a registered passkey returning a different PRF value as prf-mismatch (recoverable)', () => {
    const { envelope } = sealWebIdentity(deriveIdentityFromMnemonic(MNEMONIC), { prfOutput: prf(7), credentialId: CREDENTIAL_A });
    expect(failureOf(() => unlockWebIdentity(envelope, prf(8), CREDENTIAL_A))).toBe('prf-mismatch');
  });

  it('refuses a wrap transplanted onto another credential id', () => {
    const { envelope } = sealWebIdentity(deriveIdentityFromMnemonic(MNEMONIC), { prfOutput: prf(7), credentialId: CREDENTIAL_A });
    const transplanted = { ...envelope, wraps: [{ ...envelope.wraps[0], credentialId: CREDENTIAL_B }] };
    // The associated data binds each wrap to its credential.
    expect(failureOf(() => unlockWebIdentity(transplanted, prf(7), CREDENTIAL_B))).toBe('prf-mismatch');
  });

  it('refuses an envelope re-labelled with another identity public key', () => {
    const { envelope, dataKey } = sealWebIdentity(deriveIdentityFromMnemonic(MNEMONIC), {
      prfOutput: prf(7),
      credentialId: CREDENTIAL_A,
    });
    const relabelled = { ...envelope, publicKey: generateWebIdentity().publicKey };
    expect(failureOf(() => openWebIdentity(relabelled, dataKey))).toBe('corrupt');
  });

  it('treats tampered sealed entropy as corrupt, never as a different identity', () => {
    const { envelope, dataKey } = sealWebIdentity(deriveIdentityFromMnemonic(MNEMONIC), {
      prfOutput: prf(7),
      credentialId: CREDENTIAL_A,
    });
    const flipped = envelope.sealedEntropy.startsWith('0') ? `1${envelope.sealedEntropy.slice(1)}` : `0${envelope.sealedEntropy.slice(1)}`;
    expect(failureOf(() => openWebIdentity({ ...envelope, sealedEntropy: flipped }, dataKey))).toBe('corrupt');
  });
});

describe('more than one passkey', () => {
  it('opens with every registered passkey and keeps a single sealed identity', () => {
    const identity = deriveIdentityFromMnemonic(MNEMONIC);
    const sealed = sealWebIdentity(identity, { prfOutput: prf(1), credentialId: CREDENTIAL_A });
    const withTwo = addWrap(sealed.envelope, sealed.dataKey, prf(2), CREDENTIAL_B);

    expect(withTwo.wraps.map((wrap) => wrap.credentialId)).toEqual([CREDENTIAL_A, CREDENTIAL_B]);
    expect(withTwo.sealedEntropy).toBe(sealed.envelope.sealedEntropy);
    expect(unlockWebIdentity(withTwo, prf(1), CREDENTIAL_A).publicKey).toBe(identity.publicKey);
    expect(unlockWebIdentity(withTwo, prf(2), CREDENTIAL_B).publicKey).toBe(identity.publicKey);
  });

  it('replaces a passkey’s wrap instead of duplicating it', () => {
    const sealed = sealWebIdentity(deriveIdentityFromMnemonic(MNEMONIC), { prfOutput: prf(1), credentialId: CREDENTIAL_A });
    const rewrapped = addWrap(sealed.envelope, sealed.dataKey, prf(9), CREDENTIAL_A);
    expect(rewrapped.wraps).toHaveLength(1);
    expect(failureOf(() => unlockWebIdentity(rewrapped, prf(1), CREDENTIAL_A))).toBe('prf-mismatch');
    expect(unlockWebIdentity(rewrapped, prf(9), CREDENTIAL_A).mnemonic).toBe(MNEMONIC);
  });

  it('will not add a wrap with a data key from a different envelope', () => {
    const first = sealWebIdentity(deriveIdentityFromMnemonic(MNEMONIC), { prfOutput: prf(1), credentialId: CREDENTIAL_A });
    const second = sealWebIdentity(generateWebIdentity(), { prfOutput: prf(1), credentialId: CREDENTIAL_A });
    expect(() => addWrap(first.envelope, second.dataKey, prf(2), CREDENTIAL_B)).toThrow();
  });

  it('removes a passkey, but never the last one', () => {
    const sealed = sealWebIdentity(deriveIdentityFromMnemonic(MNEMONIC), { prfOutput: prf(1), credentialId: CREDENTIAL_A });
    const withTwo = addWrap(sealed.envelope, sealed.dataKey, prf(2), CREDENTIAL_B);
    const withOne = removeWrap(withTwo, CREDENTIAL_A);

    expect(withOne.wraps.map((wrap) => wrap.credentialId)).toEqual([CREDENTIAL_B]);
    expect(() => removeWrap(withOne, CREDENTIAL_B)).toThrow('at least one passkey');
  });

  it('keeps the data key usable only until it is wiped', () => {
    const sealed = sealWebIdentity(deriveIdentityFromMnemonic(MNEMONIC), { prfOutput: prf(1), credentialId: CREDENTIAL_A });
    const recovered = unwrapDataKey(sealed.envelope, prf(1), CREDENTIAL_A);
    wipeBytes(recovered);
    expect(failureOf(() => openWebIdentity(sealed.envelope, recovered))).toBe('corrupt');
  });
});

describe('identity actions', () => {
  it('signs the exact message the API reconstructs, verifiable with the public key', async () => {
    const identity = deriveIdentityFromMnemonic(MNEMONIC);
    const { signature, timestamp } = await signIdentityAction(identity, 'link_identity', 'user-1', 1_700_000_000_000);

    const message = buildIdentityActionMessage('link_identity', 'user-1', timestamp);
    expect(message).toBe('{"action":"link_identity","userId":"user-1","timestamp":1700000000000}');
    expect(await verifySignature(message, signature, identity.publicKey)).toBe(true);
    expect(await verifySignature(buildIdentityActionMessage('web_envelope_delete', 'user-1', timestamp), signature, identity.publicKey)).toBe(false);
  });
});

describe('transfer short authentication string', () => {
  const base = {
    pairingId: 'ab'.repeat(16),
    initiatorEphemeralPublicKey: generateWebIdentity().publicKey,
    responderEphemeralPublicKey: generateWebIdentity().publicKey,
  };

  it('is six digits and identical on both sides', () => {
    const sas = deriveTransferSas(base);
    expect(sas).toMatch(/^\d{6}$/);
    expect(deriveTransferSas({ ...base, pairingId: base.pairingId.toUpperCase() })).toBe(sas);
  });

  it('changes when the relay substitutes either ephemeral key, or swaps the roles', () => {
    const sas = deriveTransferSas(base);
    const attacker = generateWebIdentity().publicKey;
    expect(deriveTransferSas({ ...base, responderEphemeralPublicKey: attacker })).not.toBe(sas);
    expect(deriveTransferSas({ ...base, initiatorEphemeralPublicKey: attacker })).not.toBe(sas);
    expect(
      deriveTransferSas({
        ...base,
        initiatorEphemeralPublicKey: base.responderEphemeralPublicKey,
        responderEphemeralPublicKey: base.initiatorEphemeralPublicKey,
      }),
    ).not.toBe(sas);
  });
});
