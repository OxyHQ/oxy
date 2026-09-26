/**
 * `serviceIdentity: 'when-anonymous'` — a backend's session-less reads carry
 * its service token.
 *
 * oxy-api charges anonymous requests to their source address, and a backend
 * fleet leaves through one NAT address, so past 100 anonymous requests in 15
 * minutes EVERY anonymous read that backend makes pays a +500 ms `slowDown`.
 * Mention measured 543–575 ms for `GET /users/:id` anonymous against ~20 ms
 * with its service token (OxyHQ/Mention#1173). A first-party service token is
 * exempt, so a backend should present one on every read that has no user.
 *
 * What is asserted is the `Authorization` header that reaches `fetch`, because
 * that is the only thing oxy-api's limiter sees.
 */

const mockAttestation = { canAttest: true };

jest.mock('../workloadIdentity', () => ({
  canAttestWorkloadIdentity: jest.fn(() => mockAttestation.canAttest),
  requestWorkloadServiceToken: jest.fn(),
}));

import { OxyServices } from '../../OxyServices';
import { ANONYMOUS_SERVICE_TOKEN_RETRY_MS, OxyServer } from '../OxyServer';
import { canAttestWorkloadIdentity } from '../workloadIdentity';

const canAttest = canAttestWorkloadIdentity as unknown as jest.Mock;

interface FetchCall {
  url: string;
  authorization: string | undefined;
}

function jsonResponse(data: unknown): Response {
  return new Response(JSON.stringify({ data }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function authorizationOf(init: RequestInit | undefined): string | undefined {
  const headers = init?.headers;
  if (!headers) return undefined;
  if (headers instanceof Headers) return headers.get('authorization') ?? undefined;
  const record = headers as Record<string, string>;
  return record.Authorization ?? record.authorization;
}

function createJwt(payload: Record<string, unknown>): string {
  const encode = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({ alg: 'EdDSA', typ: 'JWT' })}.${encode(payload)}.signature`;
}

describe("OxyServer serviceIdentity: 'when-anonymous'", () => {
  const originalFetch = globalThis.fetch;
  let calls: FetchCall[];

  beforeEach(() => {
    calls = [];
    mockAttestation.canAttest = true;
    canAttest.mockClear();
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), authorization: authorizationOf(init) });
      return jsonResponse({ id: 'u1', username: 'alice', name: { displayName: 'Alice' } });
    }) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  function backend(serviceAuth?: { apiKey: string; apiSecret: string }): OxyServer {
    return new OxyServer({ baseURL: 'https://api.oxy.test', serviceIdentity: 'when-anonymous', serviceAuth });
  }

  it('sends a session-less read with the service token', async () => {
    const oxy = backend();
    const serviceToken = jest.spyOn(oxy, 'serviceToken').mockResolvedValue('svc-token');

    await oxy.users.get('u1');
    await oxy.users.byUsername('alice');

    expect(calls.map((call) => call.authorization)).toEqual(['Bearer svc-token', 'Bearer svc-token']);
    expect(serviceToken).toHaveBeenCalledTimes(2);
  });

  it('uses a configured key pair without asking about attestation', async () => {
    const oxy = backend({ apiKey: 'oxy_dk_test', apiSecret: 'secret' });
    jest.spyOn(oxy, 'serviceToken').mockResolvedValue('keypair-token');

    await oxy.users.get('u1');

    expect(calls[0].authorization).toBe('Bearer keypair-token');
    expect(canAttest).not.toHaveBeenCalled();
  });

  it('lets a user session win over the service token', async () => {
    const oxy = backend();
    const serviceToken = jest.spyOn(oxy, 'serviceToken').mockResolvedValue('svc-token');
    const userToken = createJwt({ userId: 'viewer', exp: Math.floor(Date.now() / 1000) + 3600 });
    oxy.session.setAccessToken(userToken);

    await oxy.users.get('u1');

    expect(calls[0].authorization).toBe(`Bearer ${userToken}`);
    expect(serviceToken).not.toHaveBeenCalled();
  });

  it('stays anonymous where no service token can exist (a local checkout)', async () => {
    mockAttestation.canAttest = false;
    const oxy = backend();
    const serviceToken = jest.spyOn(oxy, 'serviceToken');

    await oxy.users.get('u1');

    expect(calls[0].authorization).toBeUndefined();
    expect(serviceToken).not.toHaveBeenCalled();
  });

  it('sends the read anonymous when the mint fails, and does not retry the mint for a window', async () => {
    const oxy = backend();
    const serviceToken = jest
      .spyOn(oxy, 'serviceToken')
      .mockRejectedValue(new Error('Oxy refused the workload attestation (401)'));
    const now = jest.spyOn(Date, 'now');
    const start = 1_800_000_000_000;
    now.mockReturnValue(start);

    // Different ids: each is a real request, not a cache hit or a deduplicated one.
    await expect(oxy.users.get('u1')).resolves.toBeDefined();
    await expect(oxy.users.get('u2')).resolves.toBeDefined();

    expect(calls.map((call) => call.authorization)).toEqual([undefined, undefined]);
    expect(serviceToken).toHaveBeenCalledTimes(1);

    // After the window the mint is tried again.
    serviceToken.mockResolvedValue('svc-token');
    now.mockReturnValue(start + ANONYMOUS_SERVICE_TOKEN_RETRY_MS + 1);
    await oxy.users.get('u3');

    expect(calls[2].authorization).toBe('Bearer svc-token');
    expect(serviceToken).toHaveBeenCalledTimes(2);
  });

  it('never attaches a bearer to a skipAuth request', async () => {
    const oxy = backend();
    const serviceToken = jest.spyOn(oxy, 'serviceToken').mockResolvedValue('svc-token');

    await oxy.request('GET', '/auth/user/abc', undefined, { skipAuth: true, cache: false });

    expect(calls[0].authorization).toBeUndefined();
    expect(serviceToken).not.toHaveBeenCalled();
  });

  it('is off by default: a server without the option stays anonymous', async () => {
    const oxy = new OxyServer({ baseURL: 'https://api.oxy.test' });
    const serviceToken = jest.spyOn(oxy, 'serviceToken').mockResolvedValue('svc-token');

    await oxy.users.get('u1');

    expect(calls[0].authorization).toBeUndefined();
    expect(serviceToken).not.toHaveBeenCalled();
  });

  it('a plain client has no service identity at all', async () => {
    const oxy = new OxyServices({ baseURL: 'https://api.oxy.test' });

    await oxy.users.get('u1');

    expect(calls[0].authorization).toBeUndefined();
  });
});
