/**
 * Service-token media-cache scoping tests.
 *
 * Covers the federation media-cache surface added to the assets router:
 *   - POST   /assets/service/cache         (service token uploads cached media)
 *   - DELETE /assets/service/cache/:id      (service token evicts cache objects)
 *
 * Security invariants exercised:
 *   1. A service token CAN upload to the cache namespace → `{ file: { id } }`.
 *   2. An unsupported content-type is rejected with 415.
 *   3. A service token CAN delete a cache-namespace asset.
 *   4. A service token CANNOT delete a normal user-owned asset → 403.
 *   5. The existing session-only routes (POST /assets/upload, DELETE
 *      /assets/:id) still run through authMiddleware (NOT serviceAuthMiddleware)
 *      — i.e. a service token does not reach them.
 *
 * The asset service singleton, both auth middlewares, the rate limiter, and
 * the media/placeholder helpers are stubbed at the module boundary so the
 * router is exercised over real `node:http` round-trips with no S3 or DB.
 */

import express from 'express';
import http from 'http';
import type { Readable } from 'stream';
import type { AddressInfo } from 'net';

const CACHE_FILE_ID = '64c0000000000000000000ff';
const USER_FILE_ID = '64c0000000000000000000aa';
const FEDERATED_OWNER_ID = '64d0000000000000000000bb';
const LOCAL_OWNER_ID = '64e0000000000000000000cc';
/**
 * An id of the right SHAPE that names no account. The route used to reject this
 * at a `isValidObjectId` gate; it now simply matches no row and takes the same
 * "not an existing federated/local user" 403 the endpoint already gave, so the
 * absent-owner case is exercised by an absent OWNER rather than by a mock
 * returning null.
 */
const UNKNOWN_OWNER_ID = '64f0000000000000000000dd';

// A body larger than the global 1 MiB JSON/urlencoded parser limit. If C1's
// guard failed to bypass those parsers, the stream would be truncated/rejected.
const LARGE_BODY_BYTES = Math.floor(1.5 * 1024 * 1024);

const mockServiceAuthMiddleware = jest.fn();
const mockAuthMiddleware = jest.fn();
const mockOptionalAuthMiddleware = jest.fn();

const mockUploadCachedMediaStream = jest.fn();
const mockUploadFederatedMediaStream = jest.fn();
const mockUploadUserMediaStream = jest.fn();
const mockDeleteCachedMedia = jest.fn();
const mockUploadFileDirect = jest.fn();
const mockGetDeletionSummary = jest.fn();
const mockDeleteFile = jest.fn();
const mockGetFilesByIds = jest.fn();
const mockFindActiveFilesBySha256 = jest.fn();
const mockGetPublicCdnUrl = jest.fn();

jest.mock('../../middleware/auth', () => ({
  authMiddleware: (...args: unknown[]) => mockAuthMiddleware(...args),
  serviceAuthMiddleware: (...args: unknown[]) => mockServiceAuthMiddleware(...args),
}));

jest.mock('../../middleware/optionalAuth', () => ({
  optionalAuthMiddleware: (...args: unknown[]) => mockOptionalAuthMiddleware(...args),
  getUserId: () => undefined,
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

jest.mock('../../services/assetServiceSingleton', () => ({
  assetService: {
    uploadCachedMediaStream: (...args: unknown[]) => mockUploadCachedMediaStream(...args),
    uploadFederatedMediaStream: (...args: unknown[]) => mockUploadFederatedMediaStream(...args),
    uploadUserMediaStream: (...args: unknown[]) => mockUploadUserMediaStream(...args),
    deleteCachedMedia: (...args: unknown[]) => mockDeleteCachedMedia(...args),
    uploadFileDirect: (...args: unknown[]) => mockUploadFileDirect(...args),
    getDeletionSummary: (...args: unknown[]) => mockGetDeletionSummary(...args),
    deleteFile: (...args: unknown[]) => mockDeleteFile(...args),
    getFilesByIds: (...args: unknown[]) => mockGetFilesByIds(...args),
    findActiveFilesBySha256: (...args: unknown[]) => mockFindActiveFilesBySha256(...args),
    getPublicCdnUrl: (...args: unknown[]) => mockGetPublicCdnUrl(...args),
  },
  s3Service: {},
}));

import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { users } from '../../db/schema';
import assetsRouter from '../assets';
import { errorHandler } from '../../middleware/errorHandler';

interface AssetMetadata {
  id: string;
  sha256: string;
  mime: string;
  size: number;
  status: string;
}

interface AssetMetadataBySha {
  sha256: string;
  id: string;
  mime: string;
  size: number;
  status: string;
  url?: string;
}

interface JsonResponse {
  status: number;
  body: {
    data?:
      | { file?: { id?: string; sha256?: string }; message?: string }
      | AssetMetadata[]
      | AssetMetadataBySha[];
    error?: string;
    message?: string;
  };
}

async function requestRaw(
  server: http.Server,
  method: string,
  path: string,
  headers: Record<string, string>,
  payload?: Buffer
): Promise<JsonResponse> {
  const address = server.address() as AddressInfo;
  return new Promise((resolve, reject) => {
    const req = http.request(
      { method, host: '127.0.0.1', port: address.port, path, headers },
      (res) => {
        let raw = '';
        res.on('data', (chunk) => { raw += chunk; });
        res.on('end', () => {
          try {
            const parsed = raw.length > 0 ? JSON.parse(raw) : {};
            resolve({ status: res.statusCode ?? 0, body: parsed });
          } catch (err) {
            reject(err);
          }
        });
      }
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

let server: http.Server;

// Faithful replica of the production C1 guard (server.ts). The cache stream-
// upload route reads the raw request itself, so the global body parsers (and
// their 1 MiB limit) MUST be bypassed for POST to the cache path. The `/api`
// prefix strip runs after parsing in production, hence both forms are matched.
const CACHE_UPLOAD_PATH = '/assets/service/cache';
const CACHE_UPLOAD_PATH_API_PREFIXED = '/api/assets/service/cache';
const FEDERATION_UPLOAD_PATH = '/assets/service/federation';
const FEDERATION_UPLOAD_PATH_API_PREFIXED = '/api/assets/service/federation';
const USER_MEDIA_UPLOAD_PATH = '/assets/service/user-media';
const USER_MEDIA_UPLOAD_PATH_API_PREFIXED = '/api/assets/service/user-media';
function isCacheUploadRequest(req: express.Request): boolean {
  return (
    req.method === 'POST' &&
    (
      req.path === CACHE_UPLOAD_PATH ||
      req.path === CACHE_UPLOAD_PATH_API_PREFIXED ||
      req.path === FEDERATION_UPLOAD_PATH ||
      req.path === FEDERATION_UPLOAD_PATH_API_PREFIXED ||
      req.path === USER_MEDIA_UPLOAD_PATH ||
      req.path === USER_MEDIA_UPLOAD_PATH_API_PREFIXED
    )
  );
}

beforeAll((done) => {
  const app = express();
  // Mirror production exactly: both global parsers are mounted with the C1
  // guard so a POST to the cache path bypasses them and the raw request reaches
  // the route as an untouched readable stream; every other request is parsed.
  const jsonParser = express.json({ limit: '1mb' });
  const urlencodedParser = express.urlencoded({ extended: true, limit: '1mb' });
  app.use((req, res, next) => (isCacheUploadRequest(req) ? next() : jsonParser(req, res, next)));
  app.use((req, res, next) => (isCacheUploadRequest(req) ? next() : urlencodedParser(req, res, next)));
  app.use('/assets', assetsRouter);
  app.use(errorHandler);
  server = app.listen(0, '127.0.0.1', done);
});

beforeAll(async () => {
  await connectPostgres();
  // `users.id` is `text`, so a test supplies the ids it asserts on. The route
  // resolves the owner against these REAL rows — including `type`, which is the
  // discriminator the two endpoints differ on.
  await getDb()
    .insert(users)
    .values([
      { id: FEDERATED_OWNER_ID, color: 'teal', type: 'federated' },
      { id: LOCAL_OWNER_ID, color: 'teal', type: 'local' },
    ])
    .onConflictDoNothing();
});

afterAll(async () => {
  await closePostgres();
});

afterAll((done) => {
  server.close(done);
});

beforeEach(() => {
  jest.clearAllMocks();

  // Default service principal: a valid service token.
  mockServiceAuthMiddleware.mockImplementation(
    (req: { serviceApp?: unknown }, _res: unknown, next: () => void) => {
      req.serviceApp = {
        type: 'service',
        appId: 'mention-app',
        appName: 'mention',
        scopes: ['files:write', 'federation:write'],
      };
      next();
    }
  );
  mockGetFilesByIds.mockResolvedValue([]);
  mockFindActiveFilesBySha256.mockResolvedValue([]);
  mockGetPublicCdnUrl.mockResolvedValue(null);

  // Default user principal for session-only routes.
  mockAuthMiddleware.mockImplementation(
    (req: { user?: unknown }, _res: unknown, next: () => void) => {
      req.user = { _id: '64b0000000000000000000aa', id: '64b0000000000000000000aa' };
      next();
    }
  );
  mockOptionalAuthMiddleware.mockImplementation(
    (_req: unknown, _res: unknown, next: () => void) => next()
  );
});

describe('POST /assets/service/cache', () => {
  it('lets a service token upload to the cache namespace and returns { file: { id } }', async () => {
    mockUploadCachedMediaStream.mockResolvedValueOnce({ id: CACHE_FILE_ID, size: 1234 });

    const res = await requestRaw(
      server,
      'POST',
      '/assets/service/cache',
      { 'content-type': 'image/png', 'content-length': '4' },
      Buffer.from('PNG!')
    );

    expect(res.status).toBe(200);
    expect(res.body.data?.file?.id).toBe(CACHE_FILE_ID);
    expect(mockServiceAuthMiddleware).toHaveBeenCalledTimes(1);
    expect(mockUploadCachedMediaStream).toHaveBeenCalledTimes(1);
    // authMiddleware must NOT have run for this service route.
    expect(mockAuthMiddleware).not.toHaveBeenCalled();
  });

  it('requires the files:write service scope', async () => {
    mockServiceAuthMiddleware.mockImplementationOnce(
      (req: { serviceApp?: unknown }, _res: unknown, next: () => void) => {
        req.serviceApp = {
          type: 'service',
          appId: 'mention-app',
          appName: 'mention',
          scopes: ['federation:write'],
        };
        next();
      }
    );

    const res = await requestRaw(
      server,
      'POST',
      '/assets/service/cache',
      { 'content-type': 'image/png', 'content-length': '4' },
      Buffer.from('PNG!')
    );

    expect(res.status).toBe(403);
    expect(mockUploadCachedMediaStream).not.toHaveBeenCalled();
  });

  it('rejects an unsupported content-type with 415 and never touches S3', async () => {
    const res = await requestRaw(
      server,
      'POST',
      '/assets/service/cache',
      { 'content-type': 'application/pdf', 'content-length': '4' },
      Buffer.from('%PDF')
    );

    expect(res.status).toBe(415);
    expect(mockUploadCachedMediaStream).not.toHaveBeenCalled();
  });

  it('rejects an SVG upload with 415 (stored-XSS vector) and never touches S3', async () => {
    const res = await requestRaw(
      server,
      'POST',
      '/assets/service/cache',
      { 'content-type': 'image/svg+xml', 'content-length': '14' },
      Buffer.from('<svg></svg>...')
    );

    expect(res.status).toBe(415);
    expect(mockUploadCachedMediaStream).not.toHaveBeenCalled();
  });

  it('streams a >1 MiB body intact through the real parser chain to the service', async () => {
    // The service stub consumes the request stream (the route hands it `req`)
    // and counts the bytes that actually arrive — proving the global 1 MiB
    // JSON/urlencoded limit did NOT truncate or reject the binary body.
    let bytesReceived = 0;
    mockUploadCachedMediaStream.mockImplementationOnce(async (source: Readable) => {
      for await (const chunk of source) {
        bytesReceived += (chunk as Buffer).length;
      }
      return { id: CACHE_FILE_ID, size: bytesReceived };
    });

    const payload = Buffer.alloc(LARGE_BODY_BYTES, 0x61);
    const res = await requestRaw(
      server,
      'POST',
      '/assets/service/cache',
      { 'content-type': 'video/mp4', 'content-length': String(LARGE_BODY_BYTES) },
      payload
    );

    expect(res.status).toBe(200);
    expect(res.body.data?.file?.id).toBe(CACHE_FILE_ID);
    expect(mockUploadCachedMediaStream).toHaveBeenCalledTimes(1);
    // Full payload reached the service — no truncation by the 1 MiB parser.
    expect(bytesReceived).toBe(LARGE_BODY_BYTES);
  });
});

describe('POST /assets/service/federation', () => {
  it('streams durable federated media owned by an existing federated user', async () => {
    mockUploadFederatedMediaStream.mockResolvedValueOnce({
      id: USER_FILE_ID,
      sha256: 'a'.repeat(64),
      size: 4,
      mime: 'image/jpeg',
      visibility: 'public',
    });

    const res = await requestRaw(
      server,
      'POST',
      '/assets/service/federation',
      {
        'content-type': 'image/jpeg',
        'content-length': '4',
        'x-owner-user-id': FEDERATED_OWNER_ID,
        'x-original-name': 'photo.jpg',
        'x-media-metadata': JSON.stringify({ remoteHost: 'example.social' }),
      },
      Buffer.from('JPEG')
    );

    expect(res.status).toBe(200);
    expect(res.body.data?.file?.id).toBe(USER_FILE_ID);
    expect(mockUploadFederatedMediaStream).toHaveBeenCalledTimes(1);
    expect(mockUploadFederatedMediaStream.mock.calls[0][1]).toBe('image/jpeg');
    expect(mockUploadFederatedMediaStream.mock.calls[0][2]).toBe('photo.jpg');
    expect(mockUploadFederatedMediaStream.mock.calls[0][4]).toBe(FEDERATED_OWNER_ID);
    expect(mockUploadFederatedMediaStream.mock.calls[0][5]).toEqual(
      expect.objectContaining({
        remoteHost: 'example.social',
        serviceAppId: 'mention-app',
        serviceAppName: 'mention',
      })
    );
  });

  it('requires the files:write service scope', async () => {
    mockServiceAuthMiddleware.mockImplementationOnce(
      (req: { serviceApp?: unknown }, _res: unknown, next: () => void) => {
        req.serviceApp = {
          type: 'service',
          appId: 'mention-app',
          appName: 'mention',
          scopes: [],
        };
        next();
      }
    );

    const res = await requestRaw(
      server,
      'POST',
      '/assets/service/federation',
      { 'content-type': 'image/png', 'content-length': '4', 'x-owner-user-id': FEDERATED_OWNER_ID },
      Buffer.from('PNG!')
    );

    expect(res.status).toBe(403);
    expect(mockUploadFederatedMediaStream).not.toHaveBeenCalled();
  });

  it('rejects owners that are not existing federated users', async () => {
    const res = await requestRaw(
      server,
      'POST',
      '/assets/service/federation',
      { 'content-type': 'image/png', 'content-length': '4', 'x-owner-user-id': UNKNOWN_OWNER_ID },
      Buffer.from('PNG!')
    );

    expect(res.status).toBe(403);
    expect(mockUploadFederatedMediaStream).not.toHaveBeenCalled();
  });
});

describe('POST /assets/service/user-media', () => {
  it('streams durable media owned by an existing local user', async () => {
    mockUploadUserMediaStream.mockResolvedValueOnce({
      id: USER_FILE_ID,
      sha256: 'b'.repeat(64),
      size: 4,
      mime: 'image/jpeg',
      visibility: 'public',
    });

    const res = await requestRaw(
      server,
      'POST',
      '/assets/service/user-media',
      {
        'content-type': 'image/jpeg',
        'content-length': '4',
        'x-owner-user-id': LOCAL_OWNER_ID,
        'x-original-name': 'photo.jpg',
      },
      Buffer.from('JPEG')
    );

    expect(res.status).toBe(200);
    expect(res.body.data?.file?.id).toBe(USER_FILE_ID);
    expect(mockUploadUserMediaStream).toHaveBeenCalledTimes(1);
    expect(mockUploadUserMediaStream.mock.calls[0][4]).toBe(LOCAL_OWNER_ID);
  });

  it('rejects owners that are not existing local users', async () => {
    const res = await requestRaw(
      server,
      'POST',
      '/assets/service/user-media',
      { 'content-type': 'image/png', 'content-length': '4', 'x-owner-user-id': UNKNOWN_OWNER_ID },
      Buffer.from('PNG!')
    );

    expect(res.status).toBe(403);
    expect(mockUploadUserMediaStream).not.toHaveBeenCalled();
  });

  it('requires privileged act-as authority in addition to files:write', async () => {
    mockServiceAuthMiddleware.mockImplementationOnce(
      (req: { serviceApp?: unknown }, _res: unknown, next: () => void) => {
        req.serviceApp = {
          type: 'service',
          appId: 'unprivileged-app',
          appName: 'unprivileged',
          scopes: ['files:write'],
        };
        next();
      }
    );

    const res = await requestRaw(
      server,
      'POST',
      '/assets/service/user-media',
      { 'content-type': 'image/png', 'content-length': '4', 'x-owner-user-id': LOCAL_OWNER_ID },
      Buffer.from('PNG!')
    );

    expect(res.status).toBe(403);
    expect(mockUploadUserMediaStream).not.toHaveBeenCalled();
  });

  it('requires the files:write service scope', async () => {
    mockServiceAuthMiddleware.mockImplementationOnce(
      (req: { serviceApp?: unknown }, _res: unknown, next: () => void) => {
        req.serviceApp = {
          type: 'service',
          appId: 'mention-app',
          appName: 'mention',
          scopes: ['federation:write'],
        };
        next();
      }
    );

    const res = await requestRaw(
      server,
      'POST',
      '/assets/service/user-media',
      { 'content-type': 'image/png', 'content-length': '4', 'x-owner-user-id': LOCAL_OWNER_ID },
      Buffer.from('PNG!')
    );

    expect(res.status).toBe(403);
    expect(mockUploadUserMediaStream).not.toHaveBeenCalled();
  });

  it('rejects an SVG upload with 415 (stored-XSS vector) and never touches S3', async () => {
    const res = await requestRaw(
      server,
      'POST',
      '/assets/service/user-media',
      {
        'content-type': 'image/svg+xml',
        'content-length': '14',
        'x-owner-user-id': LOCAL_OWNER_ID,
      },
      Buffer.from('<svg></svg>...')
    );

    expect(res.status).toBe(415);
    expect(mockUploadUserMediaStream).not.toHaveBeenCalled();
  });

  it('streams a >1 MiB body intact through the real parser chain to the service', async () => {
    let bytesReceived = 0;
    mockUploadUserMediaStream.mockImplementationOnce(async (source: Readable) => {
      for await (const chunk of source) {
        bytesReceived += (chunk as Buffer).length;
      }
      return { id: USER_FILE_ID, size: bytesReceived };
    });

    const payload = Buffer.alloc(LARGE_BODY_BYTES, 0x61);
    const res = await requestRaw(
      server,
      'POST',
      '/assets/service/user-media',
      {
        'content-type': 'video/mp4',
        'content-length': String(LARGE_BODY_BYTES),
        'x-owner-user-id': LOCAL_OWNER_ID,
      },
      payload
    );

    expect(res.status).toBe(200);
    expect(res.body.data?.file?.id).toBe(USER_FILE_ID);
    expect(mockUploadUserMediaStream).toHaveBeenCalledTimes(1);
    expect(bytesReceived).toBe(LARGE_BODY_BYTES);
  });
});

describe('DELETE /assets/service/cache/:id', () => {
  it('lets a service token delete a cache-namespace asset', async () => {
    mockDeleteCachedMedia.mockResolvedValueOnce({ deleted: true, outOfScope: false });

    const res = await requestRaw(
      server,
      'DELETE',
      `/assets/service/cache/${CACHE_FILE_ID}`,
      {}
    );

    expect(res.status).toBe(200);
    expect(mockDeleteCachedMedia).toHaveBeenCalledWith(CACHE_FILE_ID);
    expect(mockAuthMiddleware).not.toHaveBeenCalled();
  });

  it('requires the federation:write service scope', async () => {
    mockServiceAuthMiddleware.mockImplementationOnce(
      (req: { serviceApp?: unknown }, _res: unknown, next: () => void) => {
        req.serviceApp = {
          type: 'service',
          appId: 'mention-app',
          appName: 'mention',
          scopes: ['files:write'],
        };
        next();
      }
    );

    const res = await requestRaw(
      server,
      'DELETE',
      `/assets/service/cache/${CACHE_FILE_ID}`,
      {}
    );

    expect(res.status).toBe(403);
    expect(mockDeleteCachedMedia).not.toHaveBeenCalled();
  });

  it('refuses to delete a normal user-owned asset (out of scope) with 403', async () => {
    mockDeleteCachedMedia.mockResolvedValueOnce({ deleted: false, outOfScope: true });

    const res = await requestRaw(
      server,
      'DELETE',
      `/assets/service/cache/${USER_FILE_ID}`,
      {}
    );

    expect(res.status).toBe(403);
    // Crucially the user-facing deleteFile path is never reached.
    expect(mockDeleteFile).not.toHaveBeenCalled();
  });

  it('returns 404 when the cache asset does not exist', async () => {
    mockDeleteCachedMedia.mockResolvedValueOnce({ deleted: false, outOfScope: false });

    const res = await requestRaw(
      server,
      'DELETE',
      `/assets/service/cache/${CACHE_FILE_ID}`,
      {}
    );

    expect(res.status).toBe(404);
  });
});

describe('POST /assets/service/by-ids', () => {
  function postByIds(ids: string[]): Promise<JsonResponse> {
    const payload = Buffer.from(JSON.stringify({ ids }));
    return requestRaw(
      server,
      'POST',
      '/assets/service/by-ids',
      { 'content-type': 'application/json', 'content-length': String(payload.length) },
      payload
    );
  }

  // Service principal carrying the files:read scope this route requires (the
  // shared default principal only carries files:write/federation:write).
  function grantFilesReadOnce(): void {
    mockServiceAuthMiddleware.mockImplementationOnce(
      (req: { serviceApp?: unknown }, _res: unknown, next: () => void) => {
        req.serviceApp = {
          type: 'service',
          appId: 'mention-app',
          appName: 'mention',
          scopes: ['files:read', 'files:write', 'federation:write'],
        };
        next();
      }
    );
  }

  it('returns metadata-only DTOs for known ids and omits deleted ones', async () => {
    grantFilesReadOnce();
    mockGetFilesByIds.mockResolvedValueOnce([
      {
        id: CACHE_FILE_ID,
        sha256: 'a'.repeat(64),
        mime: 'image/png',
        size: 1234,
        status: 'active',
        metadata: { image: { width: 800, height: 600 }, media: { width: 800, height: 600, orientation: 'landscape', aspectRatio: 800 / 600 } },
        variants: [{ type: 'thumb', key: 'k', width: 256, height: 192 }],
        // Fields below must NOT leak into the response.
        storageKey: 'public/content/2026/06/aa/secret.png',
        ownerUserId: 'owner-1',
        links: [{ app: 'mention' }],
      },
      {
        id: USER_FILE_ID,
        sha256: 'b'.repeat(64),
        mime: 'video/mp4',
        size: 9999,
        status: 'deleted',
      },
    ]);

    const res = await postByIds([CACHE_FILE_ID, USER_FILE_ID]);

    expect(res.status).toBe(200);
    expect(mockServiceAuthMiddleware).toHaveBeenCalledTimes(1);
    expect(mockAuthMiddleware).not.toHaveBeenCalled();
    expect(mockGetFilesByIds).toHaveBeenCalledWith([CACHE_FILE_ID, USER_FILE_ID]);

    const data = res.body.data as AssetMetadata[];
    expect(Array.isArray(data)).toBe(true);
    // Deleted id is omitted.
    expect(data).toHaveLength(1);
    expect(data[0]).toEqual({
      id: CACHE_FILE_ID,
      sha256: 'a'.repeat(64),
      mime: 'image/png',
      size: 1234,
      status: 'active',
      width: 800,
      height: 600,
      orientation: 'landscape',
      aspectRatio: 800 / 600,
    });
    // Metadata-only contract: no bytes/url/owner/links/storageKey; variants not exposed.
    expect(Object.keys(data[0]).sort()).toEqual(
      ['aspectRatio', 'height', 'id', 'mime', 'orientation', 'sha256', 'size', 'status', 'width'].sort(),
    );
  });

  it('omits unknown ids (no whole-batch 404)', async () => {
    grantFilesReadOnce();
    // Only one of the two requested ids resolves to a live file.
    mockGetFilesByIds.mockResolvedValueOnce([
      {
        id: CACHE_FILE_ID,
        sha256: 'c'.repeat(64),
        mime: 'image/jpeg',
        size: 42,
        status: 'active',
      },
    ]);

    const res = await postByIds([CACHE_FILE_ID, USER_FILE_ID]);

    expect(res.status).toBe(200);
    const data = res.body.data as AssetMetadata[];
    expect(data).toHaveLength(1);
    expect(data[0].id).toBe(CACHE_FILE_ID);
  });

  it('requires the files:read service scope', async () => {
    mockServiceAuthMiddleware.mockImplementationOnce(
      (req: { serviceApp?: unknown }, _res: unknown, next: () => void) => {
        req.serviceApp = {
          type: 'service',
          appId: 'mention-app',
          appName: 'mention',
          scopes: ['files:write', 'federation:write'],
        };
        next();
      }
    );

    const res = await postByIds([CACHE_FILE_ID]);

    expect(res.status).toBe(403);
    expect(mockGetFilesByIds).not.toHaveBeenCalled();
  });

  it('rejects an empty ids array with 400', async () => {
    const res = await postByIds([]);

    expect(res.status).toBe(400);
    expect(mockGetFilesByIds).not.toHaveBeenCalled();
  });

  it('rejects more than 100 ids with 400', async () => {
    const ids = Array.from({ length: 101 }, (_v, i) => `64c00000000000000000${String(i).padStart(4, '0')}`);

    const res = await postByIds(ids);

    expect(res.status).toBe(400);
    expect(mockGetFilesByIds).not.toHaveBeenCalled();
  });
});

describe('POST /assets/service/by-sha256', () => {
  const SHA_PUBLIC = 'a'.repeat(64);
  const SHA_PRIVATE = 'b'.repeat(64);
  const SHA_UNKNOWN = 'c'.repeat(64);
  const CDN_URL = `https://cloud.oxy.so/content/2026/06/aa/${'a'.repeat(8)}.png`;

  function postBySha(sha256s: string[]): Promise<JsonResponse> {
    const payload = Buffer.from(JSON.stringify({ sha256s }));
    return requestRaw(
      server,
      'POST',
      '/assets/service/by-sha256',
      { 'content-type': 'application/json', 'content-length': String(payload.length) },
      payload
    );
  }

  // Service principal carrying the files:read scope this route requires (the
  // shared default principal only carries files:write/federation:write).
  function grantFilesReadOnce(): void {
    mockServiceAuthMiddleware.mockImplementationOnce(
      (req: { serviceApp?: unknown }, _res: unknown, next: () => void) => {
        req.serviceApp = {
          type: 'service',
          appId: 'mention-app',
          appName: 'mention',
          scopes: ['files:read', 'files:write', 'federation:write'],
        };
        next();
      }
    );
  }

  it('resolves a known public sha to metadata + CDN url, and a private sha without url', async () => {
    grantFilesReadOnce();
    const publicFile = {
      id: CACHE_FILE_ID,
      sha256: SHA_PUBLIC,
      mime: 'image/png',
      size: 1234,
      status: 'active',
      visibility: 'public',
      // Fields below must NOT leak into the response.
      storageKey: 'public/content/2026/06/aa/secret.png',
      ownerUserId: 'owner-1',
      links: [{ app: 'mention' }],
      variants: [{ type: 'thumb', key: 'k' }],
    };
    const privateFile = {
      id: USER_FILE_ID,
      sha256: SHA_PRIVATE,
      mime: 'video/mp4',
      size: 9999,
      status: 'active',
      visibility: 'private',
      storageKey: 'content/2026/06/bb/secret.mp4',
    };
    mockFindActiveFilesBySha256.mockResolvedValueOnce([publicFile, privateFile]);
    // Public asset → CDN-reachable url; private asset → null (omit url).
    mockGetPublicCdnUrl.mockImplementation(async (file: { visibility?: string }) =>
      file.visibility === 'public' ? CDN_URL : null
    );

    const res = await postBySha([SHA_PUBLIC, SHA_PRIVATE]);

    expect(res.status).toBe(200);
    expect(mockServiceAuthMiddleware).toHaveBeenCalledTimes(1);
    expect(mockAuthMiddleware).not.toHaveBeenCalled();
    expect(mockFindActiveFilesBySha256).toHaveBeenCalledWith([SHA_PUBLIC, SHA_PRIVATE]);

    const data = res.body.data as AssetMetadataBySha[];
    expect(Array.isArray(data)).toBe(true);
    expect(data).toHaveLength(2);

    const bySha = Object.fromEntries(data.map((d) => [d.sha256, d]));
    expect(bySha[SHA_PUBLIC]).toEqual({
      sha256: SHA_PUBLIC,
      id: CACHE_FILE_ID,
      mime: 'image/png',
      size: 1234,
      status: 'active',
      url: CDN_URL,
    });
    // Private asset: identical shape minus url.
    expect(bySha[SHA_PRIVATE]).toEqual({
      sha256: SHA_PRIVATE,
      id: USER_FILE_ID,
      mime: 'video/mp4',
      size: 9999,
      status: 'active',
    });
    expect(bySha[SHA_PRIVATE].url).toBeUndefined();
    // Metadata-only contract: no owner/links/variants/storageKey leak.
    expect(Object.keys(bySha[SHA_PUBLIC]).sort()).toEqual(['id', 'mime', 'sha256', 'size', 'status', 'url']);
  });

  it('does not 500 the batch when one hash CDN resolution throws', async () => {
    grantFilesReadOnce();
    const publicFile = {
      id: CACHE_FILE_ID,
      sha256: SHA_PUBLIC,
      mime: 'image/png',
      size: 1234,
      status: 'active',
      visibility: 'public',
    };
    const brokenFile = {
      id: USER_FILE_ID,
      sha256: SHA_PRIVATE,
      mime: 'image/jpeg',
      size: 5678,
      status: 'active',
      visibility: 'public',
    };
    mockFindActiveFilesBySha256.mockResolvedValueOnce([publicFile, brokenFile]);
    mockGetPublicCdnUrl.mockImplementation(async (file: { sha256?: string }) => {
      if (file.sha256 === SHA_PRIVATE) {
        throw new Error('Failed to download buffer from S3: NoSuchKey');
      }
      return CDN_URL;
    });

    const res = await postBySha([SHA_PUBLIC, SHA_PRIVATE]);

    expect(res.status).toBe(200);
    const data = res.body.data as AssetMetadataBySha[];
    expect(data).toHaveLength(2);

    const bySha = Object.fromEntries(data.map((d) => [d.sha256, d]));
    expect(bySha[SHA_PUBLIC].url).toBe(CDN_URL);
    expect(bySha[SHA_PRIVATE].url).toBeUndefined();
    expect(bySha[SHA_PRIVATE]).toEqual(
      expect.objectContaining({
        sha256: SHA_PRIVATE,
        id: USER_FILE_ID,
        mime: 'image/jpeg',
        size: 5678,
        status: 'active',
      })
    );
  });

  it('omits unknown hashes (no whole-batch 404)', async () => {
    grantFilesReadOnce();
    // Only one of the two requested hashes resolves to a live file.
    mockFindActiveFilesBySha256.mockResolvedValueOnce([
      {
        id: CACHE_FILE_ID,
        sha256: SHA_PUBLIC,
        mime: 'image/jpeg',
        size: 42,
        status: 'active',
        visibility: 'private',
      },
    ]);

    const res = await postBySha([SHA_PUBLIC, SHA_UNKNOWN]);

    expect(res.status).toBe(200);
    const data = res.body.data as AssetMetadataBySha[];
    expect(data).toHaveLength(1);
    expect(data[0].sha256).toBe(SHA_PUBLIC);
  });

  it('requires the files:read service scope', async () => {
    // Default principal lacks files:read.
    const res = await postBySha([SHA_PUBLIC]);

    expect(res.status).toBe(403);
    expect(mockFindActiveFilesBySha256).not.toHaveBeenCalled();
  });

  it('rejects an empty sha256s array with 400', async () => {
    const res = await postBySha([]);

    expect(res.status).toBe(400);
    expect(mockFindActiveFilesBySha256).not.toHaveBeenCalled();
  });

  it('rejects more than 100 hashes with 400', async () => {
    const shas = Array.from({ length: 101 }, (_v, i) =>
      i.toString(16).padStart(64, '0')
    );

    const res = await postBySha(shas);

    expect(res.status).toBe(400);
    expect(mockFindActiveFilesBySha256).not.toHaveBeenCalled();
  });

  it('rejects a non-hex digest with 400', async () => {
    grantFilesReadOnce();
    const res = await postBySha(['not-a-valid-sha']);

    expect(res.status).toBe(400);
    expect(mockFindActiveFilesBySha256).not.toHaveBeenCalled();
  });
});

describe('existing session-only routes are unchanged', () => {
  it('POST /assets/upload runs through authMiddleware, not serviceAuthMiddleware', async () => {
    // The session-only multipart upload route is wired to authMiddleware. We
    // assert the auth middleware that fronts it is authMiddleware by sending a
    // request and confirming serviceAuthMiddleware never fires for it.
    mockAuthMiddleware.mockImplementationOnce(
      (_req: unknown, res: { status: (n: number) => { json: (b: unknown) => void } }) => {
        res.status(401).json({ error: 'Authentication required' });
      }
    );

    const res = await requestRaw(
      server,
      'POST',
      '/assets/upload',
      { 'content-type': 'application/json', 'content-length': '2' },
      Buffer.from('{}')
    );

    expect(res.status).toBe(401);
    expect(mockAuthMiddleware).toHaveBeenCalledTimes(1);
    expect(mockServiceAuthMiddleware).not.toHaveBeenCalled();
  });

  it('DELETE /assets/:id runs through authMiddleware, not serviceAuthMiddleware', async () => {
    mockAuthMiddleware.mockImplementationOnce(
      (_req: unknown, res: { status: (n: number) => { json: (b: unknown) => void } }) => {
        res.status(401).json({ error: 'Authentication required' });
      }
    );

    const res = await requestRaw(
      server,
      'DELETE',
      `/assets/${USER_FILE_ID}`,
      {}
    );

    expect(res.status).toBe(401);
    expect(mockAuthMiddleware).toHaveBeenCalledTimes(1);
    expect(mockServiceAuthMiddleware).not.toHaveBeenCalled();
  });
});
