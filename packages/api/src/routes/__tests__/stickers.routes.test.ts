/**
 * `/stickers` route wiring — route order, guards, validation and status codes.
 * The catalogue's rules are covered against a real Postgres in
 * `services/__tests__/stickers.service.test.ts`; this file only proves the
 * router reaches the right service call with the right arguments.
 */

import express from 'express';
import request from 'supertest';

const USER_ID = '6c0000000000000000000001';
let isStaff = false;

const mockService = {
  listPublishedPacks: jest.fn(),
  getPackBySlug: jest.fn(),
  resolveStickers: jest.fn(),
  searchStickers: jest.fn(),
  listInstalledPacks: jest.fn(),
  installPack: jest.fn(),
  uninstallPack: jest.fn(),
  reorderInstalledPacks: jest.fn(),
  listAllPacks: jest.fn(),
  getPackForStaff: jest.fn(),
  createPack: jest.fn(),
  updatePack: jest.fn(),
  addSticker: jest.fn(),
  removeSticker: jest.fn(),
  publishPack: jest.fn(),
  archivePack: jest.fn(),
  deleteDraftPack: jest.fn(),
};

jest.mock('../../services/stickers.service', () => mockService);

jest.mock('../../middleware/auth', () => ({
  authMiddleware: (req: { user?: Record<string, unknown> }, _res: unknown, next: () => void) => {
    req.user = { _id: USER_ID, id: USER_ID, isStaff };
    next();
  },
}));

jest.mock('../../middleware/rateLimiter', () => ({
  rateLimit: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));

jest.mock('../../utils/logger', () => ({
  logger: { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

import stickersRouter from '../stickers';
import { errorHandler } from '../../middleware/errorHandler';

const app = express();
app.use(express.json());
app.use('/stickers', stickersRouter);
app.use(errorHandler);

beforeEach(() => {
  jest.clearAllMocks();
  isStaff = false;
});

describe('public catalogue', () => {
  it('serves a sticker by id with a cacheable header', async () => {
    mockService.resolveStickers.mockResolvedValue([{ id: 'abc' }]);
    const response = await request(app).get('/stickers/abc');
    expect(response.status).toBe(200);
    expect(mockService.resolveStickers).toHaveBeenCalledWith(['abc']);
    expect(response.headers['cache-control']).toContain('public');
  });

  it('answers 404 for an unknown sticker', async () => {
    mockService.resolveStickers.mockResolvedValue([]);
    expect((await request(app).get('/stickers/nope')).status).toBe(404);
  });

  it('bounds a resolve request', async () => {
    mockService.resolveStickers.mockResolvedValue([]);
    expect((await request(app).post('/stickers/resolve').send({ ids: [] })).status).toBe(400);
    const tooMany = Array.from({ length: 101 }, (_, index) => `id-${index}`);
    expect((await request(app).post('/stickers/resolve').send({ ids: tooMany })).status).toBe(400);
    expect((await request(app).post('/stickers/resolve').send({ ids: ['a', 'b'] })).status).toBe(200);
    expect(mockService.resolveStickers).toHaveBeenCalledWith(['a', 'b']);
  });

  it('takes exactly one search term', async () => {
    mockService.searchStickers.mockResolvedValue([]);
    expect((await request(app).get('/stickers/search')).status).toBe(400);
    expect((await request(app).get('/stickers/search').query({ emoji: '😂', q: 'cat' })).status).toBe(400);
    expect((await request(app).get('/stickers/search').query({ emoji: '😂' })).status).toBe(200);
  });
});

describe('the picker', () => {
  it('reads /me/packs as the picker, not as a sticker id', async () => {
    mockService.listInstalledPacks.mockResolvedValue([]);
    const response = await request(app).get('/stickers/me/packs');
    expect(response.status).toBe(200);
    expect(mockService.listInstalledPacks).toHaveBeenCalledWith(USER_ID);
    expect(response.headers['cache-control']).toContain('private');
  });

  it('installs, uninstalls and reorders for the signed-in account', async () => {
    expect((await request(app).put('/stickers/me/packs/pack-1')).status).toBe(204);
    expect(mockService.installPack).toHaveBeenCalledWith(USER_ID, 'pack-1');
    expect((await request(app).delete('/stickers/me/packs/pack-1')).status).toBe(204);
    expect(mockService.uninstallPack).toHaveBeenCalledWith(USER_ID, 'pack-1');
    expect((await request(app).patch('/stickers/me/packs-order').send({ packIds: ['b', 'a'] })).status).toBe(204);
    expect(mockService.reorderInstalledPacks).toHaveBeenCalledWith(USER_ID, ['b', 'a']);
  });
});

describe('staff tools', () => {
  it('refuses a non-staff account before reaching the service', async () => {
    const response = await request(app).post('/stickers/admin/packs').send({ slug: 'cats', title: 'Cats' });
    expect(response.status).toBe(403);
    expect(mockService.createPack).not.toHaveBeenCalled();
  });

  it('creates a pack for staff, validating the slug', async () => {
    isStaff = true;
    mockService.createPack.mockResolvedValue({ id: 'pack-1' });
    expect((await request(app).post('/stickers/admin/packs').send({ slug: 'Not A Slug', title: 'x' })).status).toBe(400);
    expect((await request(app).post('/stickers/admin/packs').send({ slug: 'cats', title: 'Cats' })).status).toBe(201);
  });

  it('adds a sticker from a multipart upload, parsing the comma lists', async () => {
    isStaff = true;
    mockService.addSticker.mockResolvedValue({ id: 'stk' });
    const response = await request(app)
      .post('/stickers/admin/packs/pack-1/stickers')
      .attach('animation', Buffer.from('{}'), { filename: 'a.json', contentType: 'application/json' })
      .field('emoji', '😂, 🤣')
      .field('keywords', 'laugh, lol');
    expect(response.status).toBe(201);
    expect(mockService.addSticker).toHaveBeenCalledWith(
      expect.objectContaining({ packId: 'pack-1', emoji: ['😂', '🤣'], keywords: ['laugh', 'lol'], fallback: undefined })
    );
  });

  it('requires the animation file and an emoji', async () => {
    isStaff = true;
    const noFile = await request(app).post('/stickers/admin/packs/pack-1/stickers').field('emoji', '😂');
    expect(noFile.status).toBe(400);
    const noEmoji = await request(app)
      .post('/stickers/admin/packs/pack-1/stickers')
      .attach('animation', Buffer.from('{}'), { filename: 'a.json', contentType: 'application/json' });
    expect(noEmoji.status).toBe(400);
    expect(mockService.addSticker).not.toHaveBeenCalled();
  });
});
