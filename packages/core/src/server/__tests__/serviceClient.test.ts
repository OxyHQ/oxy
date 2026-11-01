import { OxyServer } from '../OxyServer';
import { requestWorkloadServiceToken } from '../workloadIdentity';

jest.mock('../workloadIdentity', () => ({
  canAttestWorkloadIdentity: () => false,
  requestWorkloadServiceToken: jest.fn(),
}));
const mint = requestWorkloadServiceToken as jest.Mock;
let mintedToken: string;
function token(nonce: string) {
  const now = Math.floor(Date.now() / 1000);
  return `e30.${Buffer.from(JSON.stringify({ type: 'service', authority: 'first_party', appId: 'app', credentialId: 'wl_app', ownerAccountId: 'owner', environment: 'production', aud: 'oxy-service:alia', iss: 'oxy-auth', iat: now, exp: now + 300, nonce })).toString('base64url')}.sig`;
}
beforeEach(() => {
  mint.mockReset();
  mintedToken = token('one');
  mint.mockResolvedValue({ token: mintedToken, expiresIn: 300, appName: 'App' });
});
afterEach(() => jest.restoreAllMocks());

it('uses only workload authentication, caches by recipient, and binds requester proof', async () => {
  const fetch = jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('ok'));
  const oxy = new OxyServer({
    baseURL: 'https://api.oxy.so',
    serviceAuth: { apiKey: 'external', apiSecret: 'external-secret' },
  });
  const client = oxy.createServiceClient({
    baseURL: 'https://api.alia.onl',
    audience: 'oxy-service:alia',
    requester: { accountId: 'person', token: 'proof' },
  });
  await client.fetch('/v1', {
    headers: {
      authorization: 'Bearer forged',
      'X-Oxy-User-Id': 'other',
      'X-Oxy-Requester-Token': 'forged',
    },
  });
  await client.fetch('/v1');
  expect(mint).toHaveBeenCalledTimes(1);
  expect(mint).toHaveBeenCalledWith({
    baseUrl: 'https://api.oxy.so',
    audience: 'oxy-service:alia',
  });
  const headers = new Headers(fetch.mock.calls[0][1]?.headers);
  expect(headers.get('authorization')).toBe(`Bearer ${mintedToken}`);
  expect(headers.get('x-oxy-user-id')).toBe('person');
  expect(headers.get('x-oxy-requester-token')).toBe('proof');
  client.dispose();
  oxy.dispose();
});

it('never forwards a user header without a configured requester and never mints for a foreign URL', async () => {
  const fetch = jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('ok'));
  const oxy = new OxyServer({ baseURL: 'https://api.oxy.so' });
  const client = oxy.createServiceClient({
    baseURL: 'https://api.alia.onl',
    audience: 'oxy-service:alia',
  });
  await expect(client.fetch('https://other.example/')).rejects.toThrow('configured API origin');
  expect(mint).not.toHaveBeenCalled();
  await client.fetch('/v1', {
    headers: { 'X-Oxy-User-Id': 'person', 'X-Oxy-Requester-Token': 'proof' },
  });
  expect(new Headers(fetch.mock.calls[0][1]?.headers).has('x-oxy-user-id')).toBe(false);
  client.dispose();
  oxy.dispose();
});

it('refreshes a 401 once without buffering the returned stream', async () => {
  mint
    .mockResolvedValueOnce({ token: token('one'), expiresIn: 300, appName: 'App' })
    .mockResolvedValue({ token: token('two'), expiresIn: 300, appName: 'App' });
  const stream = new Response('data: hello\n\n');
  jest
    .spyOn(globalThis, 'fetch')
    .mockResolvedValueOnce(new Response('', { status: 401 }))
    .mockResolvedValueOnce(stream);
  const oxy = new OxyServer({ baseURL: 'https://api.oxy.so' });
  const client = oxy.createServiceClient({
    baseURL: 'https://api.alia.onl',
    audience: 'oxy-service:alia',
  });
  expect(await client.fetch('/v1', { method: 'POST', body: '{}' })).toBe(stream);
  expect(mint).toHaveBeenCalledTimes(2);
  expect(stream.bodyUsed).toBe(false);
  client.dispose();
  oxy.dispose();
});

it('binds task context and strips any caller-injected requester bearer', async () => {
  const fetch = jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('ok'));
  const oxy = new OxyServer({ baseURL: 'https://api.oxy.so' });
  const client = oxy.createServiceClient({
    baseURL: 'https://api.alia.onl',
    audience: 'oxy-service:alia',
    requester: { accountId: 'person', taskId: 'task' },
  });
  await client.fetch('/v1', {
    headers: { 'X-Oxy-Requester-Token': 'forged', 'X-Oxy-Task-Id': 'other' },
  });
  const headers = new Headers(fetch.mock.calls[0][1]?.headers);
  expect(headers.get('x-oxy-task-id')).toBe('task');
  expect(headers.has('x-oxy-requester-token')).toBe(false);
  client.dispose();
  oxy.dispose();
});
