import { logger } from './logger';

interface RateLimitConfig {
  maxRequests: number;
  windowMs: number;
  retryAfterMs: number;
}

interface RateLimitState {
  requests: number[];
  blockedUntil?: number;
}

class ApiRateLimiter {
  private limits: Map<string, RateLimitState> = new Map();
  private config: RateLimitConfig;
  /**
   * Until when the upstream itself refused us (its 429's `Retry-After`).
   * Every key waits for it: asking again inside the window it stated only
   * extends the block.
   */
  private upstreamRefusedUntil = 0;

  constructor(config: Partial<RateLimitConfig> = {}) {
    this.config = {
      maxRequests: 1, // 1 request per window by default
      windowMs: 1000, // 1 second window
      retryAfterMs: 1000, // 1 second retry after
      ...config,
    };
  }

  /**
   * Check if a request is allowed for the given key
   */
  isAllowed(key: string): { allowed: boolean; retryAfter?: number } {
    const now = Date.now();
    const state = this.limits.get(key) || { requests: [] };

    // Check if currently blocked
    if (state.blockedUntil && now < state.blockedUntil) {
      return {
        allowed: false,
        retryAfter: state.blockedUntil - now,
      };
    }

    // Clean old requests outside the window
    const windowStart = now - this.config.windowMs;
    state.requests = state.requests.filter((timestamp) => timestamp > windowStart);

    // Check if we're within the limit
    if (state.requests.length >= this.config.maxRequests) {
      // Block until the oldest request expires
      const oldestRequest = Math.min(...state.requests);
      const blockUntil = oldestRequest + this.config.windowMs;

      state.blockedUntil = blockUntil;
      this.limits.set(key, state);

      return {
        allowed: false,
        retryAfter: blockUntil - now,
      };
    }

    // Allow the request
    state.requests.push(now);
    state.blockedUntil = undefined; // Clear any previous block
    this.limits.set(key, state);

    return { allowed: true };
  }

  /**
   * Wait for the rate limit to reset
   */
  async waitForReset(key: string): Promise<void> {
    while (true) {
      const { allowed, retryAfter } = this.isAllowed(key);

      if (allowed) {
        return;
      }

      const waitTime = Math.max(retryAfter ?? this.config.retryAfterMs, 0);
      if (waitTime > 0) {
        logger.debug(`Rate limited for ${key}, waiting ${waitTime}ms`);
        await new Promise((resolve) => setTimeout(resolve, waitTime));
      } else {
        // Yield back to the event loop even if we don't need to wait
        await Promise.resolve();
      }
    }
  }

  /** Record the upstream's own refusal: no request should be made for `waitMs`. */
  recordUpstreamRefusal(waitMs: number): void {
    this.upstreamRefusedUntil = Math.max(this.upstreamRefusedUntil, Date.now() + waitMs);
  }

  /** How long the upstream's last refusal still holds, in ms; 0 once it has passed. */
  upstreamRefusalRemainingMs(): number {
    return Math.max(0, this.upstreamRefusedUntil - Date.now());
  }

  /**
   * Get current state for a key
   */
  getState(key: string): RateLimitState | undefined {
    return this.limits.get(key);
  }

  /**
   * Clear rate limit state for a key
   */
  clear(key: string): void {
    this.limits.delete(key);
  }

  /**
   * Clear all rate limit states
   */
  clearAll(): void {
    this.limits.clear();
    this.upstreamRefusedUntil = 0;
  }
}

// Create specific rate limiters for different APIs
export const nominatimRateLimiter = new ApiRateLimiter({
  maxRequests: 1, // Nominatim allows 1 request per second
  windowMs: 1000,
  retryAfterMs: 1000,
});

export default ApiRateLimiter;
