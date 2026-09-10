/**
 * `GET /cdn/:id` public CDN-origin resolver behavior.
 *
 * This is the origin endpoint behind the `cloud.oxy.so/<id>` CloudFront
 * behavior (CloudFront `OriginPath = /cdn`). It serves ONLY public, CDN-backed
 * assets and must never expose private bytes or 500:
 *
 *   1. A PUBLIC, CDN-backed file 302-redirects to its `cloud.oxy.so` URL with a
 *      cacheable `Cache-Control`, variant-aware (`?variant=thumb` resolves the
 *      thumb URL, not the original).
 *   2. A PRIVATE file resolves to 404 — `getPublicCdnUrl` returns null and no
 *      bytes are ever streamed here.
 *   3. A non-active file resolves to 404 before any CDN probe.
 *   4. A missing/unknown id resolves to 404.
 *   5. A public file with no CDN-reachable copy (probe returns null) → 404.
 *   6. A throwing CDN probe degrades to 404, never 500.
 *
 * The asset service singleton, validate middleware, and logger are stubbed at
 * the module boundary so the router runs over real `node:http` round-trips with
 * no S3 or DB. Mirrors the `assetsStreamCdn.test.ts` harness idiom.
 */

import express from 'express';
import http from 'http';
import type { AddressInfo } from 'net';

const PUBLIC_FILE_ID = '64c0000000000000000000b1';
const PRIVATE_FILE_ID = '64c0000000000000000000b2';
const TRASHED_FILE_ID = '64c0000000000000000000b5';
const NO_COPY_FILE_ID = '64c0000000000000000000b3';
const PROBE_THROWS_FILE_ID = '64c0000000000000000000b4';

const ORIGINAL_CDN_URL =
  'https://cloud.oxy.so/content/2026/03/bb/bb7a29b85077cd58d945959b017bc954.png';
const THUMB_CDN_URL =
  'https://cloud.oxy.so/variants/2026/03/bb/bb7a29b85077cd58d945959b017bc954/thumb.webp';

const mockGetFile = jest.fn();
const mockGetPublicCdnUrl = jest.fn();

jest.mock('../../services/assetServiceSingleton', () => ({
  assetService: {
    getFile: (...args: unknown[]) => mockGetFile(...args),
    getPublicCdnUrl: (...args: unknown[]) => mockGetPublicCdnUrl(...args),
  },
  s3Service: {},
}));

jest.mock('../../utils/logger', () => ({
  logger: { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

import cdnRouter from '../cdn';
import { errorHandler } from '../../middleware/errorHandler';

interface RawResponse {
  status: number;
  location?: string;
  cacheControl?: string;
  acceptRanges?: string;
  body: string;
}

/** Issue a request WITHOUT following redirects so we can assert the 302 itself. */
async function requestNoFollow(
  server: http.Server,
  path: string,
  headers: http.OutgoingHttpHeaders = {}
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
            acceptRanges: res.headers['accept-ranges'],
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
  app.use('/cdn', cdnRouter);
  app.use(errorHandler);
  server = app.listen(0, '127.0.0.1', done);
});

afterAll((done) => {
  server.close(done);
});

beforeEach(() => {
  jest.clearAllMocks();
});

describe('GET /cdn/:id — public CDN origin resolver', () => {
  it('carries no body and declares that ranges do not apply', async () => {
    // The redirect is cached at the edge for an hour, and CloudFront answered
    // RANGED requests out of that cached redirect BODY:
    //
    //   GET cloud.oxy.so/<id>  Range: bytes=1000000-
    //   → 416, content-range: bytes */130, x-cache: Error from cloudfront
    //
    // A video player re-opens its source at a non-zero offset on every seek and
    // resume, so that 416 reached Mention's reel as ExoPlayer's `Source error`
    // and painted "Video unavailable" over a local Oxy video that was fine.
    // Nothing to slice, and a header that says so.
    mockGetFile.mockResolvedValue({
      _id: PUBLIC_FILE_ID,
      status: 'active',
      visibility: 'public',
      storageKey: 'public/content/2026/03/bb/bb7a29b85077cd58d945959b017bc954.png',
    });
    mockGetPublicCdnUrl.mockResolvedValue(ORIGINAL_CDN_URL);

    const res = await requestNoFollow(server, `/cdn/${PUBLIC_FILE_ID}`);

    expect(res.status).toBe(302);
    expect(res.location).toBe(ORIGINAL_CDN_URL);
    expect(res.acceptRanges).toBe('none');
    expect(res.body).toBe('');
  });

  it('answers a RANGED request with the redirect, never a 416', async () => {
    // The origin must not develop its own opinion about ranges either: a range
    // header on a redirect is meaningless, not an error.
    mockGetFile.mockResolvedValue({
      _id: PUBLIC_FILE_ID,
      status: 'active',
      visibility: 'public',
      storageKey: 'public/content/2026/03/bb/bb7a29b85077cd58d945959b017bc954.png',
    });
    mockGetPublicCdnUrl.mockResolvedValue(ORIGINAL_CDN_URL);

    const res = await requestNoFollow(server, `/cdn/${PUBLIC_FILE_ID}`, {
      Range: 'bytes=1000000-',
    });

    expect(res.status).toBe(302);
    expect(res.location).toBe(ORIGINAL_CDN_URL);
    expect(res.acceptRanges).toBe('none');
  });

  it('302s a public CDN-backed file to its cloud.oxy.so URL with Cache-Control', async () => {
    mockGetFile.mockResolvedValue({
      _id: PUBLIC_FILE_ID,
      status: 'active',
      visibility: 'public',
      storageKey: 'public/content/2026/03/bb/bb7a29b85077cd58d945959b017bc954.png',
    });
    mockGetPublicCdnUrl.mockResolvedValue(ORIGINAL_CDN_URL);

    const res = await requestNoFollow(server, `/cdn/${PUBLIC_FILE_ID}`);

    expect(res.status).toBe(302);
    expect(res.location).toBe(ORIGINAL_CDN_URL);
    expect(res.cacheControl).toContain('public, max-age=');
    // Original requested → probe called with no variant.
    expect(mockGetPublicCdnUrl).toHaveBeenCalledWith(expect.any(Object), undefined);
  });

  it('keeps the 302 hard-fresh for an hour but lets a client paint from a stale one', async () => {
    // Two properties in one header, and they pull opposite ways.
    //
    // `max-age` is SHORT on purpose: this 302 is the only place the status and
    // visibility check runs — the 404 cases in this suite — so its freshness
    // window is exactly how long a just-deleted or just-privatised asset keeps
    // resolving for a client that already holds the redirect. Raising it trades
    // that away, which is why the fix for the round trip is the second
    // directive and not a bigger number here.
    //
    // `stale-while-revalidate` removes the once-an-hour BLOCKING round trip per
    // asset without touching the freshness bound: the client paints from the
    // stale redirect and refreshes it in the background, so a revoked asset is
    // corrected after one more render rather than after another whole `max-age`.
    mockGetFile.mockResolvedValue({
      _id: PUBLIC_FILE_ID,
      status: 'active',
      visibility: 'public',
      storageKey: 'public/content/2026/03/bb/bb7a29b85077cd58d945959b017bc954.png',
    });
    mockGetPublicCdnUrl.mockResolvedValue(ORIGINAL_CDN_URL);

    const res = await requestNoFollow(server, `/cdn/${PUBLIC_FILE_ID}`);

    expect(res.cacheControl).toBe('public, max-age=3600, stale-while-revalidate=86400');
  });

  it('is variant-aware: ?variant=thumb resolves the thumb CDN URL', async () => {
    mockGetFile.mockResolvedValue({
      _id: PUBLIC_FILE_ID,
      status: 'active',
      visibility: 'public',
      storageKey: 'public/content/2026/03/bb/bb7a29b85077cd58d945959b017bc954.png',
    });
    mockGetPublicCdnUrl.mockResolvedValue(THUMB_CDN_URL);

    const res = await requestNoFollow(server, `/cdn/${PUBLIC_FILE_ID}?variant=thumb`);

    expect(res.status).toBe(302);
    expect(res.location).toBe(THUMB_CDN_URL);
    expect(mockGetPublicCdnUrl).toHaveBeenCalledWith(expect.any(Object), 'thumb');
  });

  /**
   * A repeated `?variant=` arrives from `qs` as an ARRAY, and the
   * `typeof … === 'string'` test that stood here read that as ABSENT — which
   * does not 404, it resolves the ORIGINAL. Measured against production:
   * `?variant=w96&variant=w96` redirected to `/content/…` (the full-resolution
   * file) where a single `?variant=w96` redirects to `/variants/…`, and the CDN
   * then caches the original as the answer for that URL. The assertion is on the
   * ARGUMENT the service receives, because both outcomes are a 302.
   */
  it('honours a repeated ?variant= instead of silently resolving the original', async () => {
    mockGetFile.mockResolvedValue({
      _id: PUBLIC_FILE_ID,
      status: 'active',
      visibility: 'public',
      storageKey: 'public/content/2026/03/bb/bb7a29b85077cd58d945959b017bc954.png',
    });
    mockGetPublicCdnUrl.mockResolvedValue(THUMB_CDN_URL);

    const res = await requestNoFollow(
      server,
      `/cdn/${PUBLIC_FILE_ID}?variant=thumb&variant=thumb`,
    );

    expect(res.status).toBe(302);
    expect(mockGetPublicCdnUrl).toHaveBeenCalledWith(expect.any(Object), 'thumb');
  });

  // Two DIFFERENT values are a malformed request either way; last-wins is the
  // conventional reading and, unlike "absent", it cannot widen what is served.
  it('takes the last value when a repeated ?variant= disagrees with itself', async () => {
    mockGetFile.mockResolvedValue({
      _id: PUBLIC_FILE_ID,
      status: 'active',
      visibility: 'public',
      storageKey: 'public/content/2026/03/bb/bb7a29b85077cd58d945959b017bc954.png',
    });
    mockGetPublicCdnUrl.mockResolvedValue(THUMB_CDN_URL);

    await requestNoFollow(server, `/cdn/${PUBLIC_FILE_ID}?variant=w2048&variant=thumb`);

    expect(mockGetPublicCdnUrl).toHaveBeenCalledWith(expect.any(Object), 'thumb');
  });

  it('404s a private file (never streams private bytes, never redirects)', async () => {
    mockGetFile.mockResolvedValue({
      _id: PRIVATE_FILE_ID,
      status: 'active',
      visibility: 'private',
      storageKey: 'content/2026/06/cc/secret.png',
    });
    // Service contract: private assets resolve to null.
    mockGetPublicCdnUrl.mockResolvedValue(null);

    const res = await requestNoFollow(server, `/cdn/${PRIVATE_FILE_ID}`);

    expect(res.status).toBe(404);
    expect(res.location).toBeUndefined();
  });

  it('404s a trashed public CDN-backed file before consulting the CDN probe', async () => {
    mockGetFile.mockResolvedValue({
      _id: TRASHED_FILE_ID,
      status: 'trash',
      visibility: 'public',
      storageKey: 'public/content/2026/03/bb/bb7a29b85077cd58d945959b017bc954.png',
    });
    mockGetPublicCdnUrl.mockResolvedValue(ORIGINAL_CDN_URL);

    const res = await requestNoFollow(server, `/cdn/${TRASHED_FILE_ID}`);

    expect(res.status).toBe(404);
    expect(res.location).toBeUndefined();
    expect(mockGetPublicCdnUrl).not.toHaveBeenCalled();
  });

  it('404s a missing/unknown id (no probe consulted)', async () => {
    mockGetFile.mockResolvedValue(null);

    const res = await requestNoFollow(server, `/cdn/${NO_COPY_FILE_ID}`);

    expect(res.status).toBe(404);
    expect(res.location).toBeUndefined();
    expect(mockGetPublicCdnUrl).not.toHaveBeenCalled();
  });

  it('404s a public file with no CDN-reachable copy (probe returns null)', async () => {
    mockGetFile.mockResolvedValue({
      _id: NO_COPY_FILE_ID,
      status: 'active',
      visibility: 'public',
      storageKey: 'content/2026/03/dd/legacy.png',
    });
    mockGetPublicCdnUrl.mockResolvedValue(null);

    const res = await requestNoFollow(server, `/cdn/${NO_COPY_FILE_ID}`);

    expect(res.status).toBe(404);
    expect(res.location).toBeUndefined();
  });

  it('404s (never 500s) when the CDN probe throws', async () => {
    mockGetFile.mockResolvedValue({
      _id: PROBE_THROWS_FILE_ID,
      status: 'active',
      visibility: 'public',
      storageKey: 'public/content/2026/03/ee/x.png',
    });
    mockGetPublicCdnUrl.mockRejectedValue(new Error('S3 head failed'));

    const res = await requestNoFollow(server, `/cdn/${PROBE_THROWS_FILE_ID}`);

    expect(res.status).toBe(404);
    expect(res.location).toBeUndefined();
  });
});
