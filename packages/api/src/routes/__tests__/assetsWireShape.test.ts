/**
 * `GET /assets/:id` wire shape — the response contract, not the query.
 *
 * The migration contract's standing rule is that the API wire format must not
 * change: every ecosystem app consumes oxy-api and will not be rebuilt for
 * weeks. Two things in this response were nested subdocuments and are now child
 * TABLE rows, and each carries its own way to break that silently:
 *
 * - **New internal columns.** `file_links` and `file_variants` have `id` and
 *   `file_id` primary/foreign keys; the Mongo subdocuments were declared
 *   `{ _id: false }` and had neither. Returning rows verbatim would publish two
 *   internal identifiers into a public payload.
 * - **`null` where a field used to be ABSENT.** Mongoose omitted an unset
 *   optional; a Postgres row spells it `null`. `JSON.stringify` drops
 *   `undefined` but preserves `null`, so a verbatim row turns "this variant has
 *   no recorded size" into `"size": null` for every client.
 *
 * - **`usageCount`** was a Mongoose virtual over `links.length`. It is derived
 *   at the serializer now, and must still be present and correct.
 *
 * The assertions are exact object equality on the emitted link and variant, so
 * an ADDED key fails just as loudly as a missing one.
 */

import express from 'express';
import request from 'supertest';

const FILE_ID = '64c0000000000000000000a1';
const OWNER_ID = '69b2d3df5d12f58c9800d651';

const mockGetFile = jest.fn();

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
  assetService: { getFile: (...args: unknown[]) => mockGetFile(...args) },
  s3Service: {},
}));

import assetsRouter from '../assets';
import { errorHandler } from '../../middleware/errorHandler';

const app = express();
app.use(express.json());
app.use('/assets', assetsRouter);
app.use(errorHandler);

const CREATED_AT = new Date('2026-07-01T10:00:00.000Z');

/**
 * A stored asset with ONE link and TWO variants: one fully populated, one with
 * every optional column NULL. The second is the case that distinguishes an
 * omitted field from an explicit `null`.
 */
function fileRecord() {
  return {
    id: FILE_ID,
    sha256: 'a'.repeat(64),
    size: 1024,
    mime: 'image/png',
    ext: 'png',
    ownerUserId: OWNER_ID,
    systemOwner: null,
    status: 'active',
    visibility: 'private',
    purpose: 'user',
    storageKey: 'content/2026/07/aa/a.png',
    originalName: 'photo.png',
    metadata: { media: { width: 10, height: 10 } },
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
    links: [
      {
        id: 'link-row-id',
        fileId: FILE_ID,
        app: 'mention',
        entityType: 'post',
        entityId: 'p1',
        createdBy: OWNER_ID,
        webhookUrl: null,
        createdAt: CREATED_AT,
      },
    ],
    variants: [
      {
        id: 'variant-row-id',
        fileId: FILE_ID,
        type: 'thumb',
        key: 'variants/2026/07/aa/thumb.webp',
        width: 256,
        height: 256,
        readyAt: CREATED_AT,
        size: 900,
        metadata: { format: 'webp' },
      },
      {
        id: 'variant-row-id-2',
        fileId: FILE_ID,
        type: 'hls_master',
        key: 'variants/2026/07/aa/hls_master.m3u8',
        width: null,
        height: null,
        readyAt: null,
        size: null,
        metadata: null,
      },
    ],
  };
}

beforeEach(() => {
  mockGetFile.mockReset();
  mockGetFile.mockResolvedValue(fileRecord());
});

describe('GET /assets/:id', () => {
  it('emits a link with no row id, no parent pointer, and no null for an unset field', async () => {
    const res = await request(app).get(`/assets/${FILE_ID}`);

    expect(res.status).toBe(200);
    // Exact equality: an added `id`/`fileId` fails here, and so would a
    // `webhookUrl: null`.
    expect(res.body.data.file.links).toEqual([
      {
        app: 'mention',
        entityType: 'post',
        entityId: 'p1',
        createdBy: OWNER_ID,
        createdAt: CREATED_AT.toISOString(),
      },
    ]);
  });

  it('emits variants with their optional fields OMITTED, never null', async () => {
    const res = await request(app).get(`/assets/${FILE_ID}`);

    expect(res.body.data.file.variants).toEqual([
      {
        type: 'thumb',
        key: 'variants/2026/07/aa/thumb.webp',
        width: 256,
        height: 256,
        readyAt: CREATED_AT.toISOString(),
        size: 900,
        metadata: { format: 'webp' },
      },
      {
        type: 'hls_master',
        key: 'variants/2026/07/aa/hls_master.m3u8',
      },
    ]);

    // Spelled out, because this is the difference JSON preserves: the key is
    // absent, not present-and-null.
    const raw = JSON.parse(res.text) as { data: { file: { variants: object[] } } };
    expect('size' in raw.data.file.variants[1]).toBe(false);
    expect('readyAt' in raw.data.file.variants[1]).toBe(false);
  });

  it('still reports usageCount, derived from the link rows', async () => {
    const res = await request(app).get(`/assets/${FILE_ID}`);

    expect(res.body.data.file.usageCount).toBe(1);
    expect(res.body.data.assetId).toBe(FILE_ID);
    expect(res.body.data.file.id).toBe(FILE_ID);
  });

  it('reports usageCount 0 for an unlinked file', async () => {
    // Guards against a serializer that hardcodes a count or reads a stale
    // stored counter: the number has to follow the rows.
    mockGetFile.mockResolvedValue({ ...fileRecord(), links: [] });

    const res = await request(app).get(`/assets/${FILE_ID}`);

    expect(res.body.data.file.usageCount).toBe(0);
    expect(res.body.data.file.links).toEqual([]);
  });
});
