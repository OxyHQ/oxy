/**
 * Storage usage, against a REAL Postgres.
 *
 * This endpoint answers "how much of your quota have you used", so the number
 * has to be EXACT, and the port moved every part of how it is computed:
 *
 * - the mime→bucket `$switch`/`$regexMatch` ladder became a SQL `CASE` with `~`,
 * - `$sum: '$variants.size'` over a nested array became a correlated subquery
 *   over `file_variants`, since the renditions are their own table,
 * - `$ifNull` became `coalesce` — and `sum` over an all-NULL set is NULL, not 0,
 *   so without it a single still-encoding rendition (`size` NULL) would make its
 *   whole file's bytes vanish from the total rather than counting the original,
 * - `bigint` sums arrive from postgres.js as STRINGS, so a missing `Number()`
 *   would concatenate rather than add.
 *
 * Each of those is a way to be quietly, plausibly wrong. So the assertions pin
 * an exact byte total computed by hand from the fixture, per category and
 * overall, rather than a shape or a lower bound.
 */

import type { Response } from 'express';
import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { fileVariants, files, users } from '../../db/schema';
import type { AuthRequest } from '../../middleware/auth';

jest.mock('../../utils/subscriptionPlan', () => ({
  resolveUserSubscriptionPlan: jest.fn(() => Promise.resolve('basic')),
}));

import { getStorageUsage } from '../storage.controller';

const GB = 1024 * 1024 * 1024;

interface UsageBucket {
  bytes: number;
  count: number;
}

interface UsageBody {
  plan: string;
  totalUsedBytes: number;
  totalLimitBytes: number;
  categories: Record<string, UsageBucket>;
}

/** Drive the controller and hand back the JSON body it produced. */
async function usageFor(userId: string): Promise<UsageBody> {
  let body: UsageBody | undefined;
  let status = 200;
  const res = {
    json: (value: UsageBody) => {
      body = value;
      return res;
    },
    status: (code: number) => {
      status = code;
      return res;
    },
  } as unknown as Response;

  await getStorageUsage({ user: { id: userId } } as unknown as AuthRequest, res);

  if (!body) {
    throw new Error(`getStorageUsage produced no body (status ${status})`);
  }
  return body;
}

/**
 * A globally unique 64-hex content hash. Jest runs suites in PARALLEL against
 * ONE throwaway database and `files_sha256_live_key` spans the whole table, so a
 * per-file counter would collide with another suite's fixture rows.
 */
const sha = () => randomBytes(32).toString('hex');

async function insertUser(): Promise<string> {
  const [row] = await getDb().insert(users).values({ color: 'teal' }).returning({ id: users.id });
  return row.id;
}

async function insertFile(values: {
  ownerUserId: string;
  mime: string;
  size: number;
  status?: 'active' | 'trash' | 'deleted';
  variantSizes?: (number | null)[];
}): Promise<string> {
  const [row] = await getDb()
    .insert(files)
    .values({
      sha256: sha(),
      size: values.size,
      mime: values.mime,
      ext: 'bin',
      storageKey: `content/${sha()}`,
      ownerUserId: values.ownerUserId,
      status: values.status ?? 'active',
    })
    .returning({ id: files.id });

  for (const [index, size] of (values.variantSizes ?? []).entries()) {
    await getDb().insert(fileVariants).values({
      fileId: row.id,
      type: `v${index}`,
      key: `variants/${row.id}/v${index}`,
      size,
    });
  }
  return row.id;
}

beforeAll(async () => {
  await connectPostgres();
});

afterAll(async () => {
  await closePostgres();
});

describe('getStorageUsage — exact byte totals', () => {
  it('sums originals plus renditions, bucketed by mime, to the byte', async () => {
    const ownerId = await insertUser();

    // photosVideos: 1000 + (10 + 20 + 30) = 1060, and 2000 with no renditions.
    await insertFile({ ownerUserId: ownerId, mime: 'image/png', size: 1000, variantSizes: [10, 20, 30] });
    await insertFile({ ownerUserId: ownerId, mime: 'video/mp4', size: 2000 });
    // recordings: 500 + 5 = 505.
    await insertFile({ ownerUserId: ownerId, mime: 'audio/mpeg', size: 500, variantSizes: [5] });
    // documents: 300, plus a rendition with NO recorded size. `coalesce` must
    // make that contribute 0 — WITHOUT it, `sum` over an all-NULL set is NULL,
    // `300 + NULL` is NULL, and this file's bytes silently leave the total.
    await insertFile({ ownerUserId: ownerId, mime: 'application/pdf', size: 300, variantSizes: [null] });
    // other: 42.
    await insertFile({ ownerUserId: ownerId, mime: 'model/gltf-binary', size: 42 });
    // Excluded: not active, and not this account's.
    await insertFile({ ownerUserId: ownerId, mime: 'image/png', size: 999_999, status: 'trash' });
    await insertFile({ ownerUserId: ownerId, mime: 'image/png', size: 888_888, status: 'deleted' });
    await insertFile({ ownerUserId: await insertUser(), mime: 'image/png', size: 777_777 });

    const body = await usageFor(ownerId);

    expect(body.categories.photosVideos).toEqual({ bytes: 3060, count: 2 });
    expect(body.categories.recordings).toEqual({ bytes: 505, count: 1 });
    expect(body.categories.documents).toEqual({ bytes: 300, count: 1 });
    expect(body.categories.other).toEqual({ bytes: 42, count: 1 });
    expect(body.totalUsedBytes).toBe(3060 + 505 + 300 + 42);

    // Not implemented yet, but part of the response contract.
    expect(body.categories.mail).toEqual({ bytes: 0, count: 0 });
    expect(body.categories.family).toEqual({ bytes: 0, count: 0 });
    expect(body.plan).toBe('basic');
    expect(body.totalLimitBytes).toBe(15 * GB);
  });

  it('ADDS the numbers rather than concatenating them', async () => {
    // `sum` over `bigint` comes back from postgres.js as a STRING. A total built
    // without `Number()` would read '1' + '2' = '12' here and still look like a
    // plausible byte count, so the sizes are chosen to make the two answers
    // differ: 1 + 2 = 3, never 12.
    const ownerId = await insertUser();
    await insertFile({ ownerUserId: ownerId, mime: 'image/png', size: 1 });
    await insertFile({ ownerUserId: ownerId, mime: 'audio/mpeg', size: 2 });

    const body = await usageFor(ownerId);

    expect(body.totalUsedBytes).toBe(3);
    expect(typeof body.totalUsedBytes).toBe('number');
  });

  it('buckets by the mime ladder in order — application/* must not shadow video/*', async () => {
    const ownerId = await insertUser();
    await insertFile({ ownerUserId: ownerId, mime: 'video/quicktime', size: 7 });
    await insertFile({ ownerUserId: ownerId, mime: 'application/zip', size: 11 });
    await insertFile({ ownerUserId: ownerId, mime: 'text/plain', size: 13 });
    await insertFile({ ownerUserId: ownerId, mime: 'image/webp', size: 17 });
    await insertFile({ ownerUserId: ownerId, mime: 'audio/wav', size: 19 });
    await insertFile({ ownerUserId: ownerId, mime: 'font/woff2', size: 23 });

    const body = await usageFor(ownerId);

    expect(body.categories.photosVideos).toEqual({ bytes: 7 + 17, count: 2 });
    expect(body.categories.documents).toEqual({ bytes: 11 + 13, count: 2 });
    expect(body.categories.recordings).toEqual({ bytes: 19, count: 1 });
    expect(body.categories.other).toEqual({ bytes: 23, count: 1 });
  });

  it('reports zeroes for an account with no files', async () => {
    const body = await usageFor(await insertUser());

    expect(body.totalUsedBytes).toBe(0);
    for (const bucket of Object.values(body.categories)) {
      expect(bucket).toEqual({ bytes: 0, count: 0 });
    }
  });

  it('counts a rendition added after the fact', async () => {
    // The renditions live in their own table now, so the total must follow a
    // write to THAT table — a version that read only `files.size` would answer
    // the same number before and after.
    const ownerId = await insertUser();
    const fileId = await insertFile({ ownerUserId: ownerId, mime: 'image/png', size: 100 });
    expect((await usageFor(ownerId)).totalUsedBytes).toBe(100);

    await getDb().insert(fileVariants).values({
      fileId,
      type: 'thumb',
      key: `variants/${fileId}/thumb`,
      size: 25,
    });

    expect((await usageFor(ownerId)).totalUsedBytes).toBe(125);

    await getDb().delete(fileVariants).where(eq(fileVariants.fileId, fileId));
    expect((await usageFor(ownerId)).totalUsedBytes).toBe(100);
  });
});
