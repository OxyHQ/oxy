/**
 * Real Redis ordering/dedup/retry behavior plus the real PostgreSQL lease owner.
 * CI starts Redis on 6391; local runs may set TEST_QUEUE_REDIS_URL. Each case owns
 * a UUID queue and removes only that queue, never flushes the shared database.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { Queue, Worker, Job } from 'bullmq';
import { eq, inArray, sql } from 'drizzle-orm';

jest.mock('../../services/s3ServiceSingleton', () => ({ s3Service: {} }));
jest.mock('../../services/variantService', () => ({ VariantService: class {} }));

import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { fileRenditionRequests, files, users } from '../../db/schema';
import {
  recordRenditionRequest,
  settleRenditionRequest,
  type RenditionLane,
  RENDITION_DISPATCH_ROUND,
} from '../../services/renditionRequests';
import {
  ASSET_VARIANT_QUEUE_TARGET_DEPTH,
  assetVariantsJobId,
  runAssetVariantSchedulerPass,
} from '../assetVariants.queue';

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

it('shares each background lease cap across simultaneous scheduler passes', async () => {
  await seed('repair', 20);
  await seed('bulk', 20);
  let markClaimed: () => void = () => {};
  let releaseWrite: () => void = () => {};
  const claimed = new Promise<void>((resolve) => {
    markClaimed = resolve;
  });
  const writeAllowed = new Promise<void>((resolve) => {
    releaseWrite = resolve;
  });
  const original = queue.addBulk.bind(queue);
  jest.spyOn(queue, 'addBulk').mockImplementationOnce(async (jobs) => {
    markClaimed();
    await writeAllowed;
    return original(jobs);
  });
  const first = dispatch();
  await claimed;
  try {
    expect(await dispatch()).toMatchObject({ skipped: true, enqueued: 0 });
  } finally {
    releaseWrite();
  }
  expect((await first).enqueued).toBe(2);
  expect((await dispatch()).enqueued).toBe(0);
  expect(await queue.getWaitingCount()).toBe(2);
  const rows = await getDb().select().from(fileRenditionRequests);
  for (const lane of ['repair', 'bulk'])
    expect(rows.filter((r) => r.lane === lane && r.enqueuedUntil)).toHaveLength(1);
});

it('reserves fresh headroom when both background backlogs arrive before any uploads', async () => {
  await seed('repair', 100);
  await seed('bulk', 100);
  expect((await dispatch()).enqueued).toBe(2);
  const active = [await take(), await take()];
  expect(active.map((job) => lanes.get(job.data.fileId)).sort()).toEqual(['bulk', 'repair']);
  expect((await dispatch()).enqueued).toBe(0);

  await seed('fresh', 100);
  expect((await dispatch()).enqueued).toBe(64);
  for (let i = 0; i < 96; i++) {
    const job = await take();
    expect(lanes.get(job.data.fileId)).toBe('fresh');
    await finish(job);
    await seed('fresh', 1);
    await dispatch();
  }
  // The two long background jobs keep their leases throughout fresh progress.
  for (const job of active) expect(await job.getState()).toBe('active');
  for (const job of active) await finish(job);
});

it('keeps retry ownership while a full fresh round fits beside a delayed background job', async () => {
  await seed('repair', 3);
  await dispatch();
  const retry = await take();
  await retry.moveToFailed(new Error('temporary source error'), token, false);
  expect(await retry.getState()).toBe('delayed');
  await seed('fresh', 100);
  expect((await dispatch()).enqueued).toBe(32);
  expect(await queue.getWaitingCount()).toBe(32);
  // A delayed retry leaves headroom for the next full fresh round after one completion.
  const first = await take();
  await finish(first);
  expect((await dispatch()).enqueued).toBe(32);
  expect((await queue.getJob(assetVariantsJobId(retry.data.fileId)))?.attemptsMade).toBe(1);
  expect(await queue.getDelayedCount()).toBe(1);
  const claimedRepairs = await getDb().select().from(fileRenditionRequests);
  expect(claimedRepairs.filter((r) => r.lane === 'repair' && r.enqueuedUntil)).toHaveLength(1);
});

it('does not refill tiny vacancies or grant extra background leases from an older deployment', async () => {
  expect(ASSET_VARIANT_QUEUE_TARGET_DEPTH).toBe(2 * RENDITION_DISPATCH_ROUND.length);
  const background = [...(await seed('repair', 3)), ...(await seed('bulk', 3))];
  await getDb()
    .update(fileRenditionRequests)
    .set({ enqueuedUntil: sql`now() + interval '5 minutes'` })
    .where(inArray(fileRenditionRequests.fileId, background));
  await seed('repair', 3);
  await seed('bulk', 3);
  await seed('fresh', 100);
  expect((await dispatch()).enqueued).toBe(64);
  for (let i = 1; i < 32; i++) {
    const job = await take();
    expect(lanes.get(job.data.fileId)).toBe('fresh');
    await finish(job);
    expect((await dispatch()).enqueued).toBe(0);
  }
  await finish(await take());
  expect((await dispatch()).enqueued).toBe(32);
  const rows = await getDb().select().from(fileRenditionRequests);
  for (const lane of ['repair', 'bulk'])
    expect(rows.filter((r) => r.lane === lane && r.enqueuedUntil)).toHaveLength(3);
});

it('keeps repair and old bulk moving under continuous fresh arrivals, in bounded FIFO rounds', async () => {
  await seed('bulk', 100);
  await seed('repair', 20);
  await seed('fresh', 100);
  const seen: string[] = [];
  for (let round = 0; round < 8; round++) {
    await dispatch();
    expect(await queue.getWaitingCount()).toBeLessThanOrEqual(64);
    const dispatched: RenditionLane[] = [];
    for (let slot = 0; slot < 32; slot++) {
      const job = await take();
      seen.push(job.data.fileId);
      const lane = lanes.get(job.data.fileId);
      if (!lane) throw new Error('Unknown dispatched file');
      dispatched.push(lane);
      await finish(job);
      await seed('fresh', 1); // sustained traffic while both background lanes stay due
      await dispatch();
    }
    expect(dispatched.filter((lane) => lane === 'fresh').length).toBeGreaterThanOrEqual(30);
    expect(dispatched.filter((lane) => lane === 'repair').length).toBeLessThanOrEqual(1);
    expect(dispatched.filter((lane) => lane === 'bulk').length).toBeLessThanOrEqual(1);
  }
  for (const lane of ['repair', 'bulk']) {
    const positions = seen.flatMap((id, index) => (lanes.get(id) === lane ? [index] : []));
    expect(positions.length).toBeGreaterThanOrEqual(3);
    // Admission may wait for the previous job's lease to settle, but every
    // two-round window still advances both background lanes under fresh load.
    for (let i = 1; i < positions.length; i++)
      expect(positions[i] - positions[i - 1]).toBeLessThanOrEqual(64);
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
  for (let slot = 1; slot <= 96; slot++) {
    const job = await take();
    await finish(job);
    if (job.data.fileId === repair) {
      seenAt = slot;
      break;
    }
    await seed('fresh', 1);
    await dispatch();
  }
  // At most64 already-admitted jobs plus one32-slot round (repair's reserved slot31).
  expect(seenAt).toBeGreaterThan(0);
  expect(seenAt).toBeLessThanOrEqual(95);
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
  expect(pass.adopted).toBe(5); //69 waiting minus64; active and delayed retry remain owned
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

async function requestFor(fileId: string) {
  const [row] = await getDb()
    .select()
    .from(fileRenditionRequests)
    .where(eq(fileRenditionRequests.fileId, fileId));
  return row;
}

async function retainedJob(fileId: string, state: 'completed' | 'failed', requestedAt?: string) {
  const request = await requestFor(fileId);
  await queue.add(
    'generate',
    { fileId, ...(requestedAt === undefined ? {} : { requestedAt }) },
    {
      jobId: assetVariantsJobId(fileId),
      timestamp: request.requestedAt.getTime() - 60_000,
      attempts: 1,
      removeOnComplete: false,
      removeOnFail: false,
    },
  );
  const job = await take();
  if (state === 'completed') await job.moveToCompleted(null, token, false);
  else await job.moveToFailed(new Error('old source failure'), token, false);
  expect(await job.getState()).toBe(state);
  return job;
}

it.each([
  ['completed', 'legacy'],
  ['failed', 'legacy'],
  ['completed', 'versioned'],
  ['failed', 'versioned'],
] as const)(
  'replaces an obsolete %s %s repair head and then processes the following repair',
  async (state, identity) => {
    const ids = await seed('repair', 2);
    const [head, following] = await getDb()
      .select()
      .from(fileRenditionRequests)
      .orderBy(fileRenditionRequests.requestedAt, fileRenditionRequests.fileId);
    const oldStamp =
      identity === 'legacy'
        ? undefined
        : new Date(head.requestedAt.getTime() - 60_000).toISOString();
    await retainedJob(head.fileId, state, oldStamp);
    expect((await dispatch()).enqueued).toBe(1);
    const replacement = await take();
    expect(replacement.data).toMatchObject({
      fileId: head.fileId,
      requestedAt: head.requestedAt.toISOString(),
    });
    expect(replacement.attemptsMade).toBe(0);
    expect(replacement.opts.attempts).toBe(3);
    expect((await requestFor(head.fileId)).enqueuedUntil).not.toBeNull();
    await finish(replacement);
    expect((await dispatch()).enqueued).toBe(1);
    const next = await take();
    expect(next.data.fileId).toBe(following.fileId);
    await finish(next);
    expect(
      await getDb()
        .select()
        .from(fileRenditionRequests)
        .where(inArray(fileRenditionRequests.fileId, ids)),
    ).toEqual([]);
  },
);

it.each(['completed', 'failed'] as const)(
  'settles a retained matching %s request without resetting attempts or deleting its record',
  async (state) => {
    const [id] = await seed('repair', 1);
    const request = await requestFor(id);
    await retainedJob(id, state, request.requestedAt.toISOString());
    const before = await queue.getJob(assetVariantsJobId(id));
    expect((await dispatch()).enqueued).toBe(0);
    expect(await requestFor(id)).toBeUndefined();
    const after = await queue.getJob(assetVariantsJobId(id));
    expect(after?.data).toEqual(before?.data);
    expect(after?.attemptsMade).toBe(before?.attemptsMade);
    expect(after?.timestamp).toBe(before?.timestamp);
    expect(await after?.getState()).toBe(state);
  },
);

it.each(['newer', 'invalid', 'wrong-file', 'wrong-file-matching-stamp'] as const)(
  'does not retire a terminal record with %s request identity',
  async (identity) => {
    const [id] = await seed('repair', 1);
    const request = await requestFor(id);
    const stamp =
      identity === 'newer'
        ? new Date(request.requestedAt.getTime() + 60_000).toISOString()
        : identity === 'invalid'
          ? 'not-a-date'
          : identity === 'wrong-file-matching-stamp'
            ? request.requestedAt.toISOString()
            : new Date(request.requestedAt.getTime() - 60_000).toISOString();
    const job = await retainedJob(id, 'failed', stamp);
    if (identity === 'wrong-file' || identity === 'wrong-file-matching-stamp')
      await job.updateData({ fileId: 'different-file', requestedAt: stamp });
    const before = await queue.getJob(assetVariantsJobId(id));
    expect((await dispatch()).enqueued).toBe(0);
    const after = await queue.getJob(assetVariantsJobId(id));
    expect(after?.data).toEqual(before?.data);
    expect(after?.attemptsMade).toBe(before?.attemptsMade);
    expect(await after?.getState()).toBe('failed');
    expect((await requestFor(id)).enqueuedUntil).toBeNull();
  },
);

it.each(['waiting', 'paused', 'delayed', 'active'] as const)(
  'preserves an older %s job and its attempt budget',
  async (state) => {
    const [id] = await seed('repair', 1);
    const request = await requestFor(id);
    await queue.add(
      'generate',
      { fileId: id, requestedAt: new Date(request.requestedAt.getTime() - 60_000).toISOString() },
      {
        jobId: assetVariantsJobId(id),
        attempts: 3,
        backoff: { type: 'fixed', delay: 60_000 },
      },
    );
    let active: Job<Data> | undefined;
    if (state === 'paused') await queue.pause();
    if (state === 'active' || state === 'delayed') active = await take();
    if (state === 'delayed') {
      if (!active) throw new Error('Expected active retry');
      await active.moveToFailed(new Error('retryable source'), token, false);
    }
    const before = await queue.getJob(assetVariantsJobId(id));
    const beforeState = await before?.getState();
    expect((await dispatch()).enqueued).toBe(0);
    const after = await queue.getJob(assetVariantsJobId(id));
    expect(after?.data).toEqual(before?.data);
    expect(after?.attemptsMade).toBe(before?.attemptsMade);
    expect(after?.opts.attempts).toBe(3);
    expect(await after?.getState()).toBe(beforeState);
    expect((await requestFor(id)).enqueuedUntil).toBeNull();
    if (state === 'active') {
      if (!active) throw new Error('Expected active job');
      await active.moveToCompleted(null, token, false);
    }
  },
);

it('keeps the durable repair due when admission fails after retiring the obsolete terminal record', async () => {
  const [id] = await seed('repair', 1);
  await retainedJob(id, 'failed');
  const add = jest
    .spyOn(queue, 'addBulk')
    .mockRejectedValueOnce(new Error('admission interrupted'));
  await expect(dispatch()).rejects.toThrow('admission interrupted');
  expect(await queue.getJob(assetVariantsJobId(id))).toBeUndefined();
  expect((await requestFor(id)).enqueuedUntil).toBeNull();
  add.mockRestore();
  expect((await dispatch()).enqueued).toBe(1);
  await finish(await take());
  expect(await requestFor(id)).toBeUndefined();
});

it('rolls back admission if a terminal job acquires an active lock before removal', async () => {
  const [id] = await seed('repair', 1);
  const retained = await retainedJob(id, 'failed');
  const getState = Job.prototype.getState;
  let active: Job<Data> | undefined;
  const state = jest.spyOn(Job.prototype, 'getState').mockImplementationOnce(async function (
    this: Job<Data>,
  ) {
    const observed = await getState.call(this);
    await retained.retry();
    active = await take();
    return observed;
  });
  try {
    await expect(dispatch()).rejects.toThrow('locked');
    expect((await requestFor(id)).enqueuedUntil).toBeNull();
    expect(await queue.getJob(assetVariantsJobId(id))).toBeDefined();
  } finally {
    state.mockRestore();
    if (active) await active.moveToCompleted(null, token, false);
  }
  expect((await dispatch()).enqueued).toBe(1);
  await finish(await take());
  expect(await requestFor(id)).toBeUndefined();
});
