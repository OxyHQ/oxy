import { OxyServices } from '../../OxyServices';
import { signInAgentAccount } from '../agentAccount';
import { deriveSecp256k1PublicKey, normalizeSecp256k1PublicKey } from '@oxy.so/protocol/secp256k1';
const publicKey = deriveSecp256k1PublicKey('1'.padStart(64, '0'), true);
const canonicalKey = normalizeSecp256k1PublicKey(publicKey);
const claims = { version: 1 as const, action: 'agent_signin' as const, audience: 'oxy-api/agent' as const,
  accountId: 'bot', actorId: 'bot', authMethodId: 'method', publicKey: canonicalKey,
  payloadDigest: 'a'.repeat(64), challenge: 'b'.repeat(64), expiresAt: Date.now() + 60_000 };
afterEach(() => jest.restoreAllMocks());
it('uses an injected signer and the ordinary user session endpoint, without passing a private key', async () => {
  const client = new OxyServices({ baseURL: 'https://fixture.invalid' });
  const response = { sessionId: 's', deviceId: 'd', accessToken: 'token', expiresAt: '2030-01-01T00:00:00.000Z', user: { id: 'bot' } };
  const request = jest.spyOn(client, 'request').mockResolvedValueOnce(claims).mockResolvedValueOnce(response);
  const signMessage = jest.fn(async () => 'c'.repeat(128));
  expect(await signInAgentAccount({ client, accountId: 'bot', signer: { publicKey, signMessage } })).toEqual(response);
  expect(JSON.parse(signMessage.mock.calls[0][0] as string)).toMatchObject({ accountId: 'bot', actorId: 'bot', role: 'credential', action: 'agent_signin' });
  expect(request.mock.calls[1][2]).toEqual(expect.objectContaining({ publicKey: canonicalKey, challenge: claims.challenge, signature: 'c'.repeat(128) }));
});
it.each(['accountId', 'actorId', 'action', 'publicKey', 'expiresAt'] as const)('does not ask the signer to sign a mismatched %s', async (field) => {
  const client = new OxyServices({ baseURL: 'https://fixture.invalid' });
  jest.spyOn(client, 'request').mockResolvedValue({ ...claims, [field]: field === 'action' ? 'agent_enroll' : field === 'expiresAt' ? 0 : field === 'publicKey' ? deriveSecp256k1PublicKey('2'.padStart(64, '0')) : 'foreign' });
  const signMessage = jest.fn(async () => 'c'.repeat(128));
  await expect(signInAgentAccount({ client, accountId: 'bot', signer: { publicKey, signMessage } })).rejects.toThrow();
  expect(signMessage).not.toHaveBeenCalled();
});

it('rejects an invalid signer point before requesting a challenge or signature', async () => {
  const client = new OxyServices({ baseURL: 'https://fixture.invalid' });
  const request = jest.spyOn(client, 'request').mockRejectedValue(new Error('Unexpected fixture request')); const signMessage = jest.fn(async () => 'unused');
  await expect(signInAgentAccount({ client, accountId: 'bot', signer: { publicKey: 'invalid', signMessage } })).rejects.toThrow();
  expect(request).not.toHaveBeenCalled(); expect(signMessage).not.toHaveBeenCalled();
});
it('does not sign a challenge with missing method provenance', async () => {
  const client = new OxyServices({ baseURL: 'https://fixture.invalid' });
  jest.spyOn(client, 'request').mockResolvedValue({ ...claims, authMethodId: '' });
  const signMessage = jest.fn(async () => 'unused');
  await expect(signInAgentAccount({ client, accountId: 'bot', signer: { publicKey, signMessage } })).rejects.toThrow();
  expect(signMessage).not.toHaveBeenCalled();
});
