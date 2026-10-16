/**
 * A takedown reaches every API task's file cache at once (ADR 0041 stage 4b),
 * against a REAL Postgres and the real claim, asset and repository code.
 *
 * Before, the per-process cache (five minutes) let a task that had cached a
 * file just before it was blocked keep streaming it for that long. Now:
 *  - the task that blocks (or reinstates, trashes, restores…) publishes the
 *    file ids on Redis after the commit;
 *  - a task holding the old record drops it when the message arrives, and its
 *    next read sees the new status.
 *
 * Stubbed: Redis (an in-memory transport recording PUBLISH), S3, the logger.
 */

import { createHash, randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';

const mockPublished: Array<{ channel: string; message: string }> = [];
const mockRedis = {
  status: 'ready',
  publish: jest.fn(async (channel: string, message: string) => {
    mockPublished.push({ channel, message });
    return 1;
  }),
};

jest.mock('../../config/redis', () => {
  const actual = jest.requireActual('../../config/redis');
  return { ...actual, getRedisClient: () => mockRedis };
});

const mockObjects = new Map<string, Buffer>();
jest.mock('../s3ServiceSingleton', () => ({
  s3Service: {
    fileExists: jest.fn(async (key: string) => mockObjects.has(key)),
    copyFile: jest.fn(async (from: string, to: string) => {
      const bytes = mockObjects.get(from);
      if (bytes) mockObjects.set(to, bytes);
    }),
    deleteFile: jest.fn(async (key: string) => {
      mockObjects.delete(key);
    }),
    listFiles: jest.fn(async () => []),
  },
}));

jest.mock('../../utils/logger', () => ({
  logger: { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

jest.mock('../variantService', () => ({
  VariantService: class {
    generateVariants = jest.fn(() => Promise.resolve());
  },
}));

jest.mock('../../queue/assetVariants.queue', () => ({
  enqueueAssetVariantGeneration: jest.fn(() => Promise.resolve()),
}));

import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { files, users } from '../../db/schema';
import { assetService } from '../assetServiceSingleton';
import {
  blockClaimTargets,
  recordCounterNotice,
  reinstateContentClaim,
  startContentClaimReview,
  submitContentClaim,
} from '../contentClaims/contentClaim.service';
import fileCache, { FILE_CACHE_INVALIDATION_CHANNEL } from '../../utils/fileCache';
import { handleFileCacheInvalidationMessage } from '../../utils/fileCacheInvalidationSubscriber';
import * as fileRepository from '../fileRepository';

jest.setTimeout(60_000);

async function account(staff = false): Promise<string> {
  const [row] = await getDb()
    .insert(users)
    .values({
      color: 'teal',
      username: `u${randomBytes(5).toString('hex')}`,
      email: `${randomBytes(5).toString('hex')}@example.com`,
      isStaff: staff,
      staffCapabilities: (staff ? ['content:claims'] : []) as never,
    })
    .returning({ id: users.id });
  return row.id;
}

async function storedFile(ownerUserId: string) {
  const bytes = randomBytes(64);
  const sha = createHash('sha256').update(bytes).digest('hex');
  const storageKey = `content/2026/10/${sha.slice(0, 2)}/${sha}.png`;
  const [row] = await getDb()
    .insert(files)
    .values({
      sha256: sha,
      size: bytes.length,
      mime: 'image/png',
      ext: 'png',
      ownerUserId,
      visibility: 'private',
      status: 'active',
      storageKey,
      originalName: 'photo.png',
      metadata: {},
    })
    .returning();
  mockObjects.set(storageKey, bytes);
  return row;
}

/** Every file id published on the invalidation channel so far. */
function publishedIds(): string[] {
  return mockPublished
    .filter((entry) => entry.channel === FILE_CACHE_INVALIDATION_CHANNEL)
    .flatMap((entry) => JSON.parse(entry.message).fileIds as string[]);
}

/** A message another API task published, as its subscriber would deliver it here. */
function peerInvalidates(fileId: string): void {
  handleFileCacheInvalidationMessage(
    FILE_CACHE_INVALIDATION_CHANNEL,
    JSON.stringify({ v: 1, origin: 'another-api-task', fileIds: [fileId] }),
  );
}

async function claimOn(fileId: string): Promise<string> {
  const { id } = await submitContentClaim(
    {
      kind: 'copyright',
      contentUrls: [`https://cloud.oxy.so/${fileId}`],
      description: 'This photo is mine and was posted without my permission.',
      claimant: {
        name: 'Ada',
        email: `ada-${randomBytes(4).toString('hex')}@example.com`,
        relationship: 'rights_holder',
      },
      statements: { goodFaith: true, accurate: true },
      signature: 'Ada',
    },
    { submittedByUserId: null, apiHosts: ['api.oxy.so'], cdnHost: 'cloud.oxy.so' },
  );
  return id;
}

beforeAll(async () => {
  process.env.DEVICE_ID_SALT ??= 'test-device-id-salt-that-is-long-enough-000';
  await connectPostgres();
});

afterAll(async () => {
  await assetService.settleStoragePurges();
  await closePostgres();
});

beforeEach(() => {
  fileCache.clear();
  mockPublished.length = 0;
});

describe('a block on one task reaches the others', () => {
  it('the blocking task publishes the file after commit; a peer that cached it drops it', async () => {
    const owner = await account();
    const staff = await account(true);
    const file = await storedFile(owner);

    // This task cached the file while it was active.
    expect((await assetService.getFile(file.id))?.status).toBe('active');

    const claimId = await claimOn(file.id);
    await startContentClaimReview(claimId, { actorUserId: staff });
    const result = await blockClaimTargets(claimId, { actorUserId: staff });
    expect(result.filesBlocked).toBe(1);

    // Published for every other task, and dropped here.
    expect(publishedIds()).toContain(file.id);
    expect((await assetService.getFile(file.id))?.status).toBe('blocked');

    // Reinstating reaches them the same way.
    mockPublished.length = 0;
    await recordCounterNotice(claimId, { actorUserId: staff, note: 'Owner says it is theirs.' });
    await reinstateContentClaim(claimId, { actorUserId: staff });
    expect(publishedIds()).toContain(file.id);
    expect((await assetService.getFile(file.id))?.status).toBe('active');
  });

  it("a peer task's message is what makes this task stop serving its cached copy", async () => {
    const owner = await account();
    const file = await storedFile(owner);
    expect((await assetService.getFile(file.id))?.status).toBe('active');

    // Another task blocks it: the row changes under this task's cache.
    await getDb().update(files).set({ status: 'blocked' }).where(eq(files.id, file.id));
    // Without its message this task still holds the old record — the gap.
    expect((await assetService.getFile(file.id))?.status).toBe('active');

    peerInvalidates(file.id);
    expect((await assetService.getFile(file.id))?.status).toBe('blocked');
  });

  it('a read in flight when the message arrives is answered but not cached', async () => {
    const owner = await account();
    const file = await storedFile(owner);
    const read = fileRepository.findFileById;
    jest.spyOn(fileRepository, 'findFileById').mockImplementationOnce(async (id: string) => {
      const stale = await read(id);
      // Meanwhile another task blocks it, and its message arrives.
      await getDb().update(files).set({ status: 'blocked' }).where(eq(files.id, id));
      peerInvalidates(id);
      return stale;
    });

    expect((await assetService.getFile(file.id))?.status).toBe('active');
    expect((await assetService.getFile(file.id))?.status).toBe('blocked');
  });

  it("the owner's trash and restore publish too", async () => {
    const owner = await account();
    const file = await storedFile(owner);
    await assetService.getFile(file.id);

    await assetService.trashFile(file.id, owner);
    expect(publishedIds()).toContain(file.id);

    mockPublished.length = 0;
    await assetService.restoreFile(file.id);
    expect(publishedIds()).toContain(file.id);
  });
});
