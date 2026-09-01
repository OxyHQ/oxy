/**
 * `GET /cdn/:id?variant=<size>` for a VIDEO file — end-to-end.
 *
 * The regression this pins: an image SIZE variant name asked of a video file
 * used to be fatal. `assetService.ensureVariant` handled `image/*` and the
 * single `video/*` + `poster` pair and threw for everything else, and the public
 * CDN origin turns a throwing probe into a 404 carrying no bytes — so every
 * consumer that resolved a bare file id through the synchronous, mime-blind
 * `getFileDownloadUrl(id, 'thumb')` got a placeholder for a video and a
 * thumbnail for an image. A size name now means "an image of this asset at that
 * size" for every mime, which for a video is a render of its poster frame.
 *
 * This exercises the WHOLE chain for real — express route → `getPublicCdnUrl`
 * → `ensureVariant` → `ensureVideoImageVariant` → `ensureVideoPoster` → a real
 * ffmpeg decode over HTTP → a real Sharp resize → the variant key the 302 points
 * at, and the `file_variants` row that records it. Only S3 is substituted, by
 * an in-memory object store, so the bytes asserted at the end are the bytes the
 * pipeline actually produced.
 *
 * The FIXTURE is what the port changed. `main` handed the services a plain
 * object with a Mongoose `_id` and an empty `variants` array, which was free
 * against a mocked model and is impossible here twice over: the code reads
 * `file.id`, so an `_id` fixture addressed `file_id = ''`; and `file_variants`
 * carries a real foreign key, so a fabricated parent cannot own a rendition.
 * The video is a REAL `files` row with a REAL owner — see `seedVideoFile`.
 *
 * ffmpeg reads the video over `http://127.0.0.1:<port>` rather than from disk,
 * which is also what proves the poster decode's protocol whitelist admits a
 * legitimate object-store URL instead of breaking it.
 *
 * The control cases matter as much as the happy path: a variant name that is
 * not a real size must STILL 404 (so a passing assertion here cannot be
 * explained by the route having become permissive), and the poster must be
 * decoded exactly once across several requested sizes.
 */

import express from 'express';
import http from 'http';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { randomBytes } from 'node:crypto';
import type { AddressInfo } from 'net';
import sharp from 'sharp';

import type { S3Service } from '../../services/s3Service';

jest.mock('../../utils/logger', () => ({
  logger: { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

jest.mock('../../services/mediaPrivacyService', () => ({ mediaPrivacyService: {} }));

const mockGetFile = jest.fn();
const mockGetPublicCdnUrl = jest.fn();

jest.mock('../../services/assetServiceSingleton', () => ({
  assetService: {
    getFile: (...args: unknown[]) => mockGetFile(...args),
    getPublicCdnUrl: (...args: unknown[]) => mockGetPublicCdnUrl(...args),
  },
  s3Service: {},
}));

import { eq } from 'drizzle-orm';
import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { fileVariants, files, users } from '../../db/schema';
import { AssetService } from '../../services/assetService';
import type { FileRecord } from '../../types/file.types';
import cdnRouter from '../cdn';
import { errorHandler } from '../../middleware/errorHandler';

/**
 * The content hash is RANDOM per run, not a fixed `'c'.repeat(64)`:
 * `files_sha256_live_key` admits one live row per hash across the whole table,
 * jest runs suites in parallel against one database, and this suite is re-run
 * against a database that already holds its previous rows. Every key the
 * pipeline derives from it is therefore derived in the assertions too, never
 * spelled out.
 */
const VIDEO_SHA256 = randomBytes(32).toString('hex');
const VIDEO_STORAGE_KEY = 'public/content/2026/08/cc/sample.mp4';
const VIDEO_WIDTH = 540;
const VIDEO_HEIGHT = 960;

/** In-memory stand-in for S3, addressed by storage key exactly as the real one is. */
class InMemoryObjectStore {
  readonly objects = new Map<string, { buffer: Buffer; contentType?: string }>();
  /** Every key handed to ffmpeg as a presigned URL, in call order. */
  readonly presignedFor: string[] = [];
  private origin = '';

  setOrigin(origin: string): void {
    this.origin = origin;
  }

  put(key: string, buffer: Buffer, contentType?: string): void {
    this.objects.set(key, { buffer, contentType });
  }

  urlFor(key: string): string {
    this.presignedFor.push(key);
    return `${this.origin}/${encodeURIComponent(key)}`;
  }
}

/** Adapt the in-memory store to the S3Service surface the services call. */
function asS3Service(store: InMemoryObjectStore): S3Service {
  return {
    getPresignedDownloadUrl: async (key: string): Promise<string> => store.urlFor(key),
    downloadBuffer: async (key: string): Promise<Buffer> => {
      const found = store.objects.get(key);
      if (!found) {
        throw new Error(`No such object: ${key}`);
      }
      return found.buffer;
    },
    uploadBuffer: async (key: string, buffer: Buffer, options?: { contentType?: string }): Promise<void> => {
      store.put(key, buffer, options?.contentType);
    },
    fileExists: async (key: string): Promise<boolean> => store.objects.has(key),
  } as unknown as S3Service;
}

/**
 * Serve the object store over HTTP with byte-range support — ffmpeg seeks an
 * mp4 with ranged requests, so a server that ignores `Range` would silently
 * change what is being tested.
 */
function startObjectServer(store: InMemoryObjectStore): Promise<http.Server> {
  const server = http.createServer((req, res) => {
    const key = decodeURIComponent((req.url ?? '/').replace(/^\//, '').split('?')[0]);
    const found = store.objects.get(key);
    if (!found) {
      res.writeHead(404).end();
      return;
    }

    const total = found.buffer.length;
    const range = req.headers.range;
    const match = typeof range === 'string' ? /^bytes=(\d*)-(\d*)$/.exec(range) : null;
    if (match) {
      const start = match[1] ? Number.parseInt(match[1], 10) : 0;
      const end = match[2] ? Number.parseInt(match[2], 10) : total - 1;
      const slice = found.buffer.subarray(start, Math.min(end, total - 1) + 1);
      res.writeHead(206, {
        'Content-Type': found.contentType ?? 'application/octet-stream',
        'Content-Length': String(slice.length),
        'Content-Range': `bytes ${start}-${start + slice.length - 1}/${total}`,
        'Accept-Ranges': 'bytes',
      });
      res.end(slice);
      return;
    }

    res.writeHead(200, {
      'Content-Type': found.contentType ?? 'application/octet-stream',
      'Content-Length': String(total),
      'Accept-Ranges': 'bytes',
    });
    res.end(found.buffer);
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

interface RawResponse {
  status: number;
  location?: string;
}

/** Issue a request WITHOUT following redirects so the 302 itself is assertable. */
function requestNoFollow(server: http.Server, urlPath: string): Promise<RawResponse> {
  const address = server.address() as AddressInfo;
  return new Promise((resolve, reject) => {
    const req = http.request(
      { method: 'GET', host: '127.0.0.1', port: address.port, path: urlPath },
      (res) => {
        res.resume();
        res.on('end', () => resolve({ status: res.statusCode ?? 0, location: res.headers.location }));
      }
    );
    req.on('error', reject);
    req.end();
  });
}

/** A real 540×960 H.264 clip, so the decode under test has genuine bytes. */
function buildSampleVideo(): Buffer {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oxy-variant-test-'));
  const output = path.join(dir, 'sample.mp4');
  try {
    execFileSync(
      'ffmpeg',
      [
        '-hide_banner', '-loglevel', 'error',
        '-f', 'lavfi',
        '-i', `testsrc=size=${VIDEO_WIDTH}x${VIDEO_HEIGHT}:rate=10:duration=2`,
        '-c:v', 'libx264',
        '-pix_fmt', 'yuv420p',
        '-movflags', '+faststart',
        '-y', output,
      ],
      { stdio: 'pipe' }
    );
    return fs.readFileSync(output);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * A REAL `files` row for the clip, owned by a REAL account.
 *
 * `file_variants.file_id` is a foreign key, so every rendition the pipeline
 * writes needs a parent that exists; and the services address the file by
 * `file.id`, which a Mongoose-shaped `_id` fixture leaves undefined.
 */
async function seedVideoFile(): Promise<FileRecord> {
  const [owner] = await getDb().insert(users).values({}).returning({ id: users.id });
  const [row] = await getDb()
    .insert(files)
    .values({
      sha256: VIDEO_SHA256,
      size: 4096,
      mime: 'video/mp4',
      ext: 'mp4',
      status: 'active',
      visibility: 'public',
      storageKey: VIDEO_STORAGE_KEY,
      ownerUserId: owner.id,
    })
    .returning();
  return { ...row, links: [], variants: [] };
}

/** The key `generateVariantKey` derives for one rendition of this clip. */
function variantKey(type: string, ext: string): string {
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  return `public/variants/${now.getFullYear()}/${month}/${VIDEO_SHA256.slice(0, 2)}/${VIDEO_SHA256}/${type}.${ext}`;
}

let store: InMemoryObjectStore;
let objectServer: http.Server;
let apiServer: http.Server;
let videoFile: FileRecord;

beforeAll(async () => {
  await connectPostgres();
  store = new InMemoryObjectStore();
  store.put(VIDEO_STORAGE_KEY, buildSampleVideo(), 'video/mp4');

  objectServer = await startObjectServer(store);
  const objectAddress = objectServer.address() as AddressInfo;
  store.setOrigin(`http://127.0.0.1:${objectAddress.port}`);

  // The real service, over the in-memory store: `ensureVariant` and the whole
  // VariantService beneath it run unmodified, against the real database.
  const assetService = new AssetService(asS3Service(store));
  mockGetPublicCdnUrl.mockImplementation((file: FileRecord, variant?: string) =>
    assetService.getPublicCdnUrl(file, variant)
  );

  // ONE row shared by every request in this file, so a variant generated by an
  // earlier assertion is visible to a later one — exactly as the persisted
  // record would be.
  videoFile = await seedVideoFile();
  mockGetFile.mockResolvedValue(videoFile);

  const app = express();
  app.use('/cdn', cdnRouter);
  app.use(errorHandler);
  await new Promise<void>((resolve) => {
    apiServer = app.listen(0, '127.0.0.1', resolve);
  });
});

afterAll(async () => {
  await new Promise<void>((resolve) => objectServer.close(() => resolve()));
  await new Promise<void>((resolve) => apiServer.close(() => resolve()));
  await closePostgres();
});

describe('GET /cdn/:id?variant=<size> for a video file', () => {
  it('302s ?variant=thumb to a real webp rendered from the poster frame', async () => {
    const res = await requestNoFollow(apiServer, `/cdn/${videoFile.id}?variant=thumb`);

    expect(res.status).toBe(302);
    expect(res.location).toMatch(/\/thumb\.webp$/);

    // The redirect target must be an object that actually exists in storage,
    // located by the SAME key the variant recorded — not merely a well-formed URL.
    const key = variantKey('thumb', 'webp');
    const stored = store.objects.get(key);
    expect(stored).toBeDefined();
    expect(stored?.contentType).toBe('image/webp');

    // And the rendition is a real `file_variants` row pointing at that object,
    // so the next read resolves it instead of re-deriving it.
    const rows = await getDb()
      .select()
      .from(fileVariants)
      .where(eq(fileVariants.fileId, videoFile.id));
    expect(rows.filter((row) => row.type === 'thumb')).toEqual([
      expect.objectContaining({ key, readyAt: expect.any(Date) }),
    ]);

    const meta = await sharp(stored?.buffer).metadata();
    expect(meta.format).toBe('webp');
    // `thumb` is 256×256 fit-inside, so a 540×960 portrait clip yields a
    // 144×256 poster render — the video's aspect ratio, never a square crop.
    expect(meta.height).toBe(256);
    expect(meta.width).toBe(144);
  }, 60_000);

  it('serves a size that is meaningfully smaller than the full poster', async () => {
    await requestNoFollow(apiServer, `/cdn/${videoFile.id}?variant=w320`);

    const poster = [...store.objects.entries()].find(([key]) => key.endsWith('/poster.jpg'));
    const w320 = [...store.objects.entries()].find(([key]) => key.endsWith('/w320.webp'));
    expect(poster).toBeDefined();
    expect(w320).toBeDefined();

    const posterBytes = poster?.[1].buffer.length ?? 0;
    const w320Bytes = w320?.[1].buffer.length ?? 0;
    expect(posterBytes).toBeGreaterThan(0);
    expect(w320Bytes).toBeGreaterThan(0);
    // The point of the sized render: a feed card stops paying for a 1920px frame.
    expect(w320Bytes).toBeLessThan(posterBytes);
  }, 60_000);

  it('decodes the poster only once no matter how many sizes are requested', async () => {
    const before = store.presignedFor.filter((key) => key === VIDEO_STORAGE_KEY).length;

    await requestNoFollow(apiServer, `/cdn/${videoFile.id}?variant=w96`);
    await requestNoFollow(apiServer, `/cdn/${videoFile.id}?variant=w128`);
    await requestNoFollow(apiServer, `/cdn/${videoFile.id}?variant=w640`);

    // The poster already exists by now (earlier tests generated it), so no
    // further presign of the SOURCE VIDEO — the only reason to touch it — occurs.
    const after = store.presignedFor.filter((key) => key === VIDEO_STORAGE_KEY).length;
    expect(after).toBe(before);

    for (const size of ['w96', 'w128', 'w640']) {
      expect([...store.objects.keys()].some((key) => key.endsWith(`/${size}.webp`))).toBe(true);
    }
  }, 60_000);

  it('still 404s a variant name that is not a real size (control)', async () => {
    const res = await requestNoFollow(apiServer, `/cdn/${videoFile.id}?variant=not-a-real-size`);

    expect(res.status).toBe(404);
    expect(res.location).toBeUndefined();
    expect([...store.objects.keys()].some((key) => key.includes('not-a-real-size'))).toBe(false);
  }, 60_000);

  it('still serves the poster under its own name', async () => {
    const res = await requestNoFollow(apiServer, `/cdn/${videoFile.id}?variant=poster`);

    expect(res.status).toBe(302);
    expect(res.location).toMatch(/\/poster\.jpg$/);
  }, 60_000);
});
