/**
 * Every periodic job this process runs, in one registry, so shutdown can stop
 * them BEFORE it closes the Postgres pool and Redis they use.
 *
 * Each sweep used to be its own `setInterval` (and four services each carried
 * a copy of the same no-overlap tick). Nothing cleared them on SIGTERM, so a
 * tick that fired, or a run already waiting on Redis, carried on after
 * `closePostgres()` and failed with "PostgreSQL is not connected" — eight
 * sweeps at once on the task oxy-api:826 replaced (2026-10-16 05:07:28Z). A
 * job here never overlaps itself, logs its failure under its own message, and
 * `stopPeriodicJobs()` clears every timer and waits for the runs in flight.
 */

import { logger } from './logger';

export interface PeriodicJob {
  /** Clears the timers and resolves once the run in flight, if any, has ended. */
  stop(): Promise<void>;
}

export interface PeriodicJobOptions {
  /** Logged with the error when a run fails; a run's failure is never thrown. */
  readonly failureMessage: string;
  readonly intervalMs: number;
  /** A first run sooner than one interval after start. */
  readonly firstRunDelayMs?: number;
  readonly run: () => Promise<void>;
}

const running = new Set<PeriodicJob>();

/** Run `run` every `intervalMs` (unref'd), never two at once, until stopped. */
export function schedulePeriodicJob(options: PeriodicJobOptions): PeriodicJob {
  let inFlight: Promise<void> | null = null;
  const tick = (): void => {
    if (inFlight !== null) return;
    inFlight = options
      .run()
      .catch((error: unknown) =>
        logger.error(
          options.failureMessage,
          error instanceof Error ? error : new Error(String(error)),
        ),
      )
      .finally(() => {
        inFlight = null;
      });
  };
  const first =
    options.firstRunDelayMs === undefined ? undefined : setTimeout(tick, options.firstRunDelayMs);
  const interval = setInterval(tick, options.intervalMs);
  first?.unref();
  interval.unref();
  const job: PeriodicJob = {
    async stop(): Promise<void> {
      if (first !== undefined) clearTimeout(first);
      clearInterval(interval);
      running.delete(job);
      await inFlight;
    },
  };
  running.add(job);
  return job;
}

/** Stop every registered job and wait for their runs in flight. Shutdown only. */
export async function stopPeriodicJobs(): Promise<void> {
  await Promise.all([...running].map((job) => job.stop()));
}
