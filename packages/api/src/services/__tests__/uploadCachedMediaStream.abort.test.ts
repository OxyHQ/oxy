/**
 * Streamed-media upload: abort cleanup, dedup scoping, and the guards around
 * them — against a REAL Postgres.
 *
 * The abort half proves the C2(b) hardening: when the source request is torn
 * down mid-upload (client disconnect / request timeout → `'aborted'`), the
 * in-flight S3 upload is aborted via the AbortSignal and the partial temp object
 * is deleted, so a cancelled upload never leaks an orphaned S3 object. A
 * hand-rolled fake S3Service (typed against the method subset the path uses, no
 * `as any`) stands in for real S3; its `uploadStream` wires the passed
 * AbortSignal and only rejects once that signal fires — mirroring how the real
 * multipart `Upload.abort()` rejects `done()`.
 *
 * The dedup half changed shape in the port. It used to assert that the lookup
 * QUERY carried `status: { $ne: 'deleted' }`, and that a rejected dedup left a
 * mock object's fields untouched — statements about a Mongo filter and about an
 * in-memory object. Both are now read back out of the database, so what is
 * checked is the row a victim actually still owns.
 *
 * Every case streams its OWN random bytes. `files_sha256_live_key` allows one
 * live row per content hash TABLE-WIDE, and Jest runs suites in parallel against
 * one database, so a shared or merely file-local-unique body would collide with
 * another case's fixture rather than exercising the path under test.
 */

import { createHash, randomBytes } from 'node:crypto';
import { Readable } from 'stream';
import { eq } from 'drizzle-orm';
import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { fileVariants, files, users } from '../../db/schema';
import { AssetService } from '../assetService';
import type { S3Service } from '../s3Service';
import type { UploadOptions } from '../s3Service';
import type { FileInfo } from '../../types/s3.types';
import fileCache from '../../utils/fileCache';

// VariantService pulls in sharp/ffmpeg at import; stub it so these storage
// tests stay focused on AssetService's dedupe/repair contract.
const mockGenerateVariants = jest.fn();
jest.mock('../variantService', () => ({
  VariantService: class {
    constructor(_s3: unknown) { /* no-op */ }

    generateVariants(...args: unknown[]) {
      return mockGenerateVariants(...args);
    }
  },
}));

import {
  startAssetVariantJobs,
  stopAssetVariantJobs,
} from '../../queue/assetVariants.queue';

/**
 * Variant generation is now HANDED OFF to `queue/assetVariants.queue` rather
 * than run inline, so `mockGenerateVariants` is reached on a later tick via the
 * queue's in-process drain. Every assertion about it — the negative ones above
 * all — must let that drain run first, or it asserts on a queue that simply has
 * not got there yet and can no longer tell success from failure.
 */
const settleVariantQueue = async (): Promise<void> => {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
};

const CACHE_MAX_BYTES = 256 * 1024 * 1024;

/** Distinct, valid-PNG bytes per case — see the header. */
function uniqueBody(): Buffer {
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    randomBytes(16),
  ]);
}

const hashOf = (content: Buffer): string => createHash('sha256').update(content).digest('hex');

/** A source that delivers `content` and ends cleanly, like a received body. */
function bodySource(content: Buffer): Readable {
  return new Readable({
    read() {
      this.push(content);
      this.push(null);
    },
  });
}

async function insertUser(): Promise<string> {
  const [row] = await getDb().insert(users).values({ color: 'teal' }).returning({ id: users.id });
  return row.id;
}

async function insertFile(
  values: Partial<typeof files.$inferInsert> & { sha256: string }
): Promise<typeof files.$inferSelect> {
  const [row] = await getDb()
    .insert(files)
    .values({
      size: 4,
      mime: 'image/png',
      ext: 'png',
      storageKey: `content/${values.sha256}.png`,
      status: 'active',
      ...values,
    })
    .returning();
  return row;
}

async function readFile(id: string): Promise<typeof files.$inferSelect> {
  const [row] = await getDb().select().from(files).where(eq(files.id, id)).limit(1);
  return row;
}

/** The S3Service surface uploadCachedMediaStream touches on the abort path. */
interface FakeS3 {
  uploadStream: jest.Mock<Promise<FileInfo>, [string, Readable, UploadOptions?]>;
  uploadBuffer: jest.Mock<Promise<FileInfo>, [string, Buffer, UploadOptions?]>;
  deleteFile: jest.Mock<Promise<void>, [string]>;
  fileExists: jest.Mock<Promise<boolean>, [string]>;
  copyFile: jest.Mock<Promise<void>, [string, string]>;
}

type FakeS3Input = Partial<Pick<FakeS3, 'uploadStream' | 'uploadBuffer' | 'fileExists' | 'copyFile' | 'deleteFile'>>;

function buildAssetService(input: FakeS3Input): { service: AssetService; fake: FakeS3 } {
  const fake: FakeS3 = {
    uploadStream: jest.fn((): Promise<FileInfo> => Promise.resolve({ key: 'unused', size: 0, contentType: 'application/octet-stream' } as FileInfo)),
    uploadBuffer: jest.fn((key: string, buffer: Buffer, options?: UploadOptions): Promise<FileInfo> => Promise.resolve({
      key,
      size: buffer.length,
      contentType: options?.contentType || 'application/octet-stream',
    } as FileInfo)),
    deleteFile: jest.fn((): Promise<void> => Promise.resolve()),
    fileExists: jest.fn((): Promise<boolean> => Promise.resolve(true)),
    copyFile: jest.fn((): Promise<void> => Promise.resolve()),
    ...input,
  };

  // AssetService only calls this method subset on this path; satisfy the
  // S3Service contract via a typed cast of the method subset (never `any`).
  const service = new AssetService(fake as unknown as S3Service);
  return { service, fake };
}

beforeAll(async () => {
  await connectPostgres();
});

afterAll(async () => {
  await closePostgres();
});

beforeEach(async () => {
  // The queue keeps a module-level pending set; without a stop/start an item
  // enqueued by the previous test drains into this one's spy.
  await stopAssetVariantJobs();
  await startAssetVariantJobs();
  fileCache.clear();
  mockGenerateVariants.mockReset();
  mockGenerateVariants.mockResolvedValue(undefined);
});

afterAll(async () => {
  await stopAssetVariantJobs();
});

describe('uploadCachedMediaStream — abort cleanup', () => {
  it('aborts the S3 upload and deletes the temp object when the source aborts', async () => {
    let capturedTempKey: string | undefined;
    let abortObserved = false;

    const uploadStream = jest.fn(
      (key: string, _body: Readable, options?: UploadOptions): Promise<FileInfo> => {
        capturedTempKey = key;
        // Reject only when the caller aborts — exactly what the real multipart
        // Upload does when `upload.abort()` is invoked from the signal handler.
        return new Promise<FileInfo>((_resolve, reject) => {
          const signal = options?.abortSignal;
          if (!signal) {
            return; // never resolves; the test only exercises the abort path
          }
          signal.addEventListener('abort', () => {
            abortObserved = true;
            reject(new Error('Upload aborted'));
          }, { once: true });
        });
      }
    );

    const deleteFile = jest.fn((): Promise<void> => Promise.resolve());

    const { service } = buildAssetService({ uploadStream, deleteFile });

    // A source stream that never ends; we trigger the client-disconnect path
    // by emitting 'aborted' after the upload has started.
    const source = new Readable({ read() { /* no data — wait for abort */ } });

    const promise = service.uploadCachedMediaStream(
      source,
      'video/mp4',
      'federation-cache-media',
      CACHE_MAX_BYTES
    );

    // Let uploadStream register its abort listener, then simulate the client
    // disconnecting mid-upload.
    await new Promise((resolve) => setImmediate(resolve));
    source.emit('aborted');

    await expect(promise).rejects.toThrow('Upload aborted');

    // The AbortSignal reached S3 and fired, and the partial temp object was
    // cleaned up with the same key the upload used.
    expect(abortObserved).toBe(true);
    expect(deleteFile).toHaveBeenCalledTimes(1);
    expect(deleteFile).toHaveBeenCalledWith(capturedTempKey);
    expect(capturedTempKey).toMatch(/^cache\/incoming\//);

    // Tear down the never-ending source so no stream handle leaks past the test.
    source.destroy();
  });

  it('does NOT abort the S3 upload when the source closes after a clean end', async () => {
    // Regression guard: Node's `'close'` event ALSO fires on normal successful
    // completion (right after the body is fully read), BEFORE `completed` flips
    // to true. The handler must NOT treat that as a client/timeout abort — it
    // previously did, self-aborting every clean upload into a 500.
    let abortObserved = false;
    let resolveUpload: ((info: FileInfo) => void) | undefined;

    const uploadStream = jest.fn(
      (_key: string, _body: Readable, options?: UploadOptions): Promise<FileInfo> => {
        const signal = options?.abortSignal;
        signal?.addEventListener('abort', () => { abortObserved = true; }, { once: true });
        return new Promise<FileInfo>((resolve) => { resolveUpload = resolve; });
      }
    );

    const deleteFile = jest.fn((): Promise<void> => Promise.resolve());
    const { service } = buildAssetService({ uploadStream, deleteFile });

    // Dedup short-circuit: an existing live row for this content lets the
    // success path resolve without creating anything new.
    const content = uniqueBody();
    const existing = await insertFile({
      sha256: hashOf(content),
      ownerUserId: await insertUser(),
      purpose: 'federation-media-cache',
    });

    const source = bodySource(content);

    const promise = service.uploadCachedMediaStream(
      source,
      'image/png',
      'federation-cache-media',
      CACHE_MAX_BYTES
    );

    // Let the meter drain the body so the source's 'end' fires and
    // `readableEnded` becomes true, then emit the normal-completion 'close'.
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    expect(source.readableEnded).toBe(true);
    source.emit('close');

    // The clean-end close must NOT have tripped the abort signal.
    expect(abortObserved).toBe(false);

    // Now let the S3 upload finish; the call resolves to the deduped file.
    resolveUpload?.({ key: 'cache/incoming/x', size: 4, contentType: 'image/png' } as FileInfo);

    await expect(promise).resolves.toMatchObject({ id: existing.id });

    // The abort signal stayed clean through the whole success path. The single
    // deleteFile here is the legitimate dedup temp-object cleanup, never an
    // abort-driven one.
    expect(abortObserved).toBe(false);
    expect(deleteFile).toHaveBeenCalledTimes(1);

    source.destroy();
  });

  it('restores a deduped cached-media object when the existing file record is missing storage', async () => {
    let resolveUpload: ((info: FileInfo) => void) | undefined;
    let capturedTempKey: string | undefined;

    const uploadStream = jest.fn(
      (key: string, _body: Readable): Promise<FileInfo> => {
        capturedTempKey = key;
        return new Promise<FileInfo>((resolve) => { resolveUpload = resolve; });
      }
    );
    const deleteFile = jest.fn((): Promise<void> => Promise.resolve());
    const fileExists = jest.fn((): Promise<boolean> => Promise.resolve(false));
    const copyFile = jest.fn((): Promise<void> => Promise.resolve());
    const { service } = buildAssetService({ uploadStream, deleteFile, fileExists, copyFile });

    const content = uniqueBody();
    const existing = await insertFile({
      sha256: hashOf(content),
      ownerUserId: await insertUser(),
      purpose: 'federation-media-cache',
    });

    const source = bodySource(content);

    const promise = service.uploadCachedMediaStream(
      source,
      'image/png',
      'federation-cache-media',
      CACHE_MAX_BYTES
    );

    await new Promise((resolve) => setImmediate(resolve));
    resolveUpload?.({ key: capturedTempKey || 'cache/incoming/x', size: 4, contentType: 'image/png' } as FileInfo);

    await expect(promise).resolves.toMatchObject({ id: existing.id });

    expect(fileExists).toHaveBeenCalledWith(existing.storageKey);
    expect(copyFile).toHaveBeenCalledWith(capturedTempKey, existing.storageKey);
    expect(deleteFile).toHaveBeenCalledTimes(1);
    expect(deleteFile).toHaveBeenCalledWith(capturedTempKey);

    source.destroy();
  });

  it('does NOT revive a deleted direct-upload tombstone — inserts a fresh owner-scoped record', async () => {
    // SECURITY: a deleted record is a tombstone, never a reusable asset. A fresh
    // upload whose SHA-256 collides with a victim's deleted file must NOT
    // revive/reassign that record (cross-tenant ownership takeover).
    const deleteFile = jest.fn((): Promise<void> => Promise.resolve());
    const fileExists = jest.fn((): Promise<boolean> => Promise.resolve(false));
    const uploadBuffer = jest.fn((key: string, buffer: Buffer, options?: UploadOptions): Promise<FileInfo> => Promise.resolve({
      key,
      size: buffer.length,
      contentType: options?.contentType || 'application/octet-stream',
    } as FileInfo));
    const { service } = buildAssetService({ deleteFile, fileExists, uploadBuffer });

    // Valid JPEG magic (FF D8 FF E0) so the image-content guard accepts it.
    const content = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), randomBytes(16)]);
    const victimId = await insertUser();
    const uploaderId = await insertUser();
    const tombstone = await insertFile({
      sha256: hashOf(content),
      ownerUserId: victimId,
      status: 'deleted',
    });

    const result = await service.uploadFileDirect(
      uploaderId,
      content,
      'image/jpeg',
      'fresh-avatar.jpg',
      'public',
      { source: 'federation-avatar' }
    );

    // A brand-new row owned by the UPLOADER — never a revived tombstone
    // reassigned away from its original owner.
    expect(result.id).not.toBe(tombstone.id);
    expect(result).toMatchObject({
      ownerUserId: uploaderId,
      status: 'active',
      originalName: 'fresh-avatar.jpg',
      visibility: 'public',
      metadata: { source: 'federation-avatar' },
    });
    expect(uploadBuffer).toHaveBeenCalled();
    await settleVariantQueue();
    expect(mockGenerateVariants).toHaveBeenCalledWith(result.id);

    // The victim's row is exactly the one they had.
    expect(await readFile(tombstone.id)).toEqual(tombstone);
  });

  it('does NOT revive a deleted cached-media tombstone — promotes a fresh record', async () => {
    // SECURITY: same tombstone-exclusion guarantee for the streamed-media path.
    let resolveUpload: ((info: FileInfo) => void) | undefined;
    let capturedTempKey: string | undefined;

    const uploadStream = jest.fn(
      (key: string, _body: Readable): Promise<FileInfo> => {
        capturedTempKey = key;
        return new Promise<FileInfo>((resolve) => { resolveUpload = resolve; });
      }
    );
    const deleteFile = jest.fn((): Promise<void> => Promise.resolve());
    const fileExists = jest.fn((): Promise<boolean> => Promise.resolve(false));
    const copyFile = jest.fn((): Promise<void> => Promise.resolve());
    const { service } = buildAssetService({ uploadStream, deleteFile, fileExists, copyFile });

    const content = uniqueBody();
    const tombstone = await insertFile({
      sha256: hashOf(content),
      ownerUserId: await insertUser(),
      status: 'deleted',
    });

    const source = bodySource(content);

    const promise = service.uploadCachedMediaStream(
      source,
      'image/png',
      'federation-cache-media',
      CACHE_MAX_BYTES
    );

    await new Promise((resolve) => setImmediate(resolve));
    resolveUpload?.({ key: capturedTempKey || 'cache/incoming/x', size: 4, contentType: 'image/png' } as FileInfo);

    const result = await promise;

    // The temp object is promoted to the content-addressed key and a fresh
    // cache-owned record is created.
    expect(copyFile).toHaveBeenCalled();
    expect(result.id).not.toBe(tombstone.id);
    expect(result).toMatchObject({
      ownerUserId: null,
      systemOwner: '__federation_media_cache__',
      purpose: 'federation-media-cache',
      status: 'active',
      visibility: 'public',
    });

    source.destroy();
  });

  it('rejects durable federated dedupe against an ordinary private user file without mutating it', async () => {
    let resolveUpload: ((info: FileInfo) => void) | undefined;
    let capturedTempKey: string | undefined;

    const uploadStream = jest.fn(
      (key: string, _body: Readable): Promise<FileInfo> => {
        capturedTempKey = key;
        return new Promise<FileInfo>((resolve) => { resolveUpload = resolve; });
      }
    );
    const deleteFile = jest.fn((): Promise<void> => Promise.resolve());
    const { service } = buildAssetService({ uploadStream, deleteFile });

    const content = uniqueBody();
    const existing = await insertFile({
      sha256: hashOf(content),
      ownerUserId: await insertUser(),
      purpose: 'user',
      visibility: 'private',
      metadata: { ownerOnly: true },
    });

    const source = bodySource(content);

    const promise = service.uploadFederatedMediaStream(
      source,
      'image/png',
      'federated-post.png',
      CACHE_MAX_BYTES,
      await insertUser(),
      { sourceUri: 'https://remote.example/media/1' }
    );

    await new Promise((resolve) => setImmediate(resolve));
    resolveUpload?.({ key: capturedTempKey || 'federation/incoming/x', size: 4, contentType: 'image/png' } as FileInfo);

    await expect(promise).rejects.toMatchObject({ statusCode: 409 });

    // The victim's stored row is untouched — read back, not remembered.
    expect(await readFile(existing.id)).toEqual(existing);
    expect(deleteFile).toHaveBeenCalledWith(capturedTempKey);

    source.destroy();
  });

  it('rejects durable user-media dedupe against another user file without mutating it', async () => {
    let resolveUpload: ((info: FileInfo) => void) | undefined;
    let capturedTempKey: string | undefined;

    const uploadStream = jest.fn(
      (key: string, _body: Readable): Promise<FileInfo> => {
        capturedTempKey = key;
        return new Promise<FileInfo>((resolve) => { resolveUpload = resolve; });
      }
    );
    const deleteFile = jest.fn((): Promise<void> => Promise.resolve());
    const { service } = buildAssetService({ uploadStream, deleteFile });

    const content = uniqueBody();
    const existing = await insertFile({
      sha256: hashOf(content),
      ownerUserId: await insertUser(),
      purpose: 'user',
      visibility: 'private',
      metadata: { ownerOnly: true },
    });

    const source = bodySource(content);

    const promise = service.uploadUserMediaStream(
      source,
      'image/png',
      'mention-post.png',
      CACHE_MAX_BYTES,
      await insertUser(),
      { source: 'mention-service' }
    );

    await new Promise((resolve) => setImmediate(resolve));
    resolveUpload?.({ key: capturedTempKey || 'user/incoming/x', size: 4, contentType: 'image/png' } as FileInfo);

    await expect(promise).rejects.toMatchObject({ statusCode: 409 });

    expect(await readFile(existing.id)).toEqual(existing);
    expect(deleteFile).toHaveBeenCalledWith(capturedTempKey);

    source.destroy();
  });

  it('promotes a deduped federation cache record for durable federated media', async () => {
    let resolveUpload: ((info: FileInfo) => void) | undefined;
    let capturedTempKey: string | undefined;

    const uploadStream = jest.fn(
      (key: string, _body: Readable): Promise<FileInfo> => {
        capturedTempKey = key;
        return new Promise<FileInfo>((resolve) => { resolveUpload = resolve; });
      }
    );
    const deleteFile = jest.fn((): Promise<void> => Promise.resolve());
    const fileExists = jest.fn((): Promise<boolean> => Promise.resolve(true));
    const { service } = buildAssetService({ uploadStream, deleteFile, fileExists });

    const content = uniqueBody();
    const existing = await insertFile({
      sha256: hashOf(content),
      ownerUserId: null,
      systemOwner: '__federation_media_cache__',
      purpose: 'federation-media-cache',
      visibility: 'public',
      storageKey: 'public/content/2026/06/ca/cache-sha.png',
      metadata: { cached: true },
    });
    const federatedOwnerId = await insertUser();

    const source = bodySource(content);

    const promise = service.uploadFederatedMediaStream(
      source,
      'image/png',
      'federated-post.png',
      CACHE_MAX_BYTES,
      federatedOwnerId,
      { sourceUri: 'https://remote.example/media/1' }
    );

    await new Promise((resolve) => setImmediate(resolve));
    resolveUpload?.({ key: capturedTempKey || 'federation/incoming/x', size: 4, contentType: 'image/png' } as FileInfo);

    await expect(promise).resolves.toMatchObject({ id: existing.id });

    // The cache record is PROMOTED in place: it becomes an ordinary user-owned
    // durable asset, so the cache eviction job can no longer delete it.
    expect(await readFile(existing.id)).toMatchObject({
      ownerUserId: federatedOwnerId,
      systemOwner: null,
      purpose: 'user',
      visibility: 'public',
      metadata: {
        cached: true,
        source: 'federation',
        sourceUri: 'https://remote.example/media/1',
        promotedFromFederationCache: true,
      },
    });
    expect(deleteFile).toHaveBeenCalledWith(capturedTempKey);

    source.destroy();
  });
});

describe('AssetService.uploadFileDirect — empty-file guard', () => {
  it('rejects a 0-byte buffer and creates NO File record or storage object', async () => {
    const uploadBuffer = jest.fn((key: string, buffer: Buffer, options?: UploadOptions): Promise<FileInfo> => Promise.resolve({
      key,
      size: buffer.length,
      contentType: options?.contentType || 'application/octet-stream',
    } as FileInfo));
    const { service } = buildAssetService({ uploadBuffer });

    const emptyHash = hashOf(Buffer.alloc(0));

    await expect(
      service.uploadFileDirect(
        await insertUser(),
        Buffer.alloc(0),
        'image/png',
        'empty.png',
        'private',
      ),
    ).rejects.toMatchObject({ statusCode: 400, message: 'Cannot store an empty file' });

    // The guard short-circuits before ANY record creation or S3 write — no empty
    // asset can be persisted under the empty-content hash.
    const stored = await getDb()
      .select({ id: files.id })
      .from(files)
      .where(eq(files.sha256, emptyHash));
    expect(stored).toEqual([]);
    expect(uploadBuffer).not.toHaveBeenCalled();
    await settleVariantQueue();
    expect(mockGenerateVariants).not.toHaveBeenCalled();
  });
});

describe('AssetService visibility relocation', () => {
  it('deletes legacy backfilled public CDN copies when a non-public DB key is downgraded', async () => {
    const existingKeys = new Set([
      'content/2026/06/legacy-avatar.jpg',
      'public/content/2026/06/legacy-avatar.jpg',
    ]);
    const deleteFile = jest.fn((key: string): Promise<void> => {
      existingKeys.delete(key);
      return Promise.resolve();
    });
    const fileExists = jest.fn((key: string): Promise<boolean> => Promise.resolve(existingKeys.has(key)));
    const copyFile = jest.fn((): Promise<void> => Promise.resolve());
    const { service } = buildAssetService({ deleteFile, fileExists, copyFile });

    type RelocationHarness = {
      relocateObjectForVisibility(key: string, visibility: 'private' | 'public' | 'unlisted'): Promise<string>;
    };

    const relocatedKey = await (service as unknown as RelocationHarness).relocateObjectForVisibility(
      'content/2026/06/legacy-avatar.jpg',
      'private'
    );

    expect(relocatedKey).toBe('content/2026/06/legacy-avatar.jpg');
    expect(copyFile).not.toHaveBeenCalled();
    expect(deleteFile).toHaveBeenCalledTimes(1);
    expect(deleteFile).toHaveBeenCalledWith('public/content/2026/06/legacy-avatar.jpg');
    expect(existingKeys.has('content/2026/06/legacy-avatar.jpg')).toBe(true);
    expect(existingKeys.has('public/content/2026/06/legacy-avatar.jpg')).toBe(false);
  });

  it('rewrites the stored keys of the original AND every variant when visibility flips', async () => {
    // The renditions are their own rows now, so a relocation that only rewrote
    // `files.storage_key` would leave every variant stranded outside the
    // CDN-reachable prefix, with nothing in the parent row to show it.
    const present = new Set<string>();
    const deleteFile = jest.fn((key: string): Promise<void> => {
      present.delete(key);
      return Promise.resolve();
    });
    const fileExists = jest.fn((key: string): Promise<boolean> => Promise.resolve(present.has(key)));
    const copyFile = jest.fn((_from: string, to: string): Promise<void> => {
      present.add(to);
      return Promise.resolve();
    });
    const { service } = buildAssetService({ deleteFile, fileExists, copyFile });

    const content = uniqueBody();
    const file = await insertFile({
      sha256: hashOf(content),
      ownerUserId: await insertUser(),
      visibility: 'private',
      storageKey: 'content/2026/06/ab/original.png',
    });
    present.add('content/2026/06/ab/original.png');
    present.add('variants/2026/06/ab/thumb.webp');
    await getDb().insert(fileVariants).values({
      fileId: file.id,
      type: 'thumb',
      key: 'variants/2026/06/ab/thumb.webp',
      readyAt: new Date(),
    });

    const updated = await service.updateFileVisibility(file.id, 'public');

    expect(updated.storageKey).toBe('public/content/2026/06/ab/original.png');
    expect(updated.variants.map((v) => v.key)).toEqual(['public/variants/2026/06/ab/thumb.webp']);
    expect((await readFile(file.id)).storageKey).toBe('public/content/2026/06/ab/original.png');
  });
});

describe('ensureOwnedAssetPublic — profile media is promoted to public', () => {
  type MaybeFile = Awaited<ReturnType<AssetService['getFile']>>;
  const asFile = (f: { ownerUserId: string; visibility: string }): MaybeFile =>
    ({ id: 'f1', ...f }) as unknown as MaybeFile;
  const okVisibility = (): Awaited<ReturnType<AssetService['updateFileVisibility']>> =>
    ({} as unknown as Awaited<ReturnType<AssetService['updateFileVisibility']>>);

  it("promotes the owner's private asset to public", async () => {
    const { service } = buildAssetService({});
    jest.spyOn(service, 'getFile').mockResolvedValue(asFile({ ownerUserId: 'u1', visibility: 'private' }));
    const updateVis = jest.spyOn(service, 'updateFileVisibility').mockResolvedValue(okVisibility());
    await service.ensureOwnedAssetPublic('f1', 'u1');
    expect(updateVis).toHaveBeenCalledWith('f1', 'public');
  });

  it('no-ops for non-owner / already-public / missing / temp id', async () => {
    const { service } = buildAssetService({});
    const getFile = jest.spyOn(service, 'getFile');
    const updateVis = jest.spyOn(service, 'updateFileVisibility').mockResolvedValue(okVisibility());
    getFile.mockResolvedValue(asFile({ ownerUserId: 'u2', visibility: 'private' })); // not owner
    await service.ensureOwnedAssetPublic('f1', 'u1');
    getFile.mockResolvedValue(asFile({ ownerUserId: 'u1', visibility: 'public' })); // already public
    await service.ensureOwnedAssetPublic('f1', 'u1');
    getFile.mockResolvedValue(null); // missing
    await service.ensureOwnedAssetPublic('f2', 'u1');
    await service.ensureOwnedAssetPublic('temp-x', 'u1'); // temp id (getFile never called)
    expect(updateVis).not.toHaveBeenCalled();
  });

  it('never throws when the visibility update fails (best-effort)', async () => {
    const { service } = buildAssetService({});
    jest.spyOn(service, 'getFile').mockResolvedValue(asFile({ ownerUserId: 'u1', visibility: 'private' }));
    jest.spyOn(service, 'updateFileVisibility').mockRejectedValue(new Error('boom'));
    await expect(service.ensureOwnedAssetPublic('f1', 'u1')).resolves.toBeUndefined();
  });
});
