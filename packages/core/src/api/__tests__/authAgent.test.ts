import { buildAgentProofMessage, type AgentProofClaims } from '@oxy.so/contracts';
import { OxyServices } from '../../OxyServices';

const claims: AgentProofClaims = { version: 1, audience: 'oxy-api/agent', action: 'agent_signin',
  accountId: 'bot', actorId: 'bot', authMethodId: 'key', publicKey: `02${'1'.repeat(64)}`,
  payloadDigest: 'a'.repeat(64), challenge: 'b'.repeat(64), expiresAt: 1_900_000_000_000 };
const login = { sessionId: 'session', deviceId: 'device', deviceSecret: 'secret',
  accessToken: 'token', expiresAt: '2030-01-01T00:00:00.000Z', user: { id: 'bot' } };

afterEach(() => jest.restoreAllMocks());
it('requests a public challenge without existing bearer or device credential, then plants the ordinary session', async () => {
  const oxy = new OxyServices({ baseURL: 'https://fixture.invalid' });
  oxy.session.setDeviceCredentialProvider(() => ({ deviceId: 'other', deviceSecret: 'never-send' }));
  const request = jest.spyOn(oxy, 'request').mockResolvedValueOnce(claims).mockResolvedValueOnce(login);
  const plant = jest.spyOn(oxy.session, 'setAccessToken');
  expect(await oxy.auth.agent.requestChallenge(claims.publicKey)).toEqual(claims);
  expect(request).toHaveBeenNthCalledWith(1, 'POST', '/auth/agent/challenge', { publicKey: claims.publicKey }, { cache: false, skipAuth: true });
  const proof = { challenge: claims.challenge, signature: 'c'.repeat(128), timestamp: 1_800_000_000_000 };
  expect(await oxy.auth.agent.verify(claims.publicKey, proof)).toEqual(login);
  expect(request).toHaveBeenNthCalledWith(2, 'POST', '/auth/agent/verify', { publicKey: claims.publicKey, ...proof }, { cache: false, skipAuth: true });
  expect(plant).toHaveBeenCalledWith('token');
});
it('rejects an unrelated response and keeps proof roles and audience in the signed bytes', async () => {
  const oxy = new OxyServices({ baseURL: 'https://fixture.invalid' });
  jest.spyOn(oxy, 'request').mockResolvedValue({ challenge: claims.challenge });
  await expect(oxy.auth.agent.requestChallenge(claims.publicKey)).rejects.toThrow();
  expect(buildAgentProofMessage(claims, 123, 'governor')).not.toBe(buildAgentProofMessage(claims, 123));
  expect(buildAgentProofMessage(claims, 123)).toContain('oxy-api/agent');
});
it('governance operations use the authenticated account API and never transmit private keys', async () => {
  const oxy = new OxyServices({ baseURL: 'https://fixture.invalid' });
  const operation = { operation: 'rotate', publicKey: claims.publicKey, label: 'next', retireCurrent: true } as const;
  const response = { claims: { ...claims, action: 'agent_rotate' }, governorPublicKey: claims.publicKey };
  const request = jest.spyOn(oxy, 'request').mockResolvedValueOnce(response)
    .mockResolvedValueOnce({ methodId: 'next', revokedMethodIds: ['old'] });
  expect(await oxy.accounts.agentKeys.requestChallenge('bot', operation)).toEqual(response);
  const proof = { challenge: claims.challenge, timestamp: 123, keySignature: 'a'.repeat(128), governorSignature: 'b'.repeat(128) };
  await oxy.accounts.agentKeys.execute('bot', operation, proof);
  expect(request).toHaveBeenNthCalledWith(2, 'POST', '/accounts/bot/agent-keys/execute', { operation, proof }, { cache: false });
});
