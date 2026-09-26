/**
 * Network Utility Functions
 *
 * Consolidated network utilities including circuit breaker pattern
 * and exponential backoff for resilient API calls.
 *
 * @module shared/utils/networkUtils
 */

/**
 * State for circuit breaker pattern.
 */
export interface CircuitBreakerState {
  /** Number of consecutive failures */
  consecutiveFailures: number;
  /** Current interval between retries (ms) */
  currentInterval: number;
  /** Base interval for retries (ms) */
  baseInterval: number;
  /** Maximum interval cap (ms) */
  maxInterval: number;
  /** Number of failures before circuit opens */
  maxFailures: number;
  /** Whether the circuit is currently open (blocking requests) */
  isOpen?: boolean;
  /** Timestamp when circuit was opened */
  openedAt?: number;
}

/**
 * Configuration for circuit breaker.
 */
export interface CircuitBreakerConfig {
  /** Base interval between retries in milliseconds. Default: 10000 (10s) */
  baseInterval?: number;
  /** Maximum interval cap in milliseconds. Default: 60000 (60s) */
  maxInterval?: number;
  /** Number of consecutive failures before opening circuit. Default: 5 */
  maxFailures?: number;
  /** Time to wait before attempting recovery in milliseconds. Default: 30000 (30s) */
  recoveryTimeout?: number;
}

/**
 * Default circuit breaker configuration.
 */
export const DEFAULT_CIRCUIT_BREAKER_CONFIG: Required<CircuitBreakerConfig> = {
  baseInterval: 10000,
  maxInterval: 60000,
  maxFailures: 5,
  recoveryTimeout: 30000,
};

/**
 * Creates initial circuit breaker state.
 *
 * @param config - Optional custom configuration
 * @returns Initial circuit breaker state
 *
 * @example
 * ```ts
 * const state = createCircuitBreakerState({ maxFailures: 3 });
 * ```
 */
export const createCircuitBreakerState = (
  config: CircuitBreakerConfig = {}
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
    isOpen: false,
  };
};

/**
 * Calculates next interval using exponential backoff.
 *
 * @param state - Current circuit breaker state
 * @returns Next interval in milliseconds
 *
 * @example
 * ```ts
 * const nextInterval = calculateBackoffInterval(state);
 * await delay(nextInterval);
 * ```
 */
export const calculateBackoffInterval = (state: CircuitBreakerState): number => {
  const { consecutiveFailures, baseInterval, maxInterval } = state;

  if (consecutiveFailures === 0) return baseInterval;

  const backoffMultiplier = Math.min(
    2 ** (consecutiveFailures - 1),
    maxInterval / baseInterval
  );

  return Math.min(baseInterval * backoffMultiplier, maxInterval);
};

/**
 * Records a failure and updates circuit breaker state.
 *
 * @param state - Current circuit breaker state
 * @returns Updated state after recording failure
 *
 * @example
 * ```ts
 * try {
 *   await apiCall();
 *   state = recordSuccess(state);
 * } catch (error) {
 *   state = recordFailure(state);
 * }
 * ```
 */
export const recordFailure = (state: CircuitBreakerState): CircuitBreakerState => {
  const newFailures = state.consecutiveFailures + 1;
  const newInterval = calculateBackoffInterval({
    ...state,
    consecutiveFailures: newFailures,
  });

  const shouldOpenCircuit = newFailures >= state.maxFailures;
  const finalInterval = shouldOpenCircuit ? state.maxInterval : newInterval;

  return {
    ...state,
    consecutiveFailures: newFailures,
    currentInterval: finalInterval,
    isOpen: shouldOpenCircuit,
    openedAt: shouldOpenCircuit ? Date.now() : state.openedAt,
  };
};

/**
 * Records a success and resets circuit breaker state.
 *
 * @param state - Current circuit breaker state
 * @returns Reset state after successful request
 */
export const recordSuccess = (state: CircuitBreakerState): CircuitBreakerState => {
  return {
    ...state,
    consecutiveFailures: 0,
    currentInterval: state.baseInterval,
    isOpen: false,
    openedAt: undefined,
  };
};

/**
 * Checks if the circuit breaker should allow a request.
 *
 * When the circuit is open, it will only allow requests after
 * the recovery timeout has passed (half-open state).
 *
 * @param state - Current circuit breaker state
 * @param recoveryTimeout - Time to wait before allowing recovery attempts
 * @returns true if request should be allowed
 */
export const shouldAllowRequest = (
  state: CircuitBreakerState,
  recoveryTimeout: number = DEFAULT_CIRCUIT_BREAKER_CONFIG.recoveryTimeout
): boolean => {
  if (!state.isOpen) return true;

  if (!state.openedAt) return true;

  const timeSinceOpen = Date.now() - state.openedAt;
  return timeSinceOpen >= recoveryTimeout;
};

/**
 * Delays execution for a specified duration.
 *
 * @param ms - Milliseconds to delay
 * @returns Promise that resolves after the delay
 *
 * @example
 * ```ts
 * await delay(1000); // Wait 1 second
 * ```
 */
export const delay = (ms: number): Promise<void> =>
  new Promise(resolve => setTimeout(resolve, ms));

/**
 * Executes a function with exponential backoff retry.
 *
 * @param fn - Async function to execute
 * @param options - Retry options
 * @returns Result of the function
 * @throws Last error if all retries fail
 *
 * @example
 * ```ts
 * const result = await withRetry(
 *   () => fetchData(),
 *   { maxRetries: 3, baseDelay: 1000 }
 * );
 * ```
 */
export const withRetry = async <T>(
  fn: () => Promise<T>,
  options: {
    maxRetries?: number;
    baseDelay?: number;
    maxDelay?: number;
    shouldRetry?: (error: unknown) => boolean;
    onRetry?: (error: unknown, attempt: number) => void;
  } = {}
): Promise<T> => {
  const {
    maxRetries = 3,
    baseDelay = 1000,
    maxDelay = 30000,
    shouldRetry = () => true,
    onRetry,
  } = options;

  let lastError: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;

      if (attempt === maxRetries || !shouldRetry(error)) {
        throw error;
      }

      const delayMs = Math.min(baseDelay * 2 ** attempt, maxDelay);
      onRetry?.(error, attempt + 1);
      await delay(delayMs);
    }
  }

  throw lastError;
};
