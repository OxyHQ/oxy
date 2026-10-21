/**
 * The two multipart upload routes refuse a file over their cap with Oxy's own
 * JSON 413, `USE_PRESIGNED_UPLOAD`, and both upload paths answer one shape.
 *
 * api.oxy.so's proxy refuses any body over 100 MB with an HTML 413 before Oxy
 * sees it. A client that still sends a large file multipart (an SDK older than
 * the presigned switch in `assets.upload`) must instead get an answer it can
 * act on: the code, the cap, and the way through. Without `limits.fileSize`
 * multer buffered any size in memory and its own refusals were 500s.
 *
 * The cap is mocked small so the routes are exercised for real without
 * sending 90 MiB; its real value is held to the two bounds it exists between.
 * And because `assets.upload` maps a presigned upload's `/assets/complete`
 * answer to `/assets/upload`'s shape, `/complete` must carry every field the
 * other answers (`ext`, `visibility`, `metadata`).
 */

import express from 'express';
import request from 'supertest';
import { createHash } from 'node:crypto';
import { ASSET_MULTIPART_UPLOAD_MAX_BYTES } from '@oxy.so/core';

const TEST_CAP = 16;

jest.mock('../../constants/assetUpload', () => ({
  ...jest.requireActual('../../constants/assetUpload'),
  ASSET_MULTIPART_FILE_MAX_BYTES: 16,
}));

const FILE_ID = '64c0000000000000000000c3';
const OWNER_ID = '69b2d3df5d12f58c9800d661';
const AT_CAP = Buffer.alloc(TEST_CAP, 7);
const OVER_CAP = Buffer.alloc(TEST_CAP + 1, 7);

const mockGetFile = jest.fn();
const mockUploadFileDirect = jest.fn();
const mockCompleteUpload = jest.fn();
const mockUploadBuffer = jest.fn();

jest.mock('../../services/supervisionPolicy.service', () => ({
  ...jest.requireActual('../../services/supervisionPolicy.service'),
  isSupervised: jest.fn().mockResolvedValue(false),
}));

jest.mock('../../middleware/auth', () => ({
  authMiddleware: (req: { user?: { _id: string } }, _res: unknown, next: () => void) => {
    req.user = { _id: OWNER_ID };
    next();
  },
  serviceAuthMiddleware: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

jest.mock('../../middleware/optionalAuth', () => ({
  optionalAuthMiddleware: (_req: unknown, _res: unknown, next: () => void) => next(),
  getUserId: () => undefined,
  getMediaViewerUserId: () => undefined,
}));

jest.mock('../../middleware/mediaHeaders', () => ({
  mediaHeadersMiddleware: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

jest.mock('../../middleware/rateLimiter', () => ({
  rateLimit: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));

jest.mock('../../utils/logger', () => ({
  logger: { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

jest.mock('../../services/assetServiceSingleton', () => ({
  assetService: {
    getFile: (...args: unknown[]) => mockGetFile(...args),
    uploadFileDirect: (...args: unknown[]) => mockUploadFileDirect(...args),
    completeUpload: (...args: unknown[]) => mockCompleteUpload(...args),
  },
}));

jest.mock('../../services/s3ServiceSingleton', () => ({
  s3Service: { uploadBuffer: (...args: unknown[]) => mockUploadBuffer(...args) },
}));

import assetsRouter from '../assets';
import { errorHandler } from '../../middleware/errorHandler';

const app = express();
app.use(express.json());
app.use('/assets', assetsRouter);
app.use(errorHandler);

function row(bytes: Buffer) {
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  return {
    id: FILE_ID,
    sha256,
    size: bytes.length,
    mime: 'video/mp4',
    ext: 'mp4',
    ownerUserId: OWNER_ID,
    systemOwner: null,
    status: 'active',
    visibility: 'public',
    purpose: 'user',
    storageKey: `content/2026/10/${sha256.slice(0, 2)}/${sha256}.mp4`,
    originalName: 'clip.mp4',
    metadata: { source: 'camera' },
    createdAt: new Date('2026-10-21T00:00:00.000Z'),
    updatedAt: new Date('2026-10-21T00:00:00.000Z'),
    links: [],
    variants: [],
    accessGrants: [],
  };
}

beforeEach(() => {
  mockGetFile.mockReset().mockResolvedValue(row(AT_CAP));
  mockUploadFileDirect.mockReset().mockResolvedValue(row(AT_CAP));
  mockCompleteUpload.mockReset().mockResolvedValue(row(AT_CAP));
  mockUploadBuffer.mockReset().mockResolvedValue({});
});

const tooLarge = {
  error: 'USE_PRESIGNED_UPLOAD',
  message: expect.stringContaining('/assets/init'),
  details: { maxBytes: TEST_CAP },
};

describe('POST /assets/upload', () => {
  it('takes a file at the cap', async () => {
    const res = await request(app).post('/assets/upload').attach('file', AT_CAP, 'clip.mp4');

    expect(res.status).toBe(200);
    expect(mockUploadFileDirect).toHaveBeenCalledTimes(1);
  });

  it('refuses a file over it with JSON 413 USE_PRESIGNED_UPLOAD, storing nothing', async () => {
    const res = await request(app).post('/assets/upload').attach('file', OVER_CAP, 'clip.mp4');

    expect(res.status).toBe(413);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    expect(res.body).toEqual(tooLarge);
    expect(mockUploadFileDirect).not.toHaveBeenCalled();
  });

  it("answers multer's other refusals as the caller's 400, not a 500", async () => {
    const res = await request(app).post('/assets/upload').attach('other', AT_CAP, 'clip.mp4');

    expect(res.status).toBe(400);
    expect(mockUploadFileDirect).not.toHaveBeenCalled();
  });
});

describe('POST /assets/:id/upload-direct', () => {
  it('takes a file at the cap', async () => {
    const res = await request(app)
      .post(`/assets/${FILE_ID}/upload-direct`)
      .attach('file', AT_CAP, 'clip.mp4');

    expect(res.status).toBe(200);
    expect(mockUploadBuffer).toHaveBeenCalledTimes(1);
  });

  it('refuses a file over it with JSON 413 USE_PRESIGNED_UPLOAD, writing nothing', async () => {
    const res = await request(app)
      .post(`/assets/${FILE_ID}/upload-direct`)
      .attach('file', OVER_CAP, 'clip.mp4');

    expect(res.status).toBe(413);
    expect(res.body).toEqual(tooLarge);
    expect(mockUploadBuffer).not.toHaveBeenCalled();
  });
});

describe('the two upload paths answer one shape', () => {
  it('/assets/complete carries every field /assets/upload answers', async () => {
    const uploaded = await request(app).post('/assets/upload').attach('file', AT_CAP, 'clip.mp4');
    const completed = await request(app).post('/assets/complete').send({
      fileId: FILE_ID,
      originalName: 'clip.mp4',
      size: AT_CAP.length,
      mime: 'video/mp4',
    });

    expect(uploaded.status).toBe(200);
    expect(completed.status).toBe(200);
    const committed = completed.body.data.file;
    for (const [field, value] of Object.entries(uploaded.body.data.file)) {
      expect([field, committed[field]]).toEqual([field, value]);
    }
  });
});

describe('the real cap', () => {
  const actual = jest.requireActual<typeof import('../../constants/assetUpload')>(
    '../../constants/assetUpload',
  );

  it("is under the proxy's 100 MB body limit, with room for the multipart envelope", () => {
    expect(actual.ASSET_MULTIPART_FILE_MAX_BYTES).toBeLessThanOrEqual(100_000_000 - 1024 * 1024);
  });

  it("is above @oxy.so/core's switch to presigned PUT, so a current client is never refused", () => {
    expect(actual.ASSET_MULTIPART_FILE_MAX_BYTES).toBeGreaterThan(ASSET_MULTIPART_UPLOAD_MAX_BYTES);
  });
});
