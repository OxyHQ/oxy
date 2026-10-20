/**
 * A bounded background queue: at most `maxConcurrent` jobs running, at most
 * `maxQueueSize` waiting, and a job offered to a full queue refused rather
 * than held. For work that must never block the request that caused it and
 * must not grow without limit when the requests come faster than it drains —
 * metered inference on inbound mail, which a stranger can trigger by sending
 * it.
 *
 * Jobs start on a microtask, never inside {@link BoundedJobQueue.enqueue}: a
 * burst enqueued in one turn is queued whole, and the size limit applies to
 * the burst rather than to whatever was left after the first jobs started.
 */

import { logger } from './logger';

export interface BoundedJobQueueOptions {
  /** Names the queue in the log line of a job that failed. */
  name: string;
  maxConcurrent: number;
  maxQueueSize: number;
}

export class BoundedJobQueue {
  private active = 0;
  private readonly waiting: Array<() => Promise<void>> = [];
  private scheduled = false;

  constructor(private readonly options: BoundedJobQueueOptions) {}

  /**
   * Queue `job`. Answers a promise that settles when the job has run — it
   * never rejects; a failure is logged — or `null`, with nothing queued, when
   * the queue is full.
   */
  enqueue(job: () => Promise<void>): Promise<void> | null {
    if (this.waiting.length >= this.options.maxQueueSize) return null;

    const done = new Promise<void>((resolve) => {
      this.waiting.push(() =>
        // `then`, so a job that throws before its first await is caught too.
        Promise.resolve()
          .then(job)
          .catch((error: unknown) => {
            logger.warn(`${this.options.name} job failed`, {
              error: error instanceof Error ? error.message : String(error),
            });
          })
          .finally(resolve),
      );
    });
    this.schedule();
    return done;
  }

  private schedule(): void {
    if (this.scheduled) return;
    this.scheduled = true;
    queueMicrotask(() => {
      this.scheduled = false;
      this.drain();
    });
  }

  private drain(): void {
    while (this.active < this.options.maxConcurrent && this.waiting.length > 0) {
      const run = this.waiting.shift();
      if (!run) return;
      this.active += 1;
      void run().finally(() => {
        this.active -= 1;
        this.schedule();
      });
    }
  }
}
