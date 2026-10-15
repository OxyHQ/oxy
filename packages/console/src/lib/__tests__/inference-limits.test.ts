import { describe, expect, it } from 'vitest';
import { limitsFromForm, limitsToForm } from '../inference-limits';

const empty = {
  maxConcurrentRealtimeSessions: '',
  maxConcurrentRealtimeSessionsPerCredential: '',
  maxConcurrentRequests: '',
  maxRequestsPerUtcDay: '',
};

describe('inference limits form', () => {
  it('reads empty fields as unset limits', () => {
    expect(limitsFromForm(empty)).toEqual({
      limits: {
        maxConcurrentRealtimeSessions: null,
        maxConcurrentRealtimeSessionsPerCredential: null,
        maxConcurrentRequests: null,
        maxRequestsPerUtcDay: null,
      },
    });
  });

  it('round-trips written limits', () => {
    const limits = {
      maxConcurrentRealtimeSessions: 8,
      maxConcurrentRealtimeSessionsPerCredential: 2,
      maxConcurrentRequests: null,
      maxRequestsPerUtcDay: 5000,
    };
    expect(limitsFromForm(limitsToForm(limits))).toEqual({ limits });
  });

  it.each([
    ['a fraction', { maxConcurrentRequests: '1.5' }],
    ['zero', { maxConcurrentRequests: '0' }],
    ['a value over the ceiling', { maxRequestsPerUtcDay: '1000001' }],
    [
      'a per-credential limit above the application’s',
      { maxConcurrentRealtimeSessions: '2', maxConcurrentRealtimeSessionsPerCredential: '3' },
    ],
  ])('refuses %s', (_name, overrides) => {
    expect(limitsFromForm({ ...empty, ...overrides })).toHaveProperty('error');
  });
});
