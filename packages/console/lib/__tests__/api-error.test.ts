import { classifyApiError, getErrorMessage } from '../api-error';

const withStatus = (status?: number) => Object.assign(new Error('x'), { status });

describe('classifyApiError', () => {
  it.each([
    [403, 'forbidden'],
    [404, 'missing'],
    [409, 'conflict'],
    [429, 'rateLimited'],
    [503, 'unavailable'],
    [500, 'unknown'],
  ])('maps %s to %s', (status, kind) => {
    expect(classifyApiError(withStatus(status))).toBe(kind);
  });

  it('treats an error without a status as unreachable', () => {
    expect(classifyApiError(withStatus())).toBe('unreachable');
  });

  it('treats a non-error as unknown', () => {
    expect(classifyApiError('boom')).toBe('unknown');
  });
});

describe('getErrorMessage', () => {
  const failed = (message: string, status?: number) => Object.assign(new Error(message), { status });

  it('keeps the sentence of a refusal the API authored', () => {
    expect(getErrorMessage(failed('Name is taken', 409), 'fallback')).toBe('Name is taken');
  });

  it('keeps the message of an error the console raised itself', () => {
    expect(getErrorMessage(failed('Image is too large'), 'fallback')).toBe('Image is too large');
  });

  it.each([500, 502, 503, 0])('never prints the message of a %s', (status) => {
    expect(getErrorMessage(failed('upstream exploded', status), 'fallback')).toBe('fallback');
  });

  it('never prints the SDK serialisation of an object', () => {
    expect(getErrorMessage(failed('[object Object]', 400), 'fallback')).toBe('fallback');
  });

  it('falls back for anything that is not an error', () => {
    expect(getErrorMessage('boom', 'fallback')).toBe('fallback');
    expect(getErrorMessage(new Error(''), 'fallback')).toBe('fallback');
  });
});
