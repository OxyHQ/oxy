/**
 * VariantService image-variant config + resize coverage.
 *
 * Focus: the `w96`/`w128` variants (96×96 / 128×128 webp, fit-inside) in the
 * `imageVariants` config — both named for their width, matching the existing
 * `w320`/`w640`/`w1280`/`w2048` size-based variants (`w128` shipped briefly
 * as `avatar` before being renamed to fit that convention, since it's a
 * generic small-image size, not avatar-specific; `w96` is a smaller sibling
 * for even-tinier renders, e.g. ~36px post avatars). Because the config is
 * consumed by BOTH the upload-time `generateImageVariants` path and the
 * on-demand `ensureImageVariant` (CDN-read) path, exercising
 * `ensureImageVariant` proves each key is wired end to end: an unknown
 * variant is rejected (config-lookup gate), and a known one downloads the
 * ORIGINAL object, runs the real Sharp resize, and uploads the resized
 * bytes.
 *
 * S3 is stubbed; Sharp runs for real so the assertions cover actual output
 * dimensions and byte sizes, and the rendition is written to a REAL
 * `file_variants` row — which is the part that changed: a variant used to be an
 * element of the parent document's array, so "was it persisted" and "was it
 * returned" were the same object. They are now a row and a return value, and the
 * last case checks they agree.
 */

import sharp from 'sharp';
import { randomBytes } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { fileVariants, files, users } from '../../db/schema';
import { findFileById } from '../fileRepository';
import { ImageNotRenderableError, VariantService } from '../variantService';
import type { S3Service } from '../s3Service';
import type { FileRecord } from '../../types/file.types';

interface UploadOptions {
  contentType: string;
  cacheControl?: string;
}

interface CapturedUpload {
  key: string;
  buffer: Buffer;
  options?: UploadOptions;
}

interface FakeS3 {
  downloadBuffer: jest.Mock<Promise<Buffer>, [string]>;
  uploadBuffer: jest.Mock<Promise<void>, [string, Buffer, UploadOptions?]>;
  fileExists: jest.Mock<Promise<boolean>, [string]>;
  uploads: CapturedUpload[];
}

function makeFakeS3(originalBuffer: Buffer): FakeS3 {
  const uploads: CapturedUpload[] = [];
  return {
    downloadBuffer: jest.fn(() => Promise.resolve(originalBuffer)),
    uploadBuffer: jest.fn((key: string, buffer: Buffer, options?: UploadOptions) => {
      uploads.push({ key, buffer, options });
      return Promise.resolve();
    }),
    fileExists: jest.fn(() => Promise.resolve(false)),
    uploads,
  };
}

/**
 * A real `files` row, so `ensureImageVariant` writes its rendition to a real
 * child row. Each call gets its own RANDOM content hash: rows for one hash share
 * storage and renditions across the whole table, and Jest runs suites in
 * parallel against one database.
 */
async function makeFile(mime = 'image/png'): Promise<FileRecord> {
  const [owner] = await getDb().insert(users).values({ color: 'teal' }).returning({ id: users.id });
  const [row] = await getDb()
    .insert(files)
    .values({
      sha256: randomBytes(32).toString('hex'),
      size: 1024,
      mime,
      ext: 'png',
      visibility: 'public',
      storageKey: 'public/uploads/2026/07/aa/original.png',
      ownerUserId: owner.id,
    })
    .returning();
  return { ...row, links: [], variants: [], accessGrants: [] };
}

beforeAll(async () => {
  await connectPostgres();
});

afterAll(async () => {
  await closePostgres();
});

async function makeSquarePng(size: number): Promise<Buffer> {
  return sharp({
    create: {
      width: size,
      height: size,
      channels: 3,
      background: { r: 200, g: 40, b: 40 },
    },
  })
    .png()
    .toBuffer();
}

describe('VariantService imageVariants — w128 variant', () => {
  it('generates a 128×128 webp for the w128 variant from an existing original', async () => {
    const original = await makeSquarePng(512);
    const fakeS3 = makeFakeS3(original);
    const service = new VariantService(fakeS3 as unknown as S3Service);

    const variant = await service.ensureImageVariant(await makeFile(), 'w128');

    expect(variant.type).toBe('w128');
    expect(variant.width).toBe(128);
    expect(variant.height).toBe(128);
    expect(variant.metadata).toMatchObject({ format: 'webp', quality: 82 });

    // The on-demand path reads the canonical original then uploads the resize.
    expect(fakeS3.downloadBuffer).toHaveBeenCalledWith('public/uploads/2026/07/aa/original.png');
    const uploaded = fakeS3.uploads.find((u) => u.key.endsWith('/w128.webp'));
    expect(uploaded).toBeDefined();
    const meta = await sharp(uploaded?.buffer).metadata();
    expect(meta.format).toBe('webp');
    expect(meta.width).toBe(128);
    expect(meta.height).toBe(128);
  });

  it('produces meaningfully smaller bytes than thumb for the same source', async () => {
    const original = await makeSquarePng(512);

    const w128S3 = makeFakeS3(original);
    const w128 = await new VariantService(w128S3 as unknown as S3Service).ensureImageVariant(
      await makeFile(),
      'w128',
    );

    const thumbS3 = makeFakeS3(original);
    const thumb = await new VariantService(thumbS3 as unknown as S3Service).ensureImageVariant(
      await makeFile(),
      'thumb',
    );

    // thumb stays 256×256 (unchanged); w128 is half the linear dimension.
    expect(thumb.width).toBe(256);
    expect(thumb.height).toBe(256);
    expect(w128.width).toBe(128);

    const w128Bytes = w128S3.uploads.find((u) => u.key.endsWith('/w128.webp'))?.buffer.length ?? 0;
    const thumbBytes =
      thumbS3.uploads.find((u) => u.key.endsWith('/thumb.webp'))?.buffer.length ?? 0;
    expect(w128Bytes).toBeGreaterThan(0);
    expect(thumbBytes).toBeGreaterThan(0);
    expect(w128Bytes).toBeLessThan(thumbBytes);
  });

  it('generates a 96×96 webp for the w96 variant, smaller than w128', async () => {
    const original = await makeSquarePng(512);

    const w96S3 = makeFakeS3(original);
    const w96 = await new VariantService(w96S3 as unknown as S3Service).ensureImageVariant(
      await makeFile(),
      'w96',
    );

    expect(w96.type).toBe('w96');
    expect(w96.width).toBe(96);
    expect(w96.height).toBe(96);
    expect(w96.metadata).toMatchObject({ format: 'webp', quality: 82 });

    const uploaded = w96S3.uploads.find((u) => u.key.endsWith('/w96.webp'));
    expect(uploaded).toBeDefined();
    const meta = await sharp(uploaded?.buffer).metadata();
    expect(meta.format).toBe('webp');
    expect(meta.width).toBe(96);
    expect(meta.height).toBe(96);

    const w128S3 = makeFakeS3(original);
    const w128 = await new VariantService(w128S3 as unknown as S3Service).ensureImageVariant(
      await makeFile(),
      'w128',
    );
    const w96Bytes = uploaded?.buffer.length ?? 0;
    const w128Bytes = w128S3.uploads.find((u) => u.key.endsWith('/w128.webp'))?.buffer.length ?? 0;
    expect(w96Bytes).toBeGreaterThan(0);
    expect(w128Bytes).toBeGreaterThan(0);
    expect(w96Bytes).toBeLessThan(w128Bytes);
  });

  it('persists the rendition as a row whose key matches the returned variant', async () => {
    // The rendition is a `file_variants` row now, not an element of the parent
    // document. A path that returned a correct-looking variant without writing
    // the row would serve a key nothing points at on the next read.
    const original = await makeSquarePng(512);
    const fakeS3 = makeFakeS3(original);
    const file = await makeFile();

    const variant = await new VariantService(fakeS3 as unknown as S3Service).ensureImageVariant(
      file,
      'w128',
    );

    const stored = await getDb()
      .select()
      .from(fileVariants)
      .where(eq(fileVariants.fileId, file.id));

    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ id: variant.id, type: 'w128', key: variant.key });
    expect(stored[0].readyAt).toBeInstanceOf(Date);
    // The caller's in-hand record is kept consistent with what was stored.
    expect(file.variants.map((v) => v.id)).toEqual([variant.id]);
  });

  it('replaces the row of the same type on a regeneration rather than duplicating it', async () => {
    const original = await makeSquarePng(512);
    const file = await makeFile();
    const service = new VariantService(makeFakeS3(original) as unknown as S3Service);

    const first = await service.ensureImageVariant(file, 'w128');
    // `fileExists` is false in the fake, so the second call regenerates rather
    // than reusing — exactly the path that used to re-`$set` the whole array.
    const second = await service.ensureImageVariant(file, 'w128');

    const stored = await getDb()
      .select()
      .from(fileVariants)
      .where(eq(fileVariants.fileId, file.id));

    expect(stored).toHaveLength(1);
    expect(stored[0].id).toBe(second.id);
    expect(second.id).not.toBe(first.id);
  });

  it('stores the rendition with an immutable Cache-Control', async () => {
    // `variants/{y}/{m}/{shard}/{sha256}/{type}.{ext}` names the SOURCE's own
    // digest, so this key can only ever hold this rendition of this source. It
    // was nonetheless written with NO `Cache-Control` at all, which sends every
    // client to heuristic freshness — zero for a rendition minted on demand,
    // whose `Last-Modified` is now. That is the avatar re-fetch: `w96` is the
    // variant a feed row's avatar asks for.
    const fakeS3 = makeFakeS3(await makeSquarePng(512));

    await new VariantService(fakeS3 as unknown as S3Service).ensureImageVariant(
      await makeFile(),
      'w96',
    );

    const uploaded = fakeS3.uploads.find((u) => u.key.endsWith('/w96.webp'));
    expect(uploaded?.options).toMatchObject({
      contentType: 'image/webp',
      cacheControl: 'public, max-age=31536000, immutable',
    });
  });

  it('keeps the renditions of a public file that is not served off the CDN (trash, blocked)', async () => {
    const original = await makeSquarePng(256);
    for (const status of ['trash', 'blocked'] as const) {
      const fakeS3 = makeFakeS3(original);
      const service = new VariantService(fakeS3 as unknown as S3Service);
      const file = { ...(await makeFile()), status };

      const variant = await service.ensureImageVariant(file, 'w128');

      // Written in the spelling the file is SERVED in (ADR 0043 D5, D10): a
      // public file out of `active` is not on the CDN, and neither is its rendition.
      expect(variant.key.startsWith('public/')).toBe(false);
      expect(fakeS3.uploads.map((upload) => upload.key)).toEqual([variant.key]);
    }
    const served = makeFakeS3(original);
    const live = await new VariantService(served as unknown as S3Service).ensureImageVariant(
      await makeFile(),
      'w128',
    );
    expect(live.key.startsWith('public/variants/')).toBe(true);
  });

  it('rejects a variant key that is not in the imageVariants config', async () => {
    const original = await makeSquarePng(512);
    const service = new VariantService(makeFakeS3(original) as unknown as S3Service);

    await expect(
      service.ensureImageVariant(await makeFile(), 'not-a-real-variant'),
    ).rejects.toThrow(/Unsupported image variant/);
  });
});

/**
 * The same size taxonomy applied to a VIDEO, rendered from its poster frame.
 *
 * These cover the branch that needs no ffmpeg — the poster already exists, so
 * only the Sharp resize runs. The decode itself (and the whole HTTP path down
 * from `GET /cdn/:id?variant=…`) is covered end to end with a real clip in
 * `src/routes/__tests__/cdnVideoImageVariant.test.ts`.
 */
describe('VariantService.ensureVideoImageVariant — sizes derived from the poster', () => {
  const POSTER_KEY = 'public/variants/2026/08/bb/poster.jpg';

  /**
   * A REAL `files` row for a video, plus a REAL poster child row.
   *
   * An in-memory object with an `_id` would be fine against a mocked store and
   * impossible against this one. `file_variants.file_id` is a
   * foreign key, so a synthetic parent fails the insert — and before that, the
   * port reads `file.id`, so `_id` produced
   * `delete from file_variants where file_id = ''`. Two different failures,
   * neither of them about the feature under test.
   */
  async function makeVideoFileWithPoster(): Promise<FileRecord> {
    const [owner] = await getDb()
      .insert(users)
      .values({ color: 'teal' })
      .returning({ id: users.id });
    const [row] = await getDb()
      .insert(files)
      .values({
        sha256: randomBytes(32).toString('hex'),
        size: 4096,
        mime: 'video/mp4',
        ext: 'mp4',
        visibility: 'public',
        storageKey: 'public/content/2026/08/bb/original.mp4',
        ownerUserId: owner.id,
      })
      .returning();
    const [poster] = await getDb()
      .insert(fileVariants)
      .values({ fileId: row.id, type: 'poster', key: POSTER_KEY, readyAt: new Date() })
      .returning();
    return { ...row, links: [], variants: [poster] };
  }

  /**
   * A poster-shaped source: portrait, like the vertical clips that dominate the
   * corpus, so a square output would be visible in the assertion.
   */
  async function makePortraitJpeg(width: number, height: number): Promise<Buffer> {
    return sharp({
      create: { width, height, channels: 3, background: { r: 30, g: 90, b: 160 } },
    })
      .jpeg()
      .toBuffer();
  }

  it('renders a size from the existing poster instead of re-decoding the video', async () => {
    const poster = await makePortraitJpeg(1080, 1920);
    const fakeS3 = makeFakeS3(poster);
    // The poster is already ready in storage, so the reuse probe must find it.
    fakeS3.fileExists.mockImplementation((key: string) => Promise.resolve(key === POSTER_KEY));

    const service = new VariantService(fakeS3 as unknown as S3Service);
    const variant = await service.ensureVideoImageVariant(await makeVideoFileWithPoster(), 'w320');

    expect(variant.type).toBe('w320');
    // The POSTER is the source — never the video's own storage key, which sharp
    // could not decode anyway.
    expect(fakeS3.downloadBuffer).toHaveBeenCalledWith(POSTER_KEY);

    const uploaded = fakeS3.uploads.find((u) => u.key.endsWith('/w320.webp'));
    expect(uploaded).toBeDefined();
    const meta = await sharp(uploaded?.buffer).metadata();
    expect(meta.format).toBe('webp');
    expect(meta.width).toBe(320);
    // Aspect preserved (1080×1920 → 320×569), so a portrait video is never
    // squashed into a square thumbnail.
    expect(meta.height).toBe(569);
  });

  it('rejects a variant key that is not a real size (keeps the 404 for a bogus name)', async () => {
    const poster = await makePortraitJpeg(1080, 1920);
    const fakeS3 = makeFakeS3(poster);
    fakeS3.fileExists.mockImplementation((key: string) => Promise.resolve(key === POSTER_KEY));

    const service = new VariantService(fakeS3 as unknown as S3Service);

    await expect(
      service.ensureVideoImageVariant(await makeVideoFileWithPoster(), 'not-a-real-variant'),
    ).rejects.toThrow(/Unsupported video image variant/);
    // A rejected name must never reach storage.
    expect(fakeS3.uploads).toHaveLength(0);
  });
});

describe('VariantService image generation retry', () => {
  it('keeps ready rendition rows instead of deleting and recreating them', async () => {
    const original = await makeSquarePng(512);
    const fakeS3 = makeFakeS3(original);
    const service = new VariantService(fakeS3 as unknown as S3Service);
    const file = await makeFile();
    const generate = (target: FileRecord) =>
      (
        service as unknown as { generateImageVariants(f: FileRecord): Promise<void> }
      ).generateImageVariants(target);

    await generate(file);
    // xmin changes whenever a row is deleted and reinserted, even with the same id.
    const rowsOf = () =>
      getDb()
        .select({
          id: fileVariants.id,
          type: fileVariants.type,
          key: fileVariants.key,
          version: sql<string>`xmin::text`,
        })
        .from(fileVariants)
        .where(eq(fileVariants.fileId, file.id));
    const first = await rowsOf();
    expect(first.length).toBeGreaterThan(0);
    const uploadsAfterFirst = fakeS3.uploads.length;

    fakeS3.fileExists.mockImplementation(() => Promise.resolve(true));
    await generate(file);
    const second = await rowsOf();
    const ids = (rows: typeof first) =>
      rows.map((row) => `${row.type}:${row.id}:${row.key}:${row.version}`).sort();
    expect(ids(second)).toEqual(ids(first));
    expect(fakeS3.uploads).toHaveLength(uploadsAfterFirst);
    expect(file.variants.map((variant) => variant.id).sort()).toEqual(
      first.map((row) => row.id).sort(),
    );
  });
});

/**
 * libvips has no ICO loader, so an icon (every favicon an application stores)
 * failed every rendition and every queue attempt with "Input buffer contains
 * unsupported image format". The pipeline renders the icon's largest frame;
 * bytes nothing can render complete as "served as stored", never as a failure
 * to retry.
 */
describe('VariantService — icons and images that cannot be rendered', () => {
  /** A one-frame 32-bit ICO, `size` square, opaque blue. */
  function blueIcon(size: number): Buffer {
    const header = Buffer.alloc(6 + 16);
    header.writeUInt16LE(1, 2);
    header.writeUInt16LE(1, 4);
    const bmp = Buffer.alloc(40 + size * size * 4 + Math.ceil(size / 32) * 4 * size);
    bmp.writeUInt32LE(40, 0);
    bmp.writeInt32LE(size, 4);
    bmp.writeInt32LE(size * 2, 8);
    bmp.writeUInt16LE(1, 12);
    bmp.writeUInt16LE(32, 14);
    for (let pixel = 0; pixel < size * size; pixel += 1) {
      bmp[40 + pixel * 4] = 255; // B
      bmp[40 + pixel * 4 + 3] = 255; // A
    }
    header.writeUInt8(size & 0xff, 6);
    header.writeUInt8(size & 0xff, 7);
    header.writeUInt16LE(32, 12);
    header.writeUInt32LE(bmp.length, 14);
    header.writeUInt32LE(22, 18);
    return Buffer.concat([header, bmp]);
  }

  it('renders an ICO from its largest frame', async () => {
    const fakeS3 = makeFakeS3(blueIcon(64));
    await expect(sharp(blueIcon(64)).metadata()).rejects.toThrow(/unsupported image format/);

    const variant = await new VariantService(fakeS3 as unknown as S3Service).ensureImageVariant(
      await makeFile('image/x-icon'),
      'w96',
    );

    // Never enlarged: the icon is 64 pixels wide.
    expect([variant.width, variant.height]).toEqual([64, 64]);
    const uploaded = fakeS3.uploads.find((u) => u.key.endsWith('/w96.webp'));
    const { data, info } = await sharp(uploaded?.buffer)
      .raw()
      .toBuffer({ resolveWithObject: true });
    expect(info.width).toBe(64);
    // Blue, within the lossy WebP encode.
    const [r, g, b] = data;
    expect(r).toBeLessThan(10);
    expect(g).toBeLessThan(10);
    expect(b).toBeGreaterThan(245);
  });

  it('builds the whole rendition set of an ICO on the queued path, with its dimensions', async () => {
    const fakeS3 = makeFakeS3(blueIcon(48));
    const file = await makeFile('image/vnd.microsoft.icon');

    await new VariantService(fakeS3 as unknown as S3Service).generateVariants(file.id);

    const stored = await getDb()
      .select()
      .from(fileVariants)
      .where(eq(fileVariants.fileId, file.id));
    expect(stored.length).toBeGreaterThan(0);
    const [row] = await getDb().select().from(files).where(eq(files.id, file.id));
    expect(row.metadata).toMatchObject({ image: { width: 48, height: 48 } });
  });

  it('completes, with no renditions and no retry, for bytes nothing can render', async () => {
    const fakeS3 = makeFakeS3(Buffer.from('definitely not an image'));
    const file = await makeFile('image/x-icon');
    const service = new VariantService(fakeS3 as unknown as S3Service);

    // The queued job resolves: a throw here is what made BullMQ retry it.
    await expect(service.generateVariants(file.id)).resolves.toBeUndefined();
    const stored = await getDb()
      .select()
      .from(fileVariants)
      .where(eq(fileVariants.fileId, file.id));
    expect(stored).toHaveLength(0);
    expect(fakeS3.uploads).toHaveLength(0);

    // A rendition asked on read is classified, so the caller serves the original.
    await expect(service.ensureImageVariant(file, 'w96')).rejects.toBeInstanceOf(
      ImageNotRenderableError,
    );
  });
});

describe('VariantService image seeds', () => {
  /** Three quarters orange, a quarter deep blue. */
  async function makeTwoColourJpeg(): Promise<Buffer> {
    return sharp({ create: { width: 400, height: 300, channels: 3, background: '#e76f51' } })
      .composite([
        {
          input: { create: { width: 100, height: 300, channels: 3, background: '#1d3557' } },
          left: 300,
          top: 0,
        },
      ])
      .jpeg()
      .toBuffer();
  }

  function expectWarmSeedsFirst(seeds: unknown): void {
    expect(Array.isArray(seeds)).toBe(true);
    const list = seeds as string[];
    expect(list.length).toBeGreaterThan(0);
    expect(list.length).toBeLessThanOrEqual(3);
    for (const seed of list) expect(seed).toMatch(/^#[0-9a-f]{6}$/);
    // The orange covers three quarters of the image: the first seed is warm.
    const [top = '#000000'] = list;
    expect(Number.parseInt(top.slice(1, 3), 16)).toBeGreaterThan(
      Number.parseInt(top.slice(5, 7), 16),
    );
  }

  it('stores the seeds of an image when its renditions are made', async () => {
    const service = new VariantService(makeFakeS3(await makeTwoColourJpeg()) as unknown as S3Service);
    const file = await makeFile('image/jpeg');

    await service.generateVariants(file.id);

    const stored = await findFileById(file.id);
    expect(stored?.metadata?.media).toMatchObject({ width: 400, height: 300 });
    expectWarmSeedsFirst((stored?.metadata?.media as { seeds?: unknown } | undefined)?.seeds);
  });

  it('stores them too when only the metadata is backfilled', async () => {
    const service = new VariantService(makeFakeS3(await makeTwoColourJpeg()) as unknown as S3Service);
    const file = await makeFile('image/jpeg');

    expect(await service.extractSourceMetadataOnly(file.id)).toBe(true);

    const stored = await findFileById(file.id);
    expectWarmSeedsFirst((stored?.metadata?.media as { seeds?: unknown } | undefined)?.seeds);
  });
});
