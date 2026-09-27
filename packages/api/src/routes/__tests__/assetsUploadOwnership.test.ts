/**
 * The two-step upload routes write only the CALLER's own row.
 *
 * Rows are per owner and their stored objects are content-addressed and SHARED
 * by every owner's row for the same bytes. So:
 *
 * - `POST /assets/:id/upload-direct` writes bytes to the row's key. It used to
 *   accept any authenticated caller and any bytes: anyone could overwrite any
 *   asset. It now requires the row's owner AND bytes that hash to the row's
 *   `sha256` — a shared key may only ever receive the content it names.
 * - `POST /assets/complete` commits metadata and visibility; it now passes the
 *   caller to the service, which refuses a row the caller does not own.
 */

import express from 'express';
import request from 'supertest';
import { createHash } from 'node:crypto';

const FILE_ID = '64c0000000000000000000b2';
const OWNER_ID = '69b2d3df5d12f58c9800d651';
const STRANGER_ID = '69b2d3df5d12f58c9800d652';
const CONTENT = Buffer.from('the real bytes');
const SHA256 = createHash('sha256').update(CONTENT).digest('hex');

let mockCurrentUser = OWNER_ID;
const mockGetFile = jest.fn();
const mockCompleteUpload = jest.fn();
const mockUploadBuffer = jest.fn();

jest.mock('../../middleware/auth', () => ({
  authMiddleware: (req: { user?: { _id: string } }, _res: unknown, next: () => void) => {
    req.user = { _id: mockCurrentUser };
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

function row() {
  return {
    id: FILE_ID,
    sha256: SHA256,
    size: CONTENT.length,
    mime: 'image/png',
    ext: '.png',
    ownerUserId: OWNER_ID,
    systemOwner: null,
    status: 'active',
    visibility: 'private',
    purpose: 'user',
    storageKey: `content/2026/09/${SHA256.slice(0, 2)}/${SHA256}.png`,
    originalName: null,
    metadata: {},
    createdAt: new Date(),
    updatedAt: new Date(),
    links: [],
    variants: [],
  };
}

beforeEach(() => {
  mockCurrentUser = OWNER_ID;
  mockGetFile.mockReset().mockResolvedValue(row());
  mockUploadBuffer.mockReset().mockResolvedValue({});
  mockCompleteUpload.mockReset().mockResolvedValue(row());
});

const uploadDirect = (bytes: Buffer) =>
  request(app).post(`/assets/${FILE_ID}/upload-direct`).attach('file', bytes, 'photo.png');

describe('POST /assets/:id/upload-direct', () => {
  it('writes the owner\'s bytes when they hash to the row\'s sha256', async () => {
    const res = await uploadDirect(CONTENT);

    expect(res.status).toBe(200);
    expect(mockUploadBuffer).toHaveBeenCalledWith(row().storageKey, CONTENT, expect.anything());
  });

  it('refuses a caller who does not own the row, writing nothing', async () => {
    mockCurrentUser = STRANGER_ID;

    const res = await uploadDirect(CONTENT);

    expect(res.status).toBe(403);
    expect(mockUploadBuffer).not.toHaveBeenCalled();
  });

  it('refuses bytes that are not the content the (shared) key names, writing nothing', async () => {
    const res = await uploadDirect(Buffer.from('something else entirely'));

    expect(res.status).toBe(400);
    expect(mockUploadBuffer).not.toHaveBeenCalled();
  });
});

describe('POST /assets/complete', () => {
  it('hands the caller to the service, which decides ownership', async () => {
    mockCurrentUser = STRANGER_ID;

    await request(app).post('/assets/complete').send({
      fileId: FILE_ID,
      originalName: 'photo.png',
      size: CONTENT.length,
      mime: 'image/png',
    });

    expect(mockCompleteUpload).toHaveBeenCalledWith(expect.objectContaining({ fileId: FILE_ID }), STRANGER_ID);
  });
});
