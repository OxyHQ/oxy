/**
 * Asset-variant queue tests.
 *
 * The properties that matter here are the ones a green build cannot tell you:
 *  - the per-file BullMQ job id is colon-free ("Custom Id cannot contain :") and
 *    STABLE, because that identical id is the whole dedup mechanism;
 *  - two enqueues for one file produce one unit of work;
 *  - the no-Redis fallback is a BOUNDED, sequential drain and not a fallback to
 *    the unbounded in-process generation this module exists to remove;
 *  - the worker is constructed with an explicit, small concurrency;
 *  - Redis holds a bounded window: an upload records its request and adds its
 *    job only while the queue has room, a job settles the request it carries,
 *    and Redis errors are paused on and logged as a summary, never per attempt
 *    (2026-10-20: 398,416 jobs filled the queue node and the worker loop logged
 *    ~1,600 errors a second). The Postgres half is `renditionRequests.test.ts`.
 */

type JobData = { fileId: string; requestedAt?: string; activitySourceRegion?: string };
type Processor = (job: { data: JobData }) => Promise<void>;

interface AddCall {
  jobId?: string;
  attempts?: number;
  removeOnComplete?: unknown;
  removeOnFail?: unknown;
}

type WorkerEventHandler = (
  job: {
    id: string;
    data: JobData;
    attemptsMade: number;
    opts: { attempts?: number };
  },
  error: Error,
) => void;

// MockQueue records every `add` so the test can assert on the job id that BullMQ
// dedupes by. MockWorker records its construction options.
jest.mock('bullmq', () => {
  class MockWorker {
    static processor: Processor;
    static lastOptions: { concurrency?: number } | undefined;
    static failedHandler: WorkerEventHandler | undefined;
    constructor(_name: unknown, processor: Processor, options: { concurrency?: number }) {
      MockWorker.lastOptions = options;
      MockWorker.processor = processor;
    }
    on(event: string, handler: WorkerEventHandler): this {
      if (event === 'failed') MockWorker.failedHandler = handler;
      return this;
    }
    close(): Promise<void> {
      return Promise.resolve();
    }
    waitUntilReady(): Promise<this> {
      return Promise.resolve(this);
    }
  }
  class MockQueue {
    static addCalls: AddCall[] = [];
    static dataCalls: JobData[] = [];
    static waiting = 0;
    static failAdd = false;
    static oldestTimestamp: number | undefined;
    on(): this {
      return this;
    }
    close(): Promise<void> {
      return Promise.resolve();
    }
    waitUntilReady(): Promise<this> {
      return Promise.resolve(this);
    }
    add(_name: unknown, data: JobData, options: AddCall): Promise<void> {
      if (MockQueue.failAdd) return Promise.reject(new Error('OOM command not allowed'));
      MockQueue.addCalls.push(options);
      MockQueue.dataCalls.push(data);
      return Promise.resolve();
    }
    async addBulk(jobs: Array<{ name: string; data: JobData; opts: AddCall }>): Promise<void> {
      await Promise.all(jobs.map((job) => this.add(job.name, job.data, job.opts)));
    }
    async getJob(jobId: string) {
      const index = MockQueue.addCalls.findIndex((options) => options.jobId === jobId);
      return index < 0 ? undefined : { data: MockQueue.dataCalls[index] };
    }
    getJobCounts(): Promise<{ waiting: number }> {
      return Promise.resolve({ waiting: MockQueue.waiting });
    }
    getJobs(): Promise<Array<{ timestamp: number }>> {
      return Promise.resolve(
        MockQueue.oldestTimestamp === undefined ? [] : [{ timestamp: MockQueue.oldestTimestamp }],
      );
    }
  }
  return { Queue: MockQueue, Worker: MockWorker };
});

const mockObserveAssetJob = jest.fn();
jest.mock('../../services/workerActivity.service', () => ({
  observeAssetJob: (region: unknown) => mockObserveAssetJob(region),
}));

const mockGenerateVariants = jest.fn(() => Promise.resolve());

const REQUESTED_AT = '2026-10-20T10:00:00.000Z';
const mockRecord = jest.fn();
let mockDue: Array<{ fileId: string; requestedAt: Date }> = [];
const mockRelease = jest.fn();
const mockSettle = jest.fn();
const mockCount = jest.fn();
const mockOldest = jest.fn();
jest.mock('../../services/renditionRequests', () => ({
  recordRenditionRequest: (...args: unknown[]) => mockRecord(...args),
  releaseRenditionRequest: (...args: unknown[]) => mockRelease(...args),
  settleRenditionRequest: (...args: unknown[]) => mockSettle(...args),
  countRenditionRequests: () => mockCount(),
  oldestRenditionRequestAt: () => mockOldest(),
  claimDueRenditionRequests: (limit: number) =>
    Promise.resolve(mockDue.splice(0, Math.max(0, limit))),
  RENDITION_DISPATCH_ROUND: Array(32).fill('fresh'),
  adoptRenditionRequests: () => Promise.resolve(0),
}));

jest.mock('../../config/postgres', () => ({
  getDb: () => ({
    transaction: (fn: (tx: unknown) => unknown) => fn({ execute: async () => [{ locked: true }] }),
  }),
}));

jest.mock('../connection', () => ({
  getAssetVariantQueueConnectionOptions: () => ({}),
  getAssetVariantQueueUrl: () =>
    process.env.QUEUE_REDIS_URL ??
    (process.env.NODE_ENV !== 'production' ? process.env.REDIS_URL : undefined),
}));
jest.mock('../../services/s3ServiceSingleton', () => ({ s3Service: {} }));
jest.mock('../../services/variantService', () => ({
  VariantService: class {
    generateVariants = (...args: unknown[]) => mockGenerateVariants(...args);
  },
}));

import { Queue, Worker } from 'bullmq';
import { logger } from '../../utils/logger';
import {
  ASSET_VARIANT_QUEUE_TARGET_DEPTH,
  ASSET_VARIANT_WORKER_CONCURRENCY,
  assetVariantsJobId,
  backOffOnWorkerErrors,
  enqueueAssetVariantGeneration,
  startAssetVariantProducer,
  startAssetVariantWorker,
  stopAssetVariantProducer,
  ThrottledErrorLog,
  WORKER_ERROR_BACKOFF_MAX_MS,
  WORKER_ERROR_BACKOFF_MIN_MS,
} from '../assetVariants.queue';

const MockQueue = Queue as unknown as {
  addCalls: AddCall[];
  dataCalls: JobData[];
  waiting: number;
  failAdd: boolean;
  oldestTimestamp: number | undefined;
};
const MockWorker = Worker as unknown as {
  processor: Processor;
  lastOptions: { concurrency?: number } | undefined;
  failedHandler: WorkerEventHandler | undefined;
};

/** Let the fallback's `setImmediate` drain kick and settle. */
const settle = () => new Promise((resolve) => setImmediate(resolve));

beforeEach(() => {
  process.env.NODE_ENV = 'test';
  delete process.env.REDIS_URL;
  delete process.env.QUEUE_REDIS_URL;
  MockQueue.addCalls = [];
  MockQueue.dataCalls = [];
  mockObserveAssetJob.mockClear();
  MockQueue.waiting = 0;
  MockQueue.failAdd = false;
  MockQueue.oldestTimestamp = undefined;
  mockRecord.mockReset();
  mockDue = [];
  mockRecord.mockImplementation((fileId: string) => {
    const request = { fileId, requestedAt: new Date(REQUESTED_AT) };
    mockDue.push(request);
    return Promise.resolve(request);
  });
  mockRelease.mockReset();
  mockRelease.mockImplementation(() => Promise.resolve());
  mockSettle.mockReset();
  mockSettle.mockImplementation(() => Promise.resolve());
  mockCount.mockReset();
  mockCount.mockImplementation(() => Promise.resolve(0));
  mockOldest.mockReset();
  mockOldest.mockImplementation(() => Promise.resolve(null));
  MockWorker.lastOptions = undefined;
  MockWorker.failedHandler = undefined;
  mockGenerateVariants.mockClear();
  mockGenerateVariants.mockImplementation(() => Promise.resolve());
});

afterEach(async () => {
  await stopAssetVariantProducer();
});

describe('assetVariantsJobId', () => {
  it('never contains a colon (BullMQ custom-id rule) and is stable per file', () => {
    const id = assetVariantsJobId('0f8b2c1e-4d5a-4a8f-9c3b-1e2d3f4a5b6c');
    expect(id).not.toContain(':');
    expect(id.startsWith('av-')).toBe(true);
    expect(assetVariantsJobId('0f8b2c1e-4d5a-4a8f-9c3b-1e2d3f4a5b6c')).toBe(id); // deterministic
    expect(assetVariantsJobId('another-file-id')).not.toBe(id);
  });

  it('stays colon-free even if a file id ever carries one', () => {
    expect(assetVariantsJobId('urn:oxy:file:123')).not.toContain(':');
  });
});

describe('dedup', () => {
  it('enqueues both requests for one file under the SAME job id (BullMQ then keeps one)', async () => {
    process.env.QUEUE_REDIS_URL = 'redis://queue.test:6379';
    await startAssetVariantProducer();

    enqueueAssetVariantGeneration('file-abc');
    enqueueAssetVariantGeneration('file-abc');
    await settle();

    // The dedup lives in BullMQ: an `add` for a jobId already queued/active is
    // ignored. What this code must guarantee is that both adds present the
    // identical id — assert that, rather than re-implementing Redis.
    expect(MockQueue.addCalls).toHaveLength(2);
    expect(MockQueue.addCalls[0].jobId).toBe(assetVariantsJobId('file-abc'));
    expect(MockQueue.addCalls[1].jobId).toBe(MockQueue.addCalls[0].jobId);

    // A different file must NOT collide onto that id.
    enqueueAssetVariantGeneration('file-xyz');
    await settle();
    expect(MockQueue.addCalls[2].jobId).not.toBe(MockQueue.addCalls[0].jobId);
  });

  it('runs generation ONCE for two fallback enqueues of the same file', async () => {
    await startAssetVariantProducer(); // queues disabled -> in-process fallback

    enqueueAssetVariantGeneration('file-abc');
    enqueueAssetVariantGeneration('file-abc');
    await settle();
    await settle();

    expect(mockGenerateVariants).toHaveBeenCalledTimes(1);
    expect(mockGenerateVariants).toHaveBeenCalledWith('file-abc');
  });

  it('carries retry attempts so a failed generation is retried, not lost', async () => {
    process.env.QUEUE_REDIS_URL = 'redis://queue.test:6379';
    await startAssetVariantProducer();

    enqueueAssetVariantGeneration('file-abc');
    await settle();

    expect(MockQueue.addCalls[0].attempts).toBeGreaterThan(1);
  });
});

describe('producer/worker separation', () => {
  it('does not construct a worker in the HTTP producer', async () => {
    process.env.QUEUE_REDIS_URL = 'redis://queue.test:6379';
    await startAssetVariantProducer();

    expect(MockWorker.lastOptions).toBeUndefined();
  });

  it('is created with an explicit, small concurrency', async () => {
    process.env.QUEUE_REDIS_URL = 'redis://queue.test:6379';
    await startAssetVariantWorker();

    expect(MockWorker.lastOptions?.concurrency).toBe(ASSET_VARIANT_WORKER_CONCURRENCY);
    // The whole point of the queue is that this stays bounded and low. A large
    // value here re-creates the CPU contention on a fractional-vCPU task.
    expect(ASSET_VARIANT_WORKER_CONCURRENCY).toBeLessThanOrEqual(2);
  });

  it('publishes queue depth, the backlog and its oldest age as CloudWatch embedded metrics', async () => {
    process.env.QUEUE_REDIS_URL = 'redis://queue.test:6379';
    MockQueue.waiting = 7;
    mockCount.mockImplementation(() => Promise.resolve(398_416));
    // The age is the backlog's oldest REQUEST, wherever it waits.
    mockOldest.mockImplementation(() => Promise.resolve(new Date(Date.now() - 125_000)));
    const info = jest.spyOn(logger, 'info');

    await startAssetVariantWorker();

    expect(info).toHaveBeenCalledWith(
      'Asset variant queue metrics',
      expect.objectContaining({
        QueueName: 'asset-variants',
        QueueDepth: 7,
        PendingRenditionRequests: 398_416,
        OldestWaitingJobAgeSeconds: expect.any(Number),
        _aws: expect.objectContaining({ CloudWatchMetrics: expect.any(Array) }),
      }),
    );
    const metricContext = info.mock.calls.find(
      ([message]) => message === 'Asset variant queue metrics',
    )?.[1];
    expect(metricContext?.OldestWaitingJobAgeSeconds).toBeGreaterThanOrEqual(124);
    info.mockRestore();
  });

  it('emits one permanent-failure metric only after the final retry', async () => {
    process.env.QUEUE_REDIS_URL = 'redis://queue.test:6379';
    const info = jest.spyOn(logger, 'info');
    await startAssetVariantWorker();

    MockWorker.failedHandler?.(
      { id: 'job-1', data: { fileId: 'file-1' }, attemptsMade: 2, opts: { attempts: 3 } },
      new Error('retryable'),
    );
    expect(info).not.toHaveBeenCalledWith(
      'Asset variant permanent failure metric',
      expect.anything(),
    );

    MockWorker.failedHandler?.(
      { id: 'job-1', data: { fileId: 'file-1' }, attemptsMade: 3, opts: { attempts: 3 } },
      new Error('permanent'),
    );
    expect(info).toHaveBeenCalledWith(
      'Asset variant permanent failure metric',
      expect.objectContaining({
        QueueName: 'asset-variants',
        PermanentJobFailures: 1,
      }),
    );
    info.mockRestore();
  });

  it('refuses to run a worker without the durable queue', async () => {
    await expect(startAssetVariantWorker()).rejects.toThrow('QUEUE_REDIS_URL is required');
    expect(MockWorker.lastOptions).toBeUndefined();
  });
});

describe('production safety', () => {
  const originalNodeEnv = process.env.NODE_ENV;

  afterEach(() => {
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalNodeEnv;
  });

  it('refuses an in-process fallback in production', async () => {
    process.env.NODE_ENV = 'production';

    await expect(startAssetVariantProducer()).rejects.toThrow(
      'QUEUE_REDIS_URL is required for the production asset-variant producer',
    );
    enqueueAssetVariantGeneration('must-not-transcode-in-http');
    await settle();
    expect(mockGenerateVariants).not.toHaveBeenCalled();
  });
});

describe('no-Redis fallback', () => {
  it('is SEQUENTIAL — never runs two generations at once', async () => {
    await startAssetVariantProducer();

    let concurrent = 0;
    let peak = 0;
    const release: Array<() => void> = [];
    mockGenerateVariants.mockImplementation(() => {
      concurrent += 1;
      peak = Math.max(peak, concurrent);
      return new Promise<void>((resolve) => {
        release.push(() => {
          concurrent -= 1;
          resolve();
        });
      });
    });

    for (const id of ['a', 'b', 'c', 'd', 'e']) {
      enqueueAssetVariantGeneration(id);
    }
    await settle();

    // Drain them one at a time; each release lets exactly one more start.
    for (let i = 0; i < 5; i += 1) {
      expect(concurrent).toBeLessThanOrEqual(1);
      release[i]?.();
      await settle();
    }

    expect(peak).toBe(1);
    expect(mockGenerateVariants).toHaveBeenCalledTimes(5);
  });

  it('does not enqueue into a dead subsystem after stop', async () => {
    await startAssetVariantProducer();
    await stopAssetVariantProducer();

    enqueueAssetVariantGeneration('file-after-stop');
    await settle();

    expect(mockGenerateVariants).not.toHaveBeenCalled();
  });

  it('keeps draining after one file fails', async () => {
    await startAssetVariantProducer();

    mockGenerateVariants
      .mockImplementationOnce(() => Promise.reject(new Error('ffmpeg exploded')))
      .mockImplementation(() => Promise.resolve());

    enqueueAssetVariantGeneration('bad');
    enqueueAssetVariantGeneration('good');
    await settle();
    await settle();
    await settle();

    expect(mockGenerateVariants).toHaveBeenCalledTimes(2);
  });
});

describe('queue activity metadata', () => {
  it('adds only a valid producer region and leaves the file payload intact', async () => {
    const region = process.env.AWS_REGION;
    try {
      process.env.QUEUE_REDIS_URL = 'redis://queue.test:6379';
      await startAssetVariantProducer();
      process.env.AWS_REGION = 'eu-west-1';
      enqueueAssetVariantGeneration('private-file');
      await settle();
      process.env.AWS_REGION = 'private-host/path';
      enqueueAssetVariantGeneration('legacy-file');
      await settle();
      expect(MockQueue.dataCalls).toEqual([
        { fileId: 'private-file', requestedAt: REQUESTED_AT, activitySourceRegion: 'eu-west-1' },
        { fileId: 'legacy-file', requestedAt: REQUESTED_AT },
      ]);
    } finally {
      if (region === undefined) delete process.env.AWS_REGION;
      else process.env.AWS_REGION = region;
    }
  });
  it('observes new and legacy jobs without passing file IDs and preserves processing failures', async () => {
    process.env.QUEUE_REDIS_URL = 'redis://queue.test:6379';
    await startAssetVariantWorker();
    await MockWorker.processor({
      data: { fileId: 'private-file', activitySourceRegion: 'eu-west-1' },
    });
    await MockWorker.processor({ data: { fileId: 'legacy-file' } });
    expect(mockObserveAssetJob.mock.calls).toEqual([['eu-west-1'], [undefined]]);
    expect(mockGenerateVariants).toHaveBeenNthCalledWith(1, 'private-file');
    expect(mockGenerateVariants).toHaveBeenNthCalledWith(2, 'legacy-file');
    const failure = new Error('rendition failed');
    mockGenerateVariants.mockRejectedValueOnce(failure);
    await expect(MockWorker.processor({ data: { fileId: 'failed-file' } })).rejects.toBe(failure);
  });
});

describe('the bounded window', () => {
  it('records a due request and wakes the unified dispatcher immediately when idle', async () => {
    process.env.QUEUE_REDIS_URL = 'redis://queue.test:6379';
    await startAssetVariantProducer();
    MockQueue.waiting = 0;

    enqueueAssetVariantGeneration('file-abc');
    await settle();

    expect(mockRecord).toHaveBeenCalledWith('file-abc', null);
    expect(MockQueue.addCalls).toHaveLength(1);
    expect(MockQueue.addCalls[0]).toMatchObject({
      jobId: assetVariantsJobId('file-abc'),
      // Nothing kept in Redis: the table and the logs are the record.
      removeOnComplete: true,
      removeOnFail: true,
    });
    expect(MockQueue.dataCalls[0]).toMatchObject({ fileId: 'file-abc', requestedAt: REQUESTED_AT });
  });

  it('leaves the request to the scheduler when the queue is at its bound', async () => {
    process.env.QUEUE_REDIS_URL = 'redis://queue.test:6379';
    await startAssetVariantProducer();
    MockQueue.waiting = ASSET_VARIANT_QUEUE_TARGET_DEPTH;

    enqueueAssetVariantGeneration('file-abc');
    await settle();

    expect(mockRecord).toHaveBeenCalledWith('file-abc', null);
    expect(MockQueue.addCalls).toHaveLength(0);
  });

  it('makes the request due again when the add fails', async () => {
    process.env.QUEUE_REDIS_URL = 'redis://queue.test:6379';
    await startAssetVariantProducer();
    MockQueue.failAdd = true;

    enqueueAssetVariantGeneration('file-abc');
    await settle();

    expect(mockRecord).toHaveBeenCalledWith('file-abc', null);
    expect(mockRelease).not.toHaveBeenCalled();
    expect(MockQueue.addCalls).toHaveLength(0); // DB rollback is covered with real Postgres.
  });

  it('still adds the job when the request cannot be recorded', async () => {
    process.env.QUEUE_REDIS_URL = 'redis://queue.test:6379';
    await startAssetVariantProducer();
    mockRecord.mockImplementation(() => Promise.reject(new Error('database down')));

    enqueueAssetVariantGeneration('file-abc');
    await settle();

    expect(MockQueue.dataCalls).toHaveLength(1);
    expect(MockQueue.dataCalls[0]?.fileId).toBe('file-abc');
    expect(MockQueue.dataCalls[0]).not.toHaveProperty('requestedAt');
  });

  it('logs a failing producer as one summary, not one line per upload', async () => {
    process.env.QUEUE_REDIS_URL = 'redis://queue.test:6379';
    await startAssetVariantProducer();
    MockQueue.failAdd = true;
    const error = jest.spyOn(logger, 'error');

    for (let i = 0; i < 50; i += 1) enqueueAssetVariantGeneration(`file-${i}`);
    await settle();

    const lines = error.mock.calls.filter(
      ([message]) => message === 'Asset variant request could not be queued',
    );
    expect(lines).toHaveLength(1);
    error.mockRestore();
  });

  it('settles the request a job carries once it is built, and not when it failed', async () => {
    process.env.QUEUE_REDIS_URL = 'redis://queue.test:6379';
    await startAssetVariantWorker();

    await MockWorker.processor({ data: { fileId: 'built', requestedAt: REQUESTED_AT } });
    expect(mockSettle).toHaveBeenCalledWith({
      fileId: 'built',
      requestedAt: new Date(REQUESTED_AT),
    });

    mockSettle.mockClear();
    mockGenerateVariants.mockRejectedValueOnce(new Error('ffmpeg exploded'));
    await expect(
      MockWorker.processor({ data: { fileId: 'broken', requestedAt: REQUESTED_AT } }),
    ).rejects.toThrow('ffmpeg exploded');
    expect(mockSettle).not.toHaveBeenCalled();
  });

  it('gives a request up only after the final retry', async () => {
    process.env.QUEUE_REDIS_URL = 'redis://queue.test:6379';
    await startAssetVariantWorker();
    const job = { id: 'job-1', data: { fileId: 'file-1', requestedAt: REQUESTED_AT } };

    MockWorker.failedHandler?.({ ...job, attemptsMade: 2, opts: { attempts: 3 } }, new Error('x'));
    expect(mockSettle).not.toHaveBeenCalled();
    MockWorker.failedHandler?.({ ...job, attemptsMade: 3, opts: { attempts: 3 } }, new Error('x'));
    expect(mockSettle).toHaveBeenCalledWith({
      fileId: 'file-1',
      requestedAt: new Date(REQUESTED_AT),
    });
  });
});

describe('Redis errors back off', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  function fakeWorker() {
    const handlers = new Map<string, (arg?: Error) => void>();
    return {
      paused: 0,
      resumed: 0,
      on(event: string, handler: (arg?: Error) => void) {
        handlers.set(event, handler);
        return this;
      },
      pause() {
        this.paused += 1;
        return Promise.resolve();
      },
      resume() {
        this.resumed += 1;
      },
      emit(event: string, arg?: Error) {
        handlers.get(event)?.(arg);
      },
    };
  }

  it('pauses on an error and resumes after a bounded, doubling delay', () => {
    jest.useFakeTimers();
    const w = fakeWorker();
    const stop = backOffOnWorkerErrors(w as never);
    const oom = new Error("OOM command not allowed when used memory > 'maxmemory'");

    // A burst — what BullMQ's loop emits with no delay — pauses ONCE.
    for (let i = 0; i < 1_000; i += 1) w.emit('error', oom);
    expect(w.paused).toBe(1);
    jest.advanceTimersByTime(WORKER_ERROR_BACKOFF_MIN_MS - 1);
    expect(w.resumed).toBe(0);
    jest.advanceTimersByTime(1);
    expect(w.resumed).toBe(1);

    // Still failing: twice as long, up to the cap.
    w.emit('error', oom);
    jest.advanceTimersByTime(WORKER_ERROR_BACKOFF_MIN_MS * 2 - 1);
    expect(w.resumed).toBe(1);
    jest.advanceTimersByTime(1);
    expect(w.resumed).toBe(2);
    for (let i = 0; i < 20; i += 1) {
      w.emit('error', oom);
      jest.advanceTimersByTime(WORKER_ERROR_BACKOFF_MAX_MS);
    }
    const resumedBefore = w.resumed;
    w.emit('error', oom);
    jest.advanceTimersByTime(WORKER_ERROR_BACKOFF_MAX_MS);
    expect(w.resumed).toBe(resumedBefore + 1);

    // A completed job resets it.
    w.emit('completed');
    w.emit('error', oom);
    jest.advanceTimersByTime(WORKER_ERROR_BACKOFF_MIN_MS);
    expect(w.resumed).toBe(resumedBefore + 2);
    stop();
  });

  it('logs an error stream as one line per interval with how many it held back', () => {
    let now = 0;
    const log = new ThrottledErrorLog('throttled stream under test', 60_000, () => now);
    const error = jest.spyOn(logger, 'error');
    const lines = () =>
      error.mock.calls.filter(([message]) => message === 'throttled stream under test');

    for (let i = 0; i < 1_000; i += 1) log.note(new Error('OOM'));
    expect(lines()).toHaveLength(1);
    now = 60_000;
    log.note(new Error('OOM'));
    expect(lines()).toHaveLength(2);
    expect(lines()[1]?.[1]).toMatchObject({ suppressedSinceLastLog: 999 });
    error.mockRestore();
  });
});
