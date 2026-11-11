import {
  createQueryClient,
  queryRetryDelay,
  shouldRetryQuery,
} from '../../src/ui/hooks/queryClient';

describe('query retry policy', () => {
  it.each([400, 401, 403, 404, 409, 422])('does not retry permanent HTTP %s', (status) => {
    expect(shouldRetryQuery(0, { status })).toBe(false);
  });

  it.each([408, 425, 429, 500, 502, 503])('retries transient HTTP %s within budget', (status) => {
    expect(shouldRetryQuery(0, { status })).toBe(true);
    expect(shouldRetryQuery(2, { status })).toBe(false);
  });

  it('recognizes axios-shaped statuses and transport failures', () => {
    expect(shouldRetryQuery(0, { response: { status: 503 } })).toBe(true);
    expect(shouldRetryQuery(0, new TypeError('network failed'))).toBe(true);
  });

  describe('a 429 that names a wait (Retry-After)', () => {
    const asks = (seconds: number) => ({ status: 429, details: { retryAfterSeconds: seconds } });

    it('waits what it asked for, not the backoff', () => {
      expect(queryRetryDelay(0, asks(7))).toBe(7000);
      expect(queryRetryDelay(1, asks(7))).toBe(7000);
      expect(
        queryRetryDelay(1, { response: { data: { details: { retryAfterSeconds: 3 } } } }),
      ).toBe(3000);
    });

    it('falls back to exponential backoff when it names none', () => {
      expect(queryRetryDelay(0, { status: 429 })).toBe(1000);
      expect(queryRetryDelay(1, { status: 503 })).toBe(2000);
      expect(queryRetryDelay(9, new TypeError('network failed'))).toBe(30000);
    });

    it('is retried when the wait is one a query can hold, and fails at once when it is not', () => {
      expect(shouldRetryQuery(0, asks(30))).toBe(true);
      expect(shouldRetryQuery(0, asks(31))).toBe(false);
    });
  });

  it('never retries generic mutations by default', () => {
    expect(createQueryClient().getDefaultOptions().mutations?.retry).toBe(false);
  });
});
