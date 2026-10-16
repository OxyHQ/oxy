jest.mock('../logger', () => ({
  logger: { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

import { logger } from '../logger';
import { schedulePeriodicJob, stopPeriodicJobs } from '../periodicJobs';

/** A run the test resolves by hand, so "in flight" is a state it controls. */
function controllableRun() {
  const releases: Array<() => void> = [];
  const run = jest.fn(
    () =>
      new Promise<void>((resolve) => {
        releases.push(resolve);
      }),
  );
  return { run, release: () => releases.shift()?.() };
}

describe('schedulePeriodicJob', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(async () => {
    await stopPeriodicJobs();
    jest.useRealTimers();
    jest.clearAllMocks();
  });

  it('never runs a job twice at once', async () => {
    const { run, release } = controllableRun();
    schedulePeriodicJob({ failureMessage: 'job failed', intervalMs: 1_000, run });

    jest.advanceTimersByTime(3_000);
    expect(run).toHaveBeenCalledTimes(1);

    release();
    await Promise.resolve();
    await Promise.resolve();
    jest.advanceTimersByTime(1_000);
    expect(run).toHaveBeenCalledTimes(2);
    release();
  });

  it('stop() clears the timer and waits for the run in flight', async () => {
    const { run, release } = controllableRun();
    const job = schedulePeriodicJob({ failureMessage: 'job failed', intervalMs: 1_000, run });
    jest.advanceTimersByTime(1_000);

    let stopped = false;
    const stopping = job.stop().then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);

    release();
    await stopping;
    expect(stopped).toBe(true);
    jest.advanceTimersByTime(10_000);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('logs a failed run under its own message and keeps the schedule', async () => {
    const run = jest.fn().mockRejectedValueOnce(new Error('boom')).mockResolvedValue(undefined);
    schedulePeriodicJob({ failureMessage: 'Retention sweep failed', intervalMs: 1_000, run });

    jest.advanceTimersByTime(1_000);
    await Promise.resolve();
    await Promise.resolve();
    expect(logger.error).toHaveBeenCalledWith('Retention sweep failed', expect.any(Error));

    jest.advanceTimersByTime(1_000);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('runs first after firstRunDelayMs when one is given', () => {
    const run = jest.fn().mockResolvedValue(undefined);
    schedulePeriodicJob({
      failureMessage: 'job failed',
      intervalMs: 60_000,
      firstRunDelayMs: 1_000,
      run,
    });
    jest.advanceTimersByTime(1_000);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('stopPeriodicJobs() stops every registered job before shutdown closes their stores', async () => {
    const first = jest.fn().mockResolvedValue(undefined);
    const second = jest.fn().mockResolvedValue(undefined);
    schedulePeriodicJob({ failureMessage: 'a failed', intervalMs: 1_000, run: first });
    schedulePeriodicJob({ failureMessage: 'b failed', intervalMs: 1_000, run: second });

    await stopPeriodicJobs();
    jest.advanceTimersByTime(10_000);
    expect(first).not.toHaveBeenCalled();
    expect(second).not.toHaveBeenCalled();
  });
});
