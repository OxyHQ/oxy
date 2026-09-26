/**
 * `oxy.apps` — applications an account owns (and their credentials), and the
 * third-party apps this user granted. Request shape, envelope unwrapping, and
 * cache discipline, checked by behaviour: a read is served from cache until a
 * write that should invalidate it, then re-fetched.
 */
import { OxyServices } from '../../OxyServices';
import type {
  Application,
  ApplicationCredential,
  ApplicationCredentialWithSecret,
  ConnectedApp,
  RotateApplicationCredentialResult,
} from '../apps';

function makeJwt(payload: Record<string, unknown>): string {
  const encode = (value: Record<string, unknown>): string => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({ alg: 'none', typ: 'JWT' })}.${encode({ exp: Math.floor(Date.now() / 1000) + 3600, ...payload })}.sig`;
}

function jsonResponse(data: unknown): Response {
  return new Response(JSON.stringify({ data }), { status: 200, headers: { 'content-type': 'application/json' } });
}

const app: Application = {
  _id: 'app1',
  name: 'Mention',
  type: 'first_party',
  status: 'active',
  isOfficial: true,
  isInternal: false,
  capabilities: [],
  redirectUris: ['https://mention.earth/oauth/callback'],
  scopes: ['profile'],
  createdByUserId: 'u1',
  ownerAccountId: 'acc1',
  createdAt: '2026-06-29T00:00:00.000Z',
  updatedAt: '2026-06-29T00:00:00.000Z',
};

const credential: ApplicationCredential = {
  _id: 'cred1',
  applicationId: 'app1',
  name: 'prod',
  publicKey: 'oxy_dk_1',
  type: 'confidential',
  environment: 'production',
  scopes: [],
  status: 'active',
  createdAt: '2026-06-29T00:00:00.000Z',
  updatedAt: '2026-06-29T00:00:00.000Z',
} as ApplicationCredential;

describe('oxy.apps', () => {
  let originalFetch: typeof globalThis.fetch;
  let fetchMock: jest.Mock<Promise<Response>, [RequestInfo | URL, RequestInit?]>;
  let oxy: OxyServices;

  const call = (i: number) => {
    const [url, init] = fetchMock.mock.calls[i];
    return { url: String(url), method: init?.method, body: init?.body ? JSON.parse(String(init.body)) : undefined };
  };

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    fetchMock = jest.fn();
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
    oxy = new OxyServices({ baseURL: 'http://test.invalid' });
    oxy.session.setAccessToken(makeJwt({ userId: 'me' }));
  });

  afterEach(() => {
    oxy.dispose();
    globalThis.fetch = originalFetch;
  });

  describe('owned applications', () => {
    it('lists by owner (encoded), unwraps, caches, and defaults to []', async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse({}));
      await expect(oxy.apps.list('acc/1')).resolves.toEqual([]);
      await oxy.apps.list('acc/1');
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(call(0).url).toBe('http://test.invalid/applications?ownerAccountId=acc%2F1');
    });

    it('create busts every owner-scoped list', async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse({ applications: [] }));
      await oxy.apps.list('acc1');
      fetchMock.mockResolvedValueOnce(jsonResponse({ application: app }));
      await expect(oxy.apps.create({ name: 'Mention' } as never)).resolves.toEqual(app);
      expect(call(1)).toMatchObject({ url: 'http://test.invalid/applications', method: 'POST' });

      fetchMock.mockResolvedValueOnce(jsonResponse({ applications: [app] }));
      await expect(oxy.apps.list('acc1')).resolves.toEqual([app]);
    });

    it('update busts the detail and lists; delete also the credentials', async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse({ application: app }));
      await oxy.apps.get('app1');
      fetchMock.mockResolvedValueOnce(jsonResponse({ credentials: [credential] }));
      await oxy.apps.credentials.list('app1');

      fetchMock.mockResolvedValueOnce(jsonResponse({ application: app }));
      await oxy.apps.update('app1', { name: 'M' } as never);
      expect(call(2)).toMatchObject({ url: 'http://test.invalid/applications/app1', method: 'PATCH', body: { name: 'M' } });

      fetchMock.mockResolvedValueOnce(jsonResponse({ application: app }));
      await oxy.apps.get('app1');
      expect(fetchMock).toHaveBeenCalledTimes(4);

      fetchMock.mockResolvedValueOnce(jsonResponse({ success: true }));
      await expect(oxy.apps.delete('app1')).resolves.toEqual({ success: true });
      fetchMock.mockResolvedValueOnce(jsonResponse({ credentials: [] }));
      await expect(oxy.apps.credentials.list('app1')).resolves.toEqual([]);
      expect(fetchMock).toHaveBeenCalledTimes(6);
    });

    it('usage passes the period only when given', async () => {
      fetchMock.mockImplementation(async () => jsonResponse({ summary: {}, byDay: [], byEndpoint: [] }));
      await oxy.apps.usage('app1', '7d');
      await oxy.apps.usage('app2');
      expect(call(0).url).toBe('http://test.invalid/applications/app1/usage?period=7d');
      expect(call(1).url).toBe('http://test.invalid/applications/app2/usage');
    });
  });

  describe('credentials', () => {
    it("create forwards a machine credential's options and returns its one-time token", async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse({ credentials: [] }));
      await oxy.apps.credentials.list('app1');

      const created: ApplicationCredentialWithSecret = {
        credential: { ...credential, type: 'machine', tokenPrefix: 'oxy_sk_0123' },
        secret: null,
        token: `oxy_sk_0123_${'a'.repeat(64)}`,
      };
      fetchMock.mockResolvedValueOnce(jsonResponse(created));
      const input = { name: 'ci', type: 'machine' as const, environment: 'production' as const, scopes: ['inference:invoke'], expiresInSeconds: 86_400 };
      const result = await oxy.apps.credentials.create('app1', input);
      expect(result.token).toBe(created.token);
      expect(call(1)).toMatchObject({ url: 'http://test.invalid/applications/app1/credentials', method: 'POST', body: input });

      fetchMock.mockResolvedValueOnce(jsonResponse({ credentials: [created.credential] }));
      await oxy.apps.credentials.list('app1');
      expect(fetchMock).toHaveBeenCalledTimes(3);
    });

    it('rotate encodes ids and forwards the grace window', async () => {
      const rotated: RotateApplicationCredentialResult = {
        credential: { ...credential, _id: 'cred2' },
        secret: 'sk_new',
        rotatedFrom: 'cred1',
        graceExpiresAt: '2026-07-06T00:00:00.000Z',
      };
      fetchMock.mockResolvedValueOnce(jsonResponse(rotated));
      await expect(oxy.apps.credentials.rotate('app1', 'cred 1', { graceSeconds: 3600 })).resolves.toEqual(rotated);
      expect(call(0)).toMatchObject({
        url: 'http://test.invalid/applications/app1/credentials/cred%201/rotate',
        method: 'POST',
        body: { graceSeconds: 3600 },
      });
    });

    it('revoke deletes the credential', async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse({ success: true }));
      await oxy.apps.credentials.revoke('app1', 'cred1');
      expect(call(0)).toMatchObject({ url: 'http://test.invalid/applications/app1/credentials/cred1', method: 'DELETE' });
    });
  });

  describe('getPublic', () => {
    it('resolves a client id without sending the bearer', async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse({ application: { id: 'app1', name: 'Mention' } }));
      await expect(oxy.apps.getPublic('oxy_dk/1')).resolves.toEqual({ id: 'app1', name: 'Mention' });
      const [url, init] = fetchMock.mock.calls[0];
      expect(String(url)).toBe('http://test.invalid/auth/oauth/client/oxy_dk%2F1');
      expect((init?.headers as Record<string, string>).Authorization).toBeUndefined();
    });
  });

  describe('connected (OAuth grants)', () => {
    const A: ConnectedApp = { applicationId: 'app-a', name: 'A', scopes: ['profile'], firstGrantedAt: 'x', lastUsedAt: 'y' };
    const B: ConnectedApp = { applicationId: 'app-b', name: 'B', scopes: ['profile'], firstGrantedAt: 'x', lastUsedAt: 'y' };

    it('lists (cached) and a revoke busts the list', async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse([A, B]));
      await expect(oxy.apps.connected.list()).resolves.toEqual([A, B]);
      await oxy.apps.connected.list();
      expect(fetchMock).toHaveBeenCalledTimes(1);

      fetchMock.mockResolvedValueOnce(jsonResponse({ revoked: true }));
      await expect(oxy.apps.connected.revoke('app-a')).resolves.toBeUndefined();
      expect(call(1)).toMatchObject({ url: 'http://test.invalid/auth/grants/app-a', method: 'DELETE' });

      fetchMock.mockResolvedValueOnce(jsonResponse([B]));
      await expect(oxy.apps.connected.list()).resolves.toEqual([B]);
      expect(fetchMock).toHaveBeenCalledTimes(3);
    });

    it('lists and revokes resource-bound MCP clients', async () => {
      const grant = { id: 'g', appSlug: 'noted', resource: 'r', scopes: [], clientId: 'c', clientName: 'n', createdAt: 'x', lastUsedAt: 'y' };
      fetchMock.mockResolvedValueOnce(jsonResponse({ grants: [grant] })).mockResolvedValueOnce(jsonResponse(undefined));
      await expect(oxy.apps.connected.mcpClients()).resolves.toEqual([grant]);
      await expect(oxy.apps.connected.revokeMcpClient('mcp/grant')).resolves.toBeUndefined();
      expect(call(0).url).toBe('http://test.invalid/auth/mcp/oauth/grants');
      expect(call(1)).toMatchObject({ url: 'http://test.invalid/auth/mcp/oauth/grants/mcp%2Fgrant', method: 'DELETE' });
    });
  });
});
