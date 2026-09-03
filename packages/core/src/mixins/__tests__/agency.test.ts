import { OxyServices } from '../../OxyServices';

function makeJwt(payload: Record<string, unknown>): string {
  const encode = (value: Record<string, unknown>): string =>
    Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({ alg: 'none', typ: 'JWT' })}.${encode({ exp: Math.floor(Date.now() / 1000) + 3600, ...payload })}.sig`;
}

function jsonResponse(data: unknown): Response {
  return new Response(JSON.stringify({ data }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

describe('native agency authority', () => {
  let originalFetch: typeof globalThis.fetch;
  let fetchMock: jest.Mock<Promise<Response>, [RequestInfo | URL, RequestInit?]>;
  let oxy: OxyServices;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    fetchMock = jest.fn();
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
    oxy = new OxyServices({ baseURL: 'http://test.invalid' });
    oxy.httpService.setTokens(makeJwt({ userId: 'owner' }));
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    jest.clearAllMocks();
  });

  it('loads account-scoped grants and audit events', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ grants: [] }))
      .mockResolvedValueOnce(jsonResponse({ events: [] }));

    await expect(oxy.listDelegationGrants('owner/account')).resolves.toEqual([]);
    await expect(oxy.listCapabilityAuditEvents('owner/account')).resolves.toEqual([]);

    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      'http://test.invalid/capabilities/grants?ownerAccountId=owner%2Faccount',
    );
    expect(String(fetchMock.mock.calls[1]?.[0])).toBe(
      'http://test.invalid/capabilities/audit?accountId=owner%2Faccount',
    );
  });

  it('invalidates the exact grant list after revocation', async () => {
    const clear = jest.spyOn(oxy, 'clearCacheEntry');
    fetchMock.mockResolvedValueOnce(jsonResponse(undefined));

    await oxy.revokeDelegationGrant('grant/id', 'owner/account');

    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      'http://test.invalid/capabilities/grants/grant%2Fid',
    );
    expect(fetchMock.mock.calls[0]?.[1]?.method).toBe('DELETE');
    expect(clear).toHaveBeenCalledWith(
      'GET:/capabilities/grants?ownerAccountId=owner%2Faccount',
    );
  });

  it('updates only a grant authority envelope through its stable id', async () => {
    const grant = { id: 'grant/id', catalog: null };
    fetchMock.mockResolvedValueOnce(jsonResponse({ grant }));

    await expect(oxy.updateDelegationGrant('grant/id', 'owner/account', {
      capabilityPackages: ['read'],
      capabilities: ['email.read'],
      toolOverrides: [{ tool: 'sendEmail', decision: 'deny' }],
      limits: [],
      maximumAutonomy: 'read_only',
      canRedelegate: false,
      expiresAt: null,
    })).resolves.toEqual(grant);

    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(String(url)).toBe('http://test.invalid/capabilities/grants/grant%2Fid');
    expect(init?.method).toBe('PUT');
    expect(JSON.parse(String(init?.body))).toEqual({
      capabilityPackages: ['read'],
      capabilities: ['email.read'],
      toolOverrides: [{ tool: 'sendEmail', decision: 'deny' }],
      limits: [],
      maximumAutonomy: 'read_only',
      canRedelegate: false,
      expiresAt: null,
    });
  });

  it('writes the most restrictive account policy without leaking it across accounts', async () => {
    const policy = {
      id: 'policy-1',
      accountId: 'account-a',
      appSlug: 'mention',
      maximumAutonomy: 'draft' as const,
      deniedCapabilities: ['social.publish'],
      createdAt: '2026-09-03T00:00:00.000Z',
      updatedAt: '2026-09-03T00:00:00.000Z',
    };
    fetchMock.mockResolvedValueOnce(jsonResponse({ policy }));

    await expect(oxy.putAccountCapabilityPolicy('mention', {
      accountId: 'account-a',
      maximumAutonomy: 'draft',
      deniedCapabilities: ['social.publish'],
    })).resolves.toEqual(policy);

    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(String(url)).toBe('http://test.invalid/capabilities/account-policies/mention');
    expect(init?.method).toBe('PUT');
    expect(init?.body).toBe(JSON.stringify({
      accountId: 'account-a',
      maximumAutonomy: 'draft',
      deniedCapabilities: ['social.publish'],
    }));
  });
});
