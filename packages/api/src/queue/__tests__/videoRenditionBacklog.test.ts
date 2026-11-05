import { randomBytes } from 'node:crypto';
import { inArray } from 'drizzle-orm';

jest.mock('../../services/s3ServiceSingleton', () => ({ s3Service: {} }));
jest.mock('../../services/variantService', () => ({
  VariantService: class {
    generateVariants = jest.fn(async () => {});
  },
}));

import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { applications, fileReferences, fileRenditionRequests, users } from '../../db/schema';
import { insertFile, upsertVariantSet } from '../../services/fileRepository';
import { recordRenditionRequest } from '../../services/renditionRequests';
import { VIDEO_RENDITION_PROFILE } from '../../services/video-renditions';
import { seedVideoRenditionBacklog } from '../../scripts/video-rendition-backlog';
import {
  ASSET_VARIANT_JOB_PRIORITY,
  ASSET_VARIANT_QUEUE_TARGET_DEPTH,
  runAssetVariantSchedulerPass,
} from '../assetVariants.queue';

beforeAll(connectPostgres);
afterAll(closePostgres);
// The scheduler owns a fleet-wide backlog, not an application-scoped queue.
// Each case must own the disposable database's request table: an older fixture
// otherwise correctly consumes the repair lane's single outstanding lease.
beforeEach(async () => {
  await getDb().delete(fileRenditionRequests);
});
afterEach(async () => {
  await getDb().delete(fileRenditionRequests);
});
const sha = () => randomBytes(32).toString('hex');
async function application() {
  const [owner] = await getDb().insert(users).values({ color: 'teal' }).returning();
  const [app] = await getDb()
    .insert(applications)
    .values({ name: 'Mention repair test', ownerAccountId: owner.id })
    .returning();
  return app.id;
}
async function video(
  app: string,
  options: {
    hash?: string;
    portrait?: boolean;
    owned?: boolean;
    referenced?: boolean;
    status?: 'active' | 'trash';
  } = {},
) {
  const hash = options.hash ?? sha();
  const [owner] = await getDb().insert(users).values({ color: 'teal' }).returning();
  const row = await insertFile({
    sha256: hash,
    mime: 'video/mp4',
    ext: 'mp4',
    size: 10,
    status: options.status ?? 'active',
    visibility: 'public',
    storageKey: `public/content/${hash}`,
    ...(options.owned ? { ownerApplicationId: app } : { ownerUserId: owner.id }),
    metadata: {
      media: { width: options.portrait ? 180 : 320, height: options.portrait ? 320 : 180 },
      serviceAppId: app,
    },
  });
  if (options.referenced !== false)
    await getDb()
      .insert(fileReferences)
      .values({ fileId: row.id, applicationId: app, entityType: 'post', entityId: sha() });
  return row;
}
async function requests(ids: string[]) {
  return getDb()
    .select()
    .from(fileRenditionRequests)
    .where(inArray(fileRenditionRequests.fileId, ids));
}

it('requires an active application and bounded inputs', async () => {
  await expect(seedVideoRenditionBacklog({ applicationId: '' })).rejects.toThrow('application ID');
  await expect(seedVideoRenditionBacklog({ applicationId: 'unknown' })).rejects.toThrow(
    'not active',
  );
  await expect(seedVideoRenditionBacklog({ applicationId: 'x', limit: 1001 })).rejects.toThrow(
    'limit',
  );
  await expect(
    seedVideoRenditionBacklog({ applicationId: 'x', maxGroups: 100001 }),
  ).rejects.toThrow('maxGroups');
  await expect(seedVideoRenditionBacklog({ applicationId: 'x', after: 'broken' })).rejects.toThrow(
    'cursor',
  );
});

it('selects owned or referenced active legacy videos only, with dry-run as the default', async () => {
  const app = await application();
  const referenced = await video(app);
  const owned = await video(app, { owned: true, referenced: false });
  const metadataOnly = await video(app, { referenced: false });
  const inactive = await video(app, { status: 'trash' });
  const current = await video(app);
  const incomplete = await video(app);
  const other = await video(await application());
  await upsertVariantSet(current.id, [
    {
      type: 'hls_master',
      key: 'current/master.m3u8',
      readyAt: new Date(),
      metadata: { encodingProfile: VIDEO_RENDITION_PROFILE },
    },
  ]);
  await upsertVariantSet(incomplete.id, [
    {
      type: 'hls_master',
      key: 'incomplete/master.m3u8',
      metadata: { encodingProfile: VIDEO_RENDITION_PROFILE },
    },
  ]);
  const ids = [referenced, owned, metadataOnly, inactive, current, incomplete, other].map(
    (f) => f.id,
  );
  expect(await seedVideoRenditionBacklog({ applicationId: app })).toMatchObject({
    considered: 3,
    inserted: 0,
    reachedLimit: false,
  });
  expect(await requests(ids)).toEqual([]);
  expect(await seedVideoRenditionBacklog({ applicationId: app, dryRun: false })).toMatchObject({
    considered: 3,
    inserted: 3,
  });
  expect((await requests(ids)).map((r) => r.fileId).sort()).toEqual(
    [referenced.id, owned.id, incomplete.id].sort(),
  );
});

it('deduplicates twins, resumes portrait-first pages and preserves an existing request lease on replay', async () => {
  const app = await application();
  const portrait = await video(app, { portrait: true, hash: 'f'.repeat(64) });
  const twin = await video(app, { portrait: true, hash: portrait.sha256 });
  const landscape = await video(app, { hash: '0'.repeat(64) });
  const first = await seedVideoRenditionBacklog({
    applicationId: app,
    dryRun: false,
    limit: 1,
    maxGroups: 1,
  });
  expect(first).toMatchObject({
    considered: 1,
    inserted: 1,
    reachedLimit: true,
    nextCursor: `0:${portrait.sha256}:public`,
  });
  expect(await requests([landscape.id])).toEqual([]);
  expect(await requests([portrait.id, twin.id])).toHaveLength(1);
  const second = await seedVideoRenditionBacklog({
    applicationId: app,
    dryRun: false,
    limit: 1,
    after: first.nextCursor,
  });
  expect(second).toMatchObject({ considered: 1, inserted: 1, reachedLimit: false });
  await recordRenditionRequest(landscape.id, 60000);
  const before = await requests([landscape.id]);
  expect(await seedVideoRenditionBacklog({ applicationId: app, dryRun: false })).toMatchObject({
    considered: 2,
    inserted: 0,
    alreadyPending: 2,
  });
  expect(await requests([landscape.id])).toEqual(before);
});

it('feeds the existing bounded scheduler at backlog priority without bypassing backpressure', async () => {
  const app = await application();
  const row = await video(app);
  await seedVideoRenditionBacklog({ applicationId: app, dryRun: false });
  type QueuedJob = {
    data: { fileId: string; requestedAt?: string };
    opts: { jobId: string };
  };
  const queued = new Map<string, QueuedJob>();
  const addBulk = jest.fn(async (jobs: QueuedJob[]) => {
    for (const job of jobs) queued.set(job.opts.jobId, job);
  });
  let depth = ASSET_VARIANT_QUEUE_TARGET_DEPTH;
  const queue = {
    getJobs: async () => [],
    getJob: async (jobId: string) => queued.get(jobId),
    getJobCounts: async (...states: string[]) =>
      Object.fromEntries(states.map((s) => [s, s === 'prioritized' ? depth : 0])),
    addBulk,
  };
  const asQueue = queue as unknown as Parameters<typeof runAssetVariantSchedulerPass>[0];
  await runAssetVariantSchedulerPass(asQueue);
  expect(addBulk).not.toHaveBeenCalled();
  expect((await requests([row.id]))[0].enqueuedUntil).toBeNull();
  depth = 0;
  await runAssetVariantSchedulerPass(asQueue);
  expect(addBulk).toHaveBeenCalledTimes(1);
  expect(addBulk).toHaveBeenCalledWith([
    expect.objectContaining({
      data: expect.objectContaining({ fileId: row.id }),
      opts: expect.objectContaining({ priority: ASSET_VARIANT_JOB_PRIORITY }),
    }),
  ]);
  expect((await requests([row.id]))[0].enqueuedUntil).not.toBeNull();
});

it('promotes an existing leased bulk request, preserving its identity and a fresh request', async () => {
  const app = await application();
  const bulk = await video(app);
  const fresh = await video(app);
  const at = new Date();
  const until = new Date(Date.now() + 60000);
  await getDb()
    .insert(fileRenditionRequests)
    .values({ fileId: bulk.id, requestedAt: at, enqueuedUntil: until });
  await recordRenditionRequest(fresh.id, 60000);
  const beforeFresh = await requests([fresh.id]);
  const result = await seedVideoRenditionBacklog({ applicationId: app, dryRun: false });
  expect(result).toMatchObject({ inserted: 0, promoted: 1, alreadyPending: 2 });
  expect(await requests([bulk.id])).toEqual([
    expect.objectContaining({ lane: 'repair', requestedAt: at, enqueuedUntil: until }),
  ]);
  expect(await requests([fresh.id])).toEqual(beforeFresh);
  expect(await seedVideoRenditionBacklog({ applicationId: app, dryRun: false })).toMatchObject({
    inserted: 0,
    promoted: 0,
  });
});
