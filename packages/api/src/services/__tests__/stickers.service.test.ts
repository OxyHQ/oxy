/**
 * The sticker catalogue, against a REAL Postgres.
 *
 * The rules worth testing live in the schema as much as in the service — the
 * `(user_id, pack_id)` key that makes installing idempotent, the widened
 * `files` CHECKs that let a sticker's files exist at all, the foreign keys that
 * keep a file from vanishing under a sticker — so a stubbed driver would test
 * the stub. Only S3 is replaced: `uploadStickerFile` writes the same `files`
 * row the real one would, without the bytes.
 */

import { createHash, randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { eq } from 'drizzle-orm';
import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { files } from '../../db/schema/files';
import { users } from '../../db/schema/users';
import { insertFile } from '../fileRepository';
import { BadRequestError, ConflictError, NotFoundError } from '../../utils/error';

jest.mock('../assetServiceSingleton', () => ({
  assetService: {
    uploadStickerFile: async (buffer: Buffer, mime: string, originalName: string) => {
      const sha256 = createHash('sha256').update(buffer).update(randomUUID()).digest('hex');
      return insertFile({
        sha256,
        size: buffer.length,
        mime,
        ext: mime === 'application/json' ? '.json' : '.webp',
        ownerUserId: null,
        systemOwner: '__stickers__',
        purpose: 'sticker',
        status: 'active',
        visibility: 'public',
        storageKey: `public/content/2026/09/${sha256.slice(0, 2)}/${sha256}`,
        originalName,
        metadata: {},
      });
    },
  },
}));

import {
  addSticker,
  archivePack,
  createPack,
  deleteDraftPack,
  getPackBySlug,
  installPack,
  listInstalledPacks,
  listPublishedPacks,
  publishPack,
  removeSticker,
  reorderInstalledPacks,
  resolveStickers,
  searchStickers,
  uninstallPack,
} from '../stickers.service';
import { normalizeStickerAnimation } from '../stickerValidation';
import { renderStickerFallback } from '../stickerRender';

beforeAll(async () => {
  await connectPostgres();
});

afterAll(async () => {
  await closePostgres();
});

/**
 * A one-second animation of a filled square sliding across the canvas: the
 * smallest real Lottie that draws visible pixels, so the renderer has
 * something to find.
 */
function lottie(overrides: Record<string, unknown> = {}, pretty = false): Buffer {
  const square = {
    ty: 4,
    ind: 1,
    ip: 0,
    op: 60,
    st: 0,
    ks: {
      o: { a: 0, k: 100 },
      r: { a: 0, k: 0 },
      p: {
        a: 1,
        k: [
          { t: 0, s: [128.123456, 256, 0], i: { x: [0.667], y: [1] }, o: { x: [0.333], y: [0] } },
          { t: 59, s: [384.987654, 256, 0] },
        ],
      },
      a: { a: 0, k: [0, 0, 0] },
      s: { a: 0, k: [100, 100, 100] },
    },
    shapes: [
      { ty: 'rc', d: 1, s: { a: 0, k: [200, 200] }, p: { a: 0, k: [0, 0] }, r: { a: 0, k: 0 } },
      { ty: 'fl', c: { a: 0, k: [0.2, 0.4, 0.9, 1] }, o: { a: 0, k: 100 }, r: 1 },
    ],
  };
  const document = { v: '5.7.4', fr: 30, ip: 0, op: 60, w: 512, h: 512, layers: [square], assets: [], ...overrides };
  return Buffer.from(pretty ? JSON.stringify(document, null, 2) : JSON.stringify(document));
}

let fallbackPng: Buffer;
beforeAll(async () => {
  fallbackPng = await sharp({
    create: { width: 512, height: 512, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
  })
    .png()
    .toBuffer();
});

async function insertUser(): Promise<string> {
  const suffix = randomUUID().slice(0, 8);
  const [row] = await getDb()
    .insert(users)
    .values({ username: `sticker-${suffix}`, email: `sticker-${suffix}@example.test` })
    .returning({ id: users.id });
  return row.id;
}

function slug(): string {
  return `pack-${randomUUID().slice(0, 8)}`;
}

async function packWithStickers(count: number, emoji = '😀') {
  const pack = await createPack({ slug: slug(), title: 'Test pack' });
  const stickers = [];
  for (let index = 0; index < count; index += 1) {
    stickers.push(
      await addSticker({
        packId: pack.id,
        animation: lottie(),
        fallback: { buffer: fallbackPng, mime: 'image/png' },
        emoji: [emoji],
        keywords: ['Happy', 'happy', 'Smile'],
      })
    );
  }
  return { pack, stickers };
}

describe('normalizing an animation', () => {
  it('accepts a 512 or 1024 square canvas and reads the loop length', () => {
    expect(normalizeStickerAnimation(lottie())).toMatchObject({ size: 512, durationMs: 2000, removedExpressions: 0 });
    expect(normalizeStickerAnimation(lottie({ w: 1024, h: 1024 })).size).toBe(1024);
  });

  it('minifies and rounds floats to a thousandth', () => {
    const { json } = normalizeStickerAnimation(lottie({}, true));
    const text = json.toString();
    expect(text).not.toContain('\n');
    expect(text).toContain('128.123');
    expect(text).not.toContain('128.1234');
    expect(json.length).toBeLessThan(lottie({}, true).length);
  });

  it('removes expressions and says how many', () => {
    const withExpression = lottie({ layers: [{ ks: { o: { a: 0, k: 100, x: 'var $bm_rt; $bm_rt = value;' } } }] });
    const normalized = normalizeStickerAnimation(withExpression);
    expect(normalized.removedExpressions).toBe(1);
    expect(normalized.json.toString()).not.toContain('$bm_rt');
  });

  it.each([
    ['a canvas that is not an allowed square', lottie({ w: 512, h: 256 })],
    ['a loop over ten seconds', lottie({ op: 330 })],
    ['a frame rate over 60', lottie({ fr: 120, op: 120 })],
    ['an embedded image', lottie({ assets: [{ id: 'img', p: 'data:image/png;base64,AAAA', e: 1 }] })],
    ['something that is not Lottie', Buffer.from('{"hello":"world"}')],
    ['something that is not JSON', Buffer.from('not json')],
  ])('refuses %s', (_label, buffer) => {
    expect(() => normalizeStickerAnimation(buffer)).toThrow(BadRequestError);
  });
});

describe('rendering a fallback', () => {
  it('draws a 512 WebP with the sticker visible in it', async () => {
    const { json, size } = normalizeStickerAnimation(lottie({ w: 1024, h: 1024 }));
    const webp = await renderStickerFallback(json, size);
    const image = sharp(webp);
    const metadata = await image.metadata();
    expect(metadata).toMatchObject({ format: 'webp', width: 512, height: 512 });
    const { data } = await image.ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    let visible = 0;
    for (let alpha = 3; alpha < data.length; alpha += 4) if (data[alpha] > 0) visible += 1;
    // A 200px square on a 1024 canvas is ~100×100 at 512: about 10,000 pixels.
    expect(visible).toBeGreaterThan(8000);
    expect(visible).toBeLessThan(12000);
  });

  it('refuses an animation that draws nothing', async () => {
    const { json, size } = normalizeStickerAnimation(lottie({ layers: [] }));
    await expect(renderStickerFallback(json, size)).rejects.toThrow(BadRequestError);
  });
});

describe('building a pack', () => {
  it('stores stickers in order, with CDN URLs and lower-cased, de-duplicated keywords', async () => {
    const { pack, stickers } = await packWithStickers(2);
    expect(stickers.map((sticker) => sticker.packId)).toEqual([pack.id, pack.id]);
    expect(stickers[0].keywords).toEqual(['happy', 'smile']);
    expect(stickers[0].durationMs).toBe(2000);
    expect(stickers[0].animation.url).toMatch(/^https:\/\/cloud\.oxy\.so\/content\//);
    expect(stickers[0].animation.mime).toBe('application/json');
    expect(stickers[0].fallback.mime).toBe('image/png');
  });

  it('refuses a fallback of the wrong size before storing anything', async () => {
    const pack = await createPack({ slug: slug(), title: 'Test pack' });
    const small = await sharp({
      create: { width: 64, height: 64, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
    })
      .png()
      .toBuffer();
    const before = await getDb().select({ id: files.id }).from(files).where(eq(files.systemOwner, '__stickers__'));
    await expect(
      addSticker({ packId: pack.id, animation: lottie(), fallback: { buffer: small, mime: 'image/png' }, emoji: ['😀'], keywords: [] })
    ).rejects.toThrow(BadRequestError);
    const after = await getDb().select({ id: files.id }).from(files).where(eq(files.systemOwner, '__stickers__'));
    expect(after).toHaveLength(before.length);
  });

  it('renders the fallback when none is supplied', async () => {
    const pack = await createPack({ slug: slug(), title: 'Rendered' });
    const sticker = await addSticker({ packId: pack.id, animation: lottie(), emoji: ['🟦'], keywords: [] });
    expect(sticker.fallback.mime).toBe('image/webp');
  });

  it('refuses a duplicate slug', async () => {
    const taken = slug();
    await createPack({ slug: taken, title: 'One' });
    await expect(createPack({ slug: taken, title: 'Two' })).rejects.toThrow(ConflictError);
  });

  it('will not publish an empty pack', async () => {
    const pack = await createPack({ slug: slug(), title: 'Empty' });
    await expect(publishPack(pack.id)).rejects.toThrow(ConflictError);
  });
});

describe('what readers see', () => {
  it('hides drafts from the shop, the pack page and resolve', async () => {
    const { pack, stickers } = await packWithStickers(1);
    expect(await getPackBySlug(pack.slug)).toBeNull();
    expect(await resolveStickers([stickers[0].id])).toEqual([]);
    const { items } = await listPublishedPacks({ limit: 100, offset: 0 });
    expect(items.map((item) => item.id)).not.toContain(pack.id);
  });

  it('lists a published pack with its cover and count', async () => {
    const { pack, stickers } = await packWithStickers(3);
    await publishPack(pack.id);
    const { items } = await listPublishedPacks({ limit: 100, offset: 0 });
    const card = items.find((item) => item.id === pack.id);
    expect(card?.stickerCount).toBe(3);
    expect(card?.cover?.id).toBe(stickers[0].id);
  });

  it('keeps resolving an archived pack, but drops it from the shop', async () => {
    const { pack, stickers } = await packWithStickers(1);
    await publishPack(pack.id);
    await archivePack(pack.id);

    const [resolved] = await resolveStickers([stickers[0].id, 'no-such-sticker']);
    expect(resolved?.id).toBe(stickers[0].id);
    expect((await getPackBySlug(pack.slug))?.status).toBe('archived');
    const { items } = await listPublishedPacks({ limit: 100, offset: 0 });
    expect(items.map((item) => item.id)).not.toContain(pack.id);
  });

  it('finds published stickers by emoji and by keyword, case-insensitively', async () => {
    const emoji = `🧪${randomUUID().slice(0, 4)}`;
    const { pack, stickers } = await packWithStickers(1, emoji);
    await publishPack(pack.id);
    expect((await searchStickers({ emoji, limit: 10 })).map((sticker) => sticker.id)).toEqual([stickers[0].id]);
    const byKeyword = await searchStickers({ q: 'SMILE', limit: 100 });
    expect(byKeyword.map((sticker) => sticker.id)).toContain(stickers[0].id);
  });
});

describe('the catalogue protects what messages point at', () => {
  it('refuses to remove a sticker from a published pack', async () => {
    const { pack, stickers } = await packWithStickers(1);
    await publishPack(pack.id);
    await expect(removeSticker(pack.id, stickers[0].id)).rejects.toThrow(ConflictError);
  });

  it('removes a draft sticker', async () => {
    const { pack, stickers } = await packWithStickers(2);
    await removeSticker(pack.id, stickers[0].id);
    await expect(removeSticker(pack.id, stickers[0].id)).rejects.toThrow(NotFoundError);
  });

  it('deletes only a never-published draft', async () => {
    const draft = await packWithStickers(1);
    await deleteDraftPack(draft.pack.id);

    const published = await packWithStickers(1);
    await publishPack(published.pack.id);
    await expect(deleteDraftPack(published.pack.id)).rejects.toThrow(ConflictError);
  });

  it('will not let a sticker file be deleted out from under a sticker', async () => {
    const { stickers } = await packWithStickers(1);
    const [row] = await getDb().select({ id: files.id, sha256: files.sha256 }).from(files).where(eq(files.sha256, stickers[0].animation.sha256));
    await expect(getDb().delete(files).where(eq(files.id, row.id))).rejects.toThrow();
  });
});

describe('a person’s picker', () => {
  it('installs idempotently, in order, and survives an archive', async () => {
    const userId = await insertUser();
    const first = await packWithStickers(1);
    const second = await packWithStickers(2);
    await publishPack(first.pack.id);
    await publishPack(second.pack.id);

    await installPack(userId, first.pack.id);
    await installPack(userId, second.pack.id);
    await installPack(userId, first.pack.id);

    let installed = await listInstalledPacks(userId);
    expect(installed.map((pack) => pack.id)).toEqual([first.pack.id, second.pack.id]);
    expect(installed[1].stickers).toHaveLength(2);

    await archivePack(first.pack.id);
    installed = await listInstalledPacks(userId);
    expect(installed.map((pack) => pack.id)).toEqual([first.pack.id, second.pack.id]);
  });

  it('refuses a draft as not found and an archived pack as no longer offered', async () => {
    const userId = await insertUser();
    const draft = await packWithStickers(1);
    await expect(installPack(userId, draft.pack.id)).rejects.toThrow(NotFoundError);

    const archived = await packWithStickers(1);
    await publishPack(archived.pack.id);
    await archivePack(archived.pack.id);
    await expect(installPack(userId, archived.pack.id)).rejects.toThrow(ConflictError);
  });

  it('reorders only with the exact installed set, and uninstalls', async () => {
    const userId = await insertUser();
    const a = await packWithStickers(1);
    const b = await packWithStickers(1);
    await publishPack(a.pack.id);
    await publishPack(b.pack.id);
    await installPack(userId, a.pack.id);
    await installPack(userId, b.pack.id);

    await expect(reorderInstalledPacks(userId, [b.pack.id])).rejects.toThrow(BadRequestError);
    await expect(reorderInstalledPacks(userId, [b.pack.id, b.pack.id])).rejects.toThrow(BadRequestError);

    await reorderInstalledPacks(userId, [b.pack.id, a.pack.id]);
    expect((await listInstalledPacks(userId)).map((pack) => pack.id)).toEqual([b.pack.id, a.pack.id]);

    await uninstallPack(userId, b.pack.id);
    expect((await listInstalledPacks(userId)).map((pack) => pack.id)).toEqual([a.pack.id]);
  });
});
