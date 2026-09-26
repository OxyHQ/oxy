/**
 * Linking Commons to a passkey account (ADR 0029 D3): what each device sends.
 * `makeRequest` is stubbed; the proof Commons signs is verified for real.
 */
import { buildIdentityProofMessage } from '@oxy.so/contracts';
import { deriveSecp256k1PublicKey } from '@oxy.so/protocol/secp256k1';
import { verifySignature } from '@oxy.so/protocol';
import { OxyServices } from '../../OxyServices';
import { KeyManager } from '../../crypto/keyManager';
import { deriveIdentityLinkCode } from '../../crypto/identityLink';

const LINK_ID = 'ab'.repeat(16);
const CHALLENGE = 'cd'.repeat(32);
const PRIVATE_KEY = '3a'.repeat(32);
const PUBLIC_KEY = deriveSecp256k1PublicKey(PRIVATE_KEY).toLowerCase();
const STATE = {
  status: 'pending',
  userId: 'user-1',
  username: 'ada',
  publicKey: null,
  audience: 'oxy-api/identity',
  expiresAt: 1_900_000_000_000,
};

describe('linking Commons', () => {
  let oxy: OxyServices;
  let makeRequest: jest.SpyInstance;

  beforeEach(() => {
    oxy = new OxyServices({ baseURL: 'http://test.invalid' });
    makeRequest = jest.spyOn(oxy, 'makeRequest');
  });
  afterEach(() => jest.restoreAllMocks());

  it('Commons signs the link proof for the account the request names, with its own key', async () => {
    jest.spyOn(KeyManager, 'getPrivateKey').mockResolvedValue(PRIVATE_KEY);
    jest.spyOn(KeyManager, 'getPublicKey').mockResolvedValue(PUBLIC_KEY.toUpperCase());
    makeRequest.mockResolvedValueOnce(STATE).mockResolvedValueOnce({ status: 'signed' });

    const result = await oxy.signIdentityLink(LINK_ID, CHALLENGE);

    expect(result).toEqual({ publicKey: PUBLIC_KEY, code: deriveIdentityLinkCode(LINK_ID, PUBLIC_KEY), username: 'ada' });
    expect(makeRequest).toHaveBeenNthCalledWith(1, 'GET', `/identity/link/${LINK_ID}`, undefined, { cache: false, skipAuth: true });
    const [, path, body, options] = makeRequest.mock.calls[1] as [string, string, { publicKey: string; proof: { signature: string; challenge: string; expiresAt: number } }, unknown];
    expect(path).toBe(`/identity/link/${LINK_ID}/proof`);
    expect(options).toEqual({ cache: false, skipAuth: true });
    expect(body.publicKey).toBe(PUBLIC_KEY);
    expect(body.proof).toMatchObject({ v: 2, challenge: CHALLENGE, expiresAt: STATE.expiresAt });
    const message = buildIdentityProofMessage({
      action: 'link_identity',
      subject: 'user-1',
      actor: 'user-1',
      rootPublicKey: PUBLIC_KEY,
      payloadDigest: null,
      expectedRevision: null,
      audience: STATE.audience,
      challenge: CHALLENGE,
      expiresAt: STATE.expiresAt,
    });
    expect(await verifySignature(message, body.proof.signature, PUBLIC_KEY)).toBe(true);
  });

  it('refuses to sign without an identity on this device', async () => {
    jest.spyOn(KeyManager, 'getPrivateKey').mockResolvedValue(null);
    jest.spyOn(KeyManager, 'getPublicKey').mockResolvedValue(null);
    await expect(oxy.signIdentityLink(LINK_ID, CHALLENGE)).rejects.toThrow('No identity');
    expect(makeRequest).not.toHaveBeenCalled();
  });

  it('the web opens, asks for the assertion options, completes and cancels', async () => {
    makeRequest
      .mockResolvedValueOnce({ linkId: LINK_ID, challenge: CHALLENGE, expiresAt: 1, qrPayload: `oxycommons://link?id=${LINK_ID}&c=${CHALLENGE}` })
      .mockResolvedValueOnce({ challenge: 'x' })
      .mockResolvedValueOnce({ success: true })
      .mockResolvedValueOnce({});

    await expect(oxy.createIdentityLink()).resolves.toMatchObject({ linkId: LINK_ID });
    await oxy.getIdentityLinkAssertionOptions(LINK_ID, CHALLENGE);
    await oxy.completeIdentityLink(LINK_ID, { id: 'cred' });
    await oxy.cancelIdentityLink(LINK_ID);

    expect(makeRequest.mock.calls.map(([method, path, body]) => [method, path, body])).toEqual([
      ['POST', '/identity/link', undefined],
      ['POST', `/identity/link/${LINK_ID}/options`, { challenge: CHALLENGE }],
      ['POST', `/identity/link/${LINK_ID}/complete`, { assertion: { id: 'cred' } }],
      ['DELETE', `/identity/link/${LINK_ID}`, undefined],
    ]);
  });
});
