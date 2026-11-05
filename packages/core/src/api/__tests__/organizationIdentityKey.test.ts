/**
 * An organization's identity key (ADR 0061): what Commons sends. `request` is
 * stubbed; every signature is verified for real against the claims the API
 * checks.
 */
import { buildIdentityProofMessage, organizationKeyProofClaims } from '@oxy.so/contracts';
import { deriveSecp256k1PublicKey } from '@oxy.so/protocol/secp256k1';
import { verifySignature } from '@oxy.so/protocol';
import { OxyServices } from '../../OxyServices';
import { KeyManager } from '../../crypto/keyManager';

function pair(seed: string) {
  const privateKey = seed.repeat(32);
  return { privateKey, publicKey: deriveSecp256k1PublicKey(privateKey).toLowerCase() };
}
const ROOT = pair('3a');
const ORG_KEY = pair('4b');
const PREVIOUS = pair('5c');
const ORG = 'org-1';

function challengeFor(operation: 'create' | 'replace', previousPublicKey: string | null) {
  return {
    operation,
    action: operation === 'create' ? 'organization_key_create' : 'organization_key_replace',
    accountId: ORG,
    actorId: 'user-1',
    actorPublicKey: ROOT.publicKey,
    publicKey: ORG_KEY.publicKey,
    previousPublicKey,
    payloadDigest: 'ef'.repeat(32),
    audience: 'oxy-api/identity',
    challenge: 'cd'.repeat(32),
    expiresAt: 1_900_000_000_000,
  } as const;
}
const STATE = { accountId: ORG, publicKey: ORG_KEY.publicKey, keys: [] };

describe('oxy.accounts.identityKey', () => {
  let oxy: OxyServices;
  let request: jest.SpyInstance;

  beforeEach(() => {
    oxy = new OxyServices({ baseURL: 'http://test.invalid' });
    request = jest.spyOn(oxy, 'request');
    jest.spyOn(KeyManager, 'getPrivateKey').mockResolvedValue(ROOT.privateKey);
    jest.spyOn(KeyManager, 'getPublicKey').mockResolvedValue(ROOT.publicKey.toUpperCase());
  });
  afterEach(() => jest.restoreAllMocks());

  it('reads the key without caching it', async () => {
    request.mockResolvedValueOnce({ accountId: ORG, publicKey: null, keys: [] });
    await expect(oxy.accounts.identityKey.get(ORG)).resolves.toEqual({
      accountId: ORG,
      publicKey: null,
      keys: [],
    });
    expect(request).toHaveBeenCalledWith('GET', `/accounts/${ORG}/identity-key`, undefined, {
      cache: false,
    });
  });

  it('creates: the device root and the new key each sign the same claims', async () => {
    const challenge = challengeFor('create', null);
    request.mockResolvedValueOnce(challenge).mockResolvedValueOnce(STATE);
    await expect(
      oxy.accounts.identityKey.link(ORG, { operation: 'create', key: ORG_KEY }),
    ).resolves.toEqual(STATE);
    expect(request).toHaveBeenNthCalledWith(
      1,
      'POST',
      `/accounts/${ORG}/identity-key/challenge`,
      { operation: 'create', publicKey: ORG_KEY.publicKey },
      { cache: false },
    );
    const [, path, body] = request.mock.calls[1] as [
      string,
      string,
      Record<string, string | number>,
    ];
    expect(path).toBe(`/accounts/${ORG}/identity-key`);
    expect(body).toMatchObject({
      operation: 'create',
      publicKey: ORG_KEY.publicKey,
      challenge: challenge.challenge,
      expiresAt: challenge.expiresAt,
    });
    expect(body).not.toHaveProperty('previousKeySignature');
    const message = (signer: string) =>
      buildIdentityProofMessage(organizationKeyProofClaims(challenge, signer));
    expect(
      await verifySignature(message(ROOT.publicKey), String(body.actorSignature), ROOT.publicKey),
    ).toBe(true);
    expect(
      await verifySignature(
        message(ORG_KEY.publicKey),
        String(body.keySignature),
        ORG_KEY.publicKey,
      ),
    ).toBe(true);
  });

  it('replaces with the current key when the device holds it', async () => {
    const challenge = challengeFor('replace', PREVIOUS.publicKey);
    request.mockResolvedValueOnce(challenge).mockResolvedValueOnce(STATE);
    await oxy.accounts.identityKey.link(ORG, {
      operation: 'replace',
      key: ORG_KEY,
      previousKey: PREVIOUS,
    });
    const body = request.mock.calls[1][2] as Record<string, string>;
    expect(
      await verifySignature(
        buildIdentityProofMessage(organizationKeyProofClaims(challenge, PREVIOUS.publicKey)),
        body.previousKeySignature,
        PREVIOUS.publicKey,
      ),
    ).toBe(true);
  });

  it("refuses when the API names a different root than this device's", async () => {
    request.mockResolvedValueOnce({
      ...challengeFor('create', null),
      actorPublicKey: PREVIOUS.publicKey,
    });
    await expect(
      oxy.accounts.identityKey.link(ORG, { operation: 'create', key: ORG_KEY }),
    ).rejects.toThrow("not the signed-in account's");
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('refuses without an identity on this device, before asking the API', async () => {
    jest.spyOn(KeyManager, 'getPrivateKey').mockResolvedValue(null);
    await expect(
      oxy.accounts.identityKey.link(ORG, { operation: 'create', key: ORG_KEY }),
    ).rejects.toThrow('No identity');
    expect(request).not.toHaveBeenCalled();
  });
});
