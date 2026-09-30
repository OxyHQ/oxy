/**
 * AssetService.initUpload — dedupe-signing authorization, against a REAL
 * Postgres.
 *
 * Rows are per owner. When another owner already holds the SHA-256, the caller
 * gets its OWN new row — never the other owner's id — sharing that row's stored
 * object when it exists, and never a presigned PUT URL for a key another owner
 * serves: signing it would let any authenticated user who knows the SHA-256
 * overwrite that owner's bytes. A repair PUT URL is issued only for the
 * caller's own row, only when the object is missing, and only when no other
 * live row stores its original at that key.
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
  copyFile?: jest.Mock<Promise<void>, [string, string]>;
}

function buildAssetService(fake: FakeS3): AssetService {
  return new AssetService(fake as unknown as S3Service);
}

/**
 * A globally unique 64-hex content hash, so this file's fixtures never share a
 * hash with another suite's rows in the same throwaway database.
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
  async function rowOf(id: string) {
    const [row] = await getDb().select().from(files).where(eq(files.id, id)).limit(1);
    return row;
  }

  it('gives another user its OWN row sharing a live existing object, with no PUT URL', async () => {
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

    expect(fakeS3.getPresignedUploadUrl).not.toHaveBeenCalled();
    expect(result.uploadUrl).toBe('');
    // Its own row — never the victim's id — pointing at the same object.
    expect(result.fileId).not.toBe(fileId);
    expect(await rowOf(result.fileId)).toMatchObject({ ownerUserId: attackerId, storageKey: VICTIM_KEY, sha256: contentHash });
    expect(await rowOf(fileId)).toMatchObject({ ownerUserId: victimId, status: 'active' });
  });

  it('never signs another owner\'s key when its object is missing: the caller gets a key of its own', async () => {
    const contentHash = sha();
    const victimId = await insertUser();
    const attackerId = await insertUser();
    const fileId = await insertFile({ sha256: contentHash, ownerUserId: victimId });

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

    expect(result.fileId).not.toBe(fileId);
    const own = await rowOf(result.fileId);
    expect(own.ownerUserId).toBe(attackerId);
    expect(own.storageKey).not.toBe(VICTIM_KEY);
    expect(own.storageKey).toMatch(new RegExp(`/${contentHash}-[0-9a-f]{16}\\.png$`));
    expect(fakeS3.getPresignedUploadUrl).toHaveBeenCalledTimes(1);
    expect(fakeS3.getPresignedUploadUrl.mock.calls[0][0]).toBe(own.storageKey);
    expect(result.uploadUrl).toBe('signed-put-url');
  });

  it('never signs a SYSTEM-owned object\'s key either', async () => {
    // `owner_user_id` is NULL here, so no caller can be its owner.
    const contentHash = sha();
    const callerId = await insertUser();
    await insertFile({
      sha256: contentHash,
      ownerUserId: null,
      systemOwner: '__federation_media_cache__',
      purpose: 'federation-media-cache',
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

    const own = await rowOf(result.fileId);
    expect(own.ownerUserId).toBe(callerId);
    expect(fakeS3.getPresignedUploadUrl).not.toHaveBeenCalledWith(VICTIM_KEY, expect.anything());
  });

  it('copies a PUBLIC-spelled shared object to the private spelling the new row needs', async () => {
    const contentHash = sha();
    const publisher = await insertUser();
    const callerId = await insertUser();
    const publicKey = `public/content/2026/09/${contentHash.slice(0, 2)}/${contentHash}.png`;
    await insertFile({ sha256: contentHash, ownerUserId: publisher, storageKey: publicKey, visibility: 'public' });

    const present = new Set([publicKey]);
    const fakeS3: FakeS3 = {
      fileExists: jest.fn((key: string) => Promise.resolve(present.has(key))),
      getPresignedUploadUrl: jest.fn(() => Promise.resolve('signed-put-url')),
      copyFile: jest.fn(async (_from: string, to: string) => { present.add(to); }),
    };

    const result = await buildAssetService(fakeS3).initUpload(callerId, contentHash, 123, 'image/png');

    const privateKey = publicKey.slice('public/'.length);
    expect(fakeS3.copyFile).toHaveBeenCalledWith(publicKey, privateKey);
    expect(await rowOf(result.fileId)).toMatchObject({ ownerUserId: callerId, storageKey: privateKey });
    expect(result.uploadUrl).toBe('');
  });

  it('does not sign a repair URL for the caller\'s own row when another owner\'s row shares the key', async () => {
    const contentHash = sha();
    const ownerId = await insertUser();
    const sharer = await insertUser();
    await insertFile({ sha256: contentHash, ownerUserId: ownerId });
    await insertFile({ sha256: contentHash, ownerUserId: sharer });

    const fakeS3: FakeS3 = {
      fileExists: jest.fn(() => Promise.resolve(false)),
      getPresignedUploadUrl: jest.fn(() => Promise.resolve('owner-repair-url')),
    };

    const result = await buildAssetService(fakeS3).initUpload(ownerId, contentHash, 123, 'image/png');

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
