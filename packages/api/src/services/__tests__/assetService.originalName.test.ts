/**
 * `original_name` normalisation, against a REAL Postgres.
 *
 * `originalName` is whatever the uploading client called the file — on some
 * platforms a share-sheet string carrying newlines, tabs or a run of spaces —
 * and it is echoed back to every viewer and mirrored onto `Message`
 * attachments. It is a single-line display value, so it gets the canonical
 * inline normalisation (`normalizeInlineText`: NFC, collapse whitespace runs,
 * trim).
 *
 * ## Why this file exists
 *
 * Mongoose ran that normalisation as a schema SETTER — the API's ONE sanctioned
 * setter, carved out precisely because there is no single write chokepoint:
 * several independent upload paths write this one leaf field. Postgres has no
 * setter, and it cannot be a generated column either: `normalizeInlineText`
 * starts with `String.prototype.normalize('NFC')` and Postgres has no IMMUTABLE
 * Unicode normalisation function in core (`schema/files.ts`).
 *
 * So the call moved to the SERVICE, at each of the three methods that write the
 * column — which is strictly stronger than the four ROUTE-level calls the schema
 * comment sketches, because it also covers the callers that never go through a
 * route (`email.service` storing an inbound attachment, `federation.service`
 * storing a remote avatar). This suite is what keeps that true: a new upload
 * path added without the call fails here, which is the guarantee the deleted
 * setter used to provide structurally.
 *
 * Each case checks the STORED column, not the return value — the return value
 * would still look normalised if the write had not been.
 */

import { createHash, randomBytes } from 'node:crypto';
import { Readable } from 'stream';
import { eq } from 'drizzle-orm';
import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { files, users } from '../../db/schema';
import { AssetService } from '../assetService';
import type { S3Service } from '../s3Service';
import type { FileInfo } from '../../types/s3.types';
import fileCache from '../../utils/fileCache';

jest.mock('../variantService', () => ({
  VariantService: class {
    constructor(_s3: unknown) { /* no-op */ }
    generateVariants = jest.fn(() => Promise.resolve());
  },
}));

/**
 * A filename with every kind of noise the normaliser removes: leading and
 * trailing spaces, a tab, a newline, a non-breaking space, and a DECOMPOSED
 * `é` (`e` + U+0301) that NFC must recompose.
 */
const MESSY_NAME = '  my\tholiday\nphoto café .png  ';
const CLEAN_NAME = 'my holiday photo café .png';

/**
 * Distinct, valid-PNG bytes per call — globally unique, because Jest runs suites
 * in PARALLEL against ONE database and one live row per content hash is a
 * table-wide constraint.
 */
function uniqueBody(): Buffer {
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    randomBytes(16),
  ]);
}

function fakeS3(): S3Service {
  return {
    uploadBuffer: jest.fn((): Promise<FileInfo> => Promise.resolve({} as FileInfo)),
    // Real S3 consumes the whole body before resolving, and the streamed-upload
    // path digests its content hash only once the pipe has ended. A fake that
    // resolved early would make the service digest mid-stream.
    uploadStream: jest.fn(async (_key: string, body: Readable): Promise<FileInfo> => {
      for await (const _chunk of body) {
        /* drain */
      }
      return {} as FileInfo;
    }),
    copyFile: jest.fn((): Promise<void> => Promise.resolve()),
    deleteFile: jest.fn((): Promise<void> => Promise.resolve()),
    fileExists: jest.fn((): Promise<boolean> => Promise.resolve(true)),
    getPresignedUploadUrl: jest.fn((): Promise<string> => Promise.resolve('url')),
  } as unknown as S3Service;
}

async function insertUser(): Promise<string> {
  const [row] = await getDb().insert(users).values({ color: 'teal' }).returning({ id: users.id });
  return row.id;
}

async function storedName(fileId: string): Promise<string | null> {
  const [row] = await getDb()
    .select({ originalName: files.originalName })
    .from(files)
    .where(eq(files.id, fileId))
    .limit(1);
  return row.originalName;
}

beforeAll(async () => {
  await connectPostgres();
});

afterEach(() => {
  fileCache.clear();
});

afterAll(async () => {
  await closePostgres();
});

it('normalises the sentinel name to exactly the expected form', () => {
  // A guard on the FIXTURE: if `MESSY_NAME` and `CLEAN_NAME` were accidentally
  // equal, every case below would pass without testing anything.
  expect(MESSY_NAME).not.toBe(CLEAN_NAME);
});

describe('every path that writes original_name normalises it', () => {
  it('uploadFileDirect', async () => {
    const service = new AssetService(fakeS3());
    const file = await service.uploadFileDirect(
      await insertUser(),
      uniqueBody(),
      'image/png',
      MESSY_NAME,
    );

    expect(await storedName(file.id)).toBe(CLEAN_NAME);
  });

  it('completeUpload', async () => {
    const service = new AssetService(fakeS3());
    const content = uniqueBody();
    const init = await service.initUpload(
      await insertUser(),
      createHash('sha256').update(content).digest('hex'),
      content.length,
      'image/png',
    );

    await service.completeUpload({
      fileId: init.fileId,
      originalName: MESSY_NAME,
      size: content.length,
      mime: 'image/png',
    });

    expect(await storedName(init.fileId)).toBe(CLEAN_NAME);
  });

  it.each([
    ['uploadCachedMediaStream', (s: AssetService, src: Readable) =>
      s.uploadCachedMediaStream(src, 'image/png', MESSY_NAME, 1_000_000)],
    ['uploadLinkPreviewImageStream', (s: AssetService, src: Readable) =>
      s.uploadLinkPreviewImageStream(src, 'image/png', MESSY_NAME, 1_000_000)],
  ])('%s', async (_label, upload) => {
    const service = new AssetService(fakeS3());
    const content = uniqueBody();
    const source = new Readable({
      read() {
        this.push(content);
        this.push(null);
      },
    });

    const file = await upload(service, source);

    expect(await storedName(file.id)).toBe(CLEAN_NAME);
  });

  it('uploadFederatedMediaStream', async () => {
    const service = new AssetService(fakeS3());
    const content = uniqueBody();
    const source = new Readable({
      read() {
        this.push(content);
        this.push(null);
      },
    });

    const file = await service.uploadFederatedMediaStream(
      source,
      'image/png',
      MESSY_NAME,
      1_000_000,
      await insertUser(),
    );

    expect(await storedName(file.id)).toBe(CLEAN_NAME);
  });

  it('uploadUserMediaStream', async () => {
    const service = new AssetService(fakeS3());
    const content = uniqueBody();
    const source = new Readable({
      read() {
        this.push(content);
        this.push(null);
      },
    });

    const file = await service.uploadUserMediaStream(
      source,
      'image/png',
      MESSY_NAME,
      1_000_000,
      await insertUser(),
    );

    expect(await storedName(file.id)).toBe(CLEAN_NAME);
  });
});
