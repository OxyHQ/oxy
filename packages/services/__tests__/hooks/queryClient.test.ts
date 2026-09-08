import { createQueryClient, shouldRetryQuery } from '../../src/ui/hooks/queryClient';

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

  it('never retries generic mutations by default', () => {
    expect(createQueryClient().getDefaultOptions().mutations?.retry).toBe(false);
  });
});
