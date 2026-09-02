/**
 * Tests for the central auth-error utilities.
 *
 * These predicates flow into `useAuthOperations.logout`'s 401 fast-path
 * (it clears local state when the targeted session is invalid) and into
 * the SessionSocket's offline retry budget. A regression in
 * `isInvalidSessionError` would either log users out on transient errors
 * (false positive) or strand them on a dead session (false negative).
 */

import {
  extractErrorMessage,
  handleAuthError,
  isInvalidSessionError,
  isTimeoutOrNetworkError,
} from '../../src/ui/utils/errorHandlers';

describe('isInvalidSessionError', () => {
  it('returns true when response.status === 401', () => {
    expect(isInvalidSessionError({ response: { status: 401 } })).toBe(true);
  });

  it('returns true when error.status === 401 (HttpService shape)', () => {
    expect(isInvalidSessionError({ status: 401, message: 'unauthorized' })).toBe(true);
  });

  it('returns true when the message contains "HTTP 401:"', () => {
    expect(isInvalidSessionError({ message: 'HTTP 401: invalid' })).toBe(true);
  });

  it('matches every known invalid-session phrasing', () => {
    const messages = [
      'Invalid or expired session',
      'Session is invalid',
      'Session not found',
      'Session expired',
    ];
    for (const message of messages) {
      expect(isInvalidSessionError({ message })).toBe(true);
    }
  });

  it('returns false for unrelated 4xx', () => {
    expect(isInvalidSessionError({ response: { status: 404 }, message: 'Not Found' })).toBe(false);
  });

  it('returns false for 5xx server errors', () => {
    expect(isInvalidSessionError({ response: { status: 500 }, message: 'boom' })).toBe(false);
  });

  it('returns false for non-object errors (string / null / number)', () => {
    expect(isInvalidSessionError('something went wrong')).toBe(false);
    expect(isInvalidSessionError(null)).toBe(false);
    expect(isInvalidSessionError(42)).toBe(false);
  });
});

describe('isTimeoutOrNetworkError', () => {
  it('returns true for axios-style ECONNABORTED', () => {
    expect(isTimeoutOrNetworkError({ code: 'ECONNABORTED', message: 'timeout' })).toBe(true);
  });

  it('returns true for TIMEOUT / NETWORK_ERROR codes', () => {
    expect(isTimeoutOrNetworkError({ code: 'TIMEOUT', message: 'x' })).toBe(true);
    expect(isTimeoutOrNetworkError({ code: 'NETWORK_ERROR', message: 'x' })).toBe(true);
  });

  it('returns true for AbortError', () => {
    const err = new Error('aborted');
    err.name = 'AbortError';
    expect(isTimeoutOrNetworkError(err)).toBe(true);
  });

  it('returns true for fetch TypeErrors', () => {
    expect(isTimeoutOrNetworkError(new TypeError('Failed to fetch'))).toBe(true);
    expect(isTimeoutOrNetworkError(new TypeError('Network request failed'))).toBe(true);
  });

  it('matches timeout / cancelled phrasing in the message body', () => {
    expect(isTimeoutOrNetworkError({ message: 'Request timeout or cancelled' })).toBe(true);
  });

  it('returns false for a regular 500 error', () => {
    expect(isTimeoutOrNetworkError({ status: 500, message: 'server error' })).toBe(false);
  });

  it('returns false for primitives', () => {
    expect(isTimeoutOrNetworkError(undefined)).toBe(false);
    expect(isTimeoutOrNetworkError('foo')).toBe(false);
    expect(isTimeoutOrNetworkError(123)).toBe(false);
  });
});

describe('extractErrorMessage', () => {
  it('returns the string when given a non-empty string', () => {
    expect(extractErrorMessage('boom')).toBe('boom');
  });

  it('returns the fallback for empty strings', () => {
    expect(extractErrorMessage('', 'fallback')).toBe('fallback');
  });

  it('prefers error.message when present', () => {
    expect(extractErrorMessage({ message: 'real' })).toBe('real');
  });

  it('falls back to response.data.message then response.data.error', () => {
    expect(
      extractErrorMessage({ response: { data: { message: 'server says no' } } }),
    ).toBe('server says no');
    expect(
      extractErrorMessage({ response: { data: { error: 'fallback error' } } }),
    ).toBe('fallback error');
  });

  it('returns the fallback when no message can be located', () => {
    expect(extractErrorMessage({}, 'fallback')).toBe('fallback');
    expect(extractErrorMessage(undefined, 'fallback')).toBe('fallback');
  });
});

describe('handleAuthError', () => {
  it('reports a normalized ApiError to onError', () => {
    const onError = jest.fn();
    const setAuthError = jest.fn();
    const logger = jest.fn();

    const message = handleAuthError(
      { response: { status: 401 }, message: 'expired' },
      {
        defaultMessage: 'Sign-in failed',
        code: 'LOGIN_ERROR',
        onError,
        setAuthError,
        logger,
      },
    );

    expect(message).toBe('expired');
    expect(setAuthError).toHaveBeenCalledWith('expired');
    expect(logger).toHaveBeenCalledWith('expired', expect.any(Object));
    expect(onError).toHaveBeenCalledWith({
      message: 'expired',
      code: 'LOGIN_ERROR',
      status: 401,
    });
  });

  it('reads the status off a flat ApiError (the shape every SDK request failure has)', () => {
    // `handleHttpError` in @oxyhq/core rejects with `{ message, code, status }`
    // and NO `response` wrapper, so a status read that only looked at
    // `response.status` reported every real SDK failure as 500.
    const onError = jest.fn();
    handleAuthError({ message: 'Service unavailable', code: 'SERVICE_UNAVAILABLE', status: 503 }, {
      defaultMessage: 'fail',
      code: 'X',
      onError,
    });
    expect(onError).toHaveBeenCalledWith({
      message: 'Service unavailable',
      code: 'X',
      status: 503,
    });
  });

  it('defaults status to 500 for unknown errors and uses the default message', () => {
    const onError = jest.fn();
    const message = handleAuthError(undefined, {
      defaultMessage: 'Something exploded',
      code: 'X',
      onError,
    });
    expect(message).toBe('Something exploded');
    expect(onError).toHaveBeenCalledWith({
      message: 'Something exploded',
      code: 'X',
      status: 500,
    });
  });

  it('honors a caller-supplied status over inference', () => {
    const onError = jest.fn();
    handleAuthError({ message: 'rate limited' }, {
      defaultMessage: 'fail',
      code: 'X',
      status: 429,
      onError,
    });
    expect(onError).toHaveBeenCalledWith({
      message: 'rate limited',
      code: 'X',
      status: 429,
    });
  });
});
