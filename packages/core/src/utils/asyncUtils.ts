/**
 * Async utilities for common asynchronous patterns and error handling
 */

import { logger } from '../logger';
import { ErrorCodes, isCancelledError } from './errorUtils';

/**
 * Wrapper for async operations with automatic error handling
 * Returns null on error instead of throwing
 */
export async function withErrorHandling<T>(
  operation: () => Promise<T>,
  errorHandler?: (error: any) => void,
  context?: string
): Promise<T | null> {
  try {
    return await operation();
  } catch (error) {
    if (errorHandler) {
      errorHandler(error);
    } else {
      logger.error(`Error in ${context || 'operation'}`, error instanceof Error ? error : new Error(String(error)), {
        component: 'asyncUtils',
        method: 'withErrorHandling',
      });
    }
    return null;
  }
}

/**
 * Execute multiple async operations in parallel with error handling
 */
export async function parallelWithErrorHandling<T>(
  operations: (() => Promise<T>)[],
  errorHandler?: (error: any, index: number) => void
): Promise<(T | null)[]> {
  const results = await Promise.allSettled(
    operations.map((op, index) => 
      withErrorHandling(op, error => errorHandler?.(error, index))
    )
  );
  
  return results.map(result => 
    result.status === 'fulfilled' ? result.value : null
  );
}

/**
 * Extract an HTTP status code from an error value, tolerating both the
 * axios-style nested shape (`error.response.status`) and the flat shape
 * produced by {@link handleHttpError} / fetch-based clients (`error.status`).
 *
 * Centralising this lookup prevents retry predicates from silently falling
 * through when one of the two shapes is missing, which previously caused
 * @oxy.so/core to retry 4xx responses and turn sub-10ms failures into
 * multi-second stalls for every missing-resource lookup.
 */
function extractHttpStatus(error: unknown): number | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const candidate = error as {
    status?: unknown;
    response?: { status?: unknown } | null;
  };
  const flat = candidate.status;
  if (typeof flat === 'number' && Number.isFinite(flat)) return flat;
  const nested = candidate.response?.status;
  if (typeof nested === 'number' && Number.isFinite(nested)) return nested;
  return undefined;
}

/**
 * Retry an async operation with exponential backoff
 *
 * By default, does not retry on 4xx errors (client errors). The default
 * predicate accepts both the axios-style `error.response.status` and the
 * flat `error.status` shape produced by {@link handleHttpError}, so callers
 * never accidentally retry a deterministic client failure.
 *
 * Use the `shouldRetry` callback to customize retry behavior.
 */
export interface RetryOptions {
  maxRetries?: number;
  baseDelay?: number;
  shouldRetry?: (error: unknown) => boolean;
  /**
   * Retry a request that hit its own per-attempt timeout. Default `false`.
   *
   * Retrying a timeout is defensible for an idempotent GET and indefensible
   * with the old defaults: a 5s per-attempt timeout with 3 retries and
   * exponential backoff spends ~28s before reporting a failure, all of it after
   * the caller stopped waiting, while holding a request-queue slot throughout.
   * A timeout also usually means the SERVER is slow, so three more attempts add
   * load to the thing already struggling.
   *
   * Opt in per call, and pair it with {@link deadline} so the total is bounded
   * by wall clock rather than by attempts x timeout + backoff.
   */
  retryOnTimeout?: boolean;
  /**
   * Absolute wall-clock budget for ALL attempts, as an epoch milliseconds
   * timestamp (`Date.now() + budget`). Once passed, no further attempt starts
   * and the last error is thrown.
   *
   * This is what makes a pathological total unreachable BY CONSTRUCTION rather
   * than by arithmetic on the other knobs: a deadline per call, a timeout per
   * attempt, and jittered retries inside the deadline.
   */
  deadline?: number;
}

/**
 * Whether an error came from a request hitting its own timeout.
 *
 * A timeout and a caller cancellation both surface from `fetch` as an
 * `AbortError`, so this only recognises one that has already been CLASSIFIED
 * (by `HttpService`, which knows which of its own timers fired). An
 * unclassified abort is treated as a cancellation, which is the safe
 * direction: refusing to retry something that was abandoned costs nothing,
 * while retrying it is the defect this whole option exists to fix.
 */
function isTimeoutError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const candidate = error as { code?: unknown; timeout?: unknown };
  return candidate.timeout === true || candidate.code === ErrorCodes.TIMEOUT;
}

export async function retryAsync<T>(
  operation: () => Promise<T>,
  maxRetriesOrOptions: number | RetryOptions = 3,
  baseDelayArg = 1000,
  shouldRetryArg?: (error: any) => boolean
): Promise<T> {
  // An options-object overload rather than a fifth positional parameter:
  // `retryOnError` below and other in-tree callers pass positionally, and a
  // boolean wedged between `baseDelay` and `shouldRetry` is the kind of
  // signature that gets called wrong exactly once and then silently.
  const options: RetryOptions =
    typeof maxRetriesOrOptions === 'object' && maxRetriesOrOptions !== null
      ? maxRetriesOrOptions
      : { maxRetries: maxRetriesOrOptions, baseDelay: baseDelayArg, shouldRetry: shouldRetryArg };

  const maxRetries = options.maxRetries ?? 3;
  const baseDelay = options.baseDelay ?? 1000;
  const retryOnTimeout = options.retryOnTimeout ?? false;
  const deadline = options.deadline;

  let lastError: any;

  // Default shouldRetry: don't retry on 4xx errors (client errors).
  // Checks BOTH `error.status` (flat shape from handleHttpError / fetch
  // clients) AND `error.response.status` (axios-style shape) so neither
  // representation can leak a client error into the retry loop.
  const defaultShouldRetry = (error: unknown): boolean => {
    // A cancellation is an INSTRUCTION, not a transient failure, and is
    // refused here rather than only in HttpService so that every `retryAsync`
    // consumer inherits it. This was the defect: an `AbortError` carries no
    // HTTP status, `status: 0` is not 4xx, so the status check below passed it
    // straight into the retry loop and the SDK re-issued requests their
    // callers had already abandoned.
    if (isCancelledError(error)) {
      return false;
    }
    const status = extractHttpStatus(error);
    if (status !== undefined && status >= 400 && status < 500) {
      return false;
    }
    return true;
  };

  const retryCheck = options.shouldRetry || defaultShouldRetry;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;

      if (attempt === maxRetries) {
        break;
      }

      // A cancellation is never retryable, whatever `shouldRetry` says: a
      // custom predicate is for deciding which FAILURES are worth another
      // attempt, and it has no business overriding an explicit abort.
      if (isCancelledError(error)) {
        break;
      }

      if (!retryOnTimeout && isTimeoutError(error)) {
        break;
      }

      if (!retryCheck(error)) {
        break;
      }

      // Calculate delay with exponential backoff and jitter
      const delay = baseDelay * Math.pow(2, attempt) + Math.random() * 1000;

      // Nothing may start, or even sleep, past the deadline — otherwise the
      // budget bounds the attempts but not the wall clock the caller feels.
      if (deadline !== undefined && Date.now() + delay >= deadline) {
        break;
      }

      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }

  throw lastError;
}

/**
 * Debounce async function calls
 */
export function debounceAsync<T extends (...args: any[]) => Promise<any>>(
  func: T,
  delay: number
): (...args: Parameters<T>) => Promise<ReturnType<T>> {
  let timeoutId: ReturnType<typeof setTimeout>;

  return (...args: Parameters<T>): Promise<ReturnType<T>> => {
    return new Promise((resolve, reject) => {
      clearTimeout(timeoutId);
      
      timeoutId = setTimeout(async () => {
        try {
          const result = await func(...args);
          resolve(result);
        } catch (error) {
          reject(error);
        }
      }, delay);
    });
  };
}

/**
 * Throttle async function calls
 */
export function throttleAsync<T extends (...args: any[]) => Promise<any>>(
  func: T,
  limit: number,
  interval: number
): (...args: Parameters<T>) => Promise<ReturnType<T>> {
  let inThrottle = false;
  let lastPromise: Promise<ReturnType<T>> | null = null;
  
  return (...args: Parameters<T>): Promise<ReturnType<T>> => {
    if (inThrottle) {
      return lastPromise!;
    }
    
    inThrottle = true;
    lastPromise = func(...args);
    
    setTimeout(() => {
      inThrottle = false;
    }, interval);
    
    return lastPromise;
  };
}

/**
 * Execute async operations sequentially with progress tracking
 */
export async function sequentialWithProgress<T>(
  operations: (() => Promise<T>)[],
  onProgress?: (completed: number, total: number) => void
): Promise<T[]> {
  const results: T[] = [];
  
  for (let i = 0; i < operations.length; i++) {
    const result = await operations[i]();
    results.push(result);
    onProgress?.(i + 1, operations.length);
  }
  
  return results;
}

/**
 * Batch async operations
 */
export async function batchAsync<T>(
  items: T[],
  batchSize: number,
  processor: (batch: T[]) => Promise<void>
): Promise<void> {
  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize);
    await processor(batch);
  }
}

/**
 * Create a cancellable async operation
 */
export function createCancellableAsync<T>(
  operation: (signal: AbortSignal) => Promise<T>
): { execute: () => Promise<T>; cancel: () => void } {
  let abortController: AbortController | null = null;
  
  return {
    execute: async () => {
      abortController = new AbortController();
      return await operation(abortController.signal);
    },
    cancel: () => {
      abortController?.abort();
    }
  };
}

/**
 * Timeout wrapper for async operations
 */
export async function withTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
  timeoutMessage?: string
): Promise<T> {
  const timeoutPromise = new Promise<never>((_, reject) => {
    setTimeout(() => {
      reject(new Error(timeoutMessage || `Operation timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });
  
  return Promise.race([operation, timeoutPromise]);
}

/**
 * Execute async operation with loading state
 */
export async function withLoadingState<T>(
  operation: () => Promise<T>,
  setLoading: (loading: boolean) => void
): Promise<T> {
  setLoading(true);
  try {
    return await operation();
  } finally {
    setLoading(false);
  }
}

/**
 * Create a promise that resolves after a delay
 */
export const delay = (ms: number): Promise<void> => 
  new Promise(resolve => setTimeout(resolve, ms));

/**
 * Execute async operation with retry on specific errors
 */
export async function retryOnError<T>(
  operation: () => Promise<T>,
  retryableErrors: (string | number)[],
  maxRetries = 3
): Promise<T> {
  return retryAsync(operation, maxRetries, 1000, (error) => {
    const errorCode = error?.code || error?.status || error?.message;
    return retryableErrors.includes(errorCode);
  });
}
