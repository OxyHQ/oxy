/**
 * Request utilities for HTTP clients
 * 
 * Provides reusable components for request deduplication, queuing, and logging
 */

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
    requestFn: () => Promise<T>
  ): Promise<T> {
    const existing = this.pendingRequests.get(key);
    if (existing) {
      return existing;
    }

    const promise = requestFn()
      .finally(() => {
        this.pendingRequests.delete(key);
      });

    this.pendingRequests.set(key, promise);
    return promise;
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
  async enqueue<T>(requestFn: () => Promise<T>): Promise<T> {
    if (this.queue.length >= this.maxQueueSize) {
      throw new Error('Request queue is full');
    }

    return new Promise<T>((resolve, reject) => {
      this.queue.push(async () => {
        try {
          const result = await requestFn();
          resolve(result);
        } catch (error) {
          reject(error);
        }
      });

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

