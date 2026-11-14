/**
 * ADR 0066 in the SDK: an Oxy service names the account it acts for, and the
 * person when they operate it, with no session, task or other proof — and a
 * receiving product admits it only on Oxy's first-party answer.
 */
import { OxyServer } from '../OxyServer';
import { requestWorkloadServiceToken } from '../workloadIdentity';

jest.mock('../workloadIdentity', () => ({
  canAttestWorkloadIdentity: () => false,
  requestWorkloadServiceToken: jest.fn(),
}));
const mint = requestWorkloadServiceToken as jest.Mock;
beforeEach(() => {
  mint.mockReset();
  mint.mockResolvedValue({ token: 'e30.e30.sig', expiresIn: 300, appName: 'App' });
});
afterEach(() => jest.restoreAllMocks());

it('sends the account and the person a service acts for, and never a caller-supplied one', async () => {
  const fetch = jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('ok'));
  const oxy = new OxyServer({ baseURL: 'https://api.oxy.so' });
  const client = oxy.createServiceClient({
    baseURL: 'https://api.mention.earth',
    audience: 'oxy-service:mention',
    actingFor: { accountId: 'organization', requesterAccountId: 'person' },
  });
  await client.fetch('/v1', {
    headers: { 'X-Oxy-User-Id': 'other', 'X-Oxy-Requester-Id': 'forged', 'X-Oxy-Task-Id': 't' },
  });
  const headers = new Headers(fetch.mock.calls[0][1]?.headers);
  expect(headers.get('x-oxy-user-id')).toBe('organization');
  expect(headers.get('x-oxy-requester-id')).toBe('person');
  expect(headers.get('x-oxy-task-id')).toBeNull();
  client.dispose();
  oxy.dispose();
});

it('refuses an inexact account or a mix with a requester proof', () => {
  const oxy = new OxyServer({ baseURL: 'https://api.oxy.so' });
  for (const actingFor of [
    { accountId: '' },
    { accountId: 'a b' },
    { accountId: 'a', requesterAccountId: ' ' },
  ])
    expect(() =>
      oxy.createServiceClient({
        baseURL: 'https://api.mention.earth',
        audience: 'oxy-api',
        actingFor,
      }),
    ).toThrow('actingFor requires an exact account id');
  expect(() =>
    oxy.createServiceClient({
      baseURL: 'https://api.mention.earth',
      audience: 'oxy-api',
      actingFor: { accountId: 'a' },
      requester: { accountId: 'a', token: 'proof' },
    }),
  ).toThrow('actingFor requires an exact account id and no requester proof');
  expect(() => oxy.assets.actingFor({ accountId: '' })).toThrow('An exact account id is required');
  oxy.dispose();
});

it('binds Files calls to the account acted for, stripping caller authority headers', async () => {
  const oxy = new OxyServer({ baseURL: 'https://api.oxy.so' });
  const sent: Array<Record<string, unknown> | undefined> = [];
  jest.spyOn(oxy, 'serviceRequest').mockImplementation(async (_method, _url, _data, options) => {
    sent.push(options as Record<string, unknown>);
    return { data: { files: [] } } as never;
  });
  const assets = oxy.assets.actingFor({ accountId: 'person' });
  await assets.linkedDownloadUrls(['file']).catch(() => undefined);
  expect(sent[0]).toMatchObject({ actAs: 'person', cache: false, retry: false });
  expect(sent[0]).not.toHaveProperty('taskId', expect.anything());
  oxy.dispose();
});

it('admits a first-party caller acting with declared authority only on the first-party answer', async () => {
  const oxy = new OxyServer({
    baseURL: 'http://test.invalid',
    serviceAuth: { apiKey: 'verifier-key', apiSecret: 'verifier-secret' },
  });
  jest.spyOn(oxy, 'serviceToken').mockResolvedValue('verifier-token');
  const answer = jest.spyOn(oxy, 'request');
  const options = {
    credentialId: 'wl_caller',
    ownerAccountId: 'owner',
    environment: 'production',
    presentedServiceToken: 'caller-token',
    effect: 'read' as const,
  };
  answer.mockResolvedValueOnce({
    authorized: true,
    authority: 'first_party',
    epoch: '0',
    requesterId: 'person',
  } as never);
  await expect(oxy.verifyActingAs('caller', 'person', options)).resolves.toEqual({
    authorized: true,
    authority: 'first_party',
    epoch: '0',
    requesterId: 'person',
  });
  expect(answer.mock.calls[0][2]).toMatchObject({ effect: 'read', userId: 'person' });
  // Without the caller's own token the answer cannot be about it.
  answer.mockResolvedValueOnce({
    authorized: true,
    authority: 'first_party',
    epoch: '0',
    requesterId: 'p',
  } as never);
  await expect(
    oxy.verifyActingAs('caller', 'person', { ...options, presentedServiceToken: undefined }),
  ).resolves.toBeNull();
  // A first-party answer carrying scopes, or no person, is malformed.
  answer.mockResolvedValueOnce({
    authorized: true,
    authority: 'first_party',
    epoch: '0',
    scopes: [],
    requesterId: 'p',
  } as never);
  await expect(oxy.verifyActingAs('caller', 'person', options)).resolves.toBeNull();
  answer.mockResolvedValueOnce({ authorized: true, authority: 'first_party', epoch: '0' } as never);
  await expect(oxy.verifyActingAs('caller', 'person', options)).resolves.toBeNull();
  answer.mockResolvedValueOnce({
    authorized: false,
    authority: 'first_party',
    epoch: '0',
  } as never);
  await expect(oxy.verifyActingAs('caller', 'person', options)).resolves.toBeNull();
  oxy.dispose();
});
