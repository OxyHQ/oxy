/**
 * The storage observation of ADR 0041 D2 against a REAL Postgres: what each
 * application stores and added, the growth anomaly, and the metrics it
 * publishes (CloudWatch embedded metric format, read back from the log lines).
 *
 *  - Stored = live rows (`active`, `trash`, `blocked`) and their renditions —
 *    the same number `applicationStoredBytes` reports and the quota counts.
 *  - Added = rows CREATED in the 24 hours before the run (any status since),
 *    against the per-day average of the seven days before; older rows count in
 *    neither window.
 *  - An anomaly is above a floor AND a multiple of the trailing average, or
 *    above the absolute cap; below the floor nothing alerts.
 *  - One line per application (bounded, anomalies first), one platform line
 *    the alarm watches, an ERROR line per anomaly; the sweep carries it and a
 *    failed observation never fails the sweep.
 *
 * The test database is shared with other files in this worker, so every
 * assertion reads only the applications a case creates.
 */

import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';

const mockInfo = jest.fn();
const mockError = jest.fn();
jest.mock('../../utils/logger', () => ({
  logger: {
    warn: jest.fn(),
    error: (...args: unknown[]) => mockError(...args),
    info: (...args: unknown[]) => mockInfo(...args),
    debug: jest.fn(),
  },
}));

import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { applications, fileVariants, files, users } from '../../db/schema';
import {
  type ApplicationStorageObservation,
  DEFAULT_GROWTH_THRESHOLDS,
  evaluateGrowth,
  type GrowthThresholds,
  growthThresholdsFromEnv,
  observeApplicationStorage,
  publishApplicationStorageMetrics,
  STORAGE_METRIC_NAMESPACE,
} from '../applicationStorageObservation';
import { runFileLifecycleSweep } from '../fileLifecycle.worker';
import { applicationStoredBytes } from '../storageQuota.service';

jest.setTimeout(60_000);

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

/** Thresholds small enough to trip with test-sized rows. */
const SMALL: GrowthThresholds = {
  multiple: 5,
  minBytes: 1_000,
  minFiles: 1_000,
  dailyCapBytes: 1_000_000_000,
  maxApplications: 1_000,
};

async function account(): Promise<string> {
  const [row] = await getDb().insert(users).values({ color: 'teal' }).returning({ id: users.id });
  return row.id;
}

async function application(type: 'first_party' | 'third_party' = 'first_party') {
  const [row] = await getDb()
    .insert(applications)
    .values({
      name: `observed-${randomBytes(4).toString('hex')}`,
      ownerAccountId: await account(),
      type,
    })
    .returning({ id: applications.id, name: applications.name });
  return row;
}

/** One application-owned row, created `ageMs` before `now`, with an optional rendition. */
async function fileOf(
  applicationId: string,
  options: {
    size: number;
    status?: 'active' | 'trash' | 'blocked' | 'deleted';
    createdAt: Date;
    variantSize?: number;
  },
) {
  const sha256 = randomBytes(32).toString('hex');
  const [row] = await getDb()
    .insert(files)
    .values({
      sha256,
      size: options.size,
      mime: 'image/png',
      ext: 'png',
      ownerApplicationId: applicationId,
      status: options.status ?? 'active',
      storageKey: `content/2026/10/${sha256.slice(0, 2)}/${sha256}.png`,
      originalName: 'x.png',
      createdAt: options.createdAt,
      ...(options.status === 'trash' ? { trashedAt: options.createdAt } : {}),
    })
    .returning({ id: files.id });
  if (options.variantSize !== undefined) {
    await getDb()
      .insert(fileVariants)
      .values({
        fileId: row.id,
        type: 'thumb',
        key: `variants/${sha256}/thumb.webp`,
        size: options.variantSize,
      });
  }
  return row.id;
}

function find(observations: ApplicationStorageObservation[], applicationId: string) {
  const found = observations.find((o) => o.applicationId === applicationId);
  if (!found) throw new Error(`no observation for ${applicationId}`);
  return found;
}

/** The EMF documents logged at info level whose namespace is ours. */
function emfLines() {
  return mockInfo.mock.calls
    .map(([, fields]) => fields as Record<string, unknown> & { _aws?: Record<string, unknown> })
    .filter((fields) => {
      const metrics = fields?._aws?.CloudWatchMetrics as Array<{ Namespace: string }> | undefined;
      return metrics?.[0]?.Namespace === STORAGE_METRIC_NAMESPACE;
    });
}

beforeAll(async () => {
  await connectPostgres();
});

afterAll(async () => {
  await closePostgres();
});

beforeEach(() => {
  mockInfo.mockClear();
  mockError.mockClear();
});

describe('what an application stores and added', () => {
  it('stores live rows and renditions — what applicationStoredBytes says — and adds by window', async () => {
    const now = new Date();
    const app = await application();
    // Live: active (with a rendition), trash and blocked. A tombstone stores nothing.
    await fileOf(app.id, { size: 100, createdAt: new Date(now.getTime() - HOUR), variantSize: 7 });
    await fileOf(app.id, {
      size: 200,
      status: 'trash',
      createdAt: new Date(now.getTime() - 3 * DAY),
    });
    await fileOf(app.id, {
      size: 400,
      status: 'blocked',
      createdAt: new Date(now.getTime() - 30 * DAY),
    });
    await fileOf(app.id, {
      size: 800,
      status: 'deleted',
      createdAt: new Date(now.getTime() - 2 * HOUR),
    });
    // Created after the run's instant: in no window.
    await fileOf(app.id, { size: 1600, createdAt: new Date(now.getTime() + HOUR) });

    const observed = find(await observeApplicationStorage(now), app.id);

    expect(observed).toMatchObject({
      applicationName: app.name,
      applicationType: 'first_party',
      applicationStatus: 'active',
      // active 100+7, trash 200, blocked 400, the future one 1600 — not the tombstone.
      storedFiles: 4,
      storedBytes: 2307,
      // The last 24 hours: the active row and the one since deleted.
      filesAdded24h: 2,
      bytesAdded24h: 907,
    });
    // The trailing week: the trashed row, three days old, over seven days.
    expect(observed.trailingDailyBytes).toBeCloseTo(200 / 7);
    expect(observed.trailingDailyFiles).toBeCloseTo(1 / 7);

    const quota = await applicationStoredBytes(getDb(), app.id);
    expect(observed.storedBytes).toBe(quota.bytes);
    expect(observed.storedFiles).toBe(quota.files);
  });

  it('an application that owns no file is not observed; a deleted one with live files is', async () => {
    const now = new Date();
    const idle = await application();
    const gone = await application('third_party');
    await fileOf(gone.id, { size: 10, createdAt: new Date(now.getTime() - 10 * DAY) });
    await getDb()
      .update(applications)
      .set({ status: 'deleted' })
      .where(eq(applications.id, gone.id));

    const observations = await observeApplicationStorage(now);

    expect(observations.some((o) => o.applicationId === idle.id)).toBe(false);
    expect(find(observations, gone.id)).toMatchObject({
      applicationStatus: 'deleted',
      applicationType: 'third_party',
      storedBytes: 10,
      bytesAdded24h: 0,
      trailingDailyBytes: 0,
    });
  });
});

describe('the growth anomaly', () => {
  const quiet = {
    bytesAdded24h: 0,
    filesAdded24h: 0,
    trailingDailyBytes: 0,
    trailingDailyFiles: 0,
  };

  it('needs the floor: a new application below it never alerts, at it does', () => {
    expect(evaluateGrowth({ ...quiet, bytesAdded24h: 999 }, SMALL)).toEqual({
      anomalous: false,
      reasons: [],
    });
    expect(evaluateGrowth({ ...quiet, bytesAdded24h: 1_000 }, SMALL)).toEqual({
      anomalous: true,
      reasons: ['bytes_multiple'],
    });
  });

  it('above the floor, alerts only beyond the multiple of the trailing average', () => {
    const steady = { ...quiet, trailingDailyBytes: 10_000 };
    expect(evaluateGrowth({ ...steady, bytesAdded24h: 50_000 }, SMALL).anomalous).toBe(false);
    expect(evaluateGrowth({ ...steady, bytesAdded24h: 50_001 }, SMALL)).toEqual({
      anomalous: true,
      reasons: ['bytes_multiple'],
    });
  });

  it('counts files on their own floor — an import loop of small files', () => {
    const steady = { ...quiet, trailingDailyFiles: 100 };
    expect(evaluateGrowth({ ...steady, filesAdded24h: 999 }, SMALL).anomalous).toBe(false);
    expect(evaluateGrowth({ ...steady, filesAdded24h: 1_000 }, SMALL)).toEqual({
      anomalous: true,
      reasons: ['files_multiple'],
    });
  });

  it('the absolute cap alerts whatever the history', () => {
    const huge = { ...quiet, trailingDailyBytes: 10_000_000_000 };
    expect(evaluateGrowth({ ...huge, bytesAdded24h: 999_999_999 }, SMALL).anomalous).toBe(false);
    expect(evaluateGrowth({ ...huge, bytesAdded24h: 1_000_000_000 }, SMALL)).toEqual({
      anomalous: true,
      reasons: ['daily_cap'],
    });
  });

  it('reads its thresholds from the environment, keeping a default for an unusable value', () => {
    const saved = { ...process.env };
    try {
      process.env.FILE_STORAGE_GROWTH_MULTIPLE = '2.5';
      process.env.FILE_STORAGE_GROWTH_MIN_BYTES = 'lots';
      process.env.FILE_STORAGE_METRICS_MAX_APPLICATIONS = '20';
      expect(growthThresholdsFromEnv()).toEqual({
        ...DEFAULT_GROWTH_THRESHOLDS,
        multiple: 2.5,
        maxApplications: 20,
      });
      expect(mockError).toHaveBeenCalledWith(
        '[FileStorage] Unusable threshold; using the default',
        expect.objectContaining({ key: 'FILE_STORAGE_GROWTH_MIN_BYTES' }),
      );
    } finally {
      process.env = saved;
    }
  });

  it('the defaults: 5x over a 1 GiB / 10,000-file floor, a 50 GiB daily cap, 100 lines', () => {
    expect(DEFAULT_GROWTH_THRESHOLDS).toEqual({
      multiple: 5,
      minBytes: 1024 ** 3,
      minFiles: 10_000,
      dailyCapBytes: 50 * 1024 ** 3,
      maxApplications: 100,
    });
  });
});

describe('what is published', () => {
  it('one EMF line per application, one platform line, an ERROR line per anomaly', async () => {
    const now = new Date();
    const loop = await application('third_party');
    const steady = await application();
    // The import loop: 5,000 bytes today, nothing before.
    await fileOf(loop.id, { size: 5_000, createdAt: new Date(now.getTime() - HOUR) });
    // Steady: 1,000 a day for the trailing week, 1,000 today.
    for (let day = 1; day <= 7; day += 1) {
      await fileOf(steady.id, {
        size: 1_000,
        createdAt: new Date(now.getTime() - day * DAY - HOUR),
      });
    }
    await fileOf(steady.id, { size: 1_000, createdAt: new Date(now.getTime() - HOUR) });

    const observations = await observeApplicationStorage(now);
    const summary = publishApplicationStorageMetrics(observations, SMALL, now);

    expect(summary.anomalies).toContainEqual({
      applicationId: loop.id,
      reasons: ['bytes_multiple'],
    });
    expect(summary.anomalies.some((a) => a.applicationId === steady.id)).toBe(false);

    const lines = emfLines();
    const perApp = lines.filter((line) => line.ApplicationId === loop.id);
    expect(perApp).toHaveLength(1);
    expect(perApp[0]).toMatchObject({
      _aws: {
        Timestamp: now.getTime(),
        CloudWatchMetrics: [
          {
            Namespace: 'Oxy/FileStorage',
            Dimensions: [['ApplicationId']],
            Metrics: expect.arrayContaining([
              { Name: 'StoredBytes', Unit: 'Bytes' },
              { Name: 'BytesAdded24h', Unit: 'Bytes' },
              { Name: 'GrowthAnomaly', Unit: 'Count' },
            ]),
          },
        ],
      },
      applicationType: 'third_party',
      StoredBytes: 5_000,
      StoredFiles: 1,
      BytesAdded24h: 5_000,
      FilesAdded24h: 1,
      TrailingDailyBytes: 0,
      GrowthAnomaly: 1,
    });
    // Every metric named in the directive has a numeric value on the line.
    const declared = perApp[0]._aws?.CloudWatchMetrics as
      | Array<{ Metrics: Array<{ Name: string }> }>
      | undefined;
    const metricNames = declared?.[0]?.Metrics.map((metric) => metric.Name) ?? [];
    expect(metricNames).toHaveLength(6);
    for (const name of metricNames) expect(typeof perApp[0][name]).toBe('number');

    expect(lines.find((line) => line.ApplicationId === steady.id)).toMatchObject({
      GrowthAnomaly: 0,
      TrailingDailyBytes: 1_000,
      BytesAdded24h: 1_000,
    });

    const platform = lines.filter((line) => line.ApplicationId === undefined);
    expect(platform).toHaveLength(1);
    expect(platform[0]).toMatchObject({
      _aws: {
        CloudWatchMetrics: [
          {
            Namespace: 'Oxy/FileStorage',
            Dimensions: [[]],
            Metrics: expect.arrayContaining([
              { Name: 'ApplicationGrowthAnomalies', Unit: 'Count' },
            ]),
          },
        ],
      },
      ApplicationGrowthAnomalies: summary.anomalies.length,
      ApplicationsWithFiles: summary.applicationsWithFiles,
    });
    expect(platform[0].ApplicationGrowthAnomalies).toBeGreaterThanOrEqual(1);

    expect(mockError).toHaveBeenCalledWith(
      '[FileStorage] Application storage growth anomaly',
      expect.objectContaining({
        applicationId: loop.id,
        applicationName: loop.name,
        reasons: ['bytes_multiple'],
        bytesAdded24h: 5_000,
      }),
    );
    expect(
      mockError.mock.calls.some(
        ([, fields]) => (fields as { applicationId?: string }).applicationId === steady.id,
      ),
    ).toBe(false);
  });

  it('bounds the per-application lines, anomalies first, then the fastest-growing', () => {
    const now = new Date();
    const o = (id: string, bytesAdded24h: number, trailingDailyBytes: number) =>
      ({
        applicationId: id,
        applicationName: id,
        applicationType: 'first_party',
        applicationStatus: 'active',
        storedFiles: 1,
        storedBytes: 1,
        filesAdded24h: 1,
        bytesAdded24h,
        trailingDailyFiles: 1,
        trailingDailyBytes,
      }) satisfies ApplicationStorageObservation;
    const summary = publishApplicationStorageMetrics(
      [o('big-steady', 900_000, 900_000), o('anomalous', 2_000, 0), o('small', 10, 10)],
      { ...SMALL, maxApplications: 2 },
      now,
    );
    expect(summary.published).toEqual(['anomalous', 'big-steady']);
    expect(emfLines().filter((line) => line.ApplicationId !== undefined)).toHaveLength(2);
    // The platform line still counts everything observed.
    expect(emfLines().find((line) => line.ApplicationId === undefined)).toMatchObject({
      ApplicationsWithFiles: 3,
      ApplicationGrowthAnomalies: 1,
      observedApplications: 3,
    });
  });
});

describe('the lifecycle sweep carries the observation', () => {
  it('reports it, and a failed observation does not fail the run', async () => {
    const quietActions = {
      trashUnusedApplicationFile: async () => null,
      purgeTrashedApplicationFile: async () => false,
      purgeBlockedApplicationFile: async () => false,
      sweepStaleUpload: async () => 'not_due' as const,
      storedObjectExists: async () => false,
      unpublishTrashedFile: async () => false,
    };
    const summary = {
      applicationsWithFiles: 0,
      totalStoredBytes: 0,
      totalBytesAdded24h: 0,
      anomalies: [],
      published: [],
    };
    const observed = jest.fn(async () => summary);
    const report = await runFileLifecycleSweep({
      mode: 'report',
      force: true,
      actions: quietActions,
      observeStorage: observed,
    });
    expect(report?.storage).toBe(summary);
    expect(observed).toHaveBeenCalledWith(report?.startedAt);

    const failed = await runFileLifecycleSweep({
      mode: 'report',
      force: true,
      actions: quietActions,
      observeStorage: async () => {
        throw new Error('statement timeout');
      },
    });
    expect(failed).not.toBeNull();
    expect(failed?.storage).toBeNull();
    expect(mockError).toHaveBeenCalledWith(
      '[FileLifecycle] Storage observation failed; the next run measures again',
      expect.objectContaining({ sweepId: failed?.id, error: 'statement timeout' }),
    );
  });
});
