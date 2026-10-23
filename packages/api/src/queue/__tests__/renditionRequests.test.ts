/**
 * The durable half of the asset-variant queue against a REAL Postgres:
 * `file_rendition_requests` and the scheduler pass that keeps Redis a bounded
 * window over it (2026-10-20: 398,416 jobs filled the 384 MB queue node).
 *
 *  - a request survives a round trip through a job's data (millisecond
 *    precision) and settles only while it is still the newest request;
 *  - due requests are leased oldest first, and a lease that ran out makes the
 *    request due again — a job lost with Redis is not lost work;
 *  - jobs beyond the direct bound go back into the table BEFORE they leave
 *    Redis, skipping files that no longer exist;
 *  - the pass tops the queue up to its target at the backlog priority, rolls the
 *    leases back when the add fails, and runs one at a time across the fleet.
 *
 * The queue is a fake that records calls: what is under test is what this code
 * asks of BullMQ and what it leaves in Postgres. The test database is shared
 * with other files in this worker, so every assertion reads only the files a
 * case creates.
 */

import { randomBytes } from 'node:crypto';
import { inArray, sql } from 'drizzle-orm';

jest.mock('../../services/s3ServiceSingleton', () => ({ s3Service: {} }));
jest.mock('../../services/variantService', () => ({
  VariantService: class {
    generateVariants = jest.fn(() => Promise.resolve());
  },
}));

import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { fileRenditionRequests, files, users } from '../../db/schema';
import {
  adoptRenditionRequests,
  claimDueRenditionRequests,
  recordRenditionRequest,
  releaseRenditionRequest,
  settleRenditionRequest,
} from '../../services/renditionRequests';
import {
  ASSET_VARIANT_JOB_PRIORITY,
  ASSET_VARIANT_QUEUE_TARGET_DEPTH,
  assetVariantsJobId,
  runAssetVariantSchedulerPass,
} from '../assetVariants.queue';

jest.setTimeout(60_000);

const LEASE_MS = 60_000;

beforeAll(async () => {
  await connectPostgres();
});

afterAll(async () => {
  await closePostgres();
});

async function fileIds(count: number): Promise<string[]> {
  const [owner] = await getDb().insert(users).values({ color: 'teal' }).returning({ id: users.id });
  const rows = await getDb()
    .insert(files)
    .values(
      Array.from({ length: count }, () => {
        const sha256 = randomBytes(32).toString('hex');
        return {
          sha256,
          size: 10,
          mime: 'image/png',
          ext: 'png',
          ownerUserId: owner.id,
          status: 'active' as const,
          storageKey: `content/2026/10/${sha256.slice(0, 2)}/${sha256}.png`,
          originalName: 'x.png',
        };
      }),
    )
    .returning({ id: files.id });
  return rows.map((row) => row.id);
}

async function requestsOf(ids: readonly string[]) {
  return getDb()
    .select()
    .from(fileRenditionRequests)
    .where(inArray(fileRenditionRequests.fileId, [...ids]));
}

/** Request `ids` in that order, each a millisecond after the previous. */
async function requestInOrder(ids: readonly string[]): Promise<void> {
  const base = Date.now() - 60_000;
  await getDb()
    .insert(fileRenditionRequests)
    .values(ids.map((fileId, i) => ({ fileId, requestedAt: new Date(base + i) })));
}

interface FakeJob {
  data: { fileId: string; requestedAt?: string };
  timestamp: number;
  attemptsMade: number;
  removed: boolean;
  remove(): Promise<void>;
}

/** A queue that records adds; `waiting` jobs are what `getJobs(['waiting'])` pages. */
function fakeQueue(options: { waiting?: FakeJob[]; depth?: number; failAdd?: boolean } = {}) {
  const added: Array<{
    name: string;
    data: { fileId: string; requestedAt?: string };
    opts: Record<string, unknown>;
  }> = [];
  const waiting = options.waiting ?? [];
  return {
    added,
    getJob: async (jobId: string) => added.find((job) => job.opts.jobId === jobId),
    getJobCounts: (...types: string[]) =>
      Promise.resolve(
        Object.fromEntries(
          types.map((type) => [
            type,
            type === 'waiting' ? waiting.filter((job) => !job.removed).length : 0,
          ]),
        ),
      ),
    getJobs: (types: string[], start: number, end: number) =>
      Promise.resolve(
        types.includes('waiting')
          ? waiting.filter((job) => !job.removed).slice(start, end + 1)
          : [],
      ),
    addBulk: (jobs: typeof added) => {
      if (options.failAdd) return Promise.reject(new Error('OOM command not allowed'));
      added.push(...jobs);
      return Promise.resolve();
    },
  };
}

function fakeJob(fileId: string, timestamp: number): FakeJob {
  const job: FakeJob = {
    data: { fileId },
    timestamp,
    attemptsMade: 0,
    removed: false,
    remove: () => {
      job.removed = true;
      return Promise.resolve();
    },
  };
  return job;
}

type SchedulerQueue = Parameters<typeof runAssetVariantSchedulerPass>[0];

describe('a request', () => {
  it('round-trips through a job at millisecond precision and settles only while newest', async () => {
    const [fileId] = await fileIds(1);
    const first = await recordRenditionRequest(fileId, LEASE_MS);
    // What a job carries, and what the worker rebuilds from it.
    const carried = { fileId, requestedAt: new Date(first.requestedAt.toISOString()) };
    expect(carried.requestedAt.getTime()).toBe(first.requestedAt.getTime());

    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = await recordRenditionRequest(fileId, null);
    expect(second.requestedAt.getTime()).toBeGreaterThan(first.requestedAt.getTime());

    // The job that ran for the first request does not settle the second.
    await settleRenditionRequest(carried);
    expect(await requestsOf([fileId])).toHaveLength(1);

    await settleRenditionRequest(second);
    expect(await requestsOf([fileId])).toHaveLength(0);
  });

  it('a release makes a leased request due at once', async () => {
    const [fileId] = await fileIds(1);
    const request = await recordRenditionRequest(fileId, LEASE_MS);
    expect(await claimDueRenditionRequests(10, LEASE_MS)).not.toContainEqual(
      expect.objectContaining({ fileId }),
    );
    await releaseRenditionRequest(request);
    const [row] = await requestsOf([fileId]);
    expect(row.enqueuedUntil).toBeNull();
  });

  it('is removed with its file', async () => {
    const [fileId] = await fileIds(1);
    await recordRenditionRequest(fileId, null);
    await getDb()
      .delete(files)
      .where(inArray(files.id, [fileId]));
    expect(await requestsOf([fileId])).toHaveLength(0);
  });
});

describe('claiming due requests', () => {
  it('leases the oldest first, never a leased one, and again once its lease ran out', async () => {
    const ids = await fileIds(3);
    await requestInOrder(ids);

    const claimed = (await claimDueRenditionRequests(10_000, LEASE_MS)).filter((r) =>
      ids.includes(r.fileId),
    );
    expect(claimed.map((r) => r.fileId)).toEqual(ids);
    expect(
      (await claimDueRenditionRequests(10_000, LEASE_MS)).filter((r) => ids.includes(r.fileId)),
    ).toEqual([]);

    // The queue lost the job (Redis flushed): the lease runs out.
    await getDb()
      .update(fileRenditionRequests)
      .set({ enqueuedUntil: sql`now() - interval '1 second'` })
      .where(inArray(fileRenditionRequests.fileId, [ids[1]]));
    const again = (await claimDueRenditionRequests(10_000, LEASE_MS)).filter((r) =>
      ids.includes(r.fileId),
    );
    expect(again.map((r) => r.fileId)).toEqual([ids[1]]);
  });
});

describe('adopting jobs back from Redis', () => {
  it('records existing files as due and skips files that are gone', async () => {
    const ids = await fileIds(2);
    await recordRenditionRequest(ids[1], LEASE_MS);
    const adopted = await adoptRenditionRequests([
      { fileId: ids[0], requestedAt: new Date('2026-10-20T10:00:00.123Z') },
      { fileId: ids[1], requestedAt: new Date('2026-10-20T10:00:00.456Z') },
      { fileId: `missing-${randomBytes(4).toString('hex')}`, requestedAt: new Date() },
    ]);
    expect(adopted).toBe(2);
    const rows = await requestsOf(ids);
    const first = rows.find((row) => row.fileId === ids[0]);
    expect(first?.requestedAt.toISOString()).toBe('2026-10-20T10:00:00.123Z');
    // Already requested: keeps its own request, and is due now.
    expect(rows.every((row) => row.enqueuedUntil === null)).toBe(true);
  });
});

describe('the scheduler pass', () => {
  afterEach(async () => {
    // The pass reads the whole table: leave nothing due for the next case.
    await getDb().delete(fileRenditionRequests);
  });

  it('takes jobs beyond the direct bound back into the table before removing them', async () => {
    const ids = await fileIds(3);
    const base = Date.now() - 10_000;
    const kept = Array.from({ length: ASSET_VARIANT_QUEUE_TARGET_DEPTH }, (_, i) =>
      fakeJob(`kept-${i}`, base),
    );
    const excess = ids.map((fileId, i) => fakeJob(fileId, base + i));
    const queue = fakeQueue({ waiting: [...kept, ...excess] });

    const pass = await runAssetVariantSchedulerPass(queue as unknown as SchedulerQueue);

    expect(pass.adopted).toBe(3);
    expect(excess.every((job) => job.removed)).toBe(true);
    expect(kept.some((job) => job.removed)).toBe(false);
    const rows = await requestsOf(ids);
    expect(rows).toHaveLength(3);
    // The queue is at its target already (2,000 waiting), so nothing is added.
    expect(pass.enqueued).toBe(0);
  });

  it('tops the queue up from the oldest due requests at the backlog priority', async () => {
    const ids = await fileIds(3);
    await requestInOrder(ids);
    const queue = fakeQueue();

    const pass = await runAssetVariantSchedulerPass(queue as unknown as SchedulerQueue);

    expect(pass.enqueued).toBe(3);
    expect(queue.added.map((job) => job.data.fileId)).toEqual(ids);
    for (const job of queue.added) {
      expect(job.opts).toMatchObject({
        jobId: assetVariantsJobId(job.data.fileId),
        priority: ASSET_VARIANT_JOB_PRIORITY,
        removeOnComplete: true,
        removeOnFail: true,
      });
      expect(typeof job.data.requestedAt).toBe('string');
    }
    expect((await requestsOf(ids)).every((row) => row.enqueuedUntil !== null)).toBe(true);
    expect(ASSET_VARIANT_QUEUE_TARGET_DEPTH).toBe(32);
  });

  it('leaves the requests due when the queue refuses the add', async () => {
    const ids = await fileIds(2);
    await requestInOrder(ids);
    const queue = fakeQueue({ failAdd: true });

    await expect(runAssetVariantSchedulerPass(queue as unknown as SchedulerQueue)).rejects.toThrow(
      'OOM',
    );
    expect((await requestsOf(ids)).every((row) => row.enqueuedUntil === null)).toBe(true);
  });

  it('runs one at a time across the fleet', async () => {
    const ids = await fileIds(1);
    await requestInOrder(ids);
    const queue = fakeQueue();

    const pass = await getDb().transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended('oxy:asset-variant-scheduler', 0))`,
      );
      return runAssetVariantSchedulerPass(queue as unknown as SchedulerQueue);
    });

    expect(pass).toEqual({ skipped: true, adopted: 0, enqueued: 0 });
    expect(queue.added).toEqual([]);
  });
});

it('ignores only the legacy normalization race where a completed job no longer exists', async () => {
  const [id] = await fileIds(1);
  await requestInOrder([id]);
  const queue = fakeQueue();
  const getJobs = queue.getJobs;
  queue.getJobs = async (types, start, end) =>
    types.includes('prioritized')
      ? ([
          {
            priority: 10,
            changePriority: async () => {
              throw Object.assign(new Error('job completed'), { code: -1 });
            },
          },
        ] as never)
      : getJobs(types, start, end);
  expect((await runAssetVariantSchedulerPass(queue as unknown as SchedulerQueue)).enqueued).toBe(1);
  await getDb().delete(fileRenditionRequests);
});
