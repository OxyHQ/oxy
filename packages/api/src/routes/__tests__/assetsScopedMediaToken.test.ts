/**
 * Scoped media token (`?mt=`) end-to-end over the real assets router.
 *
 * Covers the fix for private-asset rendering under zero-cookie: `GET
 * /assets/:id/url` mints a single-asset, short-lived media token for a private
 * asset the caller is allowed to see, and `GET /assets/:id/stream?mt=<token>`
 * accepts it to stream the bytes — while a token for a DIFFERENT asset, an
 * EXPIRED token, and a token for a user WITHOUT access are all denied, and a
 * PUBLIC asset is unchanged (clean CDN url, no token).
 *
 * The asset service singleton, s3, auth/media/rate-limit middleware, and
 * placeholder helpers are stubbed at the module boundary so the router runs over
 * real `node:http` round-trips with no S3 or DB. The media token itself is the
 * REAL crypto: `optionalAuth`'s `getMediaViewerUserId` is backed by the genuine
 * `verifyMediaToken`, and the route mints via the genuine `signMediaToken`.
 */

process.env.ACCESS_TOKEN_SECRET = 'test-access-token-secret';

// The global jest.setup.cjs stubs `jsonwebtoken`; this suite mints and verifies
// REAL media tokens, so restore the genuine module.
jest.mock('jsonwebtoken', () => jest.requireActual('jsonwebtoken'));

import express from 'express';
import http from 'http';
import { Readable } from 'stream';
import type { AddressInfo } from 'net';

const PRIVATE_FILE_ID = '64c0000000000000000000a1';
const OTHER_FILE_ID = '64c0000000000000000000a2';
const PUBLIC_FILE_ID = '64c0000000000000000000a3';
const VIEWER_ID = '69b2d3df5d12f58c9800d651';
const STRANGER_ID = '69b2d3df5d12f58c9800d999';

const mockGetFile = jest.fn();
const mockGetFilesByIds = jest.fn();
const mockCanUserAccessFile = jest.fn();
const mockGetFileUrl = jest.fn();
const mockGetPublicCdnUrl = jest.fn();
const mockEnsureVariant = jest.fn();
const mockFileExists = jest.fn();
const mockGetObjectStreamRange = jest.fn();
const mockRepairMissingFederationFileContent = jest.fn();

// authMiddleware (for /:id/url) authenticates as VIEWER_ID.
jest.mock('../../middleware/auth', () => ({
  authMiddleware: (req: { user?: { _id: string } }, _res: unknown, next: () => void) => {
    req.user = { _id: VIEWER_ID };
    next();
  },
  serviceAuthMiddleware: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

// optionalAuthMiddleware is a pass-through; getMediaViewerUserId uses the REAL
// scoped-token verifier so the single-asset binding is genuinely exercised.
jest.mock('../../middleware/optionalAuth', () => {
  const { verifyMediaToken, MEDIA_TOKEN_QUERY_PARAM } = jest.requireActual('../../utils/mediaToken');
  return {
    optionalAuthMiddleware: (_req: unknown, _res: unknown, next: () => void) => next(),
    getUserId: () => undefined,
    getMediaViewerUserId: (req: {
      query?: Record<string, unknown>;
      params?: Record<string, unknown>;
    }): string | undefined => {
      const token = req.query?.[MEDIA_TOKEN_QUERY_PARAM];
      const id = req.params?.id;
      if (typeof token !== 'string' || token.length === 0) return undefined;
      if (typeof id !== 'string' || id.length === 0) return undefined;
      return verifyMediaToken(token, id);
    },
  };
});

jest.mock('../../middleware/mediaHeaders', () => ({
  mediaHeadersMiddleware: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

jest.mock('../../middleware/rateLimiter', () => ({
  rateLimit: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));

jest.mock('../../utils/placeholders', () => ({
  generateMissingFilePlaceholder: () => '<svg/>',
  TRANSPARENT_PNG_PLACEHOLDER: '',
}));

jest.mock('../../utils/logger', () => ({
  logger: { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

jest.mock('../../utils/validation', () => ({
  isValidObjectId: (id: string) => /^[a-fA-F0-9]{24}$/.test(id),
}));

jest.mock('../../services/assetServiceSingleton', () => ({
  assetService: {
    getFile: (...args: unknown[]) => mockGetFile(...args),
    getFilesByIds: (...args: unknown[]) => mockGetFilesByIds(...args),
    canUserAccessFile: (...args: unknown[]) => mockCanUserAccessFile(...args),
    getFileUrl: (...args: unknown[]) => mockGetFileUrl(...args),
    getPublicCdnUrl: (...args: unknown[]) => mockGetPublicCdnUrl(...args),
    ensureVariant: (...args: unknown[]) => mockEnsureVariant(...args),
    repairMissingFederationFileContent: (...args: unknown[]) =>
      mockRepairMissingFederationFileContent(...args),
  },
}));

jest.mock('../../services/s3ServiceSingleton', () => ({
  s3Service: {
    fileExists: (...args: unknown[]) => mockFileExists(...args),
    getObjectStreamRange: (...args: unknown[]) => mockGetObjectStreamRange(...args),
  },
}));

import assetsRouter from '../assets';
import { errorHandler } from '../../middleware/errorHandler';
import { verifyMediaToken, signMediaToken, MEDIA_TOKEN_TTL_SECONDS } from '../../utils/mediaToken';

interface RawResponse {
  status: number;
  location?: string;
  contentType?: string;
  body: string;
}

async function request(
  server: http.Server,
  path: string,
): Promise<RawResponse> {
  const address = server.address() as AddressInfo;
  return new Promise((resolve, reject) => {
    const req = http.request(
      { method: 'GET', host: '127.0.0.1', port: address.port, path },
      (res) => {
        let raw = '';
        res.on('data', (chunk) => { raw += chunk; });
        res.on('end', () => {
          resolve({
            status: res.statusCode ?? 0,
            location: res.headers.location,
            contentType: res.headers['content-type'],
            body: raw,
          });
        });
      },
    );
    req.on('error', reject);
    req.end();
  });
}

async function postJson(
  server: http.Server,
  path: string,
  payload: unknown,
): Promise<RawResponse> {
  const address = server.address() as AddressInfo;
  const bodyStr = JSON.stringify(payload);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        method: 'POST',
        host: '127.0.0.1',
        port: address.port,
        path,
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(bodyStr) },
      },
      (res) => {
        let raw = '';
        res.on('data', (chunk) => { raw += chunk; });
        res.on('end', () => {
          resolve({
            status: res.statusCode ?? 0,
            location: res.headers.location,
            contentType: res.headers['content-type'],
            body: raw,
          });
        });
      },
    );
    req.on('error', reject);
    req.end(bodyStr);
  });
}

const PRIVATE_FILE = {
  id: PRIVATE_FILE_ID,
  visibility: 'private' as const,
  storageKey: 'content/2026/06/aa/secret.png',
  variants: [],
};

let server: http.Server;

beforeAll((done) => {
  const app = express();
  app.use(express.json());
  app.use('/assets', assetsRouter);
  app.use(errorHandler);
  server = app.listen(0, '127.0.0.1', done);
});

afterAll((done) => {
  server.close(done);
});

beforeEach(() => {
  jest.clearAllMocks();
  mockFileExists.mockResolvedValue(true);
  mockRepairMissingFederationFileContent.mockResolvedValue(false);
  // Access reflects real ownership: only VIEWER_ID may see the private asset.
  mockCanUserAccessFile.mockImplementation((_file: unknown, userId?: string) =>
    Promise.resolve(userId === VIEWER_ID),
  );
});

describe('GET /assets/:id/url — scoped media token minting', () => {
  it('mints an origin stream url carrying a single-asset ?mt= token for a private asset', async () => {
    mockGetFile.mockResolvedValue(PRIVATE_FILE);
    mockGetFileUrl.mockResolvedValue(null); // private → not CDN-reachable

    const res = await request(server, `/assets/${PRIVATE_FILE_ID}/url`);
    expect(res.status).toBe(200);

    const { url } = JSON.parse(res.body).data;
    expect(url).toContain(`/assets/${PRIVATE_FILE_ID}/stream`);
    const mt = new URL(url).searchParams.get('mt');
    expect(mt).toBeTruthy();

    // The minted token authorizes exactly this asset for this viewer …
    expect(verifyMediaToken(mt as string, PRIVATE_FILE_ID)).toBe(VIEWER_ID);
    // … and CANNOT be replayed against another asset.
    expect(verifyMediaToken(mt as string, OTHER_FILE_ID)).toBeUndefined();
  });

  it('reports the media-token TTL (not the requested signed-url expiry) for private assets', async () => {
    mockGetFile.mockResolvedValue(PRIVATE_FILE);
    mockGetFileUrl.mockResolvedValue(null);

    const res = await request(server, `/assets/${PRIVATE_FILE_ID}/url?expiresIn=3600`);
    expect(res.status).toBe(200);

    const { expiresIn } = JSON.parse(res.body).data;
    expect(expiresIn).toBe(MEDIA_TOKEN_TTL_SECONDS);
  });

  it('returns a clean CDN url with NO token for a public asset', async () => {
    mockGetFile.mockResolvedValue({
      id: PUBLIC_FILE_ID,
      visibility: 'public',
      storageKey: 'public/content/2026/06/aa/pub.png',
      variants: [],
    });
    mockGetFileUrl.mockResolvedValue('https://cloud.oxy.so/content/2026/06/aa/pub.png');

    const res = await request(server, `/assets/${PUBLIC_FILE_ID}/url`);
    expect(res.status).toBe(200);

    const { url } = JSON.parse(res.body).data;
    expect(url).toBe('https://cloud.oxy.so/content/2026/06/aa/pub.png');
    expect(url).not.toContain('mt=');
    expect(url).not.toContain('token=');
  });

  it('403s when the authenticated caller cannot access the asset', async () => {
    mockGetFile.mockResolvedValue({ ...PRIVATE_FILE, id: PRIVATE_FILE_ID });
    mockCanUserAccessFile.mockResolvedValue(false);

    const res = await request(server, `/assets/${PRIVATE_FILE_ID}/url`);
    expect(res.status).toBe(403);
    // No token is minted on the denial path.
    expect(res.body).not.toContain('mt=');
  });

  it('does not 500 when CDN resolution throws — falls back to the origin stream URL', async () => {
    mockGetFile.mockResolvedValue({
      id: PUBLIC_FILE_ID,
      visibility: 'public',
      storageKey: 'public/content/2026/06/aa/pub.png',
      variants: [],
    });
    mockGetFileUrl.mockRejectedValue(
      new Error('Failed to download buffer from S3: NoSuchKey: The specified key does not exist.'),
    );

    const res = await request(server, `/assets/${PUBLIC_FILE_ID}/url`);
    expect(res.status).toBe(200);

    const { url } = JSON.parse(res.body).data;
    expect(new URL(url).pathname).toBe(`/assets/${PUBLIC_FILE_ID}/stream`);
    expect(url).not.toContain('cloud.oxy.so');
  });
});

describe('GET /assets/:id/stream — scoped media token acceptance', () => {
  function streamBytes(bytes: string) {
    mockGetObjectStreamRange.mockResolvedValue({
      body: Readable.from([Buffer.from(bytes)]),
      contentType: 'image/png',
      contentLength: bytes.length,
      acceptRanges: 'bytes',
      statusCode: 200,
    });
  }

  it('streams the bytes for a valid mt bound to this asset', async () => {
    mockGetFile.mockResolvedValue(PRIVATE_FILE);
    streamBytes('PRIVATEBYTES');
    const mt = signMediaToken(PRIVATE_FILE_ID, VIEWER_ID);

    const res = await request(server, `/assets/${PRIVATE_FILE_ID}/stream?mt=${encodeURIComponent(mt)}`);

    expect(res.status).toBe(200);
    expect(res.body).toBe('PRIVATEBYTES');
    // The viewer resolved from the token was passed to the access check.
    expect(mockCanUserAccessFile).toHaveBeenCalledWith(PRIVATE_FILE, VIEWER_ID, undefined);
  });

  it('denies an mt minted for a DIFFERENT asset', async () => {
    mockGetFile.mockResolvedValue(PRIVATE_FILE);
    // Token authorizes OTHER_FILE_ID; requested asset is PRIVATE_FILE_ID.
    const mt = signMediaToken(OTHER_FILE_ID, VIEWER_ID);

    const res = await request(server, `/assets/${PRIVATE_FILE_ID}/stream?mt=${encodeURIComponent(mt)}`);

    expect(res.status).toBe(403);
    // Viewer resolved to anonymous → access check ran with undefined.
    expect(mockCanUserAccessFile).toHaveBeenCalledWith(PRIVATE_FILE, undefined, undefined);
    expect(mockGetObjectStreamRange).not.toHaveBeenCalled();
  });

  it('denies an EXPIRED mt', async () => {
    mockGetFile.mockResolvedValue(PRIVATE_FILE);
    jest.useFakeTimers();
    let mt: string;
    try {
      jest.setSystemTime(new Date('2026-01-01T00:00:00Z'));
      mt = signMediaToken(PRIVATE_FILE_ID, VIEWER_ID);
    } finally {
      jest.useRealTimers();
    }

    const res = await request(server, `/assets/${PRIVATE_FILE_ID}/stream?mt=${encodeURIComponent(mt)}`);

    expect(res.status).toBe(403);
    expect(mockGetObjectStreamRange).not.toHaveBeenCalled();
  });

  it('denies an mt whose viewer has no access to the asset', async () => {
    mockGetFile.mockResolvedValue(PRIVATE_FILE);
    // Well-formed, unexpired token — but for a user who is not the owner.
    const mt = signMediaToken(PRIVATE_FILE_ID, STRANGER_ID);

    const res = await request(server, `/assets/${PRIVATE_FILE_ID}/stream?mt=${encodeURIComponent(mt)}`);

    expect(res.status).toBe(403);
    expect(mockCanUserAccessFile).toHaveBeenCalledWith(PRIVATE_FILE, STRANGER_ID, undefined);
    expect(mockGetObjectStreamRange).not.toHaveBeenCalled();
  });
});

describe('POST /assets/batch-access — variant-aware, scoped, per-file', () => {
  const PUBLIC_FILE = {
    id: PUBLIC_FILE_ID,
    visibility: 'public' as const,
    storageKey: 'public/content/2026/06/aa/pub.png',
    mime: 'image/png',
    variants: [],
  };

  beforeEach(() => {
    // Public asset → CDN url for the requested variant; private → origin (null).
    mockGetFileUrl.mockImplementation((fileId: string, variant?: string) => {
      if (fileId === PUBLIC_FILE_ID) {
        const vq = variant ? `?variant=${encodeURIComponent(variant)}` : '';
        return Promise.resolve(`https://cloud.oxy.so/${fileId}${vq}`);
      }
      return Promise.resolve(null);
    });
  });

  it('resolves a mixed public/private batch — scoped mt for private, CDN for public, both variant-aware', async () => {
    mockGetFilesByIds.mockResolvedValue([
      { ...PRIVATE_FILE, mime: 'image/jpeg' },
      PUBLIC_FILE,
    ]);

    const res = await postJson(server, '/assets/batch-access', {
      files: [
        { fileId: PRIVATE_FILE_ID, variant: 'thumb' },
        { fileId: PUBLIC_FILE_ID, variant: 'poster' },
      ],
      context: 'file-manager',
    });

    expect(res.status).toBe(200);
    const { results } = JSON.parse(res.body).data;

    // Private tile → our-origin scoped stream url with the requested variant.
    const priv = results[PRIVATE_FILE_ID];
    expect(priv.allowed).toBe(true);
    expect(priv.visibility).toBe('private');
    const privUrl = new URL(priv.url);
    expect(privUrl.pathname).toBe(`/assets/${PRIVATE_FILE_ID}/stream`);
    expect(privUrl.searchParams.get('variant')).toBe('thumb');
    const mt = privUrl.searchParams.get('mt');
    expect(verifyMediaToken(mt as string, PRIVATE_FILE_ID)).toBe(VIEWER_ID);
    // Single-asset scope: this batch token must not open the public asset id.
    expect(verifyMediaToken(mt as string, PUBLIC_FILE_ID)).toBeUndefined();

    // Public tile → clean CDN url with the requested variant, no token.
    const pub = results[PUBLIC_FILE_ID];
    expect(pub.allowed).toBe(true);
    expect(pub.url).toBe(`https://cloud.oxy.so/${PUBLIC_FILE_ID}?variant=poster`);
    expect(pub.url).not.toContain('mt=');

    // A bare label context carries no entity gate (parsed to undefined).
    expect(mockCanUserAccessFile).toHaveBeenCalledWith(expect.any(Object), VIEWER_ID, undefined);
  });

  it('omits a url for a file the caller cannot access, and the batch still 200s', async () => {
    mockGetFilesByIds.mockResolvedValue([PRIVATE_FILE, PUBLIC_FILE]);
    // Deny only the private file; allow the public one.
    mockCanUserAccessFile.mockImplementation((file: { id: string }) =>
      Promise.resolve(file.id === PUBLIC_FILE_ID),
    );

    const res = await postJson(server, '/assets/batch-access', {
      files: [{ fileId: PRIVATE_FILE_ID }, { fileId: PUBLIC_FILE_ID }],
    });

    expect(res.status).toBe(200);
    const { results } = JSON.parse(res.body).data;
    expect(results[PRIVATE_FILE_ID]).toEqual({ allowed: false, error: 'Access denied' });
    expect(results[PRIVATE_FILE_ID].url).toBeUndefined();
    expect(results[PUBLIC_FILE_ID].allowed).toBe(true);
    expect(results[PUBLIC_FILE_ID].url).toBeTruthy();
  });

  it('marks an unknown id as not found without failing the batch', async () => {
    mockGetFilesByIds.mockResolvedValue([PRIVATE_FILE]); // OTHER_FILE_ID missing

    const res = await postJson(server, '/assets/batch-access', {
      files: [{ fileId: PRIVATE_FILE_ID, variant: 'thumb' }, { fileId: OTHER_FILE_ID }],
    });

    expect(res.status).toBe(200);
    const { results } = JSON.parse(res.body).data;
    expect(results[PRIVATE_FILE_ID].allowed).toBe(true);
    expect(results[OTHER_FILE_ID]).toEqual({ allowed: false, error: 'File not found' });
  });

  it('threads the requested variant + expiresIn into getFileUrl', async () => {
    mockGetFilesByIds.mockResolvedValue([PRIVATE_FILE]);

    await postJson(server, '/assets/batch-access', {
      files: [{ fileId: PRIVATE_FILE_ID, variant: 'thumb' }],
      expiresIn: 600,
    });

    expect(mockGetFileUrl).toHaveBeenCalledWith(PRIVATE_FILE_ID, 'thumb', 600, expect.any(Object));
  });

  it('does not 500 the batch when one file throws resolving its URL — falls back to the origin stream URL', async () => {
    mockGetFilesByIds.mockResolvedValue([PUBLIC_FILE, { ...PRIVATE_FILE, mime: 'image/jpeg' }]);
    // The public tile's CDN resolution throws (e.g. on-demand variant
    // generation hits a missing S3 original → NoSuchKey). The whole batch must
    // still 200 and the throwing file stays allowed with an origin fallback URL.
    mockGetFileUrl.mockImplementation((fileId: string) => {
      if (fileId === PUBLIC_FILE_ID) {
        return Promise.reject(
          new Error('Failed to download buffer from S3: NoSuchKey: The specified key does not exist.'),
        );
      }
      return Promise.resolve(null);
    });

    const res = await postJson(server, '/assets/batch-access', {
      files: [
        { fileId: PUBLIC_FILE_ID, variant: 'thumb' },
        { fileId: PRIVATE_FILE_ID, variant: 'thumb' },
      ],
    });

    expect(res.status).toBe(200);
    const { results } = JSON.parse(res.body).data;

    // The throwing file is still allowed and gets an our-origin stream URL.
    const broken = results[PUBLIC_FILE_ID];
    expect(broken.allowed).toBe(true);
    expect(new URL(broken.url).pathname).toBe(`/assets/${PUBLIC_FILE_ID}/stream`);

    // The other tile resolves normally in the same batch.
    expect(results[PRIVATE_FILE_ID].allowed).toBe(true);
    expect(new URL(results[PRIVATE_FILE_ID].url).pathname).toBe(`/assets/${PRIVATE_FILE_ID}/stream`);
  });

  it('rejects a batch over the 100-file cap with 400', async () => {
    const files = Array.from({ length: 101 }, (_v, i) => ({
      fileId: `64c00000000000000000${String(1000 + i)}`,
    }));

    const res = await postJson(server, '/assets/batch-access', { files });

    expect(res.status).toBe(400);
    // Never reaches the service.
    expect(mockGetFilesByIds).not.toHaveBeenCalled();
  });
});
