import { useEffect, useRef } from 'react';

import { useOxyRuntime, useRuntimeSelector, type OxyRuntimeSnapshot } from '../runtime';

export type OxyProductEvent =
  | 'oxy_auth_resolved'
  | 'oxy_session_started'
  | 'oxy_session_ended'
  | 'oxy_account_switched';

export interface ProductAnalytics {
  capture(event: OxyProductEvent, properties?: Readonly<Record<string, boolean | number | string>>): void;
  identify(distinctId: string): void;
  reset(): void;
}

/**
 * Loads a vendor SDK only after the first analytics operation. Calls retain
 * their original order and loader failures remain outside the product runtime.
 */
export function createDeferredProductAnalytics(
  load: () => Promise<ProductAnalytics>,
): ProductAnalytics {
  let clientPromise: Promise<ProductAnalytics> | null = null;
  const withClient = (operation: (client: ProductAnalytics) => void): void => {
    clientPromise ??= load();
    void clientPromise.then(operation).catch(() => undefined);
  };

  return {
    capture: (event, properties) => withClient((client) => client.capture(event, properties)),
    identify: (distinctId) => withClient((client) => client.identify(distinctId)),
    reset: () => withClient((client) => client.reset()),
  };
}

interface AnalyticsAuthState {
  authResolved: boolean;
  userId: string | null;
}

const selectAnalyticsAuthState = (snapshot: OxyRuntimeSnapshot): AnalyticsAuthState => ({
  authResolved: snapshot.authResolved,
  userId: snapshot.account?.id ?? null,
});

const analyticsAuthStatesEqual = (left: AnalyticsAuthState, right: AnalyticsAuthState): boolean =>
  left.authResolved === right.authResolved && left.userId === right.userId;

/**
 * Emits a deliberately small, non-sensitive auth lifecycle vocabulary.
 * Analytics is observational only: failures are isolated and can never affect
 * authentication, rendering, or account switching.
 */
export function ProductAnalyticsObserver({ analytics }: { analytics?: ProductAnalytics }): null {
  const runtime = useOxyRuntime();
  const state = useRuntimeSelector(runtime, selectAnalyticsAuthState, analyticsAuthStatesEqual);
  const previousRef = useRef<AnalyticsAuthState | null>(null);

  useEffect(() => {
    if (!analytics || !state.authResolved) return;

    const previous = previousRef.current;
    recordAuthStateChange(analytics, previous, state);
    previousRef.current = state;
  }, [analytics, state]);

  return null;
}

function safelyRecord(action: () => void): void {
  try {
    action();
  } catch {
    // Product analytics must never enter the authentication failure domain.
  }
}

function identify(analytics: ProductAnalytics, userId: string): void {
  safelyRecord(() => analytics.identify(userId));
}

function capture(
  analytics: ProductAnalytics,
  event: OxyProductEvent,
  properties?: Readonly<Record<string, boolean | number | string>>,
): void {
  safelyRecord(() => analytics.capture(event, properties));
}

export function recordAuthStateChange(
  analytics: ProductAnalytics,
  previous: AnalyticsAuthState | null,
  current: AnalyticsAuthState,
): void {
  if (!previous) {
    if (current.userId) identify(analytics, current.userId);
    capture(analytics, 'oxy_auth_resolved', { authenticated: current.userId !== null });
    return;
  }

  if (previous.userId === current.userId) return;
  if (!current.userId) {
    capture(analytics, 'oxy_session_ended');
    safelyRecord(() => analytics.reset());
    return;
  }

  identify(analytics, current.userId);
  capture(
    analytics,
    previous.userId ? 'oxy_account_switched' : 'oxy_session_started',
  );
}
