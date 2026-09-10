import {
  createDeferredProductAnalytics,
  recordAuthStateChange,
  type ProductAnalytics,
} from '../../src/ui/analytics/productAnalytics';

function createAnalytics(): ProductAnalytics & {
  capture: jest.Mock;
  identify: jest.Mock;
  reset: jest.Mock;
} {
  return {
    capture: jest.fn(),
    identify: jest.fn(),
    reset: jest.fn(),
  };
}

describe('product analytics auth transitions', () => {
  it('loads the vendor lazily and preserves operation order', async () => {
    const operations: string[] = [];
    const load = jest.fn(async (): Promise<ProductAnalytics> => ({
      capture: (event) => operations.push(`capture:${event}`),
      identify: (id) => operations.push(`identify:${id}`),
      reset: () => operations.push('reset'),
    }));
    const analytics = createDeferredProductAnalytics(load);

    expect(load).not.toHaveBeenCalled();
    analytics.identify('user-a');
    analytics.capture('oxy_session_started');
    analytics.reset();
    await Promise.resolve();
    await Promise.resolve();

    expect(load).toHaveBeenCalledTimes(1);
    expect(operations).toEqual([
      'identify:user-a',
      'capture:oxy_session_started',
      'reset',
    ]);
  });

  it('emits only the explicit, non-sensitive lifecycle vocabulary', () => {
    const analytics = createAnalytics();

    recordAuthStateChange(analytics, null, { authResolved: true, userId: null });
    recordAuthStateChange(
      analytics,
      { authResolved: true, userId: null },
      { authResolved: true, userId: 'user-a' },
    );
    recordAuthStateChange(
      analytics,
      { authResolved: true, userId: 'user-a' },
      { authResolved: true, userId: 'user-b' },
    );
    recordAuthStateChange(
      analytics,
      { authResolved: true, userId: 'user-b' },
      { authResolved: true, userId: null },
    );

    expect(analytics.capture.mock.calls).toEqual([
      ['oxy_auth_resolved', { authenticated: false }],
      ['oxy_session_started', undefined],
      ['oxy_account_switched', undefined],
      ['oxy_session_ended', undefined],
    ]);
    expect(analytics.identify.mock.calls).toEqual([['user-a'], ['user-b']]);
    expect(analytics.reset).toHaveBeenCalledTimes(1);
  });

  it('isolates analytics failures from authentication state changes', () => {
    const analytics = createAnalytics();
    analytics.identify.mockImplementation(() => {
      throw new Error('collector unavailable');
    });
    analytics.capture.mockImplementation(() => {
      throw new Error('collector unavailable');
    });

    expect(() => recordAuthStateChange(analytics, null, {
      authResolved: true,
      userId: 'user-a',
    })).not.toThrow();
  });
});
