/**
 * `oxy.assets.publicUrl()` resolution tests.
 *
 * This is the single chokepoint every Oxy app uses to turn a stored asset id
 * into a `<img src>`-ready URL. It resolves to one of two forms:
 *
 *   - PUBLIC (no access token planted, no `expiresIn`) → the clean CDN form
 *     `${cloudURL}/<id>[?variant=...]` (default `https://cloud.oxy.so/<id>`),
 *     which CloudFront resolves against the public media origin.
 *   - EXPIRING ORIGIN FALLBACK (`expiresIn` is passed) → the API origin
 *     stream form without a bearer token in the query string. Callers that need
 *     private access should use `oxy.assets.url()` for a scoped URL.
 */

import { OxyServices } from '../../OxyServices';
import { AssetUrlResolutionError } from '../../OxyServices.errors';
import { assetUrlCacheTTL } from '../assets';

/**
 * Build a non-verified JWT whose payload decodes to the given claims.
 * `jwtDecode` only base64url-decodes the middle segment (no signature check),
 * so this is enough to give the HTTP cache a distinct per-user identity tag.
 */
function makeJwt(payload: Record<string, unknown>): string {
  const b64url = (obj: Record<string, unknown>): string =>
    Buffer.from(JSON.stringify(obj)).toString('base64url');
  const fullPayload = { exp: Math.floor(Date.now() / 1000) + 3600, ...payload };
  return `${b64url({ alg: 'none', typ: 'JWT' })}.${b64url(fullPayload)}.sig`;
}

/** A JSON `Response` mimicking the API's `{ data: ... }` success envelope. */
function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify({ data }), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** An error `Response` mimicking the API's error body. */
function errorResponse(status: number, code: string): Response {
  return new Response(JSON.stringify({ error: code, message: code }), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('oxy.assets.publicUrl', () => {
  describe('public assets (no token, no expiresIn) → CDN', () => {
    it('returns the clean cloud.oxy.so URL for a bare file id', () => {
      const oxy = new OxyServices({ baseURL: 'https://api.oxy.so' });

      expect(oxy.assets.publicUrl('file123')).toBe('https://cloud.oxy.so/file123');
    });

    it('appends only a variant query param (no token/fallback) for the thumb variant', () => {
      const oxy = new OxyServices({ baseURL: 'https://api.oxy.so' });

      expect(oxy.assets.publicUrl('file123', 'thumb')).toBe(
        'https://cloud.oxy.so/file123?variant=thumb',
      );
    });

    it('uses the configured cloudURL when overridden', () => {
      const oxy = new OxyServices({
        baseURL: 'https://api.oxy.so',
        cloudURL: 'https://cdn.example.test',
      });

      expect(oxy.assets.publicUrl('file123', 'thumb')).toBe(
        'https://cdn.example.test/file123?variant=thumb',
      );
    });

    it('URL-encodes the file id and the variant', () => {
      const oxy = new OxyServices({ baseURL: 'https://api.oxy.so' });

      expect(oxy.assets.publicUrl('a/b c', 'large size')).toBe(
        'https://cloud.oxy.so/a%2Fb%20c?variant=large%20size',
      );
    });

  });

  describe('token-safe URL generation', () => {
    it('does not include the in-memory access token in synchronous image URLs', () => {
      const oxy = new OxyServices({ baseURL: 'https://api.oxy.so' });
      oxy.session.setAccessToken('access-token-abc');

      const url = oxy.assets.publicUrl('file123', 'thumb');

      expect(url).toBe('https://cloud.oxy.so/file123?variant=thumb');
      expect(url).not.toContain('access-token-abc');
      expect(url).not.toContain('token=');
    });

    it('routes through the stream endpoint when expiresIn is requested without embedding a token', () => {
      const oxy = new OxyServices({ baseURL: 'https://api.oxy.so' });
      oxy.session.setAccessToken('access-token-abc');

      const url = oxy.assets.publicUrl('file123', 'thumb', 3600);

      expect(url.startsWith('https://api.oxy.so/assets/file123/stream?')).toBe(true);
      const params = new URLSearchParams(url.split('?')[1]);
      expect(params.get('expiresIn')).toBe('3600');
      expect(params.get('variant')).toBe('thumb');
      expect(params.get('fallback')).toBe('placeholderVisible');
      expect(params.get('token')).toBeNull();
      expect(url).not.toContain('access-token-abc');
      expect(url).not.toContain('cloud.oxy.so');
    });
  });
});

describe('oxy.assets.url', () => {
  let originalFetch: typeof globalThis.fetch;
  let fetchMock: jest.Mock<Promise<Response>, [RequestInfo | URL, RequestInit?]>;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    fetchMock = jest.fn();
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    jest.clearAllMocks();
  });

  it('passes the API-scoped private stream URL through UNCHANGED', async () => {
    const oxy = new OxyServices({ baseURL: 'https://api.oxy.so' });
    oxy.session.setAccessToken(makeJwt({ userId: 'viewer-A' }));

    const scopedUrl =
      'https://api.oxy.so/assets/priv1/stream?variant=thumb&mt=SCOPED-MEDIA-TOKEN';
    fetchMock.mockResolvedValueOnce(jsonResponse({ url: scopedUrl, variant: 'thumb', expiresIn: 600 }));

    const resolved = await oxy.assets.url('priv1', 'thumb');

    // Returned exactly as the API produced it — never rewritten to the CDN.
    expect(resolved).toBe(scopedUrl);
    expect(resolved).not.toContain('cloud.oxy.so');
    // It hit the authorized resolution endpoint, not the public CDN builder.
    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toContain('/assets/priv1/url');
  });

  it('resolves a public asset to the CDN URL the API returns', async () => {
    const oxy = new OxyServices({ baseURL: 'https://api.oxy.so' });
    oxy.session.setAccessToken(makeJwt({ userId: 'viewer-A' }));

    fetchMock.mockResolvedValueOnce(
      jsonResponse({ url: 'https://cloud.oxy.so/pub1?variant=thumb', variant: 'thumb', expiresIn: 3600 }),
    );

    const resolved = await oxy.assets.url('pub1', 'thumb');
    expect(resolved).toBe('https://cloud.oxy.so/pub1?variant=thumb');
  });

  it('THROWS rather than returning a known-404 CDN URL when the API denies access', async () => {
    const oxy = new OxyServices({ baseURL: 'https://api.oxy.so' });
    oxy.session.setAccessToken(makeJwt({ userId: 'viewer-A' }));

    fetchMock.mockResolvedValue(errorResponse(403, 'Access denied'));

    await expect(oxy.assets.url('priv1', 'thumb')).rejects.toBeInstanceOf(
      AssetUrlResolutionError,
    );

    // Prove the failure was surfaced instead of a silent public-CDN fallback.
    const err = await oxy.assets
      .url('priv1', 'thumb')
      .catch((e: unknown) => e as AssetUrlResolutionError);
    expect(err).toBeInstanceOf(AssetUrlResolutionError);
    expect(err.fileId).toBe('priv1');
    expect(err.variant).toBe('thumb');
    expect(err.status).toBe(403);
    // The error must not leak the scoped media token.
    expect(err.message).not.toContain('mt=');
  });

  it('THROWS when the API returns an empty URL body', async () => {
    const oxy = new OxyServices({ baseURL: 'https://api.oxy.so' });
    oxy.session.setAccessToken(makeJwt({ userId: 'viewer-A' }));

    fetchMock.mockResolvedValueOnce(jsonResponse({ url: '', variant: undefined, expiresIn: 600 }));

    await expect(oxy.assets.url('priv1')).rejects.toBeInstanceOf(
      AssetUrlResolutionError,
    );
  });
});

describe('OxyServices asset URL cache TTL', () => {
  const MEDIA_TOKEN_TTL_MS = 10 * 60 * 1000;

  it('never caches a resolved URL for as long as the media-token TTL', () => {
    // Default (no explicit expiry) and an over-long explicit expiry both stay
    // comfortably under the token lifetime.
    expect(assetUrlCacheTTL()).toBeLessThan(MEDIA_TOKEN_TTL_MS);
    expect(assetUrlCacheTTL(3600)).toBeLessThan(MEDIA_TOKEN_TTL_MS);
    // Half of the 10-min bound.
    expect(assetUrlCacheTTL(3600)).toBe(5 * 60 * 1000);
  });

  it('scales a short requested expiry down proportionally', () => {
    expect(assetUrlCacheTTL(60)).toBe(30 * 1000);
  });
});

describe('oxy.assets.urls (variant-aware batch)', () => {
  let originalFetch: typeof globalThis.fetch;
  let fetchMock: jest.Mock<Promise<Response>, [RequestInfo | URL, RequestInit?]>;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    fetchMock = jest.fn();
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    jest.clearAllMocks();
  });

  it('sends a per-file {fileId, variant} list plus expiresIn and keeps only usable URLs', async () => {
    const oxy = new OxyServices({ baseURL: 'https://api.oxy.so' });
    oxy.session.setAccessToken(makeJwt({ userId: 'viewer-A' }));

    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        results: {
          img1: {
            allowed: true,
            url: 'https://api.oxy.so/assets/img1/stream?variant=thumb&mt=TKN',
            visibility: 'private',
            mime: 'image/jpeg',
          },
          vid1: {
            allowed: true,
            url: 'https://cloud.oxy.so/vid1?variant=poster',
            visibility: 'public',
          },
          gone: { allowed: false, error: 'Access denied' },
        },
      }),
    );

    const urls = await oxy.assets.urls(
      [
        { fileId: 'img1', variant: 'thumb' },
        { fileId: 'vid1', variant: 'poster' },
        { fileId: 'gone' },
      ],
      { expiresIn: 600, context: 'file-manager' },
    );

    // Denied/missing ids are OMITTED (never an empty-string value).
    expect(urls).toEqual({
      img1: 'https://api.oxy.so/assets/img1/stream?variant=thumb&mt=TKN',
      vid1: 'https://cloud.oxy.so/vid1?variant=poster',
    });
    expect('gone' in urls).toBe(false);

    // The request carried the per-file variants + expiresIn on the POST body.
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(String(init.body));
    expect(body.files).toEqual([
      { fileId: 'img1', variant: 'thumb' },
      { fileId: 'vid1', variant: 'poster' },
      { fileId: 'gone' },
    ]);
    expect(body.expiresIn).toBe(600);
    expect(body.context).toBe('file-manager');
  });

  it('drops blank ids and collapses exact (fileId, variant) duplicates before sending', async () => {
    const oxy = new OxyServices({ baseURL: 'https://api.oxy.so' });
    oxy.session.setAccessToken(makeJwt({ userId: 'viewer-A' }));

    fetchMock.mockResolvedValueOnce(jsonResponse({ results: {} }));

    await oxy.assets.urls([
      { fileId: 'img1', variant: 'thumb' },
      { fileId: 'img1', variant: 'thumb' },
      { fileId: '   ' },
      { fileId: 'img1' },
    ]);

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(String(init.body));
    // Dedup on (fileId, variant): the two thumb entries collapse; the
    // variant-less img1 is a DIFFERENT request and survives; blank id dropped.
    expect(body.files).toEqual([
      { fileId: 'img1', variant: 'thumb' },
      { fileId: 'img1' },
    ]);
  });

  it('makes NO network call for an all-empty request list', async () => {
    const oxy = new OxyServices({ baseURL: 'https://api.oxy.so' });
    oxy.session.setAccessToken(makeJwt({ userId: 'viewer-A' }));

    const urls = await oxy.assets.urls([{ fileId: '' }, { fileId: '  ' }]);
    expect(urls).toEqual({});
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('OxyServices asset URL cache isolation across accounts', () => {
  let originalFetch: typeof globalThis.fetch;
  let fetchMock: jest.Mock<Promise<Response>, [RequestInfo | URL, RequestInit?]>;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    fetchMock = jest.fn();
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    jest.clearAllMocks();
  });

  it('never serves account A’s scoped URL to account B after a switch', async () => {
    const oxy = new OxyServices({ baseURL: 'https://api.oxy.so' });

    // Account A resolves the asset; response is cached under A's identity.
    oxy.session.setAccessToken(makeJwt({ userId: 'account-A' }));
    const urlForA = 'https://api.oxy.so/assets/priv1/stream?mt=TOKEN-FOR-A';
    fetchMock.mockResolvedValueOnce(jsonResponse({ url: urlForA, expiresIn: 600 }));
    expect(await oxy.assets.url('priv1')).toBe(urlForA);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Switching to account B mints a new access token → new identity tag. B's
    // read must MISS A's cache entry and hit the network for its own scoped URL.
    oxy.session.setAccessToken(makeJwt({ userId: 'account-B' }));
    const urlForB = 'https://api.oxy.so/assets/priv1/stream?mt=TOKEN-FOR-B';
    fetchMock.mockResolvedValueOnce(jsonResponse({ url: urlForB, expiresIn: 600 }));

    const resolvedForB = await oxy.assets.url('priv1');
    expect(resolvedForB).toBe(urlForB);
    expect(resolvedForB).not.toBe(urlForA);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
