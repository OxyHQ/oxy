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
import { eq } from 'drizzle-orm';
import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { fileVariants, files, users } from '../../db/schema';
import { VariantService } from '../variantService';
import type { S3Service } from '../s3Service';
import type { FileRecord } from '../../types/file.types';

interface CapturedUpload {
  key: string;
  buffer: Buffer;
}

interface FakeS3 {
  downloadBuffer: jest.Mock<Promise<Buffer>, [string]>;
  uploadBuffer: jest.Mock<Promise<void>, [string, Buffer, { contentType: string }?]>;
  fileExists: jest.Mock<Promise<boolean>, [string]>;
  uploads: CapturedUpload[];
}

function makeFakeS3(originalBuffer: Buffer): FakeS3 {
  const uploads: CapturedUpload[] = [];
  return {
    downloadBuffer: jest.fn(() => Promise.resolve(originalBuffer)),
    uploadBuffer: jest.fn((key: string, buffer: Buffer) => {
      uploads.push({ key, buffer });
      return Promise.resolve();
    }),
    fileExists: jest.fn(() => Promise.resolve(false)),
    uploads,
  };
}

/**
 * A real `files` row, so `ensureImageVariant` writes its rendition to a real
 * child row. Each call gets its own RANDOM content hash: `files_sha256_live_key`
 * allows one live row per hash across the whole table, and Jest runs suites in
 * parallel against one database.
 */
async function makeFile(): Promise<FileRecord> {
  const [owner] = await getDb()
    .insert(users)
    .values({ color: 'teal' })
    .returning({ id: users.id });
  const [row] = await getDb()
    .insert(files)
    .values({
      sha256: randomBytes(32).toString('hex'),
      size: 1024,
      mime: 'image/png',
      ext: 'png',
      visibility: 'public',
      storageKey: 'public/uploads/2026/07/aa/original.png',
      ownerUserId: owner.id,
    })
    .returning();
  return { ...row, links: [], variants: [] };
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
    const uploaded = fakeS3.uploads.find(u => u.key.endsWith('/w128.webp'));
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

    const w128Bytes = w128S3.uploads.find(u => u.key.endsWith('/w128.webp'))?.buffer.length ?? 0;
    const thumbBytes = thumbS3.uploads.find(u => u.key.endsWith('/thumb.webp'))?.buffer.length ?? 0;
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

    const uploaded = w96S3.uploads.find(u => u.key.endsWith('/w96.webp'));
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
    const w128Bytes = w128S3.uploads.find(u => u.key.endsWith('/w128.webp'))?.buffer.length ?? 0;
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

    const variant = await new VariantService(
      fakeS3 as unknown as S3Service
    ).ensureImageVariant(file, 'w128');

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

  it('rejects a variant key that is not in the imageVariants config', async () => {
    const original = await makeSquarePng(512);
    const service = new VariantService(makeFakeS3(original) as unknown as S3Service);

    await expect(service.ensureImageVariant(await makeFile(), 'not-a-real-variant')).rejects.toThrow(
      /Unsupported image variant/,
    );
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
   * main's fixture was an in-memory object with a Mongoose `_id`: fine against
   * a mocked store, impossible against this one. `file_variants.file_id` is a
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

    const uploaded = fakeS3.uploads.find(u => u.key.endsWith('/w320.webp'));
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
