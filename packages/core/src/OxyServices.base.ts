/**
 * OxyServices Base Class
 * 
 * Contains core infrastructure, HTTP client, request management, and error handling
 */
import { jwtDecode } from 'jwt-decode';
import type { OxyConfig as OxyConfigBase, ApiError, User } from './models/interfaces';
import { handleHttpError } from './utils/errorUtils';
import { HttpService, type AuthRefreshReason, type RequestOptions } from './HttpService';
import { OxyAuthenticationError, OxyAuthenticationTimeoutError } from './OxyServices.errors';

export interface OxyConfig extends OxyConfigBase {
  cloudURL?: string;
}

export interface LinkedHttpClient {
  client: HttpService;
  dispose(): void;
}

interface JwtPayload {
  exp?: number;
  userId?: string;
  id?: string;
  sessionId?: string;
  [key: string]: any;
}

/**
 * Base class for OxyServices with core infrastructure
 */
export class OxyServicesBase {
  public httpService: HttpService;
  public cloudURL: string;
  public config: OxyConfig;

  constructor(...args: any[]) {
    const config = args[0] as OxyConfig;
    if (!config || typeof config !== 'object') {
      throw new Error('OxyConfig is required');
    }

    // `authWebUrl` is a plain optional config value now (used only for building
    // third-party "Sign in with Oxy" OAuth links). The SDK no longer derives or
    // defaults an IdP host — the device-first cold boot restores sessions from
    // the persisted refresh store, not an `auth.<apex>` bounce.
    this.config = config;
    this.cloudURL = config.cloudURL || 'https://cloud.oxy.so';

    // Initialize unified HTTP service (handles auth, caching, deduplication, queuing, retry)
    this.httpService = new HttpService(config);
  }

  // Test-only utility to reset tokens on this instance between jest tests
  // Note: tokens are now per-instance, so create new instances in tests for isolation
  __resetTokensForTests(): void {
    this.httpService.__resetTokensForTests();
  }

  /**
   * Make a request with all performance optimizations
   * This is the main method for all API calls - ensures authentication and performance features
   */
  public async makeRequest<T>(
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
    url: string,
    data?: any,
    options: RequestOptions = {}
  ): Promise<T> {
    return this.httpService.request<T>({
      method,
      url,
      data: method !== 'GET' ? data : undefined,
      params: method === 'GET' ? data : undefined,
      ...options,
    });
  }

  // ============================================================================
  // CORE METHODS (HTTP Client, Token Management, Error Handling)
  // ============================================================================

  /**
   * Get the configured Oxy API base URL
   */
  public getBaseURL(): string {
    return this.httpService.getBaseURL();
  }

  /**
   * Get the HTTP service instance
   * Useful for advanced use cases where direct access to the HTTP service is needed
   */
  public getClient(): HttpService {
    return this.httpService;
  }

  /**
   * Create an app/backend HTTP client linked to this Oxy session.
   *
   * Use this when an app has its own API origin (for example
   * `https://api.syra.fm`) but authentication is owned by the canonical
   * OxyServices instance mounted in OxyProvider. The returned client has its own
   * base URL, cache and request queue, but its bearer token is kept in lockstep
   * with this session and its 401 refresh path delegates back to this session.
   *
   * **GET response caching is OFF by default for linked clients.** The SDK's
   * per-instance GET cache is only safe where the SDK OWNS invalidation: on the
   * canonical OxyServices client, every mutation (`updateProfile`, `followUser`,
   * `blockUser`, …) busts the matching cached GET. A linked client targets the
   * consuming app's OWN backend (`api.mention.earth`, `api.syra.fm`, …), whose
   * resources and write endpoints the SDK has no knowledge of — so it cannot
   * invalidate them, and a cached GET there would silently serve stale data
   * after the app mutates its own data. Caching is therefore unsafe-by-construction
   * here and is left to the consumer's own layer (React Query / stores), which
   * owns its invalidation. Pass `createLinkedClient({ baseURL, enableCache: true })`
   * to explicitly opt back in when the consumer accepts that responsibility.
   */
  public createLinkedClient(config: OxyConfig): LinkedHttpClient {
    // Default the GET cache OFF unless the caller explicitly opts in (see the
    // method doc): the SDK cannot invalidate the consumer backend's resources.
    const client = new HttpService({ ...config, enableCache: config.enableCache ?? false });

    const syncToken = (accessToken: string | null): void => {
      const currentAccessToken = client.getAccessToken();
      if (accessToken) {
        if (currentAccessToken !== accessToken) {
          client.setTokens(accessToken);
        }
        return;
      }

      if (currentAccessToken) {
        client.clearTokens();
      }
    };

    syncToken(this.getAccessToken());
    const unsubscribe = this.onTokensChanged(syncToken);
    client.setAccessTokenProvider(() => this.getAccessToken());
    client.setAuthRefreshHandler(async (reason: AuthRefreshReason) => {
      const refreshed = await this.httpService.refreshAccessToken(reason);
      if (!refreshed) {
        return null;
      }

      syncToken(refreshed);
      return refreshed;
    });

    return {
      client,
      dispose: () => {
        unsubscribe();
        client.setAuthRefreshHandler(null);
        client.setAccessTokenProvider(null);
        client.clearTokens();
      },
    };
  }

  /**
   * Get performance metrics
   */
  public getMetrics() {
    return this.httpService.getMetrics();
  }

  /**
   * Clear request cache
   */
  public clearCache(): void {
    this.httpService.clearCache();
  }

  /**
   * Clear specific cache entry
   */
  public clearCacheEntry(key: string): void {
    this.httpService.clearCacheEntry(key);
  }

  /**
   * Clear every cache entry whose key starts with `prefix`.
   * Useful for mutations that invalidate a family of GET responses
   * without enumerating each one (e.g. all session-user lookups after
   * a profile update).
   */
  public clearCacheByPrefix(prefix: string): number {
    return this.httpService.clearCacheByPrefix(prefix);
  }

  /**
   * Get cache statistics
   */
  public getCacheStats() {
    return this.httpService.getCacheStats();
  }

  /**
   * Get the configured Oxy Cloud (file storage/CDN) URL
   */
  public getCloudURL(): string {
    return this.cloudURL;
  }

  /**
   * Set authentication tokens
   */
  public setTokens(accessToken: string): void {
    this.httpService.setTokens(accessToken);
  }

  /**
   * Clear stored authentication tokens
   */
  public clearTokens(): void {
    this.httpService.clearTokens();
    this._cachedUserId = undefined;
    this._cachedAccessToken = null;
  }

  /**
   * Subscribe to access-token changes on this client.
   *
   * The listener fires on every access-token mutation — explicit
   * `setTokens`/`clearTokens`, a successful silent refresh, and the internal
   * 401-driven clear — receiving the resulting token, or `null` when cleared.
   * Returns an unsubscribe function.
   *
   * Primary use: keeping an external token sink (e.g. the shared `oxyClient`
   * singleton) in lockstep with whichever `OxyServices` instance actually owns
   * the session, so imperative consumers reading the singleton always observe
   * the live token regardless of the code path that changed it.
   */
  public onTokensChanged(listener: (accessToken: string | null) => void): () => void {
    return this.httpService.addTokenChangeListener(listener);
  }

  /** @internal */ _cachedUserId: string | null | undefined = undefined;
  /** @internal */ _cachedAccessToken: string | null = null;

  /**
   * Get the current user ID from the access token.
   * Caches the decoded value and invalidates when the token changes.
   */
  public getCurrentUserId(): string | null {
    const accessToken = this.httpService.getAccessToken();

    // Return cached value if token hasn't changed
    if (accessToken === this._cachedAccessToken && this._cachedUserId !== undefined) {
      return this._cachedUserId;
    }

    this._cachedAccessToken = accessToken;

    if (!accessToken) {
      this._cachedUserId = null;
      return null;
    }

    try {
      const decoded = jwtDecode<JwtPayload>(accessToken);
      const userId = decoded.userId || decoded.id || null;
      this._cachedUserId = userId;
      return userId;
    } catch {
      this._cachedUserId = null;
      return null;
    }
  }

  /**
   * Check if the client has a valid access token (public method)
   */
  public hasValidToken(): boolean {
    return this.httpService.hasAccessToken();
  }

  /**
   * Get the raw access token (for constructing anchor URLs when needed)
   */
  public getAccessToken(): string | null {
    return this.httpService.getAccessToken();
  }

  /**
   * Decode the current access token and return its `exp` claim in SECONDS since
   * the Unix epoch (the raw JWT `exp` unit), or `null` when there is no token,
   * the token is opaque/undecodable, or it carries no numeric `exp`.
   *
   * Exposed so `@oxy.so/services` can schedule a PROACTIVE in-session refresh a
   * fixed lead before expiry without re-importing a JWT decoder (and without
   * duplicating the `jwt-decode` dependency in the RN bundle). HttpService keeps
   * the per-request preflight refresh; this powers the idle/background timer.
   */
  public getAccessTokenExpiry(): number | null {
    const token = this.httpService.getAccessToken();
    if (!token) {
      return null;
    }
    try {
      const decoded = jwtDecode<JwtPayload>(token);
      return typeof decoded.exp === 'number' ? decoded.exp : null;
    } catch {
      // A malformed / non-JWT token has no usable expiry — fall back to the
      // reactive 401 refresh path instead of a scheduled one.
      return null;
    }
  }

  /**
   * Wait for authentication to be ready
   * 
   * Optimized for high-scale usage with immediate synchronous check and adaptive polling.
   * Returns immediately if token is already available (0ms delay), otherwise uses
   * adaptive polling that starts fast (50ms) and gradually increases to reduce CPU usage.
   * 
   * @param timeoutMs Maximum time to wait in milliseconds (default: 5000ms)
   * @returns Promise that resolves to true if authentication is ready, false if timeout
   * 
   * @example
   * ```typescript
   * const isReady = await oxyServices.waitForAuth(3000);
   * if (isReady) {
   *   // Proceed with authenticated operations
   * }
   * ```
   */
  public async waitForAuth(timeoutMs = 5000): Promise<boolean> {
    // Immediate synchronous check - no delay if token is ready
    if (this.httpService.hasAccessToken()) {
      return true;
    }

    const startTime = performance.now();
    const maxTime = startTime + timeoutMs;
    
    // Adaptive polling: start fast, then slow down to reduce CPU usage
    let pollInterval = 50; // Start with 50ms
    
    while (performance.now() < maxTime) {
      await new Promise(resolve => setTimeout(resolve, pollInterval));
      
      if (this.httpService.hasAccessToken()) {
        return true;
      }
      
      // Increase interval after first few checks (adaptive polling)
      // This reduces CPU usage for long waits while maintaining responsiveness
      if (pollInterval < 200) {
        pollInterval = Math.min(pollInterval * 1.5, 200);
      }
    }
    
    return false;
  }

  /**
   * Execute a function with automatic authentication retry logic
   * This handles the common case where API calls are made before authentication completes
   */
  public async withAuthRetry<T>(
    operation: () => Promise<T>, 
    operationName: string,
    options: {
      maxRetries?: number;
      retryDelay?: number;
      authTimeoutMs?: number;
    } = {}
  ): Promise<T> {
    const { 
      maxRetries = 2, 
      retryDelay = 1000,
      authTimeoutMs = 5000 
    } = options;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        // First attempt: check if we have a token
        if (!this.httpService.hasAccessToken()) {
          if (attempt === 0) {
            // On first attempt, wait briefly for authentication to complete
            const authReady = await this.waitForAuth(authTimeoutMs);
            
            if (!authReady) {
              throw new OxyAuthenticationTimeoutError(operationName, authTimeoutMs);
            }
          } else {
            // On retry attempts, fail immediately if no token
            throw new OxyAuthenticationError(
              `Authentication required: ${operationName} requires a valid access token.`,
              'AUTH_REQUIRED'
            );
          }
        }

        // Execute the operation
        return await operation();

      } catch (error: unknown) {
        const isLastAttempt = attempt === maxRetries;
        const errorObj = error && typeof error === 'object' ? error as { response?: { status?: number }; code?: string; message?: string } : null;
        const isAuthError = errorObj?.response?.status === 401 || 
                           errorObj?.code === 'MISSING_TOKEN' ||
                           errorObj?.message?.includes('Authentication') ||
                           error instanceof OxyAuthenticationError;

        if (isAuthError && !isLastAttempt && !(error instanceof OxyAuthenticationTimeoutError)) {
          await new Promise(resolve => setTimeout(resolve, retryDelay));
          continue;
        }

        // If it's not an auth error, or it's the last attempt, throw the error
        if (error instanceof OxyAuthenticationError) {
          throw error;
        }
        throw this.handleError(error);
      }
    }

    // This should never be reached, but TypeScript requires it
    throw new OxyAuthenticationError(`${operationName} failed after ${maxRetries + 1} attempts`);
  }

  /**
   * Validate the current access token with the server
   */
  async validate(): Promise<boolean> {
    if (!this.hasValidToken()) {
      return false;
    }

    try {
      const res = await this.makeRequest<{ valid: boolean }>('GET', '/auth/validate', undefined, {
        cache: false,
        retry: false,
      });
      return res.valid === true;
    } catch (error) {
      return false;
    }
  }

  /**
   * Centralized error handling
   */
  public handleError(error: unknown): Error {
    const api = handleHttpError(error);
    // Ensure we always have a non-empty message
    const message = api.message?.trim() || 'An unexpected error occurred';
    const err = new Error(message) as Error & { code?: string; status?: number; details?: Record<string, unknown> };
    err.code = api.code;
    err.status = api.status;
    err.details = api.details;
    return err;
  }

  /**
   * Health check endpoint
   */
  async healthCheck(): Promise<{ 
    status: string; 
    users?: number; 
    timestamp?: string; 
    [key: string]: any 
  }> {
    try {
      return await this.makeRequest('GET', '/health', undefined, { 
        cache: false,
        retry: false,
        timeout: 5000
      });
    } catch (error) {
      throw this.handleError(error);
    }
  }
}
