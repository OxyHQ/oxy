/**
 * `GET /assets/:id/stream` CDN-redirect behavior.
 *
 * Exercises the public-media serving rule that no media bytes ever leave
 * `api.oxy.so` once a CDN-reachable (`public/`-prefixed) copy exists:
 *
 *   1. A PUBLIC, legacy-backfilled file whose DB `storageKey` still points at a
 *      non-public key (`content/..`) but whose bytes were copied under `public/`
 *      302-redirects to `cloud.oxy.so`, VARIANT-AWARE — `?variant=thumb` yields
 *      the thumb CDN URL, not the original.
 *   2. A PUBLIC file already keyed under `public/` 302s via the fast path and
 *      never probes S3 for a public copy.
 *   3. A PRIVATE file is streamed through our own origin (no CDN redirect),
 *      preserving authorize-then-stream behavior.
 *   4. When the public-CDN probe throws, the request degrades to origin
 *      streaming rather than 500-ing.
 *
 * The asset service singleton, auth middlewares, rate limiter, media-headers,
 * and placeholder helpers are stubbed at the module boundary so the router runs
 * over real `node:http` round-trips with no S3 or DB.
 */

import express from 'express';
import http from 'http';
import { Readable } from 'stream';
import type { AddressInfo } from 'net';

const LEGACY_PUBLIC_FILE_ID = '64c0000000000000000000a1';
const PREFIXED_PUBLIC_FILE_ID = '64c0000000000000000000a2';
const PRIVATE_FILE_ID = '64c0000000000000000000a3';
const PROBE_THROWS_FILE_ID = '64c0000000000000000000a4';

const THUMB_CDN_URL =
  'https://cloud.oxy.so/variants/2026/03/bb/bb7a29b85077cd58d945959b017bc954/thumb.webp';

const mockGetFile = jest.fn();
const mockCanUserAccessFile = jest.fn();
const mockEnsureVariant = jest.fn();
const mockGetPublicCdnUrl = jest.fn();
const mockFileExists = jest.fn();
const mockGetObjectStreamRange = jest.fn();
const mockRepairMissingFederationFileContent = jest.fn();

jest.mock('../../middleware/auth', () => ({
  authMiddleware: (_req: unknown, _res: unknown, next: () => void) => next(),
  serviceAuthMiddleware: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

jest.mock('../../middleware/optionalAuth', () => ({
  optionalAuthMiddleware: (_req: unknown, _res: unknown, next: () => void) => next(),
  getUserId: () => undefined,
  // The stream/download routes resolve the viewer via getMediaViewerUserId
  // (session user OR `?token=` owner). These CDN-redirect tests issue
  // tokenless requests → anonymous viewer.
  getMediaViewerUserId: () => undefined,
}));

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
    canUserAccessFile: (...args: unknown[]) => mockCanUserAccessFile(...args),
    ensureVariant: (...args: unknown[]) => mockEnsureVariant(...args),
    getPublicCdnUrl: (...args: unknown[]) => mockGetPublicCdnUrl(...args),
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

interface RawResponse {
  status: number;
  location?: string;
  cacheControl?: string;
  body: string;
}

/** Issue a request WITHOUT following redirects so we can assert the 302 itself. */
async function requestNoFollow(
  server: http.Server,
  path: string,
  headers: Record<string, string> = {}
): Promise<RawResponse> {
  const address = server.address() as AddressInfo;
  return new Promise((resolve, reject) => {
    const req = http.request(
      { method: 'GET', host: '127.0.0.1', port: address.port, path, headers },
      (res) => {
        let raw = '';
        res.on('data', (chunk) => { raw += chunk; });
        res.on('end', () => {
          resolve({
            status: res.statusCode ?? 0,
            location: res.headers.location,
            cacheControl: res.headers['cache-control'],
            body: raw,
          });
        });
      }
    );
    req.on('error', reject);
    req.end();
  });
}

let server: http.Server;

beforeAll((done) => {
  const app = express();
  app.use('/assets', assetsRouter);
  app.use(errorHandler);
  server = app.listen(0, '127.0.0.1', done);
});

afterAll((done) => {
  server.close(done);
});

beforeEach(() => {
  jest.clearAllMocks();
  // Default: access allowed; source object exists; no federation repair needed.
  mockCanUserAccessFile.mockResolvedValue(true);
  mockFileExists.mockResolvedValue(true);
  mockRepairMissingFederationFileContent.mockResolvedValue(false);
});

describe('GET /assets/:id/stream — public CDN redirect', () => {
  it('302s a legacy-backfilled public file to the variant CDN URL (thumb)', async () => {
    mockGetFile.mockResolvedValue({
      _id: LEGACY_PUBLIC_FILE_ID,
      visibility: 'public',
      storageKey: 'content/2026/03/bb/bb7a29b85077cd58d945959b017bc954.png',
      variants: [{ type: 'thumb', key: 'variants/2026/03/bb/bb7a29b85077cd58d945959b017bc954/thumb.webp' }],
    });
    // Variant resolution yields the (still non-public) variant key.
    mockEnsureVariant.mockResolvedValue({
      key: 'variants/2026/03/bb/bb7a29b85077cd58d945959b017bc954/thumb.webp',
    });
    // The public/ copy exists → probe returns the cloud.oxy.so URL for `thumb`.
    mockGetPublicCdnUrl.mockResolvedValue(THUMB_CDN_URL);

    const res = await requestNoFollow(server, `/assets/${LEGACY_PUBLIC_FILE_ID}/stream?variant=thumb`);

    expect(res.status).toBe(302);
    expect(res.location).toBe(THUMB_CDN_URL);
    expect(res.cacheControl).toContain('public, max-age=');
    // Variant-aware: the probe was asked for the SAME variant the client wants.
    expect(mockGetPublicCdnUrl).toHaveBeenCalledWith(expect.any(Object), 'thumb');
    // Never streamed bytes through our origin.
    expect(mockGetObjectStreamRange).not.toHaveBeenCalled();
  });

  it('302s a file already keyed under public/ via the fast path (no CDN probe)', async () => {
    mockGetFile.mockResolvedValue({
      _id: PREFIXED_PUBLIC_FILE_ID,
      visibility: 'public',
      storageKey: 'public/content/2026/06/aa/aaaa.png',
      variants: [],
    });

    const res = await requestNoFollow(server, `/assets/${PREFIXED_PUBLIC_FILE_ID}/stream`);

    expect(res.status).toBe(302);
    expect(res.location).toBe('https://cloud.oxy.so/content/2026/06/aa/aaaa.png');
    // Fast path: the public-copy probe is NOT consulted for already-public keys.
    expect(mockGetPublicCdnUrl).not.toHaveBeenCalled();
    expect(mockGetObjectStreamRange).not.toHaveBeenCalled();
  });

  it('streams a private file through our origin (never a CDN redirect)', async () => {
    mockGetFile.mockResolvedValue({
      _id: PRIVATE_FILE_ID,
      visibility: 'private',
      storageKey: 'content/2026/06/cc/secret.png',
      variants: [],
    });
    mockGetObjectStreamRange.mockResolvedValue({
      body: Readable.from([Buffer.from('PRIVATEBYTES')]),
      contentType: 'image/png',
      contentLength: 12,
      acceptRanges: 'bytes',
      statusCode: 200,
    });

    const res = await requestNoFollow(server, `/assets/${PRIVATE_FILE_ID}/stream`);

    expect(res.status).toBe(200);
    expect(res.location).toBeUndefined();
    expect(res.body).toBe('PRIVATEBYTES');
    // Private assets must never consult the public-CDN probe.
    expect(mockGetPublicCdnUrl).not.toHaveBeenCalled();
    expect(mockGetObjectStreamRange).toHaveBeenCalledTimes(1);
  });

  it('returns 404 when a requested variant cannot be ensured (never streams the original)', async () => {
    mockGetFile.mockResolvedValue({
      _id: PRIVATE_FILE_ID,
      visibility: 'private',
      storageKey: 'content/2026/06/vv/video.mp4',
      mimeType: 'video/mp4',
      variants: [],
    });
    mockEnsureVariant.mockRejectedValue(new Error('poster ffmpeg timed out'));

    const res = await requestNoFollow(server, `/assets/${PRIVATE_FILE_ID}/stream?variant=thumb`);

    expect(res.status).toBe(404);
    expect(mockGetObjectStreamRange).not.toHaveBeenCalled();
  });

  it('serves a placeholder when variant ensure fails and fallback=icon is requested', async () => {
    mockGetFile.mockResolvedValue({
      _id: PRIVATE_FILE_ID,
      visibility: 'private',
      storageKey: 'content/2026/06/vv/video.mp4',
      mimeType: 'video/mp4',
      variants: [],
    });
    mockEnsureVariant.mockRejectedValue(new Error('poster ffmpeg timed out'));

    const res = await requestNoFollow(
      server,
      `/assets/${PRIVATE_FILE_ID}/stream?variant=thumb&fallback=icon`,
    );

    expect(res.status).toBe(200);
    expect(res.body).toBe('<svg/>');
    expect(mockGetObjectStreamRange).not.toHaveBeenCalled();
  });

  it('degrades to origin streaming when the public-CDN probe throws', async () => {
    mockGetFile.mockResolvedValue({
      _id: PROBE_THROWS_FILE_ID,
      visibility: 'public',
      storageKey: 'content/2026/03/dd/legacy.png',
      variants: [],
    });
    mockGetPublicCdnUrl.mockRejectedValue(new Error('S3 head failed'));
    mockGetObjectStreamRange.mockResolvedValue({
      body: Readable.from([Buffer.from('ORIGINBYTES')]),
      contentType: 'image/png',
      contentLength: 11,
      acceptRanges: 'bytes',
      statusCode: 200,
    });

    const res = await requestNoFollow(server, `/assets/${PROBE_THROWS_FILE_ID}/stream`);

    expect(res.status).toBe(200);
    expect(res.location).toBeUndefined();
    expect(res.body).toBe('ORIGINBYTES');
    expect(mockGetPublicCdnUrl).toHaveBeenCalledTimes(1);
    expect(mockGetObjectStreamRange).toHaveBeenCalledTimes(1);
  });
});
