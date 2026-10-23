/**
 * Real Redis ordering/dedup/retry behavior plus the real PostgreSQL lease owner.
 * CI starts Redis on 6391; local runs may set TEST_QUEUE_REDIS_URL. Each case owns
 * a UUID queue and removes only that queue, never flushes the shared database.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { Queue, Worker, type Job } from 'bullmq';
import { eq, inArray, sql } from 'drizzle-orm';

jest.mock('../../services/s3ServiceSingleton', () => ({ s3Service: {} }));
jest.mock('../../services/variantService', () => ({ VariantService: class {} }));

import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { fileRenditionRequests, files, users } from '../../db/schema';
import {
  recordRenditionRequest,
  settleRenditionRequest,
  type RenditionLane,
} from '../../services/renditionRequests';
import { assetVariantsJobId, runAssetVariantSchedulerPass } from '../assetVariants.queue';

type Data = { fileId: string; requestedAt?: string };
const endpoint = new URL(process.env.TEST_QUEUE_REDIS_URL ?? 'redis://127.0.0.1:6391');
const connection = {
  host: endpoint.hostname,
  port: Number(endpoint.port || 6379),
  maxRetriesPerRequest: null,
};
let queue: Queue<Data>;
let worker: Worker<Data>;
let ownerId: string;
const lanes = new Map<string, RenditionLane>();
const token = 'test-owner';
jest.setTimeout(60000);
beforeAll(connectPostgres);
afterAll(closePostgres);
beforeEach(async () => {
  await getDb().delete(fileRenditionRequests);
  lanes.clear();
  const [owner] = await getDb().insert(users).values({ color: 'teal' }).returning({ id: users.id });
  ownerId = owner.id;
  queue = new Queue<Data>(`rendition-fairness-${randomUUID()}`, { connection });
  worker = new Worker<Data>(queue.name, async () => {}, { connection, autorun: false });
  await Promise.all([queue.waitUntilReady(), worker.waitUntilReady()]);
});
afterEach(async () => {
  await worker.close(true);
  await queue.obliterate({ force: true });
  await queue.close();
  await getDb().delete(fileRenditionRequests);
});

async function seed(lane: RenditionLane, count: number): Promise<string[]> {
  const rows = await getDb()
    .insert(files)
    .values(
      Array.from({ length: count }, () => {
        const sha256 = randomBytes(32).toString('hex');
        return {
          sha256,
          ownerUserId: ownerId,
          mime: 'image/png',
          size: 10,
          ext: 'png',
          storageKey: `content/${sha256}.png`,
          originalName: 'x.png',
          status: 'active' as const,
        };
      }),
    )
    .returning({ id: files.id });
  const ids = rows.map((row) => row.id);
  ids.forEach((id) => {
    lanes.set(id, lane);
  });
  await getDb()
    .insert(fileRenditionRequests)
    .values(ids.map((fileId) => ({ fileId, lane, requestedAt: new Date() })));
  return ids;
}
async function take(): Promise<Job<Data>> {
  const job = await worker.getNextJob(token, { block: false });
  if (!job) throw new Error('Expected a dispatched job');
  return job;
}
async function finish(job: Job<Data>) {
  if (job.data.requestedAt)
    await settleRenditionRequest({
      fileId: job.data.fileId,
      requestedAt: new Date(job.data.requestedAt),
    });
  await job.moveToCompleted(null, token, false);
}
async function dispatch() {
  return runAssetVariantSchedulerPass(queue);
}

it('keeps repair and old bulk moving under continuous fresh arrivals, in bounded FIFO rounds', async () => {
  await seed('bulk', 100);
  await seed('repair', 20);
  await seed('fresh', 100);
  const seen: string[] = [];
  for (let round = 0; round < 6; round++) {
    await dispatch();
    expect(await queue.getWaitingCount()).toBeLessThanOrEqual(32);
    const dispatched: RenditionLane[] = [];
    for (let slot = 0; slot < 16; slot++) {
      const job = await take();
      seen.push(job.data.fileId);
      const lane = lanes.get(job.data.fileId);
      if (!lane) throw new Error('Unknown dispatched file');
      dispatched.push(lane);
      await finish(job);
      await seed('fresh', 1); // sustained traffic while both background lanes stay due
      await dispatch();
    }
    expect(dispatched.filter((lane) => lane === 'fresh')).toHaveLength(14);
    expect(dispatched.filter((lane) => lane === 'repair')).toHaveLength(1);
    expect(dispatched.filter((lane) => lane === 'bulk')).toHaveLength(1);
  }
  expect(new Set(seen).size).toBe(seen.length);
  expect(await queue.getPrioritizedCount()).toBe(0);
});

it('donates an empty lane, then admits its new request within the next bounded window', async () => {
  await seed('fresh', 100);
  await seed('bulk', 100);
  await dispatch();
  const [repair] = await seed('repair', 1);
  let seenAt = 0;
  for (let slot = 1; slot <= 48; slot++) {
    const job = await take();
    await finish(job);
    if (job.data.fileId === repair) {
      seenAt = slot;
      break;
    }
    await seed('fresh', 1);
    await dispatch();
  }
  // At most32 already-admitted jobs plus one16-slot round (repair's reserved slot15).
  expect(seenAt).toBeGreaterThan(0);
  expect(seenAt).toBeLessThanOrEqual(47);
});

it('recovers a partial Redis write after transaction rollback and scheduler restart without duplicate work', async () => {
  const ids = await seed('repair', 33);
  const original = queue.addBulk.bind(queue);
  jest.spyOn(queue, 'addBulk').mockImplementationOnce(async (jobs) => {
    await original(jobs.slice(0, 1));
    throw new Error('scheduler stopped after first Redis write');
  });
  await expect(dispatch()).rejects.toThrow('scheduler stopped');
  expect(
    (await getDb().select().from(fileRenditionRequests)).every((r) => r.enqueuedUntil === null),
  ).toBe(true);
  const name = queue.name;
  await queue.close();
  queue = new Queue<Data>(name, { connection });
  const seen: string[] = [];
  for (let i = 0; i < ids.length; i++) {
    await dispatch();
    const job = await take();
    seen.push(job.data.fileId);
    await finish(job);
  }
  expect(seen.sort()).toEqual([...ids].sort());
  expect(await getDb().select().from(fileRenditionRequests)).toEqual([]);
  expect(await queue.getWaitingCount()).toBe(0);
});

it('adopts an oversized legacy queue while preserving active jobs, retries and durable request identity', async () => {
  const [retryId] = await seed('bulk', 1);
  const retryRequest = await recordRenditionRequest(retryId, 60000);
  await queue.add(
    'generate',
    { fileId: retryId, requestedAt: retryRequest.requestedAt.toISOString() },
    {
      jobId: assetVariantsJobId(retryId),
      priority: 10,
      attempts: 3,
      backoff: { type: 'fixed', delay: 60000 },
    },
  );
  const retry = await take();
  await retry.moveToFailed(new Error('temporary source error'), token, false);
  const beforeRetry = await queue.getJob(assetVariantsJobId(retryId));
  expect(beforeRetry?.attemptsMade).toBe(1);

  const ids = await seed('bulk', 70);
  const rows = await getDb()
    .select()
    .from(fileRenditionRequests)
    .where(inArray(fileRenditionRequests.fileId, ids));
  await queue.addBulk(
    rows.map((row) => ({
      name: 'generate',
      data: { fileId: row.fileId, requestedAt: row.requestedAt.toISOString() },
      opts: { jobId: assetVariantsJobId(row.fileId), removeOnComplete: true },
    })),
  );
  const active = await take();
  const pass = await dispatch();
  expect(pass.adopted).toBe(37); //69 waiting minus32; active and delayed retry remain owned
  const afterRetry = await queue.getJob(assetVariantsJobId(retryId));
  expect(afterRetry?.attemptsMade).toBe(1);
  expect(afterRetry?.priority).toBe(0);
  expect(await afterRetry?.getState()).toBe('delayed');
  expect(await active.getState()).toBe('active');
  const after = await getDb()
    .select()
    .from(fileRenditionRequests)
    .where(inArray(fileRenditionRequests.fileId, ids));
  expect(after.map((r) => [r.fileId, r.requestedAt.toISOString()]).sort()).toEqual(
    rows.map((r) => [r.fileId, r.requestedAt.toISOString()]).sort(),
  );
  expect(after).toHaveLength(70);
  await finish(active);
});

it('recovers an expired lease after Redis loss and preserves a new request while an older job settles', async () => {
  const [id] = await seed('repair', 1);
  await dispatch();
  await queue.drain(); // simulated loss of Redis's disposable waiting window
  await getDb()
    .update(fileRenditionRequests)
    .set({ enqueuedUntil: sql`now() - interval '1 second'` })
    .where(eq(fileRenditionRequests.fileId, id));
  await dispatch();
  const old = await take();
  await new Promise((resolve) => setTimeout(resolve, 5));
  const renewed = await recordRenditionRequest(id, null);
  // The actual producer dispatches immediately, before the old active job settles.
  expect((await dispatch()).enqueued).toBe(0);
  const [notLeasedToOldJob] = await getDb()
    .select()
    .from(fileRenditionRequests)
    .where(eq(fileRenditionRequests.fileId, id));
  expect(notLeasedToOldJob.enqueuedUntil).toBeNull();
  await finish(old);
  const [pending] = await getDb()
    .select()
    .from(fileRenditionRequests)
    .where(eq(fileRenditionRequests.fileId, id));
  expect(pending).toMatchObject({ lane: 'fresh', requestedAt: renewed.requestedAt });
  await dispatch();
  const next = await take();
  expect(next.data.requestedAt).toBe(renewed.requestedAt.toISOString());
  await finish(next);
  expect(await getDb().select().from(fileRenditionRequests)).toEqual([]);
});
