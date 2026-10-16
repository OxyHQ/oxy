/**
 * Oxy's own applications are observed, not metered (ADR 0041 D2) — and a
 * third-party application's footprint is worth watching too.
 *
 * Every lifecycle sweep run (`fileLifecycle.worker.ts`: hourly, leased, one
 * task at a time) also measures, per application that owns files:
 *
 *  - what it STORES: its live rows (`active`, `trash`, `blocked`) and their
 *    renditions — exactly what `storageQuota.service.applicationStoredBytes`
 *    and the quota count;
 *  - what it ADDED in the 24 hours before the run, and on average per day in
 *    the {@link TRAILING_DAYS} days before that: originals plus renditions of
 *    the rows it created in each window, whatever became of them since (an
 *    import loop that deletes what it imported still shows).
 *
 * No table: both come from `files` (`owner_application_id`, `created_at`) at
 * the run's instant, so a missed run loses nothing.
 *
 * ## The growth anomaly
 *
 * An application's last 24 hours are ANOMALOUS when
 *
 *  - it added at least `FILE_STORAGE_GROWTH_DAILY_CAP_BYTES` (default 50 GiB):
 *    an absolute cap, whatever its history; or
 *  - it added more than `FILE_STORAGE_GROWTH_MULTIPLE` (default 5) times its
 *    trailing daily average, in bytes — and at least
 *    `FILE_STORAGE_GROWTH_MIN_BYTES` (default 1 GiB), so a small application
 *    going from 2 MB to 20 MB stays quiet — or in files, at least
 *    `FILE_STORAGE_GROWTH_MIN_FILES` (default 10,000).
 *
 * A new application has a trailing average of 0, so its first day above a
 * floor is an anomaly: that is the import loop of an application nobody has
 * seen grow before.
 *
 * ## What is published
 *
 * As CloudWatch metrics in the embedded metric format (namespace
 * {@link STORAGE_METRIC_NAMESPACE}), like the sweep's own `Oxy/FileLifecycle`:
 *
 *  - one line per application, dimension `ApplicationId`: `StoredBytes`,
 *    `StoredFiles`, `BytesAdded24h`, `FilesAdded24h`, `TrailingDailyBytes`,
 *    `GrowthAnomaly` (0 or 1). Cardinality is bounded: only applications that
 *    own files, at most `FILE_STORAGE_METRICS_MAX_APPLICATIONS` (default 100)
 *    of them — every anomalous one first, then the fastest-growing, then the
 *    largest;
 *  - one platform line, no dimension: `ApplicationsWithFiles`,
 *    `TotalStoredBytes`, `TotalBytesAdded24h` and `ApplicationGrowthAnomalies`
 *    — the one metric the alarm watches (oxy-infra; the spec is in ADR 0041,
 *    stage 4b), so no alarm has to be created per application.
 *
 * Each anomalous application is also an ERROR log line naming it, its type and
 * the numbers that tripped it, which is what the person paged reads first.
 */

import { sql } from 'drizzle-orm';
import { getEnvVar } from '../config/env';
import { type DatabaseOrTransaction, getDb } from '../config/postgres';
import { FILE_LIVE_STATUS_SQL_LIST } from '../db/schema/files';
import { logger } from '../utils/logger';

export const STORAGE_METRIC_NAMESPACE = 'Oxy/FileStorage';

const DAY_MS = 24 * 60 * 60 * 1000;
const GIB = 1024 * 1024 * 1024;

/** Days before the last 24 hours that make up an application's trailing average. */
export const TRAILING_DAYS = 7;

export interface GrowthThresholds {
  /** The last 24 hours exceed this multiple of the trailing daily average. */
  multiple: number;
  /** …and added at least this many bytes (the multiple's floor, bytes). */
  minBytes: number;
  /** …or at least this many files (the multiple's floor, files). */
  minFiles: number;
  /** Anomalous whatever the history: at least this many bytes in 24 hours. */
  dailyCapBytes: number;
  /** At most this many per-application metric lines per run. */
  maxApplications: number;
}

export const DEFAULT_GROWTH_THRESHOLDS: GrowthThresholds = {
  multiple: 5,
  minBytes: GIB,
  minFiles: 10_000,
  dailyCapBytes: 50 * GIB,
  maxApplications: 100,
};

/** A positive finite number from the environment, or the default (logged when unusable). */
function positiveEnv(key: string, fallback: number): number {
  const raw = getEnvVar(key, '').trim();
  if (raw === '') return fallback;
  const value = Number(raw);
  if (Number.isFinite(value) && value > 0) return value;
  logger.error('[FileStorage] Unusable threshold; using the default', {
    key,
    value: raw,
    default: fallback,
  });
  return fallback;
}

/** The configured thresholds (`FILE_STORAGE_GROWTH_*`, `FILE_STORAGE_METRICS_MAX_APPLICATIONS`). */
export function growthThresholdsFromEnv(): GrowthThresholds {
  const d = DEFAULT_GROWTH_THRESHOLDS;
  return {
    multiple: positiveEnv('FILE_STORAGE_GROWTH_MULTIPLE', d.multiple),
    minBytes: positiveEnv('FILE_STORAGE_GROWTH_MIN_BYTES', d.minBytes),
    minFiles: positiveEnv('FILE_STORAGE_GROWTH_MIN_FILES', d.minFiles),
    dailyCapBytes: positiveEnv('FILE_STORAGE_GROWTH_DAILY_CAP_BYTES', d.dailyCapBytes),
    maxApplications: Math.floor(
      positiveEnv('FILE_STORAGE_METRICS_MAX_APPLICATIONS', d.maxApplications),
    ),
  };
}

/** One application's footprint at the run's instant. */
export interface ApplicationStorageObservation {
  applicationId: string;
  applicationName: string;
  applicationType: string;
  applicationStatus: string;
  storedFiles: number;
  storedBytes: number;
  /** Rows created in the 24 hours before the run, and their bytes. */
  filesAdded24h: number;
  bytesAdded24h: number;
  /** Per-day average over the {@link TRAILING_DAYS} days before those 24 hours. */
  trailingDailyFiles: number;
  trailingDailyBytes: number;
}

export type GrowthAnomalyReason = 'daily_cap' | 'bytes_multiple' | 'files_multiple';

export interface GrowthVerdict {
  anomalous: boolean;
  reasons: GrowthAnomalyReason[];
}

/** Whether an application's last 24 hours are a growth anomaly (see the module header). */
export function evaluateGrowth(
  observation: Pick<
    ApplicationStorageObservation,
    'bytesAdded24h' | 'filesAdded24h' | 'trailingDailyBytes' | 'trailingDailyFiles'
  >,
  thresholds: GrowthThresholds,
): GrowthVerdict {
  const reasons: GrowthAnomalyReason[] = [];
  if (observation.bytesAdded24h >= thresholds.dailyCapBytes) reasons.push('daily_cap');
  if (
    observation.bytesAdded24h >= thresholds.minBytes &&
    observation.bytesAdded24h > thresholds.multiple * observation.trailingDailyBytes
  ) {
    reasons.push('bytes_multiple');
  }
  if (
    observation.filesAdded24h >= thresholds.minFiles &&
    observation.filesAdded24h > thresholds.multiple * observation.trailingDailyFiles
  ) {
    reasons.push('files_multiple');
  }
  return { anomalous: reasons.length > 0, reasons };
}

/** A row's bytes as the quota counts them: the original plus every rendition. */
const ROW_BYTES = sql.raw(
  `(f.size + coalesce((select sum(v.size) from file_variants v where v.file_id = f.id), 0))`,
);

/**
 * Every application that owns a live file or created one in the trailing
 * window, measured at `now`. One statement per measure; nothing is written.
 */
export async function observeApplicationStorage(
  now: Date,
  db: DatabaseOrTransaction = getDb(),
): Promise<ApplicationStorageObservation[]> {
  // Raw SQL binds no `Date`: each instant goes as ISO text, cast once.
  const at = (instant: Date) => sql`${instant.toISOString()}::timestamptz`;
  const until = at(now);
  const dayStart = at(new Date(now.getTime() - DAY_MS));
  const windowStart = at(new Date(now.getTime() - (TRAILING_DAYS + 1) * DAY_MS));

  const stored = await db.execute<{ application_id: string; files: string; bytes: string }>(sql`
    select f.owner_application_id as application_id,
           count(*) as files,
           coalesce(sum(${ROW_BYTES}), 0) as bytes
      from files f
     where f.owner_application_id is not null
       and f.status in (${sql.raw(FILE_LIVE_STATUS_SQL_LIST)})
     group by f.owner_application_id`);

  // Every status: what an application ADDED, whatever became of it since.
  const added = await db.execute<{
    application_id: string;
    recent_files: string;
    recent_bytes: string;
    trailing_files: string;
    trailing_bytes: string;
  }>(sql`
    select f.owner_application_id as application_id,
           count(*) filter (where f.created_at >= ${dayStart}) as recent_files,
           coalesce(sum(${ROW_BYTES}) filter (where f.created_at >= ${dayStart}), 0) as recent_bytes,
           count(*) filter (where f.created_at < ${dayStart}) as trailing_files,
           coalesce(sum(${ROW_BYTES}) filter (where f.created_at < ${dayStart}), 0) as trailing_bytes
      from files f
     where f.owner_application_id is not null
       and f.created_at >= ${windowStart}
       and f.created_at < ${until}
     group by f.owner_application_id`);

  const byId = new Map<string, ApplicationStorageObservation>();
  const entry = (applicationId: string): ApplicationStorageObservation => {
    let found = byId.get(applicationId);
    if (!found) {
      found = {
        applicationId,
        applicationName: '',
        applicationType: '',
        applicationStatus: '',
        storedFiles: 0,
        storedBytes: 0,
        filesAdded24h: 0,
        bytesAdded24h: 0,
        trailingDailyFiles: 0,
        trailingDailyBytes: 0,
      };
      byId.set(applicationId, found);
    }
    return found;
  };
  // postgres.js decodes `count`/`sum` (int8/numeric) as strings.
  for (const row of stored) {
    const o = entry(row.application_id);
    o.storedFiles = Number(row.files);
    o.storedBytes = Number(row.bytes);
  }
  for (const row of added) {
    const o = entry(row.application_id);
    o.filesAdded24h = Number(row.recent_files);
    o.bytesAdded24h = Number(row.recent_bytes);
    o.trailingDailyFiles = Number(row.trailing_files) / TRAILING_DAYS;
    o.trailingDailyBytes = Number(row.trailing_bytes) / TRAILING_DAYS;
  }
  if (byId.size === 0) return [];

  const ids = [...byId.keys()];
  const apps = await db.execute<{ id: string; name: string; type: string; status: string }>(sql`
    select id, name, type, status from applications
     where id in (${sql.join(
       ids.map((id) => sql`${id}`),
       sql`, `,
     )})`);
  for (const app of apps) {
    const o = byId.get(app.id);
    if (!o) continue;
    o.applicationName = app.name;
    o.applicationType = app.type;
    o.applicationStatus = app.status;
  }
  return [...byId.values()].sort((a, b) => a.applicationId.localeCompare(b.applicationId));
}

/** What one run published. */
export interface ApplicationStorageSummary {
  applicationsWithFiles: number;
  totalStoredBytes: number;
  totalBytesAdded24h: number;
  /** The applications whose last 24 hours are anomalous, with why. */
  anomalies: Array<{ applicationId: string; reasons: GrowthAnomalyReason[] }>;
  /** The applications given a metric line of their own (bounded). */
  published: string[];
}

/**
 * Publish one run's observations (see the module header): one EMF line per
 * application (bounded), one platform line, and an ERROR line per anomaly.
 */
export function publishApplicationStorageMetrics(
  observations: readonly ApplicationStorageObservation[],
  thresholds: GrowthThresholds,
  now: Date,
): ApplicationStorageSummary {
  const judged = observations.map((observation) => ({
    observation,
    verdict: evaluateGrowth(observation, thresholds),
  }));
  const ranked = [...judged].sort(
    (a, b) =>
      Number(b.verdict.anomalous) - Number(a.verdict.anomalous) ||
      b.observation.bytesAdded24h - a.observation.bytesAdded24h ||
      b.observation.storedBytes - a.observation.storedBytes ||
      a.observation.applicationId.localeCompare(b.observation.applicationId),
  );
  const published = ranked.slice(0, Math.max(thresholds.maxApplications, 0));
  const timestamp = now.getTime();

  for (const { observation: o, verdict } of published) {
    logger.info('[FileStorage] Application storage', {
      _aws: {
        Timestamp: timestamp,
        CloudWatchMetrics: [
          {
            Namespace: STORAGE_METRIC_NAMESPACE,
            Dimensions: [['ApplicationId']],
            Metrics: [
              { Name: 'StoredBytes', Unit: 'Bytes' },
              { Name: 'StoredFiles', Unit: 'Count' },
              { Name: 'BytesAdded24h', Unit: 'Bytes' },
              { Name: 'FilesAdded24h', Unit: 'Count' },
              { Name: 'TrailingDailyBytes', Unit: 'Bytes' },
              { Name: 'GrowthAnomaly', Unit: 'Count' },
            ],
          },
        ],
      },
      ApplicationId: o.applicationId,
      applicationType: o.applicationType,
      StoredBytes: o.storedBytes,
      StoredFiles: o.storedFiles,
      BytesAdded24h: o.bytesAdded24h,
      FilesAdded24h: o.filesAdded24h,
      TrailingDailyBytes: Math.round(o.trailingDailyBytes),
      GrowthAnomaly: verdict.anomalous ? 1 : 0,
    });
  }

  const anomalies = judged.filter(({ verdict }) => verdict.anomalous);
  for (const { observation: o, verdict } of anomalies) {
    logger.error('[FileStorage] Application storage growth anomaly', {
      applicationId: o.applicationId,
      applicationName: o.applicationName,
      applicationType: o.applicationType,
      applicationStatus: o.applicationStatus,
      reasons: verdict.reasons,
      bytesAdded24h: o.bytesAdded24h,
      filesAdded24h: o.filesAdded24h,
      trailingDailyBytes: Math.round(o.trailingDailyBytes),
      trailingDailyFiles: Math.round(o.trailingDailyFiles),
      storedBytes: o.storedBytes,
      thresholds,
    });
  }

  const summary: ApplicationStorageSummary = {
    applicationsWithFiles: observations.filter((o) => o.storedFiles > 0).length,
    totalStoredBytes: observations.reduce((sum, o) => sum + o.storedBytes, 0),
    totalBytesAdded24h: observations.reduce((sum, o) => sum + o.bytesAdded24h, 0),
    anomalies: anomalies.map(({ observation, verdict }) => ({
      applicationId: observation.applicationId,
      reasons: verdict.reasons,
    })),
    published: published.map(({ observation }) => observation.applicationId),
  };

  logger.info('[FileStorage] Applications storage observed', {
    _aws: {
      Timestamp: timestamp,
      CloudWatchMetrics: [
        {
          Namespace: STORAGE_METRIC_NAMESPACE,
          Dimensions: [[]],
          Metrics: [
            { Name: 'ApplicationsWithFiles', Unit: 'Count' },
            { Name: 'TotalStoredBytes', Unit: 'Bytes' },
            { Name: 'TotalBytesAdded24h', Unit: 'Bytes' },
            { Name: 'ApplicationGrowthAnomalies', Unit: 'Count' },
          ],
        },
      ],
    },
    ApplicationsWithFiles: summary.applicationsWithFiles,
    TotalStoredBytes: summary.totalStoredBytes,
    TotalBytesAdded24h: summary.totalBytesAdded24h,
    ApplicationGrowthAnomalies: summary.anomalies.length,
    publishedApplications: summary.published.length,
    observedApplications: observations.length,
  });
  return summary;
}

/** Measure and publish at `now`. Called by the lifecycle sweep after its steps. */
export async function observeAndPublishApplicationStorage(
  now: Date,
  thresholds: GrowthThresholds = growthThresholdsFromEnv(),
): Promise<ApplicationStorageSummary> {
  return publishApplicationStorageMetrics(await observeApplicationStorage(now), thresholds, now);
}
