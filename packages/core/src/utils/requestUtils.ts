/**
 * Request utilities for HTTP clients
 * 
 * Provides reusable components for request deduplication, queuing, and logging
 */

import { createCancelledError } from './errorUtils';

/**
 * The error to reject an aborted request with.
 *
 * ALWAYS the SDK's own cancellation error, with the signal's `reason` preserved
 * as `cause` rather than substituted for it. The tempting version —
 * `reason ?? createCancelledError()` — is wrong twice: `controller.abort()`
 * always populates `reason` with a default `DOMException`, so the fallback
 * would never run, and that `DOMException` carries none of the fields the retry
 * predicates and consumers key off (`code: 'CANCELLED'`, `cancelled: true`).
 * A cancellation that is not recognisable as one is the whole defect.
 */
function abortReason(signal: AbortSignal): unknown {
  const reason = (signal as AbortSignal & { reason?: unknown }).reason;
  const error = createCancelledError('Request cancelled') as Error & { cause?: unknown };
  if (reason !== undefined) {
    error.cause = reason;
  }
  return error;
}

/**
 * Request deduplication - prevents duplicate concurrent requests
 * 
 * When multiple requests with the same key are made simultaneously,
 * only one request is executed and all callers receive the same result.
 * 
 * @example
 * ```typescript
 * const deduplicator = new RequestDeduplicator();
 * 
 * // Multiple calls with same key will share the same promise
 * const promise1 = deduplicator.deduplicate('user-123', () => fetchUser('123'));
 * const promise2 = deduplicator.deduplicate('user-123', () => fetchUser('123'));
 * // promise1 === promise2, only one API call is made
 * ```
 */
export class RequestDeduplicator {
  private pendingRequests = new Map<string, Promise<any>>();

  /**
   * Deduplicate a request by key
   * @param key Unique key for the request
   * @param requestFn Function that returns a promise
   * @returns Promise that will be shared if key already exists
   */
  async deduplicate<T>(
    key: string,
    requestFn: () => Promise<T>,
    signal?: AbortSignal
  ): Promise<T> {
    if (signal?.aborted) {
      throw abortReason(signal);
    }

    let promise = this.pendingRequests.get(key) as Promise<T> | undefined;
    if (!promise) {
      promise = requestFn().finally(() => {
        this.pendingRequests.delete(key);
      });
      this.pendingRequests.set(key, promise);
    }

    // Callers SHARE the work but own their cancellation separately.
    //
    // Returning the shared promise directly meant one caller's abort rejected
    // every other caller on the same key — including ones that never cancelled
    // anything, and which had no way to tell that the failure was not theirs.
    // Racing each caller's own signal against the shared work keeps the single
    // in-flight request (the point of deduplication) while making cancellation
    // per-caller. The shared promise is left running: another caller may still
    // want it, and if nobody does its own abort domain ends it.
    if (!signal) {
      return promise;
    }

    // `promise` is already owned by the map's `finally`, so attach a no-op
    // catch to the copy we race: without it, a rejection settled by the race's
    // loser surfaces as an unhandled rejection.
    const shared = promise;
    shared.catch(() => { /* ownership stays with the caller(s) awaiting it */ });

    return new Promise<T>((resolve, reject) => {
      const onAbort = (): void => reject(abortReason(signal));
      signal.addEventListener('abort', onAbort, { once: true });
      shared.then(
        (value) => { signal.removeEventListener('abort', onAbort); resolve(value); },
        (error) => { signal.removeEventListener('abort', onAbort); reject(error); },
      );
    });
  }

  /**
   * Clear all pending requests
   */
  clear(): void {
    this.pendingRequests.clear();
  }

  /**
   * Get number of pending requests
   */
  size(): number {
    return this.pendingRequests.size;
  }
}

/**
 * Request queue with concurrency control
 * 
 * Limits the number of concurrent requests and queues excess requests.
 * Useful for rate limiting and preventing request flooding.
 * 
 * @example
 * ```typescript
 * const queue = new RequestQueue(5, 100); // Max 5 concurrent, queue up to 100
 * 
 * // All requests will be queued and processed with max 5 concurrent
 * await queue.enqueue(() => fetchUser('1'));
 * await queue.enqueue(() => fetchUser('2'));
 * // ...
 * ```
 */
export class RequestQueue {
  private queue: Array<() => Promise<any>> = [];
  private running = 0;
  private maxConcurrent: number;
  private maxQueueSize: number;

  /**
   * Create a new request queue
   * @param maxConcurrent Maximum number of concurrent requests (default: 10)
   * @param maxQueueSize Maximum queue size (default: 100)
   */
  constructor(maxConcurrent = 10, maxQueueSize = 100) {
    this.maxConcurrent = maxConcurrent;
    this.maxQueueSize = maxQueueSize;
  }

  /**
   * Enqueue a request
   * @param requestFn Function that returns a promise
   * @returns Promise that resolves when request completes
   */
  async enqueue<T>(requestFn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (this.queue.length >= this.maxQueueSize) {
      throw new Error('Request queue is full');
    }

    // A slot is the scarce resource — ten by default — so a request whose
    // caller has already given up must never consume one. Without this, a
    // burst of cancelled work (a search box being typed into, say) keeps every
    // slot busy on results nobody will read, and the ONE request the user is
    // waiting on queues behind them. This is the change that actually returns
    // the slots; refusing to retry a cancellation only stops making more.
    if (signal?.aborted) {
      throw abortReason(signal);
    }

    return new Promise<T>((resolve, reject) => {
      let settled = false;
      const finish = (fn: () => void): void => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener('abort', onAbort);
        fn();
      };

      const entry = async (): Promise<void> => {
        // Re-checked at the moment of execution, not just at enqueue: a request
        // can sit in the queue for as long as the slots stay busy, and the
        // caller may well have moved on in the meantime.
        if (signal?.aborted) {
          finish(() => reject(abortReason(signal)));
          return;
        }
        try {
          const result = await requestFn();
          finish(() => resolve(result));
        } catch (error) {
          finish(() => reject(error));
        }
      };

      const abortingSignal = signal;
      function onAbort(this: void): void {
        if (!abortingSignal) return;
        // Drop it from the queue if it has not started. An entry already
        // running is left to its own abort domain — the queue must still see it
        // finish, or `running` never decrements and the slot leaks for good.
        const index = queueRef.indexOf(entry);
        if (index !== -1) {
          queueRef.splice(index, 1);
        }
        finish(() => reject(abortReason(abortingSignal)));
      }

      const queueRef = this.queue;
      signal?.addEventListener('abort', onAbort, { once: true });
      this.queue.push(entry);
      this.process();
    });
  }

  /**
   * Process queued requests
   */
  private async process(): Promise<void> {
    if (this.running >= this.maxConcurrent || this.queue.length === 0) {
      return;
    }

    this.running++;
    const requestFn = this.queue.shift();
    if (requestFn) {
      try {
        await requestFn();
      } finally {
        this.running--;
        this.process();
      }
    } else {
      this.running--;
    }
  }

  /**
   * Clear all queued requests
   */
  clear(): void {
    this.queue = [];
  }

  /**
   * Get queue size
   */
  size(): number {
    return this.queue.length;
  }

  /**
   * Get number of currently running requests
   */
  runningCount(): number {
    return this.running;
  }
}

/** Log level type for SimpleLogger */
export type LogLevel = 'none' | 'error' | 'warn' | 'info' | 'debug';

/**
 * Simple logger with level support
 *
 * Lightweight logger for HTTP clients and utilities.
 * For structured, namespaced, level-gated logging, use `@oxy.so/core/logger`.
 *
 * @example
 * ```typescript
 * const logger = new SimpleLogger(true, 'debug');
 * logger.debug('Debug message');
 * logger.info('Info message');
 * logger.error('Error message');
 * ```
 */
export class SimpleLogger {
  private enabled: boolean;
  private level: LogLevel;
  private prefix: string;

  /**
   * Create a new simple logger
   * @param enabled Whether logging is enabled
   * @param level Minimum log level
   * @param prefix Prefix for log messages (default: '')
   */
  constructor(
    enabled = false,
    level: LogLevel = 'error',
    prefix = ''
  ) {
    this.enabled = enabled;
    this.level = level;
    this.prefix = prefix;
  }

  private shouldLog(level: LogLevel): boolean {
    if (!this.enabled || this.level === 'none') return false;
    const levels: LogLevel[] = ['none', 'error', 'warn', 'info', 'debug'];
    return levels.indexOf(level) <= levels.indexOf(this.level);
  }

  private formatMessage(...args: any[]): any[] {
    return this.prefix ? [`[${this.prefix}]`, ...args] : args;
  }

  error(...args: any[]): void {
    if (this.shouldLog('error')) {
      console.error(...this.formatMessage(...args));
    }
  }

  warn(...args: any[]): void {
    if (this.shouldLog('warn')) {
      console.warn(...this.formatMessage(...args));
    }
  }

  info(...args: any[]): void {
    if (this.shouldLog('info')) {
      console.info(...this.formatMessage(...args));
    }
  }

  debug(...args: any[]): void {
    if (this.shouldLog('debug')) {
      console.log(...this.formatMessage(...args));
    }
  }
}

