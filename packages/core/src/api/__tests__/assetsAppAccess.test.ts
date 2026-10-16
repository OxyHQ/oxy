/**
 * `oxy.assets` — the applications that can read one of your files (ADR 0042
 * stage 4c): listing them and revoking one, and `uploadLarge` sending an SVG
 * through the sanitizing upload instead of the presigned path.
 */
import { OxyServices } from '../../OxyServices';

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify({ data }), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function makeJwt(payload: Record<string, unknown>): string {
  const b64url = (obj: Record<string, unknown>): string =>
    Buffer.from(JSON.stringify(obj)).toString('base64url');
  return `${b64url({ alg: 'none', typ: 'JWT' })}.${b64url({ exp: Math.floor(Date.now() / 1000) + 3600, ...payload })}.sig`;
}

describe('oxy.assets — applications with access', () => {
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

  it('listAppAccess GETs the file access list and returns its applications', async () => {
    const applications = [
      {
        applicationId: 'app-1',
        name: 'Syra',
        icon: null,
        via: ['upload'],
        since: '2026-10-16T00:00:00.000Z',
      },
    ];
    fetchMock.mockResolvedValueOnce(jsonResponse({ fileId: 'f 1', applications }));
    await expect(oxy.assets.listAppAccess('f 1')).resolves.toEqual(applications);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.oxy.so/assets/f%201/access');
    expect(init.method).toBe('GET');
  });

  it('listAppAccess is never answered from the cache', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ fileId: 'f1', applications: [] }))
      .mockResolvedValueOnce(jsonResponse({ fileId: 'f1', applications: [] }));
    await oxy.assets.listAppAccess('f1');
    await oxy.assets.listAppAccess('f1');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('revokeAppAccess DELETEs the application from the file access list', async () => {
    const answer = { fileId: 'f1', applicationId: 'app/1', revoked: true, streamsRevoked: 2 };
    fetchMock.mockResolvedValueOnce(jsonResponse(answer));
    await expect(oxy.assets.revokeAppAccess('f1', 'app/1')).resolves.toEqual(answer);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.oxy.so/assets/f1/access/app%2F1');
    expect(init.method).toBe('DELETE');
  });

  it('a 404 for somebody else’s file propagates', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ message: 'File not found' }), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      }),
    );
    await expect(oxy.assets.revokeAppAccess('f1', 'app-1')).rejects.toMatchObject({ status: 404 });
  });

  it('uploadLarge sends an SVG through POST /assets/upload, never /assets/init', async () => {
    const record = {
      id: 'svg-1',
      sha256: 'b'.repeat(64),
      size: 30,
      mime: 'image/svg+xml',
      ext: '.svg',
      status: 'active',
      visibility: 'public',
      usageCount: 0,
      createdAt: '2026-10-16T00:00:00.000Z',
      updatedAt: '2026-10-16T00:00:00.000Z',
      links: [],
      variants: [],
      originalName: 'logo.svg',
    };
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ file: record }))
      .mockResolvedValueOnce(jsonResponse({ assetId: 'svg-1', file: record }));
    const svg = new Blob(['<svg xmlns="http://www.w3.org/2000/svg"/>'], { type: 'image/svg+xml' });

    const result = await oxy.assets.uploadLarge(svg, { name: 'logo.svg', visibility: 'public' });

    const urls = fetchMock.mock.calls.map(([url]) => url as string);
    expect(urls).toEqual(['https://api.oxy.so/assets/upload', 'https://api.oxy.so/assets/svg-1']);
    expect(urls.some((url) => url.includes('/assets/init'))).toBe(false);
    const form = (fetchMock.mock.calls[0][1] as RequestInit).body as FormData;
    expect(form.get('visibility')).toBe('public');
    expect((form.get('file') as File).name).toBe('logo.svg');
    expect(result).toMatchObject({
      assetId: 'svg-1',
      deduplicated: false,
      file: { id: 'svg-1', sha256: 'b'.repeat(64), mime: 'image/svg+xml', status: 'active' },
    });
  });
});
