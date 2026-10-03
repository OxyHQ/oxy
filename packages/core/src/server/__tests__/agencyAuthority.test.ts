import { OxyServer } from '../OxyServer';
import type { CreateExecutionAuthorizationInput } from '../namespaces';

function fixture() {
  const oxy = new OxyServer({ baseURL: 'http://test.invalid', serviceAuth: { apiKey: 'fixture-key', apiSecret: 'fixture-secret' } });
  const token = jest.spyOn(oxy, 'serviceToken').mockResolvedValue('fixture-service-token');
  const request = jest.spyOn(oxy, 'request');
  return { oxy, token, request };
}
const pin = { registrationId: 'registration-1', version: '1.0.0', digest: 'a'.repeat(64) };

afterEach(() => jest.restoreAllMocks());

it('discovers catalogues live on the service lane without cache, deduplication or retries', async () => {
  const { oxy, request } = fixture();
  request.mockResolvedValue({ registrations: [{ id: 'registration-1' }] } as never);
  await expect(oxy.agency.serviceCatalogs({ appId: 'app/1' })).resolves.toEqual([{ id: 'registration-1' }]);
  await oxy.agency.serviceCatalogs({ appId: 'app/1' });
  expect(request).toHaveBeenCalledTimes(2);
  expect(request).toHaveBeenCalledWith('GET', '/capabilities/catalogs?appId=app%2F1', undefined, {
    cache: false, deduplicate: false, retry: false, skipAuth: true, timeout: 5000,
    headers: { Authorization: 'Bearer fixture-service-token' },
  });
});

it('preserves the expected catalogue and forwards an abort signal on ticket issuance/introspection', async () => {
  const { oxy, request } = fixture();
  request.mockResolvedValue({ decision: { allowed: true, reason: 'allowed' }, ticket: 'fixture-ticket' } as never);
  const abort = new AbortController();
  await oxy.agency.issueCapabilityTicket({ executionAuthorizationId: 'authorization-1', expectedCatalog: pin }, { signal: abort.signal });
  await oxy.agency.introspectCapabilityTicket('fixture-ticket', { signal: abort.signal });
  expect(request.mock.calls[0]).toEqual(['POST', '/capabilities/tickets', { executionAuthorizationId: 'authorization-1', expectedCatalog: pin }, expect.objectContaining({ cache: false, retry: false, skipAuth: true, signal: abort.signal })]);
  expect(request.mock.calls[1]).toEqual(['POST', '/capabilities/tickets/introspect', { ticket: 'fixture-ticket' }, expect.objectContaining({ cache: false, retry: false, signal: abort.signal })]);
});

it('creates execution authorization only with the explicit requester bearer, never service attribution', async () => {
  const { oxy, token, request } = fixture();
  request.mockResolvedValue({ authorization: { id: 'authorization-1' } } as never);
  const input: CreateExecutionAuthorizationInput = { kind: 'direct_request', ownerAccountId: 'owner',
    coordinatorApplicationId: 'app', coordinatorCredentialId: 'credential', actor: { type: 'alia', ownerAccountId: 'owner' },
    resource: { appId: 'inbox', effectiveAccountId: 'owner', resourceType: 'account', resourceId: 'owner' },
    tool: 'read', maximumAutonomy: 'read_only', runId: 'run', expiresAt: '2026-10-02T20:00:00.000Z' };
  await expect(oxy.agency.createExecutionAuthorization(input, { requesterToken: 'requester-token' })).resolves.toEqual({ id: 'authorization-1' });
  expect(token).not.toHaveBeenCalled();
  expect(request).toHaveBeenCalledWith('POST', '/capabilities/execution-authorizations', input, {
    cache: false, deduplicate: false, retry: false, skipAuth: true, timeout: 5000,
    headers: { Authorization: 'Bearer requester-token' },
  });
  await expect(oxy.agency.createExecutionAuthorization(input, { requesterToken: '' })).rejects.toThrow('requester bearer');
});

it('refuses pre-aborted or malformed requests before any authority call and propagates network refusal', async () => {
  const { oxy, request, token } = fixture();
  const signal = AbortSignal.abort(new Error('fixture abort'));
  await expect(oxy.agency.issueCapabilityTicket({ executionAuthorizationId: 'a' }, { signal })).rejects.toThrow('fixture abort');
  await expect(oxy.agency.issueCapabilityTicket({ executionAuthorizationId: 'a', expectedCatalog: { ...pin, digest: 'invalid' } })).rejects.toThrow();
  expect(request).not.toHaveBeenCalled();
  expect(token).not.toHaveBeenCalled();
  request.mockRejectedValue(new Error('authority unavailable'));
  await expect(oxy.agency.introspectCapabilityTicket('fixture-ticket')).rejects.toThrow('authority unavailable');
  expect(request).toHaveBeenCalledTimes(1);
});


it('sends foreground requester proof only to the configured Oxy authority alongside independent service proof', async () => {
  const { oxy, token, request } = fixture();
  request.mockResolvedValue({ authorization: { id: 'foreground-authorization' } } as never);
  const input = { tool: 'recommendProfiles' as const, expectedCatalog: pin, runId: 'foreground-run', expiresAt: '2026-10-03T11:00:00.000Z' };
  await expect(oxy.agency.createForegroundExecutionAuthorization(input, { requesterToken: 'current-requester-token' })).resolves.toEqual({ id: 'foreground-authorization' });
  expect(token).toHaveBeenCalledTimes(1);
  expect(request).toHaveBeenCalledWith('POST', '/capabilities/foreground-execution-authorizations', { ...input, subjectToken: 'current-requester-token' }, {
    cache: false, deduplicate: false, retry: false, skipAuth: true, timeout: 5000,
    headers: { Authorization: 'Bearer fixture-service-token' },
  });
  request.mockClear(); token.mockClear();
  for (const bearer of ['', 'token with-space', 'x'.repeat(16_385)]) {
    await expect(oxy.agency.createForegroundExecutionAuthorization(input, { requesterToken: bearer })).rejects.toThrow('requester bearer');
  }
  await expect(oxy.agency.createForegroundExecutionAuthorization({ ...input, expectedCatalog: { ...pin, digest: 'invalid' } }, { requesterToken: 'requester-token' })).rejects.toThrow();
  expect(request).not.toHaveBeenCalled(); expect(token).not.toHaveBeenCalled();
});
