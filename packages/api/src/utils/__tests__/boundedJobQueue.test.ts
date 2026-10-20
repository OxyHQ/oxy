const mockWarn = jest.fn();

jest.mock('../logger', () => ({
  logger: { debug: jest.fn(), info: jest.fn(), warn: (...args: unknown[]) => mockWarn(...args) },
}));

import { BoundedJobQueue } from '../boundedJobQueue';

/** A job the test finishes by hand. */
function job() {
  let finish: () => void = () => undefined;
  let fail: (error: Error) => void = () => undefined;
  const started = jest.fn();
  const run = () => {
    started();
    return new Promise<void>((resolve, reject) => {
      finish = resolve;
      fail = reject;
    });
  };
  return { run, started, finish: () => finish(), fail: (error: Error) => fail(error) };
}

/** Let every pending continuation run. */
const flush = () => new Promise((resolve) => setImmediate(resolve));

beforeEach(() => {
  jest.clearAllMocks();
});

describe('BoundedJobQueue', () => {
  it('runs at most maxConcurrent jobs, and the next as one finishes', async () => {
    const queue = new BoundedJobQueue({ name: 'Test', maxConcurrent: 2, maxQueueSize: 10 });
    const jobs = [job(), job(), job()];
    for (const j of jobs) queue.enqueue(j.run);

    await flush();
    expect(jobs.map((j) => j.started.mock.calls.length)).toEqual([1, 1, 0]);

    jobs[0].finish();
    await flush();
    expect(jobs[2].started).toHaveBeenCalledTimes(1);
  });

  it('refuses a job offered to a full queue, counting a burst enqueued in one turn whole', async () => {
    const queue = new BoundedJobQueue({ name: 'Test', maxConcurrent: 2, maxQueueSize: 2 });
    const jobs = [job(), job(), job()];

    expect(queue.enqueue(jobs[0].run)).not.toBeNull();
    expect(queue.enqueue(jobs[1].run)).not.toBeNull();
    // Nothing has started yet, so the queue holds two: the third is refused
    // even though two slots are about to free up.
    expect(queue.enqueue(jobs[2].run)).toBeNull();

    await flush();
    expect(jobs[2].started).not.toHaveBeenCalled();
    // Once the burst has started, there is room again.
    expect(queue.enqueue(job().run)).not.toBeNull();
  });

  it('settles a job`s promise when it ends, logging a failure instead of rejecting', async () => {
    const queue = new BoundedJobQueue({ name: 'Test', maxConcurrent: 1, maxQueueSize: 10 });
    const failing = job();
    const done = queue.enqueue(failing.run);
    await flush();
    failing.fail(new Error('upstream down'));

    await expect(done).resolves.toBeUndefined();
    expect(mockWarn).toHaveBeenCalledWith('Test job failed', { error: 'upstream down' });
  });

  it('catches a job that throws before its first await', async () => {
    const queue = new BoundedJobQueue({ name: 'Test', maxConcurrent: 1, maxQueueSize: 10 });
    const done = queue.enqueue(() => {
      throw new Error('synchronous');
    });
    await expect(done).resolves.toBeUndefined();
    expect(mockWarn).toHaveBeenCalledWith('Test job failed', { error: 'synchronous' });

    // The slot it held is free again.
    const next = job();
    queue.enqueue(next.run);
    await flush();
    expect(next.started).toHaveBeenCalledTimes(1);
  });
});
