/**
 * The file lifecycle sweep (ADR 0043 D5): what Oxy collects, and what it never
 * touches.
 *
 * | Step | Condition | Action (`enforce`) |
 * |---|---|---|
 * | `deletedApplications` | a `deleted` APPLICATION that still owns live files or holds references (deleted before D8 shipped) | ADR 0043 D8, as the console's delete runs it |
 * | `purge` | an APPLICATION's file in trash for 30 days | tombstone + purge through `storage_object_deletions` |
 * | `purgeBlocked` | an APPLICATION's blocked file (D10) unused for 30 days, no open claim holding it | tombstone + purge |
 * | `trash` | an APPLICATION's active file unreferenced for 24 hours | trash, off the CDN |
 * | `staleUploads` | an ACCOUNT's `/assets/init` upload never completed, 24 h old, NO object | tombstone (nothing to purge but the row) |
 * | `unpublishTrashed` | a public file in trash or blocked still under `public/` | move its objects off the CDN |
 *
 * Never acted on, in any mode: an ACCOUNT's file because it is unused (it is
 * only marked *not in use*, `unreferenced_since`; its person decides), an
 * account's trash (no expiry), and the platform namespaces (`system_owner`:
 * the federation caches and stickers keep their own rules).
 *
 * ## Modes — `FILE_LIFECYCLE_MODE`
 *
 * - `off`: the sweep does not run.
 * - `report` (DEFAULT): every run counts what each step is due to act on and
 *   names up to {@link SAMPLE_SIZE} files per step, in `file_lifecycle_sweeps`
 *   (`GET /assets/admin/lifecycle/sweeps`, staff) and as a log line with
 *   CloudWatch metrics — and acts on NOTHING. Migration 0172 back-filled
 *   `unreferenced_since` on every existing file, so the first runs report the
 *   whole backlog; that is what an operator reviews before switching.
 * - `enforce`: also acts, at most {@link DEFAULT_BATCH_SIZE} files per step per
 *   run. ADR 0043, "Switching the sweep to enforce", says when and how.
 *
 * ## Safety
 *
 * Every action is ONE conditional write that re-checks the step's whole
 * condition at the instant it acts (`fileRepository.fileLifecyclePredicate`):
 * a reference, a restore or a re-upload that lands after a candidate was listed
 * keeps the file. The reference check reads `file_references` (and mail
 * attachments, store screenshots) itself, so `unreferenced_since` only orders
 * the work and can never make a referenced file collectable.
 *
 * ## One sweeper, a schedule, backoff
 *
 * Every API task runs this timer; `file_lifecycle_sweeps` decides which one
 * sweeps. A run is claimed under a transaction-scoped advisory lock by
 * inserting a `running` row with a lease; the next is due
 * {@link DEFAULT_INTERVAL_MS} after the last completed one, or after an
 * exponential backoff (5 minutes doubling, capped at 6 hours) on consecutive
 * failures. A task that dies mid-run leaves a `running` row whose lease the next
 * claim retires as `abandoned`. The lease is renewed between steps.
 *
 * Time is injected (`now`), so a test sweeps "25 hours later" without waiting.
 *
 * ## The storage observation (ADR 0043 D2)
 *
 * After its steps, every run (either mode — it acts on nothing) measures what
 * each application stores and added in the last 24 hours, publishes it as
 * `Oxy/FileStorage` metrics and flags a growth anomaly
 * (`applicationStorageObservation.ts`). It rides this lease and schedule, so
 * exactly one task measures, once an interval; `FILE_LIFECYCLE_MODE=off` stops
 * it too. A failure to observe is logged and never fails the sweep.
 */

import { randomBytes } from 'node:crypto';
import { hostname } from 'node:os';
import { and, desc, eq, inArray, lte, sql } from 'drizzle-orm';
import { getEnvNumber, getEnvVar } from '../config/env';
import { getDb } from '../config/postgres';
import {
  type DeletedApplicationSample,
  type FileLifecycleSample,
  type FileLifecycleStepCounts,
  type FileLifecycleSweepMode,
  fileLifecycleSweeps,
} from '../db/schema/fileLifecycleSweeps';
import { logger } from '../utils/logger';
import {
  type ApplicationStorageSummary,
  observeAndPublishApplicationStorage,
} from './applicationStorageObservation';
import {
  countDeletedApplicationsWithContent,
  type DeletedApplicationContent,
  type DeletedApplicationResidue,
  listDeletedApplicationsWithContent,
  purgeDeletedApplicationContent,
} from './applicationDeletion.service';
import { assetService } from './assetServiceSingleton';
import {
  countFileLifecycleCandidates,
  type FileLifecycleCandidate,
  type FileLifecycleStep,
  listFileLifecycleCandidates,
} from './fileRepository';

export type FileLifecycleMode = 'off' | FileLifecycleSweepMode;

export const FILE_LIFECYCLE_MODES: readonly FileLifecycleMode[] = ['off', 'report', 'enforce'];

/** Files acted on per step per run in `enforce`. */
export const DEFAULT_BATCH_SIZE = 200;
/**
 * Deleted applications cleaned per run in `enforce`: each is ONE transaction
 * over everything it left (as the console's delete is), so they are few.
 */
export const DELETED_APPLICATIONS_PER_RUN = 10;
/** Files named per step in a report. */
export const SAMPLE_SIZE = 100;
/** A run is due this long after the last completed one. */
export const DEFAULT_INTERVAL_MS = 60 * 60 * 1000;
/** How often each task asks whether a run is due. */
const DEFAULT_POLL_INTERVAL_MS = 5 * 60 * 1000;
/** A run's lease; renewed between steps. */
export const SWEEP_LEASE_MS = 15 * 60 * 1000;
const BASE_BACKOFF_MS = 5 * 60 * 1000;
const MAX_BACKOFF_MS = 6 * 60 * 60 * 1000;
const MAX_RECORDED_ERROR_LENGTH = 500;
const METRIC_NAMESPACE = 'Oxy/FileLifecycle';

/** A step of a run: the per-file steps, and the per-application clean-up. */
export type FileLifecycleSweepStep = 'deletedApplications' | FileLifecycleStep;

/**
 * Enforce order: a deleted application's content first (its developer asked
 * for that long ago; it also leaves the per-file steps nothing of it to
 * trash), then what has waited 30 days before what has waited 24 hours.
 */
export const FILE_LIFECYCLE_STEPS: readonly FileLifecycleSweepStep[] = [
  'deletedApplications',
  'purge',
  'purgeBlocked',
  'trash',
  'staleUploads',
  'unpublishTrashed',
];

/**
 * The configured mode. An unrecognised value is `report` — the mode that acts
 * on nothing — and says so, never a silent `enforce`.
 */
export function fileLifecycleMode(): FileLifecycleMode {
  const raw = getEnvVar('FILE_LIFECYCLE_MODE', 'report').trim().toLowerCase();
  if ((FILE_LIFECYCLE_MODES as readonly string[]).includes(raw)) return raw as FileLifecycleMode;
  logger.error('[FileLifecycle] Unrecognised FILE_LIFECYCLE_MODE; running in report mode', {
    value: raw,
    accepted: FILE_LIFECYCLE_MODES,
  });
  return 'report';
}

/** Delay before the next attempt after `failures` consecutive failed runs. */
export function fileLifecycleBackoffMs(failures: number): number {
  const exponent = Math.max(failures - 1, 0);
  return Math.min(BASE_BACKOFF_MS * 2 ** Math.min(exponent, 20), MAX_BACKOFF_MS);
}

/** What the sweep acts through: `assetService`, narrowed (a seam for tests). */
export interface FileLifecycleActions {
  trashUnusedApplicationFile(fileId: string, now: Date): Promise<unknown | null>;
  purgeTrashedApplicationFile(fileId: string, now: Date): Promise<boolean>;
  purgeBlockedApplicationFile(fileId: string, now: Date): Promise<boolean>;
  sweepStaleUpload(fileId: string, now: Date): Promise<'tombstoned' | 'has_object' | 'not_due'>;
  storedObjectExists(fileId: string): Promise<boolean>;
  unpublishTrashedFile(fileId: string): Promise<boolean>;
  /**
   * ADR 0043 D8 on an application already `deleted`, committed and then
   * finished (CDN, cache, the purge started); `null` when it is not deleted.
   */
  purgeDeletedApplication(applicationId: string): Promise<DeletedApplicationContent | null>;
}

export interface FileLifecycleSweepOptions {
  mode: FileLifecycleSweepMode;
  ownerId?: string;
  now?: () => Date;
  batchSize?: number;
  intervalMs?: number;
  leaseMs?: number;
  /** Skip the schedule (not the lease): an operator's run, and tests. */
  force?: boolean;
  actions?: FileLifecycleActions;
  /** The storage observation (ADR 0043 D2); a seam for tests. */
  observeStorage?: (now: Date) => Promise<ApplicationStorageSummary>;
}

/** Per step, what a report names: files, or (for `deletedApplications`) applications. */
export type FileLifecycleSamples = Record<FileLifecycleStep, FileLifecycleSample[]> & {
  deletedApplications: DeletedApplicationSample[];
};

export interface FileLifecycleSweepReport {
  id: string;
  mode: FileLifecycleSweepMode;
  startedAt: Date;
  counts: Record<FileLifecycleSweepStep, FileLifecycleStepCounts>;
  samples: FileLifecycleSamples;
  /** What the storage observation published, or `null` when it failed (logged). */
  storage: ApplicationStorageSummary | null;
}

const WORKER_OWNER_ID = `${hostname()}:${process.pid}:${randomBytes(4).toString('hex')}`;
/** Arbitrary but fixed: the claim's advisory lock. */
const CLAIM_LOCK_NAME = 'oxy:file-lifecycle-sweep';

/**
 * Claim the next run, or `null` when it is not due or another task holds one.
 * One transaction under an advisory lock, so two tasks can never both insert.
 */
export async function claimFileLifecycleSweep(
  options: Pick<FileLifecycleSweepOptions, 'mode' | 'ownerId' | 'force' | 'intervalMs' | 'leaseMs'>,
  now: Date,
): Promise<{ id: string; startedAt: Date } | null> {
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  const leaseMs = options.leaseMs ?? SWEEP_LEASE_MS;
  return getDb().transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${CLAIM_LOCK_NAME}))`);

    // A task that died mid-run: its lease ran out.
    await tx
      .update(fileLifecycleSweeps)
      .set({ status: 'abandoned', finishedAt: now })
      .where(
        and(
          eq(fileLifecycleSweeps.status, 'running'),
          lte(fileLifecycleSweeps.leaseExpiresAt, now),
        ),
      );
    const [running] = await tx
      .select({ id: fileLifecycleSweeps.id })
      .from(fileLifecycleSweeps)
      .where(eq(fileLifecycleSweeps.status, 'running'))
      .limit(1);
    if (running) return null;

    if (!options.force) {
      const recent = await tx
        .select({
          status: fileLifecycleSweeps.status,
          startedAt: fileLifecycleSweeps.startedAt,
          finishedAt: fileLifecycleSweeps.finishedAt,
        })
        .from(fileLifecycleSweeps)
        .where(inArray(fileLifecycleSweeps.status, ['completed', 'failed']))
        .orderBy(desc(fileLifecycleSweeps.startedAt))
        .limit(20);
      const last = recent[0];
      if (last?.status === 'completed' && now.getTime() - last.startedAt.getTime() < intervalMs) {
        return null;
      }
      if (last?.status === 'failed') {
        const failures = recent.findIndex((run) => run.status !== 'failed');
        const consecutive = failures === -1 ? recent.length : failures;
        const since = (last.finishedAt ?? last.startedAt).getTime();
        if (now.getTime() - since < fileLifecycleBackoffMs(consecutive)) return null;
      }
    }

    const [claimed] = await tx
      .insert(fileLifecycleSweeps)
      .values({
        mode: options.mode,
        status: 'running',
        claimedBy: options.ownerId ?? WORKER_OWNER_ID,
        leaseExpiresAt: new Date(now.getTime() + leaseMs),
        startedAt: now,
      })
      .returning({ id: fileLifecycleSweeps.id, startedAt: fileLifecycleSweeps.startedAt });
    return claimed ?? null;
  });
}

function sample(step: FileLifecycleStep, candidate: FileLifecycleCandidate): FileLifecycleSample {
  return {
    fileId: candidate.id,
    ...(step === 'staleUploads' || step === 'unpublishTrashed'
      ? { ownerUserId: candidate.ownerUserId }
      : {}),
    ownerApplicationId: candidate.ownerApplicationId,
    size: candidate.size,
    since: candidate.since ? candidate.since.toISOString() : null,
  };
}

function describeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.length > MAX_RECORDED_ERROR_LENGTH
    ? `${message.slice(0, MAX_RECORDED_ERROR_LENGTH)}…`
    : message;
}

function applicationSample(residue: DeletedApplicationResidue): DeletedApplicationSample {
  return {
    applicationId: residue.applicationId,
    files: residue.files,
    bytes: residue.bytes,
    references: residue.references,
    since: residue.since ? residue.since.toISOString() : null,
  };
}

/**
 * The `deletedApplications` step: count the deleted applications that still
 * have content (and how many files and references in all), name them, and —
 * in `enforce` — run D8 on up to {@link DELETED_APPLICATIONS_PER_RUN}.
 */
async function runDeletedApplicationsStep(
  mode: FileLifecycleSweepMode,
  batchSize: number,
  actions: FileLifecycleActions,
): Promise<{ counts: FileLifecycleStepCounts; samples: DeletedApplicationSample[] }> {
  const due = await countDeletedApplicationsWithContent();
  const residues =
    due.applications === 0
      ? []
      : await listDeletedApplicationsWithContent(
          mode === 'enforce' ? Math.min(batchSize, DELETED_APPLICATIONS_PER_RUN) : SAMPLE_SIZE,
        );
  const counts: FileLifecycleStepCounts = {
    due: due.applications,
    acted: 0,
    skipped: 0,
    failed: 0,
    files: due.files,
    references: due.references,
    filesDeleted: 0,
    referencesRemoved: 0,
  };
  const samples = residues.slice(0, SAMPLE_SIZE).map(applicationSample);
  if (mode === 'report') return { counts, samples };

  for (const residue of residues) {
    try {
      const content = await actions.purgeDeletedApplication(residue.applicationId);
      if (content && (content.files.length > 0 || content.referencesRemoved > 0)) {
        counts.acted += 1;
        counts.filesDeleted += content.files.length;
        counts.referencesRemoved += content.referencesRemoved;
        logger.info('[FileLifecycle] Deleted application content removed (ADR 0043 D8)', {
          applicationId: residue.applicationId,
          filesDeleted: content.files.length,
          referencesRemoved: content.referencesRemoved,
        });
      } else {
        counts.skipped += 1;
      }
    } catch (error) {
      counts.failed += 1;
      logger.warn('[FileLifecycle] Deleted application clean-up failed; the next run retries it', {
        applicationId: residue.applicationId,
        error: describeError(error),
      });
    }
  }
  return { counts, samples };
}

/** Run one step at `now`: count, sample, and — in `enforce` — act on one batch. */
async function runStep(
  step: FileLifecycleStep,
  mode: FileLifecycleSweepMode,
  now: Date,
  batchSize: number,
  actions: FileLifecycleActions,
): Promise<{ counts: FileLifecycleStepCounts; samples: FileLifecycleSample[] }> {
  const due = await countFileLifecycleCandidates(step, now);
  const candidates = due === 0 ? [] : await listFileLifecycleCandidates(step, now, batchSize);
  const counts: FileLifecycleStepCounts = { due, acted: 0, skipped: 0, failed: 0 };
  const samples = candidates.slice(0, SAMPLE_SIZE).map((candidate) => sample(step, candidate));

  if (step === 'staleUploads') {
    // Whether a stale upload holds an object is the store's answer: only one
    // that holds NONE is collected. Reported for the batch examined.
    counts.withObject = 0;
    counts.withoutObject = 0;
  }

  for (const candidate of candidates) {
    try {
      if (mode === 'report') {
        if (step === 'staleUploads') {
          if (await actions.storedObjectExists(candidate.id)) counts.withObject += 1;
          else counts.withoutObject += 1;
        }
        continue;
      }
      let acted = false;
      switch (step) {
        case 'purge':
          acted = await actions.purgeTrashedApplicationFile(candidate.id, now);
          break;
        case 'purgeBlocked':
          acted = await actions.purgeBlockedApplicationFile(candidate.id, now);
          break;
        case 'trash':
          acted = (await actions.trashUnusedApplicationFile(candidate.id, now)) !== null;
          break;
        case 'staleUploads': {
          const outcome = await actions.sweepStaleUpload(candidate.id, now);
          if (outcome === 'has_object') counts.withObject += 1;
          else counts.withoutObject += outcome === 'tombstoned' ? 1 : 0;
          acted = outcome === 'tombstoned';
          break;
        }
        case 'unpublishTrashed':
          acted = await actions.unpublishTrashedFile(candidate.id);
          break;
      }
      if (acted) counts.acted += 1;
      else counts.skipped += 1;
    } catch (error) {
      counts.failed += 1;
      logger.warn('[FileLifecycle] Action failed; the next run retries it', {
        step,
        fileId: candidate.id,
        error: describeError(error),
      });
    }
  }
  return { counts, samples };
}

const defaultActions: FileLifecycleActions = {
  trashUnusedApplicationFile: (fileId, now) => assetService.trashUnusedApplicationFile(fileId, now),
  purgeTrashedApplicationFile: (fileId, now) =>
    assetService.purgeTrashedApplicationFile(fileId, now),
  purgeBlockedApplicationFile: (fileId, now) =>
    assetService.purgeBlockedApplicationFile(fileId, now),
  sweepStaleUpload: (fileId, now) => assetService.sweepStaleUpload(fileId, now),
  storedObjectExists: (fileId) => assetService.storedObjectExists(fileId),
  unpublishTrashedFile: (fileId) => assetService.unpublishTrashedFile(fileId),
  purgeDeletedApplication: async (applicationId) => {
    const content = await purgeDeletedApplicationContent(applicationId);
    if (content) assetService.finishApplicationDeletion(content);
    return content;
  },
};

/** The run as CloudWatch metrics (embedded metric format), one line. */
function publishMetrics(report: FileLifecycleSweepReport): void {
  const values: Record<string, number> = {};
  const metrics: { Name: string; Unit: 'Count' }[] = [];
  for (const step of FILE_LIFECYCLE_STEPS) {
    for (const field of ['due', 'acted', 'failed'] as const) {
      const name = `${step}${field[0].toUpperCase()}${field.slice(1)}`;
      values[name] = report.counts[step][field];
      metrics.push({ Name: name, Unit: 'Count' });
    }
  }
  logger.info('[FileLifecycle] Sweep finished', {
    _aws: {
      Timestamp: report.startedAt.getTime(),
      CloudWatchMetrics: [
        { Namespace: METRIC_NAMESPACE, Dimensions: [['Mode']], Metrics: metrics },
      ],
    },
    Mode: report.mode,
    sweepId: report.id,
    ...values,
  });
}

/**
 * One run: claim it, run every step at the run's instant, record the report.
 * `null` when no run was due or another task holds one.
 */
export async function runFileLifecycleSweep(
  options: FileLifecycleSweepOptions,
): Promise<FileLifecycleSweepReport | null> {
  const clock = options.now ?? (() => new Date());
  const now = clock();
  const claimed = await claimFileLifecycleSweep(options, now);
  if (!claimed) return null;

  const batchSize = Math.max(
    options.batchSize ?? getEnvNumber('FILE_LIFECYCLE_BATCH_SIZE', DEFAULT_BATCH_SIZE),
    1,
  );
  const leaseMs = options.leaseMs ?? SWEEP_LEASE_MS;
  const actions = options.actions ?? defaultActions;
  const counts = {} as Record<FileLifecycleSweepStep, FileLifecycleStepCounts>;
  const samples = {} as FileLifecycleSamples;
  const ownRow = and(
    eq(fileLifecycleSweeps.id, claimed.id),
    eq(fileLifecycleSweeps.status, 'running'),
  );

  try {
    for (const step of FILE_LIFECYCLE_STEPS) {
      if (step === 'deletedApplications') {
        const result = await runDeletedApplicationsStep(options.mode, batchSize, actions);
        counts[step] = result.counts;
        samples[step] = result.samples;
      } else {
        const result = await runStep(step, options.mode, now, batchSize, actions);
        counts[step] = result.counts;
        samples[step] = result.samples;
      }
      // Renew the lease and save progress: a long step must not read as dead.
      await getDb()
        .update(fileLifecycleSweeps)
        .set({ counts, samples, leaseExpiresAt: new Date(clock().getTime() + leaseMs) })
        .where(ownRow);
    }
    await getDb()
      .update(fileLifecycleSweeps)
      .set({ status: 'completed', finishedAt: clock(), counts, samples })
      .where(ownRow);
  } catch (error) {
    await getDb()
      .update(fileLifecycleSweeps)
      .set({ status: 'failed', finishedAt: clock(), counts, samples, error: describeError(error) })
      .where(ownRow);
    throw error;
  }

  // Observability rides the run (ADR 0043 D2): never a reason for it to fail.
  let storage: ApplicationStorageSummary | null = null;
  try {
    storage = await (options.observeStorage ?? observeAndPublishApplicationStorage)(now);
  } catch (error) {
    logger.error('[FileLifecycle] Storage observation failed; the next run measures again', {
      sweepId: claimed.id,
      error: describeError(error),
    });
  }

  const report: FileLifecycleSweepReport = {
    id: claimed.id,
    mode: options.mode,
    startedAt: claimed.startedAt,
    counts,
    samples,
    storage,
  };
  publishMetrics(report);
  return report;
}

/** The newest runs, for the staff report. */
export async function listFileLifecycleSweeps(limit: number) {
  return getDb()
    .select()
    .from(fileLifecycleSweeps)
    .orderBy(desc(fileLifecycleSweeps.startedAt))
    .limit(limit);
}

let timer: ReturnType<typeof setInterval> | null = null;
let tickInFlight = false;

async function tick(mode: FileLifecycleSweepMode): Promise<void> {
  if (tickInFlight) return;
  tickInFlight = true;
  try {
    await runFileLifecycleSweep({
      mode,
      intervalMs: getEnvNumber('FILE_LIFECYCLE_INTERVAL_MS', DEFAULT_INTERVAL_MS),
    });
  } catch (error) {
    logger.error(
      '[FileLifecycle] Sweep failed; backing off',
      error instanceof Error ? error : new Error(String(error)),
    );
  } finally {
    tickInFlight = false;
  }
}

/**
 * Start polling. `report` by default (ADR 0043: the sweep acts only after a
 * week of reviewed reports); `FILE_LIFECYCLE_MODE=off` does not start it.
 */
export function startFileLifecycleWorker(): boolean {
  const mode = fileLifecycleMode();
  if (mode === 'off') {
    logger.info('[FileLifecycle] Sweep off (FILE_LIFECYCLE_MODE=off)');
    return false;
  }
  if (timer) return true;
  const intervalMs = Math.max(
    getEnvNumber('FILE_LIFECYCLE_POLL_INTERVAL_MS', DEFAULT_POLL_INTERVAL_MS),
    1000,
  );
  timer = setInterval(() => void tick(mode), intervalMs);
  timer.unref?.();
  void tick(mode);
  logger.info('[FileLifecycle] Sweep started', { mode, ownerId: WORKER_OWNER_ID, intervalMs });
  return true;
}

export function stopFileLifecycleWorker(): void {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
}
