/**
 * AssetService.initUpload — dedupe-signing authorization, against a REAL
 * Postgres.
 *
 * When a SHA-256 already maps to an existing file, initUpload must NOT hand a
 * presigned PUT URL for that object's storage key to an arbitrary caller:
 * signing a live deduplicated object's key would let any authenticated user who
 * knows the SHA-256 overwrite another user's asset bytes. A repair PUT URL is
 * issued only to the file's OWNER, and only when the underlying object is
 * actually missing.
 *
 * The ownership comparison is what the port changed. It was
 * `existingFile.ownerUserId?.toString() === userId` against an ObjectId; it is
 * now a comparison of two `text` values, and `owner_user_id` can be NULL for a
 * system-owned asset — a case the old expression answered `undefined === userId`
 * (false, correctly) by accident rather than by design. Both are pinned below.
 *
 * Only S3 is stubbed; the rows are real.
 */

import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { files, users } from '../../db/schema';
import type { S3Service } from '../s3Service';
import { AssetService } from '../assetService';
import fileCache from '../../utils/fileCache';

jest.mock('../variantService', () => ({
  VariantService: class {
    constructor(_s3: unknown) {
      /* no-op: initUpload never reaches variant generation */
    }
  },
}));

interface FakeS3 {
  fileExists: jest.Mock<Promise<boolean>, [string]>;
  getPresignedUploadUrl: jest.Mock<
    Promise<string>,
    [string, { contentType: string; expiresIn: number }]
  >;
}

function buildAssetService(fake: FakeS3): AssetService {
  return new AssetService(fake as unknown as S3Service);
}

/**
 * A globally unique 64-hex content hash. Jest runs suites in PARALLEL against
 * ONE throwaway database and `files_sha256_live_key` spans the whole table, so a
 * per-file counter would collide with another suite's fixture rows.
 */
const sha = () => randomBytes(32).toString('hex');

const VICTIM_KEY = 'users/victim/private/secret.png';

async function insertUser(): Promise<string> {
  const [row] = await getDb().insert(users).values({ color: 'teal' }).returning({ id: users.id });
  return row.id;
}

async function insertFile(
  values: Partial<typeof files.$inferInsert> & { sha256: string }
): Promise<string> {
  const [row] = await getDb()
    .insert(files)
    .values({
      size: 123,
      mime: 'image/png',
      ext: 'png',
      storageKey: VICTIM_KEY,
      status: 'active',
      ...values,
    })
    .returning({ id: files.id });
  return row.id;
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

describe('AssetService.initUpload dedupe signing', () => {
  it('does not return a PUT URL for a live existing object owned by another user', async () => {
    const contentHash = sha();
    const victimId = await insertUser();
    const attackerId = await insertUser();
    const fileId = await insertFile({ sha256: contentHash, ownerUserId: victimId });

    const fakeS3: FakeS3 = {
      fileExists: jest.fn(() => Promise.resolve(true)),
      getPresignedUploadUrl: jest.fn(() => Promise.resolve('signed-put-url')),
    };

    const result = await buildAssetService(fakeS3).initUpload(
      attackerId,
      contentHash,
      123,
      'image/png',
    );

    expect(fakeS3.fileExists).toHaveBeenCalledWith(VICTIM_KEY);
    expect(fakeS3.getPresignedUploadUrl).not.toHaveBeenCalled();
    expect(result).toEqual({ uploadUrl: '', fileId, sha256: contentHash });
  });

  it('does not return a repair PUT URL for a missing object to a non-owner', async () => {
    const contentHash = sha();
    const victimId = await insertUser();
    const attackerId = await insertUser();
    await insertFile({ sha256: contentHash, ownerUserId: victimId });

    const fakeS3: FakeS3 = {
      fileExists: jest.fn(() => Promise.resolve(false)),
      getPresignedUploadUrl: jest.fn(() => Promise.resolve('signed-put-url')),
    };

    const result = await buildAssetService(fakeS3).initUpload(
      attackerId,
      contentHash,
      123,
      'image/png',
    );

    expect(fakeS3.fileExists).toHaveBeenCalledWith(VICTIM_KEY);
    expect(fakeS3.getPresignedUploadUrl).not.toHaveBeenCalled();
    expect(result.uploadUrl).toBe('');
  });

  it('does not return a repair PUT URL for a SYSTEM-owned object', async () => {
    // `owner_user_id` is NULL here, so no caller can be its owner. Worth its own
    // case: this is the shape the ownership check compares against nothing.
    const contentHash = sha();
    const callerId = await insertUser();
    await insertFile({
      sha256: contentHash,
      ownerUserId: null,
      systemOwner: '__link_preview_cache__',
      purpose: 'link-preview',
    });

    const fakeS3: FakeS3 = {
      fileExists: jest.fn(() => Promise.resolve(false)),
      getPresignedUploadUrl: jest.fn(() => Promise.resolve('signed-put-url')),
    };

    const result = await buildAssetService(fakeS3).initUpload(
      callerId,
      contentHash,
      123,
      'image/png',
    );

    expect(fakeS3.getPresignedUploadUrl).not.toHaveBeenCalled();
    expect(result.uploadUrl).toBe('');
  });

  it('only returns a repair PUT URL for a missing existing object when requested by its owner', async () => {
    const contentHash = sha();
    const ownerId = await insertUser();
    await insertFile({ sha256: contentHash, ownerUserId: ownerId });

    const fakeS3: FakeS3 = {
      fileExists: jest.fn(() => Promise.resolve(false)),
      getPresignedUploadUrl: jest.fn(() => Promise.resolve('owner-repair-url')),
    };

    const result = await buildAssetService(fakeS3).initUpload(
      ownerId,
      contentHash,
      123,
      'image/png',
    );

    expect(fakeS3.getPresignedUploadUrl).toHaveBeenCalledWith(VICTIM_KEY, {
      contentType: 'image/png',
      expiresIn: 3600,
    });
    expect(result.uploadUrl).toBe('owner-repair-url');
  });

  it('creates a new row and signs its own key when the hash is unknown', async () => {
    const contentHash = sha();
    const ownerId = await insertUser();

    const fakeS3: FakeS3 = {
      fileExists: jest.fn(() => Promise.resolve(false)),
      getPresignedUploadUrl: jest.fn(() => Promise.resolve('fresh-url')),
    };

    const result = await buildAssetService(fakeS3).initUpload(
      ownerId,
      contentHash,
      123,
      'image/png',
    );

    expect(result.uploadUrl).toBe('fresh-url');
    const [row] = await getDb()
      .select()
      .from(files)
      .where(eq(files.id, result.fileId))
      .limit(1);
    expect(row.ownerUserId).toBe(ownerId);
    expect(row.sha256).toBe(contentHash);
    expect(row.status).toBe('active');
    // `initUpload` runs before visibility is known, so the key must NOT be
    // CDN-reachable yet — `completeUpload` relocates it if it turns out public.
    expect(row.visibility).toBe('private');
    expect(row.storageKey.startsWith('public/')).toBe(false);
  });
});
