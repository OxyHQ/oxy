/**
 * `oxy.assets` writes: delete (force travels in the query string the route
 * reads — it used to ride a DELETE body the server never looked at), cache
 * eviction on delete / visibility change, the avatar upload-and-link, and
 * content reads that send cookies only to the API's own origin.
 */
import { OxyServices } from '../../OxyServices';

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify({ data }), { status, headers: { 'content-type': 'application/json' } });
}

function makeJwt(payload: Record<string, unknown>): string {
  const b64url = (obj: Record<string, unknown>): string => Buffer.from(JSON.stringify(obj)).toString('base64url');
  return `${b64url({ alg: 'none', typ: 'JWT' })}.${b64url({ exp: Math.floor(Date.now() / 1000) + 3600, ...payload })}.sig`;
}

describe('oxy.assets lifecycle', () => {
  const originalFetch = globalThis.fetch;
  let fetchMock: jest.Mock;
  let oxy: OxyServices;

  beforeEach(() => {
    fetchMock = jest.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    oxy = new OxyServices({ baseURL: 'https://api.oxy.so' });
    oxy.session.setAccessToken(makeJwt({ userId: 'u1' }));
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  it('delete sends force as a query parameter', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ summary: {}, message: 'File deleted successfully', force: true }));
    await oxy.assets.delete('f1', { force: true });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.oxy.so/assets/f1?force=true');
    expect(init.method).toBe('DELETE');
    expect(init.body).toBeUndefined();
  });

  it('delete evicts the cached record and every cached URL of the asset', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ assetId: 'f1', file: { id: 'f1' } }))
      .mockResolvedValueOnce(jsonResponse({ url: 'https://cloud.oxy.so/f1' }))
      .mockResolvedValueOnce(jsonResponse({ summary: {}, message: 'ok' }))
      .mockResolvedValueOnce(jsonResponse({ assetId: 'f1', file: { id: 'f1', status: 'trash' } }))
      .mockResolvedValueOnce(jsonResponse({ url: 'https://cloud.oxy.so/f1?v=2' }));

    await oxy.assets.get('f1');
    await oxy.assets.url('f1');
    await oxy.assets.delete('f1');
    await oxy.assets.get('f1');
    await oxy.assets.url('f1');
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });

  it('setVisibility evicts the cached URL', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ url: 'https://api.oxy.so/assets/f1/stream?mt=A' }))
      .mockResolvedValueOnce(jsonResponse({ file: { id: 'f1', visibility: 'public', updatedAt: 'now' } }))
      .mockResolvedValueOnce(jsonResponse({ url: 'https://cloud.oxy.so/f1' }));

    await oxy.assets.url('f1');
    await oxy.assets.setVisibility('f1', 'public');
    await expect(oxy.assets.url('f1')).resolves.toBe('https://cloud.oxy.so/f1');
  });

  it('uploadAvatar uploads public and links the avatar to the user', async () => {
    const requestSpy = jest.spyOn(oxy.http, 'request');
    requestSpy
      .mockResolvedValueOnce({ file: { id: 'av1' } } as never)
      .mockResolvedValueOnce({ assetId: 'av1', file: { id: 'av1' } } as never);

    const res = await oxy.assets.uploadAvatar(new Blob([new Uint8Array([1])], { type: 'image/png' }), 'u1');

    expect(res.file.id).toBe('av1');
    expect(requestSpy.mock.calls[1][0]).toMatchObject({
      method: 'POST',
      url: '/assets/av1/links',
      data: { app: 'profiles', entityType: 'avatar', entityId: 'u1', visibility: 'public' },
    });
  });

  it('text() fetches the resolved URL and sends cookies only to the API origin', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ url: 'https://cloud.oxy.so/f1' }))
      .mockResolvedValueOnce(new Response('hello', { status: 200 }))
      .mockResolvedValueOnce(jsonResponse({ url: 'https://api.oxy.so/assets/f2/stream?mt=X' }))
      .mockResolvedValueOnce(new Response('private', { status: 200 }));

    await expect(oxy.assets.text('f1')).resolves.toBe('hello');
    expect((fetchMock.mock.calls[1] as [string, RequestInit])[1].credentials).toBe('omit');

    await expect(oxy.assets.text('f2')).resolves.toBe('private');
    expect((fetchMock.mock.calls[3] as [string, RequestInit])[1].credentials).toBe('include');
  });
});
