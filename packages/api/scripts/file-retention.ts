/**
 * The file retention pass: remove the rows the shared database keeps for files
 * that no longer need them. Mechanism and safety rules:
 * `src/services/fileRetention.service.ts`.
 *
 *   bun run packages/api/scripts/file-retention.ts                     # dry run (report)
 *   bun run packages/api/scripts/file-retention.ts --apply \
 *     --confirm=delete-file-retention-rows                             # delete
 *
 * Steps (`--steps=a,b`; default `tombstoneRenditions,unusedRenditions`):
 *   tombstoneRenditions     variant and source rows of tombstoned files
 *   unusedRenditions        all but one ladder rendition row of images unused for --unused-days
 *   federationCacheExpiry   federation media-cache entries cached more than --cache-ttl-days ago
 *                           (opt-in: Mention must treat a missing cache object as evicted first)
 *
 * Options: `--unused-days=<n>` (default 30, min 7), `--cache-ttl-days=<n>`
 * (default 90, min 30), `--scan-window=<n>` file ids examined per batch
 * (default 2000, 100-10000), `--after=<file id>` to resume, `--max-batches=<n>`
 * for a bounded run, `--window=<start>-<end>` UTC hours to run in (default
 * `1-7`; `any` for no window), `--pause-ms=<n>` between batches (default 250),
 * `--slow-batch-ms=<n>` (default 2000: a slower batch halves the window and
 * pauses; five in a row stop the run), `--sample=<n>` per-file lines to print
 * (default 200; the summary counts every file).
 *
 * Prints one JSON line per file selected (up to --sample), a `{"progress": …}`
 * line every 25 batches, and a final `{"summary": …}`. Their `lastFileId`
 * resumes an unfinished run (`--after`). Nothing is written without `--apply`,
 * and `--apply` without the confirmation phrase is refused. A second run
 * changes nothing that the first changed.
 *
 * In production it runs inside the VPC as an ECS one-shot:
 * `.github/workflows/file-retention.yml`.
 */
// Only the dependency-free options load before the arguments are valid: the
// service reaches the object store at import time, and a malformed command must
// fail on its arguments, not on a missing R2 binding.
import {
  DEFAULT_FILE_RETENTION_STEPS,
  FILE_RETENTION_CONFIRMATION,
  FILE_RETENTION_STEPS,
  type FileRetentionStep,
  MIN_CACHE_TTL_DAYS,
  MIN_SCAN_WINDOW,
  MIN_UNUSED_DAYS,
  type OffPeakWindow,
} from '../src/services/fileRetention.options';

function flag(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find((value) => value.startsWith(prefix))?.slice(prefix.length);
}

function boundedInt(
  name: string,
  fallback: number | undefined,
  min: number,
  max: number,
): number | undefined {
  const raw = flag(name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isInteger(value) || value < min || value > max) {
    throw new Error(`--${name} must be an integer between ${min} and ${max}`);
  }
  return value;
}

function parseSteps(raw: string | undefined): FileRetentionStep[] {
  if (raw === undefined) return [...DEFAULT_FILE_RETENTION_STEPS];
  const names = raw.split(',').map((name) => name.trim());
  const unknown = names.filter(
    (name) => !(FILE_RETENTION_STEPS as readonly string[]).includes(name),
  );
  if (unknown.length > 0 || names.length === 0) {
    throw new Error(`--steps must name steps among ${FILE_RETENTION_STEPS.join(', ')}`);
  }
  return names as FileRetentionStep[];
}

function parseWindow(raw: string | undefined): OffPeakWindow | null | undefined {
  if (raw === undefined) return undefined;
  if (raw === 'any') return null;
  const match = /^(\d{1,2})-(\d{1,2})$/.exec(raw);
  const startHour = Number(match?.[1]);
  const endHour = Number(match?.[2]);
  if (!match || startHour > 23 || endHour > 23 || startHour === endHour) {
    throw new Error('--window must be <start>-<end> in UTC hours (0-23, distinct), or any');
  }
  return { startHour, endHour };
}

/** `getRedisClient()` starts connecting; wait until it is ready, for at most 15 s. */
async function redisReady(): Promise<void> {
  const { getRedisClient } = await import('../src/config/redis.js');
  const redis = getRedisClient();
  if (!redis || redis.status === 'ready') return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Redis was not ready within 15 s')), 15_000);
    redis.once('ready', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

/** A progress line every this many batches. */
const PROGRESS_EVERY_BATCHES = 25;

const KNOWN_ARGUMENT =
  /^--(apply|(confirm|steps|unused-days|cache-ttl-days|scan-window|after|max-batches|window|pause-ms|slow-batch-ms|sample)=.*)$/;

async function main(): Promise<void> {
  // A misspelled option would otherwise be ignored, and a bounded run unbounded.
  const unknown = process.argv.slice(2).filter((value) => !KNOWN_ARGUMENT.test(value));
  if (unknown.length > 0) throw new Error(`unknown argument(s): ${unknown.join(' ')}`);
  if (flag('apply') !== undefined) throw new Error('--apply takes no value');
  const apply = process.argv.includes('--apply');
  // Refused before anything loads: an apply deletes production rows.
  if (apply && flag('confirm') !== FILE_RETENTION_CONFIRMATION) {
    throw new Error(
      `--apply deletes rows: confirm it with --confirm=${FILE_RETENTION_CONFIRMATION}`,
    );
  }
  const options = {
    apply,
    confirm: flag('confirm'),
    steps: parseSteps(flag('steps')),
    unusedDays: boundedInt('unused-days', undefined, MIN_UNUSED_DAYS, 3650),
    cacheTtlDays: boundedInt('cache-ttl-days', undefined, MIN_CACHE_TTL_DAYS, 3650),
    scanWindow: boundedInt('scan-window', undefined, MIN_SCAN_WINDOW, 10_000),
    after: flag('after'),
    maxBatches: boundedInt('max-batches', undefined, 1, 1_000_000),
    offPeakWindow: parseWindow(flag('window')),
    pauseMs: boundedInt('pause-ms', undefined, 0, 60_000),
    slowBatchMs: boundedInt('slow-batch-ms', undefined, 100, 600_000),
  };
  const sample = boundedInt('sample', 200, 0, 1_000_000) ?? 200;
  let printed = 0;
  const { closePostgres, connectPostgres } = await import('../src/config/postgres.js');
  const { closeRedis } = await import('../src/config/redis.js');
  const { flushCdnInvalidations } = await import('../src/services/cdnInvalidation.js');
  const { runFileRetention } = await import('../src/services/fileRetention.service.js');
  await connectPostgres();
  if (apply) {
    // Ready before any change, so the cross-task file-cache invalidation a
    // batch publishes reaches every API task (skipped while Redis is not ready).
    await redisReady();
  }
  try {
    const summary = await runFileRetention({
      ...options,
      emit: (record) => {
        if (printed >= sample) return;
        printed += 1;
        console.log(JSON.stringify(record));
      },
      progress: (totals) => {
        if (totals.batches % PROGRESS_EVERY_BATCHES === 0) {
          console.log(JSON.stringify({ progress: totals }));
        }
      },
    });
    console.log(JSON.stringify({ summary }));
  } finally {
    if (apply) {
      // An expired cache entry's CDN paths were queued; send them before exiting.
      await flushCdnInvalidations();
      await closeRedis();
    }
    await closePostgres();
  }
}

// Exit once stdout and stderr are flushed: as an ECS one-shot, a handle left
// open by an imported module would otherwise keep the task running.
void main()
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .then(async () => {
    await Promise.all(
      [process.stdout, process.stderr].map(
        (stream) => new Promise<void>((resolve) => stream.write('', () => resolve())),
      ),
    );
    process.exit(process.exitCode ?? 0);
  });
