/**
 * App Attest verification (ADR 0045) on real certificates, CBOR and ECDSA, with
 * a test root in place of Apple's. Each step of Apple's procedure has a case
 * that breaks exactly it.
 */

import { generateKeyPairSync, X509Certificate } from 'node:crypto';
import {
  APPLE_APP_ATTESTATION_ROOT_CA_PEM,
  appAttestAllowedEnvironments,
} from '../../config/appAttest';
import { createTestAppAttestWorld } from '../__fixtures__/appAttestFixtures';
import {
  AppAttestVerificationError,
  appAttestClientDataHash,
  verifyAppAttestAssertion,
  verifyAppAttestAttestation,
} from '../appAttest';

const APP_ID = 'ABCDE12345.earth.mention.app';
const CLIENT_DATA = 'r'.repeat(43);
const NOW = new Date();
const world = createTestAppAttestWorld(NOW);

function attestation(
  device = world.device(APP_ID),
  overrides: Partial<Parameters<typeof verifyAppAttestAttestation>[0]> = {},
  attestOptions: Parameters<ReturnType<typeof world.device>['attest']>[1] = {},
) {
  return verifyAppAttestAttestation({
    attestation: Buffer.from(device.attest(CLIENT_DATA, attestOptions), 'base64'),
    clientDataHash: appAttestClientDataHash(CLIENT_DATA),
    keyId: device.keyId,
    appId: APP_ID,
    rootCertificate: world.root,
    allowedEnvironments: ['production'],
    now: NOW,
    ...overrides,
  });
}

function reason(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    if (error instanceof AppAttestVerificationError) return error.reason;
    throw error;
  }
  return 'accepted';
}

describe('verifyAppAttestAttestation', () => {
  it('accepts a key attested for this app, challenge and environment', () => {
    const device = world.device(APP_ID);
    const attested = attestation(device);
    expect(attested.environment).toBe('production');
    expect(attested.signCount).toBe(0);
    expect(
      attested.publicKeySpki.equals(
        device.publicKey.export({ type: 'spki', format: 'der' }) as Buffer,
      ),
    ).toBe(true);
  });

  it('refuses a chain that does not end at the root', () => {
    expect(reason(() => attestation(undefined, {}, { rogueIntermediate: true }))).toBe(
      'certificate_chain',
    );
    expect(
      reason(() =>
        attestation(undefined, {
          rootCertificate: new X509Certificate(APPLE_APP_ATTESTATION_ROOT_CA_PEM),
        }),
      ),
    ).toBe('certificate_chain');
    expect(
      reason(() => attestation(undefined, { now: new Date(NOW.getTime() + 2 * 365 * 86_400_000) })),
    ).toBe('certificate_chain');
  });

  it('refuses another challenge', () => {
    expect(
      reason(() =>
        attestation(undefined, { clientDataHash: appAttestClientDataHash('another-challenge') }),
      ),
    ).toBe('nonce_mismatch');
    expect(reason(() => attestation(undefined, {}, { nonce: Buffer.alloc(32, 7) }))).toBe(
      'nonce_mismatch',
    );
  });

  it('refuses another key id, another app and a used key', () => {
    const other = world.device(APP_ID);
    expect(reason(() => attestation(undefined, { keyId: other.keyId }))).toBe('key_id_mismatch');
    expect(reason(() => attestation(undefined, {}, { credentialId: Buffer.alloc(32, 1) }))).toBe(
      'key_id_mismatch',
    );
    expect(reason(() => attestation(undefined, { appId: 'ABCDE12345.earth.other' }))).toBe(
      'rp_id_mismatch',
    );
    expect(
      reason(() => attestation(undefined, {}, { appId: 'ZZZZZ99999.earth.mention.app' })),
    ).toBe('rp_id_mismatch');
    expect(reason(() => attestation(undefined, {}, { counter: 1 }))).toBe('counter');
  });

  it('refuses a development key unless development is allowed', () => {
    expect(reason(() => attestation(undefined, {}, { environment: 'development' }))).toBe(
      'environment',
    );
    expect(
      attestation(
        undefined,
        { allowedEnvironments: ['production', 'development'] },
        { environment: 'development' },
      ).environment,
    ).toBe('development');
  });

  it('refuses something that is not an attestation', () => {
    expect(reason(() => attestation(undefined, { attestation: Buffer.from('not cbor') }))).toBe(
      'malformed',
    );
  });
});

describe('verifyAppAttestAssertion', () => {
  const device = world.device(APP_ID);
  const publicKeySpki = attestation(device).publicKeySpki;
  const verify = (
    assertion: string,
    overrides: Partial<Parameters<typeof verifyAppAttestAssertion>[0]> = {},
  ) =>
    verifyAppAttestAssertion({
      assertion: Buffer.from(assertion, 'base64'),
      clientDataHash: appAttestClientDataHash(CLIENT_DATA),
      publicKeySpki,
      appId: APP_ID,
      previousSignCount: 0,
      ...overrides,
    });

  it('accepts an assertion over this challenge with a counter that moved forward', () => {
    expect(verify(device.assert(CLIENT_DATA, 1))).toEqual({ signCount: 1 });
  });

  it('refuses a counter that did not move forward', () => {
    expect(reason(() => verify(device.assert(CLIENT_DATA, 3), { previousSignCount: 3 }))).toBe(
      'counter',
    );
    expect(reason(() => verify(device.assert(CLIENT_DATA, 2), { previousSignCount: 3 }))).toBe(
      'counter',
    );
  });

  it('refuses another challenge, another key and another app', () => {
    expect(
      reason(() =>
        verify(device.assert(CLIENT_DATA, 1), { clientDataHash: appAttestClientDataHash('x') }),
      ),
    ).toBe('signature');
    expect(
      reason(() =>
        verify(
          device.assert(CLIENT_DATA, 1, {
            key: generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey,
          }),
        ),
      ),
    ).toBe('signature');
    expect(
      reason(() => verify(device.assert(CLIENT_DATA, 1, { appId: 'ABCDE12345.earth.other' }))),
    ).toBe('rp_id_mismatch');
  });
});

describe('appAttestAllowedEnvironments', () => {
  const previous = process.env.APP_ATTEST_ENVIRONMENTS;
  afterEach(() => {
    if (previous === undefined) delete process.env.APP_ATTEST_ENVIRONMENTS;
    else process.env.APP_ATTEST_ENVIRONMENTS = previous;
  });

  it('is production unless configured, and refuses a name it does not know', () => {
    delete process.env.APP_ATTEST_ENVIRONMENTS;
    expect(appAttestAllowedEnvironments()).toEqual(['production']);
    process.env.APP_ATTEST_ENVIRONMENTS = 'production, development';
    expect(appAttestAllowedEnvironments()).toEqual(['production', 'development']);
    process.env.APP_ATTEST_ENVIRONMENTS = 'staging';
    expect(() => appAttestAllowedEnvironments()).toThrow('APP_ATTEST_ENVIRONMENTS');
  });

  it('pins Apple’s App Attestation Root CA', () => {
    const root = new X509Certificate(APPLE_APP_ATTESTATION_ROOT_CA_PEM);
    expect(root.subject).toContain('Apple App Attestation Root CA');
    expect(root.fingerprint256).toBe(
      '1C:B9:82:3B:A2:8B:A6:AD:2D:33:A0:06:94:1D:E2:AE:4F:51:3E:F1:D4:E8:31:B9:F7:E0:FA:7B:62:42:C9:32',
    );
  });
});
