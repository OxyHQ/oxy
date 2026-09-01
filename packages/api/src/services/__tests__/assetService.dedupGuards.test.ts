/**
 * AssetService dedup + public-CDN status guards (security regression coverage),
 * against a REAL Postgres.
 *
 * 1. [CRITICAL] Content-addressed dedup MUST exclude `deleted` tombstones. A
 *    prior change matched tombstones globally and revived them under the next
 *    uploader's ownership — a cross-tenant ownership takeover via SHA-256
 *    collision. The previous version of this file asserted the QUERY carried
 *    `status: { $ne: 'deleted' }`; that is a statement about a Mongo filter, not
 *    about who ends up owning the bytes. Here the tombstone is a real row and
 *    the assertion is on the OUTCOME: the uploader gets a brand-new row, and the
 *    victim's tombstone is untouched.
 *
 * 2. [MEDIUM] `getPublicCdnUrl` must return null for any non-`active` asset even
 *    when `visibility === 'public'`, so trashed/deleted objects can't keep
 *    serving from the public CDN.
 *
 * Only S3 and the variant pipeline are stubbed; the rows are real.
 */

import { createHash, randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { files, users } from '../../db/schema';
import type { S3Service } from '../s3Service';
import { AssetService } from '../assetService';
import fileCache from '../../utils/fileCache';

jest.mock('../variantService', () => ({
  VariantService: class {
    constructor(_s3: unknown) {
      /* no-op */
    }
    generateVariants = jest.fn(() => Promise.resolve());
  },
}));

interface FakeS3 {
  fileExists: jest.Mock;
  getPresignedUploadUrl: jest.Mock;
  uploadBuffer: jest.Mock;
}

function buildAssetService(fake: Partial<FakeS3>): AssetService {
  return new AssetService(fake as unknown as S3Service);
}

/**
 * A globally unique 64-hex content hash. Jest runs suites in PARALLEL against
 * ONE throwaway database and `files_sha256_live_key` spans the whole table, so a
 * per-file counter would collide with another suite's fixture rows.
 */
const sha = () => randomBytes(32).toString('hex');

/**
 * A real PNG magic prefix, so the image-content guard accepts the upload, plus a
 * random suffix so no two cases — in this file or in a suite running in a
 * parallel worker — ever hash to the same content. One live row per content hash
 * is a table-wide constraint.
 */
const png = () =>
  Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    randomBytes(16),
  ]);

async function insertUser(): Promise<string> {
  const [row] = await getDb().insert(users).values({ color: 'teal' }).returning({ id: users.id });
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

describe('dedup excludes deleted tombstones (cross-tenant takeover regression)', () => {
  it('uploadFileDirect never revives a tombstone — it inserts a new row owned by the uploader', async () => {
    const victimId = await insertUser();
    const attackerId = await insertUser();
    const content = png();
    const contentHash = createHash('sha256').update(content).digest('hex');

    // The victim's deleted asset for exactly this content.
    const [tombstone] = await getDb()
      .insert(files)
      .values({
        sha256: contentHash,
        size: content.length,
        mime: 'image/png',
        ext: 'png',
        storageKey: 'users/victim/secret.png',
        ownerUserId: victimId,
        status: 'deleted',
      })
      .returning({ id: files.id });

    const fakeS3: FakeS3 = {
      fileExists: jest.fn(() => Promise.resolve(false)),
      getPresignedUploadUrl: jest.fn(() => Promise.resolve('signed-url')),
      uploadBuffer: jest.fn(() => Promise.resolve()),
    };

    const result = await buildAssetService(fakeS3).uploadFileDirect(
      attackerId,
      content,
      'image/png',
      'avatar.png',
    );

    // A BRAND-NEW row, owned by the uploader.
    expect(result.id).not.toBe(tombstone.id);
    expect(result.ownerUserId).toBe(attackerId);
    expect(result.status).toBe('active');
    expect(fakeS3.uploadBuffer).toHaveBeenCalled();

    // …and the victim's record is exactly as it was: same owner, still deleted.
    const [after] = await getDb()
      .select({ ownerUserId: files.ownerUserId, status: files.status })
      .from(files)
      .where(eq(files.id, tombstone.id))
      .limit(1);
    expect(after).toEqual({ ownerUserId: victimId, status: 'deleted' });
  });

  it('deduplicates against a LIVE row of the same content instead', async () => {
    // The other half of the same rule: a tombstone is not reusable, but a live
    // record is — that is what content addressing is for.
    const ownerId = await insertUser();
    const content = png();
    const contentHash = createHash('sha256').update(content).digest('hex');
    const [existing] = await getDb()
      .insert(files)
      .values({
        sha256: contentHash,
        size: content.length,
        mime: 'image/png',
        ext: 'png',
        storageKey: 'content/live.png',
        ownerUserId: ownerId,
        status: 'active',
      })
      .returning({ id: files.id });

    const fakeS3: FakeS3 = {
      fileExists: jest.fn(() => Promise.resolve(true)),
      getPresignedUploadUrl: jest.fn(() => Promise.resolve('signed-url')),
      uploadBuffer: jest.fn(() => Promise.resolve()),
    };

    const result = await buildAssetService(fakeS3).uploadFileDirect(
      ownerId,
      content,
      'image/png',
      'avatar.png',
    );

    expect(result.id).toBe(existing.id);
    expect(fakeS3.uploadBuffer).not.toHaveBeenCalled();
  });
});

describe('getPublicCdnUrl status gate (trashed/deleted CDN exposure regression)', () => {
  const fakeS3 = { fileExists: jest.fn(() => Promise.resolve(true)) } as unknown as Partial<FakeS3>;

  it.each(['trash', 'deleted'] as const)(
    'returns null for a public but %s asset',
    async (status) => {
      const ownerId = await insertUser();
      const [row] = await getDb()
        .insert(files)
        .values({
          sha256: sha(),
          size: 10,
          mime: 'image/png',
          ext: 'png',
          storageKey: 'public/content/2026/06/ab/abc.png',
          ownerUserId: ownerId,
          visibility: 'public',
          status,
        })
        .returning();

      const url = await buildAssetService(fakeS3).getPublicCdnUrl({
        ...row,
        links: [],
        variants: [],
      });

      expect(url).toBeNull();
    }
  );

  it('serves an ACTIVE public asset, so the gate is not vacuous', async () => {
    const ownerId = await insertUser();
    const [row] = await getDb()
      .insert(files)
      .values({
        sha256: sha(),
        size: 10,
        mime: 'image/png',
        ext: 'png',
        storageKey: 'public/content/2026/06/ab/abc.png',
        ownerUserId: ownerId,
        visibility: 'public',
        status: 'active',
      })
      .returning();

    const url = await buildAssetService(fakeS3).getPublicCdnUrl({
      ...row,
      links: [],
      variants: [],
    });

    expect(url).not.toBeNull();
  });
});
