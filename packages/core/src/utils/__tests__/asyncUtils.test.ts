import { retryAsync } from '../asyncUtils';
import { createCancelledError, ErrorCodes, handleHttpError } from '../errorUtils';

/**
 * Regression coverage for the 1.11.11 retry storm:
 *
 * HttpService wraps fetch errors through handleHttpError before rethrowing.
 * handleHttpError returns a flat ApiError ({ message, code, status }) without
 * a nested `.response` field. Prior to the fix, retryAsync's default
 * shouldRetry predicate only inspected `error.response.status`, so every 4xx
 * response was treated as retryable. That turned ~5ms 404 lookups into 8-10s
 * stalls because every Mention endpoint hitting Oxy for a missing
 * user/topic hit the full retry+backoff schedule.
 *
 * These tests lock the fix in place: both the nested and flat shapes MUST
 * short-circuit retries for 4xx, and 5xx/network errors MUST still retry.
 */
describe('retryAsync default shouldRetry predicate', () => {
  it('does not retry on a flat ApiError-shaped 404 (handleHttpError output)', async () => {
    let attempts = 0;
    const started = Date.now();
    const apiError = { message: 'Not found', code: 'NOT_FOUND', status: 404 };

    await expect(
      retryAsync(async () => {
        attempts++;
        throw apiError;
      }, 3, 50)
    ).rejects.toBe(apiError);

    expect(attempts).toBe(1);
    // Sanity: we should NOT have slept through any backoff windows.
    expect(Date.now() - started).toBeLessThan(100);
  });

  it('does not retry on an axios-style nested 404 (response.status)', async () => {
    let attempts = 0;
    const axiosError = {
      message: 'Not found',
      response: { status: 404, statusText: 'Not Found' },
    };

    await expect(
      retryAsync(async () => {
        attempts++;
        throw axiosError;
      }, 3, 50)
    ).rejects.toBe(axiosError);

    expect(attempts).toBe(1);
  });

  it('does not retry on any 4xx flat-shape (400/401/403/422)', async () => {
    for (const status of [400, 401, 403, 422]) {
      let attempts = 0;
      await expect(
        retryAsync(async () => {
          attempts++;
          throw { message: 'client', code: 'X', status };
        }, 2, 10)
      ).rejects.toBeDefined();
      expect(attempts).toBe(1);
    }
  });

  it('retries on flat-shape 500 errors until maxRetries', async () => {
    let attempts = 0;
    await expect(
      retryAsync(async () => {
        attempts++;
        throw { message: 'boom', code: 'INTERNAL_ERROR', status: 500 };
      }, 2, 1)
    ).rejects.toBeDefined();
    expect(attempts).toBe(3); // initial + 2 retries
  });

  it('retries on nested-shape 503 errors until maxRetries', async () => {
    let attempts = 0;
    await expect(
      retryAsync(async () => {
        attempts++;
        throw { message: 'unavailable', response: { status: 503 } };
      }, 2, 1)
    ).rejects.toBeDefined();
    expect(attempts).toBe(3);
  });

  it('retries on network-style errors without any status (TypeError)', async () => {
    let attempts = 0;
    await expect(
      retryAsync(async () => {
        attempts++;
        throw new TypeError('Failed to fetch');
      }, 2, 1)
    ).rejects.toBeDefined();
    expect(attempts).toBe(3);
  });

  it('returns the successful result without extra attempts', async () => {
    let attempts = 0;
    const result = await retryAsync(async () => {
      attempts++;
      return 'ok' as const;
    }, 3, 1);
    expect(result).toBe('ok');
    expect(attempts).toBe(1);
  });

  it('recovers after a transient 5xx followed by success', async () => {
    let attempts = 0;
    const result = await retryAsync(async () => {
      attempts++;
      if (attempts < 2) {
        throw { message: 'transient', status: 502 };
      }
      return 'recovered' as const;
    }, 3, 1);
    expect(result).toBe('recovered');
    expect(attempts).toBe(2);
  });

  it('honours a custom shouldRetry predicate even when default would retry', async () => {
    let attempts = 0;
    await expect(
      retryAsync(
        async () => {
          attempts++;
          throw { message: 'nope', status: 500 };
        },
        5,
        1,
        () => false
      )
    ).rejects.toBeDefined();
    expect(attempts).toBe(1);
  });

  it('ignores non-numeric status fields instead of treating them as 4xx', async () => {
    let attempts = 0;
    await expect(
      retryAsync(async () => {
        attempts++;
        throw { message: 'weird', status: 'oops' as unknown as number };
      }, 2, 1)
    ).rejects.toBeDefined();
    // Non-numeric status must NOT be interpreted as 4xx — should retry normally.
    expect(attempts).toBe(3);
  });
});

/**
 * handleHttpError is the wire between fetch-thrown errors and retryAsync.
 * Lock in that it exposes the HTTP status at the top level so the retry
 * predicate above can see it.
 */
describe('handleHttpError preserves HTTP status for retry predicates', () => {
  it('flattens a fetch-style error with .response.status into ApiError.status', () => {
    const fetchError = Object.assign(new Error('Not found'), {
      status: 404,
      response: { status: 404, statusText: 'Not Found' },
    });
    const result = handleHttpError(fetchError);
    expect(result.status).toBe(404);
    expect(result.code).toBe('NOT_FOUND');
    expect(result.message).toBe('Not found');
  });

  it('preserves 401 status from fetch errors', () => {
    const fetchError = Object.assign(new Error('Unauthorized'), {
      status: 401,
      response: { status: 401, statusText: 'Unauthorized' },
    });
    const result = handleHttpError(fetchError);
    expect(result.status).toBe(401);
    expect(result.code).toBe('UNAUTHORIZED');
  });

  it('maps 500 to INTERNAL_ERROR with status preserved', () => {
    const fetchError = Object.assign(new Error('boom'), {
      status: 500,
      response: { status: 500, statusText: 'Internal Server Error' },
    });
    const result = handleHttpError(fetchError);
    expect(result.status).toBe(500);
    expect(result.code).toBe('INTERNAL_ERROR');
  });
});

describe('retryAsync refuses to retry a cancellation', () => {
  it('stops after one attempt on a cancellation, whatever the retry budget', async () => {
    const operation = jest.fn(async () => { throw createCancelledError(); });

    await expect(retryAsync(operation, { maxRetries: 3, baseDelay: 1 })).rejects.toMatchObject({
      code: ErrorCodes.CANCELLED,
    });
    // This is the defect in one assertion: a cancellation carries no HTTP
    // status, `status: 0` is not 4xx, so the status-only predicate passed it
    // into the retry loop and the SDK re-issued abandoned requests.
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it('refuses a cancellation even when a custom shouldRetry says yes', async () => {
    const operation = jest.fn(async () => { throw createCancelledError(); });

    await expect(
      retryAsync(operation, { maxRetries: 3, baseDelay: 1, shouldRetry: () => true }),
    ).rejects.toBeDefined();
    // A custom predicate decides which FAILURES deserve another attempt. It has
    // no business overriding an explicit instruction to stop.
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it('treats a bare AbortError as a cancellation', async () => {
    const operation = jest.fn(async () => {
      throw new DOMException('The operation was aborted.', 'AbortError');
    });

    await expect(retryAsync(operation, { maxRetries: 3, baseDelay: 1 })).rejects.toBeDefined();
    // An unclassified abort is assumed to be a cancellation: refusing to retry
    // something abandoned costs nothing, retrying it is the bug.
    expect(operation).toHaveBeenCalledTimes(1);
  });
});

describe('retryAsync timeout policy', () => {
  afterEach(() => { jest.restoreAllMocks(); });

  const timeoutError = (): Error => {
    const error = new Error('timed out') as Error & { code?: string; timeout?: boolean; status?: number };
    error.code = ErrorCodes.TIMEOUT;
    error.timeout = true;
    error.status = 0;
    return error;
  };

  it('does not retry a timeout by default', async () => {
    const operation = jest.fn(async () => { throw timeoutError(); });

    await expect(retryAsync(operation, { maxRetries: 3, baseDelay: 1 })).rejects.toBeDefined();
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it('retries a timeout when asked to', async () => {
    const operation = jest.fn(async () => { throw timeoutError(); });

    await expect(
      retryAsync(operation, { maxRetries: 2, baseDelay: 1, retryOnTimeout: true }),
    ).rejects.toBeDefined();
    expect(operation).toHaveBeenCalledTimes(3);
  });

  it('stops at the deadline rather than at the attempt budget', async () => {
    // Jitter pinned so the backoff is exactly baseDelay * 2**attempt; otherwise
    // this measures Math.random() rather than the deadline.
    jest.spyOn(Math, 'random').mockReturnValue(0);
    const operation = jest.fn(async () => { throw new Error('5xx-ish'); });

    const started = Date.now();
    await expect(
      retryAsync(operation, { maxRetries: 10, baseDelay: 50, deadline: Date.now() + 120 }),
    ).rejects.toBeDefined();

    // The point of a deadline: the wall clock a caller feels is bounded by a
    // budget it stated, not by arithmetic over attempts x timeout + backoff.
    expect(Date.now() - started).toBeLessThan(400);
    expect(operation.mock.calls.length).toBeLessThan(11);
  });
});

describe('retryAsync keeps its positional signature working', () => {
  it('accepts the legacy (operation, maxRetries, baseDelay, shouldRetry) call', async () => {
    const operation = jest.fn(async () => { throw new Error('transient'); });

    await expect(retryAsync(operation, 2, 1)).rejects.toThrow('transient');
    // In-tree callers pass positionally, so the options object had to be an
    // overload rather than a replacement.
    expect(operation).toHaveBeenCalledTimes(3);
  });
});
