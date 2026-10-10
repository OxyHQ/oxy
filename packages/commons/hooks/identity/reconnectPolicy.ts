/**
 * Network utilities for circuit breaker and exponential backoff.
 */

export interface CircuitBreakerState {
  consecutiveFailures: number;
  currentInterval: number;
  baseInterval: number;
  maxInterval: number;
  maxFailures: number;
}

export const DEFAULT_CIRCUIT_BREAKER_CONFIG = {
  baseInterval: 10000, // 10 seconds
  maxInterval: 60000, // 60 seconds
  maxFailures: 5, // Circuit breaker threshold
};

/**
 * Create initial circuit breaker state.
 */
export const createCircuitBreakerState = (
  config: Partial<typeof DEFAULT_CIRCUIT_BREAKER_CONFIG> = {},
): CircuitBreakerState => {
  const { baseInterval, maxInterval, maxFailures } = {
    ...DEFAULT_CIRCUIT_BREAKER_CONFIG,
    ...config,
  };

  return {
    consecutiveFailures: 0,
    currentInterval: baseInterval,
    baseInterval,
    maxInterval,
    maxFailures,
  };
};

/**
 * Calculate next interval with exponential backoff.
 */
export const calculateBackoffInterval = (state: CircuitBreakerState): number => {
  const { consecutiveFailures, baseInterval, maxInterval } = state;

  // Calculate exponential backoff multiplier
  const backoffMultiplier = Math.min(
    Math.pow(2, consecutiveFailures - 1),
    maxInterval / baseInterval,
  );

  // Calculate new interval, capped at maxInterval
  const newInterval = Math.min(baseInterval * backoffMultiplier, maxInterval);

  return newInterval;
};

/**
 * Update circuit breaker state after a failure.
 */
export const recordFailure = (state: CircuitBreakerState): CircuitBreakerState => {
  const newFailures = state.consecutiveFailures + 1;
  const newInterval = calculateBackoffInterval({
    ...state,
    consecutiveFailures: newFailures,
  });

  // If we hit the circuit breaker threshold, use max interval
  const finalInterval = newFailures >= state.maxFailures ? state.maxInterval : newInterval;

  return {
    ...state,
    consecutiveFailures: newFailures,
    currentInterval: finalInterval,
  };
};

/**
 * Reset circuit breaker state after a success.
 */
export const recordSuccess = (state: CircuitBreakerState): CircuitBreakerState => {
  return {
    ...state,
    consecutiveFailures: 0,
    currentInterval: state.baseInterval,
  };
};
