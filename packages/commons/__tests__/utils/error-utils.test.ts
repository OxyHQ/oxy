import { ErrorCodes } from '@oxy.so/core';
import {
  extractAuthErrorMessage,
  handleAuthError,
  isNetworkOrTimeoutError,
} from '@/utils/auth/errorUtils';

// handleHttpError treats objects with both `code` AND `status` fields as
// already-formed ApiError instances; we use that shape throughout these tests.

describe('isNetworkOrTimeoutError', () => {
  it('returns true for explicit network errors', () => {
    expect(
      isNetworkOrTimeoutError({
        code: ErrorCodes.NETWORK_ERROR,
        status: 0,
        message: 'offline',
      }),
    ).toBe(true);
  });

  it('returns true for timeout errors', () => {
    expect(
      isNetworkOrTimeoutError({
        code: ErrorCodes.TIMEOUT,
        status: 0,
        message: 'timed out',
      }),
    ).toBe(true);
  });

  it('returns true for connection failed errors', () => {
    expect(
      isNetworkOrTimeoutError({
        code: ErrorCodes.CONNECTION_FAILED,
        status: 0,
        message: 'cant connect',
      }),
    ).toBe(true);
  });

  it('returns false for a 4xx HTTP error', () => {
    expect(
      isNetworkOrTimeoutError({
        code: ErrorCodes.NOT_FOUND,
        status: 404,
        message: 'Not found',
      }),
    ).toBe(false);
  });

  it('returns false for a 500 HTTP error', () => {
    expect(
      isNetworkOrTimeoutError({
        code: ErrorCodes.INTERNAL_ERROR,
        status: 500,
        message: 'Internal error',
      }),
    ).toBe(false);
  });
});

describe('extractAuthErrorMessage', () => {
  it('returns the message from a real Error instance', () => {
    expect(extractAuthErrorMessage(new Error('Invalid credentials'))).toBe('Invalid credentials');
  });

  it('returns the message of a pre-formed ApiError shape', () => {
    expect(
      extractAuthErrorMessage({
        code: ErrorCodes.UNAUTHORIZED,
        status: 401,
        message: 'Invalid credentials',
      }),
    ).toBe('Invalid credentials');
  });

  it('handles undefined input without throwing', () => {
    expect(() => extractAuthErrorMessage(undefined)).not.toThrow();
  });

  it('returns a non-empty string for undefined input', () => {
    // handleHttpError always returns a non-empty message; the fallback only
    // kicks in if the resolved ApiError itself has an empty `.message`.
    expect(extractAuthErrorMessage(undefined).length).toBeGreaterThan(0);
  });
});

describe('handleAuthError', () => {
  it('returns the underlying Error message', () => {
    expect(handleAuthError(new Error('Bad credentials'), 'login')).toBe('Bad credentials');
  });

  it('returns a non-empty string for unknown input', () => {
    expect(handleAuthError({ unexpected: 'shape' }, 'login').length).toBeGreaterThan(0);
  });

  it('does not throw when given a plain string', () => {
    expect(() => handleAuthError('boom', 'signup')).not.toThrow();
  });
});
