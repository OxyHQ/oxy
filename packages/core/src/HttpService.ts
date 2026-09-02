/**
 * Unified HTTP Service
 * 
 * Consolidates HttpClient + RequestManager into a single efficient class.
 * Uses native fetch instead of axios for smaller bundle size.
 * 
 * Handles:
 * - Authentication (token management, auto-refresh)
 * - Caching (TTL-based)
 * - Deduplication (concurrent requests)
 * - Retry logic
 * - Error handling
 * - Request queuing
 */

import { TTLCache, registerCacheForCleanup } from './utils/cache';
import { RequestDeduplicator, RequestQueue, SimpleLogger } from './utils/requestUtils';
import { retryAsync } from './utils/asyncUtils';
import { handleHttpError, parseHttpErrorBody } from './utils/errorUtils';
import { jwtDecode } from 'jwt-decode';
import { isNative, getPlatformOS } from './utils/platform';
import { isReactNative } from '@oxyhq/protocol';
import { computeIdentityTag, fnv1a32 } from './utils/cacheKey';
import { redactUrlQuery } from './utils/redactUrl';
import type { OxyConfig } from './models/interfaces';
import type { DeviceSecretMintOutcome } from './session/refresh';

/**
 * Check if we're running in a native app environment (React Native, not web)
 * This is used to determine CSRF handling mode
 */
const isNativeApp = isNative();

interface JwtPayload {
  exp?: number;
  userId?: string;
  id?: string;
  sessionId?: string;
  [key: string]: unknown;
}

export type AuthRefreshReason = 'preflight' | 'response-401';
export type AuthRefreshHandler = (reason: AuthRefreshReason) => Promise<string | null>;
export type AccessTokenProvider = () => string | null;

/**
 * Structural type that captures the multipart-write surface every supported
 * FormData implementation exposes (browser, React Native, Node `form-data`
 * polyfill, jsdom, undici, etc). We type-narrow against this in
 * `isFormData()` so callers don't have to know which runtime produced the
 * value.
 *
 * Deliberately mirrored from the lib.dom `FormData` interface — kept as a
 * local type because @types/node and @types/react-native model FormData
 * differently and a single import wouldn't be safe in both bundles.
 */
interface FormDataLike {
  append(name: string, value: unknown, fileName?: string): void;
  delete(name: string): void;
  get(name: string): unknown;
  getAll(name: string): unknown[];
  has(name: string): boolean;
}

export interface RequestOptions {
  cache?: boolean;
  cacheTTL?: number;
  deduplicate?: boolean;
  retry?: boolean;
  maxRetries?: number;
  timeout?: number;
  signal?: AbortSignal;
  headers?: Record<string, string>;
  responseType?: 'blob';
  /**
   * Skip BOTH the bearer auth header (and its near-expiry preflight refresh)
   * AND the 401-driven auto-refresh/retry for this request.
   *
   * Required for the body-authenticated device-secret mint (`POST
   * /session/device/token`): it does not need a bearer, and — critically — it is
   * itself invoked from inside the registered `AuthRefreshHandler`. If it went
   * through the normal preflight, `getAuthHeader` would call
   * `refreshAccessToken` while the handler-owning `tokenRefreshPromise` is
   * still in flight and await ITSELF (deadlock). Skipping auth makes the
   * mint call fully independent of the current (near-expired) bearer.
   */
  skipAuth?: boolean;
  /**
   * Execute this request WITHOUT taking a `RequestQueue` slot — run it directly.
   *
   * A queue slot represents network occupancy for ordinary DATA requests. The
   * CONTROL-PLANE calls the auth lane depends on (the device-secret mint, `POST
   * /session/device/token`, reached from `getAuthHeader` → `refreshAccessToken`)
   * must never compete for a slot: when `maxConcurrentRequests` requests are all
   * parked awaiting that very mint, a queued mint could never acquire a slot to
   * run — a systemic deadlock. `bypassQueue` lets the mint run even when the
   * queue is saturated. (The auth preflight is also resolved OUTSIDE the slot in
   * `request()`, so ordinary requests never hold a slot while awaiting the mint;
   * this flag is the explicit guarantee for the mint itself.)
   */
  bypassQueue?: boolean;
}

interface RequestConfig extends RequestOptions {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  url: string;
  data?: unknown;
  params?: Record<string, unknown>;
  /** @internal Used to prevent infinite auth retry loops */
  _isAuthRetry?: boolean;
  /** @internal Used to prevent infinite CSRF retry loops */
  _isCsrfRetry?: boolean;
}

/**
 * Default per-request timeout (ms) when neither the call site nor
 * {@link OxyConfig.requestTimeout} overrides it. Kept tight so a stalled
 * endpoint surfaces as an `AbortError` quickly rather than blocking the
 * request queue.
 */
const DEFAULT_REQUEST_TIMEOUT_MS = 5000;

/**
 * Timeout (ms) for the dedicated `GET /csrf-token` fetch. Independent of the
 * regular request timeout: this is a small, fast, unauthenticated call and
 * should never inherit a longer per-request budget.
 */
const CSRF_FETCH_TIMEOUT_MS = 5000;

/**
 * Number of attempts for fetching a CSRF token before giving up. The first
 * failure is usually a cold edge/cookie race; a single retry recovers it
 * without masking a genuinely broken `/csrf-token` route.
 */
const CSRF_FETCH_MAX_ATTEMPTS = 2;

/**
 * Backoff (ms) between CSRF-token fetch attempts. Short by design — a CSRF
 * fetch sits in the critical path of a state-changing request, so the retry
 * must add minimal latency.
 */
const CSRF_FETCH_RETRY_DELAY_MS = 500;

/**
 * Cooldown (ms) applied after a failed access-token refresh before another
 * refresh is attempted while the CURRENT token is still valid (a proactive,
 * near-expiry refresh). Prevents a refresh storm (and server hammering) when
 * the auth refresh handler is failing — every in-flight request that
 * hits a 401 would otherwise trigger its own refresh. A still-valid token can
 * afford to wait this out; the request keeps carrying it in the meantime.
 */
const TOKEN_REFRESH_COOLDOWN_MS = 15000;

/**
 * Cooldown (ms) applied after a failed refresh when the CURRENT access token is
 * already past its `exp`. Much shorter than {@link TOKEN_REFRESH_COOLDOWN_MS}:
 * an expired token is UNUSABLE, so the client must re-mint as soon as the mint
 * endpoint is reachable again (e.g. a few seconds after an ECS rolling-deploy
 * blip drains/restarts a task) instead of waiting out the full proactive
 * cooldown while every request forwards or omits a stale bearer → server 401.
 *
 * Still NON-ZERO on purpose: it bounds the request-driven retry rate to at most
 * one attempt per this interval so a PROLONGED outage cannot become a tight
 * network storm. Combined with the process-wide single-flight below (concurrent
 * requests coalesce to one in-flight mint) and the refresh handler's own
 * terminal-state handling (a genuinely revoked session clears its device
 * credential and stops issuing network mints), this recovers a transient blip
 * ~15× faster without weakening the storm guard.
 */
const EXPIRED_TOKEN_REFRESH_COOLDOWN_MS = 1000;

/**
 * Lead time (seconds) before access-token expiry at which a preflight refresh
 * is triggered. A token within this window of `exp` is treated as effectively
 * expired so the request carries a fresh bearer rather than racing the clock.
 */
const TOKEN_REFRESH_LEAD_SECONDS = 60;

/**
 * Soft ceiling on the number of live entries in the identity-scoped GET
 * response cache. Crossing it does NOT evict anything (the {@link TTLCache}
 * still expires by TTL and is swept on its cleanup interval) — it emits a
 * single throttled telemetry warning via the logger so an unbounded-growth
 * regression (e.g. an endpoint that mints a fresh identity tag per request, or
 * a cache-key that accidentally folds in volatile data) is observable in the
 * field instead of silently consuming memory. Tuned well above the working set
 * a single authenticated user generates in normal use.
 */
const CACHE_SOFT_MAX_ENTRIES = 500;

/**
 * Minimum interval (ms) between successive cache-size telemetry warnings, so a
 * cache that sits above the soft limit logs at most once per window rather than
 * on every cached write.
 */
const CACHE_SIZE_WARNING_THROTTLE_MS = 60000;

/**
 * Token store for authentication (instance-based)
 * Each HttpService gets its own TokenStore to prevent conflicts
 * when multiple OxyServices instances coexist server-side.
 */
class TokenStore {
  private accessToken: string | null = null;
  private csrfToken: string | null = null;
  private csrfTokenFetchPromise: Promise<string | null> | null = null;

  setTokens(accessToken: string): void {
    this.accessToken = accessToken;
  }

  getAccessToken(): string | null {
    return this.accessToken;
  }

  clearTokens(): void {
    this.accessToken = null;
  }

  hasAccessToken(): boolean {
    return !!this.accessToken;
  }

  setCsrfToken(token: string | null): void {
    this.csrfToken = token;
  }

  getCsrfToken(): string | null {
    return this.csrfToken;
  }

  setCsrfTokenFetchPromise(promise: Promise<string | null> | null): void {
    this.csrfTokenFetchPromise = promise;
  }

  getCsrfTokenFetchPromise(): Promise<string | null> | null {
    return this.csrfTokenFetchPromise;
  }

  clearCsrfToken(): void {
    this.csrfToken = null;
    this.csrfTokenFetchPromise = null;
  }
}

/**
 * Unified HTTP Service
 * 
 * Consolidates HttpClient + RequestManager into a single efficient class.
 * Uses native fetch instead of axios for smaller bundle size.
 */
export class HttpService {
  private baseURL: string;
  private tokenStore: TokenStore;
  private cache: TTLCache<any>;
  /**
   * When true, the per-instance GET response cache is OFF: GET responses are
   * never read from nor written to {@link cache}, so every request hits the
   * network. Set from `config.enableCache === false` OR `config.cacheTTL <= 0`.
   * A disabled instance does not register its cache for the global cleanup
   * interval (nothing ever lands in it). Request deduplication is unaffected —
   * concurrent identical in-flight requests still collapse into one.
   */
  private readonly cacheDisabled: boolean;
  private deduplicator: RequestDeduplicator;
  private requestQueue: RequestQueue;
  private logger: SimpleLogger;
  private config: OxyConfig;
  private tokenRefreshPromise: Promise<string | null> | null = null;
  /**
   * Epoch ms of the last FAILED refresh (0 = none since the last success). The
   * post-failure cooldown is measured from here; its length depends on whether
   * the current token is still valid ({@link TOKEN_REFRESH_COOLDOWN_MS}) or
   * already expired ({@link EXPIRED_TOKEN_REFRESH_COOLDOWN_MS}), so an expired
   * token recovers promptly the instant it crosses `exp` — without storing a
   * fixed deadline that could not shrink once the token expired mid-cooldown.
   */
  private lastRefreshFailureAt = 0;
  private authRefreshHandler: AuthRefreshHandler | null = null;
  private accessTokenProvider: AccessTokenProvider | null = null;
  private deviceSecretMintInFlight: Promise<DeviceSecretMintOutcome> | null = null;

  /**
   * Epoch (ms) before which a cache-size telemetry warning must not be
   * re-emitted. Throttles the {@link CACHE_SOFT_MAX_ENTRIES} warning to at most
   * one per {@link CACHE_SIZE_WARNING_THROTTLE_MS} window.
   */
  private cacheSizeWarningSilentUntil = 0;

  /**
   * Fan-out listeners notified on EVERY access-token change on this instance:
   * explicit `setTokens`, `clearTokens`, a refresh-handler rotation, and the
   * internal 401-driven clear. This is a Set so multiple independent observers
   * can mirror token state without clobbering each other.
   *
   * Each listener receives the resulting access token, or `null` when cleared.
   */
  private _tokenChangeListeners = new Set<(accessToken: string | null) => void>();

  // Performance monitoring
  private requestMetrics = {
    totalRequests: 0,
    successfulRequests: 0,
    failedRequests: 0,
    cacheHits: 0,
    cacheMisses: 0,
    averageResponseTime: 0,
  };

  constructor(config: OxyConfig) {
    this.config = config;
    this.baseURL = config.baseURL;
    this.tokenStore = new TokenStore();
    
    this.logger = new SimpleLogger(
      config.enableLogging || false,
      config.logLevel || 'error',
      'HttpService'
    );

    // Initialize performance infrastructure. The per-instance GET response
    // cache is disabled when the consumer explicitly opts out
    // (`enableCache: false`) or asks for a non-positive TTL (`cacheTTL <= 0`).
    // When disabled, nothing is ever stored, so there is no reason to register
    // the cache for the global cleanup interval. Default (config unset) keeps
    // caching ON with the 5-minute TTL — unchanged for existing consumers.
    this.cacheDisabled =
      config.enableCache === false ||
      (typeof config.cacheTTL === 'number' && config.cacheTTL <= 0);
    this.cache = new TTLCache<any>(config.cacheTTL && config.cacheTTL > 0 ? config.cacheTTL : 5 * 60 * 1000);
    if (!this.cacheDisabled) {
      registerCacheForCleanup(this.cache);
    }
    this.deduplicator = new RequestDeduplicator();
    this.requestQueue = new RequestQueue(
      config.maxConcurrentRequests || 10,
      config.requestQueueSize || 100
    );
  }

  private syncAccessTokenFromProvider(): string | null {
    if (!this.accessTokenProvider) {
      return this.tokenStore.getAccessToken();
    }

    const providedToken = this.accessTokenProvider();
    const currentToken = this.tokenStore.getAccessToken();

    if (providedToken) {
      if (providedToken !== currentToken) {
        this.tokenStore.setTokens(providedToken);
        this.notifyTokenChange();
      }
      return providedToken;
    }

    if (currentToken) {
      this.clearTokens();
    }

    return null;
  }

  /**
   * Robust FormData detection that works in browser, React Native, and
   * Node.js polyfill environments.
   *
   * Why we don't use `instanceof FormData` alone:
   *  - React Native's FormData is a separate class, not the browser one —
   *    `instanceof FormData` is true only inside the JS runtime that
   *    instantiated the value (browser-side polyfills also have their own).
   *  - The Node.js `form-data` polyfill ships its own constructor.
   *
   * Why we explicitly reject `URLSearchParams`:
   *  - `URLSearchParams` ALSO exposes `append` / `get` / `has`, so the
   *    duck-type fallback below would have misidentified it as FormData and
   *    sent an empty multipart body.
   *  - It has its own encoding path instead — see {@link isUrlSearchParams}.
   */
  private isFormData(data: unknown): data is FormDataLike {
    if (!data || typeof data !== 'object') {
      return false;
    }

    // Reject URLSearchParams up front: it shares the duck-typed surface
    // (append / get / has) but is a fundamentally different content type.
    // The caller routes URLSearchParams through the regular body path.
    if (typeof URLSearchParams !== 'undefined' && data instanceof URLSearchParams) {
      return false;
    }

    // Primary check: instanceof FormData. Works whenever the value was
    // constructed by the same runtime/realm that exposes `FormData`.
    if (typeof FormData !== 'undefined' && data instanceof FormData) {
      return true;
    }

    // Fallback: detect Node / RN polyfills by constructor name. Limited to
    // the small handful of known names so we don't accept arbitrary
    // user-supplied objects with a coincidental `name`.
    const constructorName = data.constructor?.name;
    if (constructorName === 'FormData' || constructorName === 'FormDataImpl') {
      return true;
    }

    // Last-resort duck typing — require the full FormData write surface
    // (`append`, `get`, `has`, `getAll`, `delete`) so plain objects with
    // an `append` method don't accidentally match.
    const candidate = data as Partial<Record<keyof FormDataLike, unknown>>;
    return (
      typeof candidate.append === 'function' &&
      typeof candidate.get === 'function' &&
      typeof candidate.has === 'function' &&
      typeof candidate.getAll === 'function' &&
      typeof candidate.delete === 'function'
    );
  }

  /**
   * True for an `application/x-www-form-urlencoded` payload.
   *
   * Needed because a handful of endpoints are defined by a standard that fixes
   * their request encoding rather than by our own JSON conventions — today
   * `POST /auth/oauth/token`, whose encoding RFC 6749 §4.1.3 mandates. Passing
   * a `URLSearchParams` as `data` selects that encoding; everything else is
   * still JSON.
   */
  private isUrlSearchParams(data: unknown): data is URLSearchParams {
    return typeof URLSearchParams !== 'undefined' && data instanceof URLSearchParams;
  }

  /**
   * Main request method - handles everything in one place
   */
  async request<T = unknown>(config: RequestConfig): Promise<T> {
    const {
      method,
      url,
      data,
      params,
      timeout = this.config.requestTimeout || DEFAULT_REQUEST_TIMEOUT_MS,
      signal,
      cache: cacheRequested = method === 'GET',
      cacheTTL,
      deduplicate = true,
      retry = this.config.enableRetry !== false,
      maxRetries = this.config.maxRetries || 3,
    } = config;

    // A per-instance disabled cache (`enableCache:false` / `cacheTTL<=0`)
    // overrides any per-request `cache:true`: nothing is read from nor written
    // to the response cache. Request deduplication below is unaffected.
    const cache = cacheRequested && !this.cacheDisabled;

    // Generate cache key (optimized for large objects)
    const cacheKey = cache ? this.generateCacheKey(method, url, data || params) : null;

    // Check cache first
    if (cache && cacheKey) {
      const cached = this.cache.get(cacheKey) as T | null;
      if (cached !== null) {
        this.requestMetrics.cacheHits++;
        // Redact the query string: an asset stream URL passed here carries a
        // scoped `mt=` media token that must never reach a log sink.
        this.logger.debug('Cache hit:', redactUrlQuery(url));
        return cached;
      }
      this.requestMetrics.cacheMisses++;
    }

    // Resolve the auth preflight OUTSIDE the queue slot. A slot represents
    // NETWORK OCCUPANCY only. `getAuthHeader` may await the single-flight token
    // refresh/mint — itself a request — so if a slot-holding request awaited it
    // here and every slot were held by requests all waiting on that same mint,
    // the mint could never acquire a slot to run (systemic deadlock). Resolving
    // it before enqueue means auth-blocked requests hold NO slot while the shared
    // mint runs. `skipAuth` requests (the body-authenticated mint) send NO bearer
    // and skip the near-expiry preflight — see RequestOptions.skipAuth. The
    // 401/CSRF retry re-enters request() with a fresh config, so it re-resolves
    // these here with the refreshed token / cleared CSRF.
    const isStateChangingMethod = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method);
    const authHeader = config.skipAuth ? null : await this.getAuthHeader();
    // CSRF protects cookie-authenticated browser writes. Bearer-authenticated SDK
    // clients are not vulnerable to ambient-cookie CSRF, and linked app APIs
    // should not need to implement a duplicate `/csrf-token` route.
    const csrfToken = isStateChangingMethod && !authHeader ? await this.fetchCsrfToken() : null;

    // Request function
    const requestFn = async (): Promise<T> => {
      const startTime = Date.now();
      try {
        // Build URL with params
        const fullUrl = this.buildURL(url, params);

        // Determine if data is FormData using robust detection
        const isFormData = this.isFormData(data);
        const isUrlEncoded = this.isUrlSearchParams(data);

        // Make fetch request
        const controller = new AbortController();
        const timeoutId = timeout ? setTimeout(() => controller.abort(), timeout) : null;
        
        if (signal) {
          signal.addEventListener('abort', () => controller.abort());
        }

        // Build headers - start with defaults
        const headers: Record<string, string> = {
          'Accept': 'application/json',
        };

        // Only set Content-Type for non-FormData requests (FormData sets it automatically with boundary)
        if (isUrlEncoded) {
          headers['Content-Type'] = 'application/x-www-form-urlencoded;charset=UTF-8';
        } else if (!isFormData) {
          headers['Content-Type'] = 'application/json';
        }

        // Add authorization header if available
        if (authHeader) {
          headers['Authorization'] = authHeader;
        }

        // Add CSRF token header for state-changing requests
        if (csrfToken) {
          headers['X-CSRF-Token'] = csrfToken;
        }

        // Add native app header for React Native (required for CSRF validation)
        // Native apps can't persist cookies like browsers, so the server uses
        // header-only CSRF validation when this header is present
        if (isNativeApp && isStateChangingMethod) {
          headers['X-Native-App'] = 'true';
        }

        // Debug logging for CSRF issues, routed through SimpleLogger so it only
        // fires when consumers opt in via `enableLogging`.
        if (isStateChangingMethod) {
          this.logger.debug('CSRF Debug:', {
            url,
            method,
            isNativeApp,
            platformOS: getPlatformOS(),
            hasCsrfToken: !!csrfToken,
            csrfTokenLength: csrfToken?.length,
            hasNativeAppHeader: headers['X-Native-App'] === 'true',
          });
        }

        // Merge custom headers if provided
        if (config.headers) {
          Object.entries(config.headers).forEach(([key, value]) => {
            // For FormData, explicitly remove Content-Type if user tries to set it
            // The browser/fetch API will set it automatically with the boundary
            if (isFormData && key.toLowerCase() === 'content-type') {
              this.logger.debug('Ignoring Content-Type header for FormData - will be set automatically');
              return;
            }
            headers[key] = value;
          });
        }

        // `URLSearchParams` is serialised explicitly rather than handed to
        // `fetch` as-is: RN's fetch does not consistently encode it, and doing
        // it here keeps the body identical across every platform.
        const bodyValue = method !== 'GET' && data
            ? (isFormData ? data : isUrlEncoded ? data.toString() : JSON.stringify(data))
            : undefined;

        // React Native FormData workaround:
        // Expo SDK 56's "winter fetch" rejects RN file descriptors `{uri, type, name}`
        // in FormDataPart conversion (`Unsupported FormDataPart implementation`).
        // RN's native XMLHttpRequest handles those descriptors correctly, so we
        // route multipart uploads through XHR on RN only. JSON, text, etc. still
        // use fetch on every platform.
        const useXhrForUpload = isFormData && isReactNative() && typeof XMLHttpRequest !== 'undefined';

        const response = useXhrForUpload
          ? await this.uploadViaXHR(
              fullUrl,
              method,
              headers,
              bodyValue as FormData,
              controller.signal,
              timeout,
              this.shouldSendCredentials(fullUrl),
            )
          : await fetch(fullUrl, {
              method,
              headers,
              body: bodyValue as BodyInit | null | undefined,
              signal: controller.signal,
              credentials: this.getCredentialsMode(fullUrl),
            });

        if (timeoutId) clearTimeout(timeoutId);

        // Handle response
        if (!response.ok) {
          // On 401, delegate to the installed auth refresh handler and retry
          // once before giving up. HttpService deliberately does not know any
          // session routes; the refresh handler owns session rotation.
          if (response.status === 401 && !config._isAuthRetry && !config.skipAuth) {
            const refreshed = await this.refreshAccessToken('response-401');
            if (refreshed) {
              // `deduplicate: false` is REQUIRED on the retry (mirrors the 403
              // CSRF retry below). This re-issue runs while the ORIGINAL request
              // is still in-flight under its dedupe key; the refreshed token is
              // for the SAME user, so the identity-scoped key is UNCHANGED — a
              // deduplicated retry would resolve to the still-pending original
              // and await itself (deadlock). Opting the retry out of dedupe makes
              // it a fresh request.
              return this.request<T>({ ...config, _isAuthRetry: true, retry: false, deduplicate: false });
            }
            // Refresh failed or no token — clear tokens and stale CSRF
            this.tokenStore.clearTokens();
            this.tokenStore.clearCsrfToken();
            this.notifyTokenChange();
          }

          // On 403 with CSRF error, clear cached token and retry once
          if (response.status === 403 && !config._isCsrfRetry) {
            try {
              const clonedResponse = response.clone();
              const errBody = await clonedResponse.json() as { code?: string } | null;
              if (errBody?.code === 'CSRF_TOKEN_INVALID' || errBody?.code === 'CSRF_TOKEN_MISSING') {
                this.tokenStore.clearCsrfToken();
                return this.request<T>({ ...config, _isCsrfRetry: true, retry: false, deduplicate: false });
              }
            } catch {
              // Failed to parse error body — not a CSRF error
            }
          }

          // Read the error body (may be absent, non-JSON, empty or malformed).
          // Anything unreadable leaves `errorBody` undefined and degrades to the
          // status-based message — an error path that throws its own error is
          // worse than the error it was reporting.
          let errorBody: unknown;
          const errorContentType = response.headers.get('content-type');
          if (errorContentType?.includes('application/json')) {
            try {
              errorBody = await response.json();
            } catch (parseError) {
              // Malformed JSON or empty response - use status text
              this.logger.warn('Failed to parse error response JSON:', parseError);
            }
          }

          // `parseHttpErrorBody` handles every envelope in use, including the
          // nested `{ error: { code, message } }` shape — assigning that nested
          // OBJECT as the message is what produced `"[object Object]"`.
          const parsed = parseHttpErrorBody(errorBody);
          const error = new Error(
            parsed.message ?? `HTTP ${response.status}: ${response.statusText}`,
          ) as Error & {
            status?: number;
            code?: string;
            details?: Record<string, unknown>;
            response?: { status: number; statusText: string; data?: unknown };
          };
          error.status = response.status;
          error.response = { status: response.status, statusText: response.statusText, data: errorBody };
          // Only set `code`/`details` when the server actually sent them.
          // Assigning `undefined` would still create the property, which changes
          // how `handleHttpError` classifies the error downstream.
          if (parsed.code !== undefined) {
            error.code = parsed.code;
          }
          if (parsed.details !== undefined) {
            error.details = parsed.details;
          }
          throw error;
        }

        // Handle different response types (optimized - read response once)
        const contentType = response.headers.get('content-type');
        let responseData: unknown;
        
        if (config.responseType === 'blob') {
          responseData = await response.blob();
        } else if (contentType && contentType.includes('application/json')) {
          // Use response.json() directly for better performance
          try {
            responseData = await response.json();
            // Handle null/undefined responses
            if (responseData === null || responseData === undefined) {
              responseData = null;
            } else {
              // Unwrap standardized API response format for JSON
              responseData = this.unwrapResponse(responseData);
            }
          } catch (parseError) {
            // Handle malformed JSON or empty responses gracefully
            // Note: Once response.json() is called, the body is consumed and cannot be read again
            // So we check the error type to determine if it's empty or malformed
            if (parseError instanceof SyntaxError) {
              this.logger.warn('Failed to parse JSON response (malformed or empty):', parseError);
              // SyntaxError typically means empty or malformed JSON
              // For empty responses, return null; for malformed JSON, throw descriptive error
              responseData = null; // Treat as empty response for safety
            } else {
              this.logger.warn('Failed to read response:', parseError);
              throw new Error('Failed to read response from server');
            }
          }
        } else if (contentType && (contentType.includes('application/octet-stream') || contentType.includes('image/') || contentType.includes('video/') || contentType.includes('audio/'))) {
          // For binary responses (blobs), return the blob directly without unwrapping
          responseData = await response.blob();
        } else {
          // For other responses, return as text
          const text = await response.text();
          responseData = text || null;
        }

        const duration = Date.now() - startTime;
        this.updateMetrics(true, duration);
        this.config.onRequestEnd?.(url, method, duration, true);

        return responseData as T;
      } catch (error: unknown) {
        const duration = Date.now() - startTime;
        this.updateMetrics(false, duration);
        this.config.onRequestEnd?.(url, method, duration, false);
        this.config.onRequestError?.(url, method, error instanceof Error ? error : new Error(String(error)));
        
        // Handle AbortError specifically for better error messages
        if (error instanceof Error && error.name === 'AbortError') {
          throw handleHttpError(error);
        }
        
        throw handleHttpError(error);
      }
    };

    // Wrap with retry if enabled
    const requestWithRetry = retry
      ? () => retryAsync(requestFn, maxRetries, this.config.retryDelay || 1000)
      : requestFn;

    // Wrap with deduplication if enabled (use optimized key generation)
    const dedupeKey = deduplicate ? this.generateCacheKey(method, url, data || params) : null;
    const finalRequest = dedupeKey
      ? () => this.deduplicator.deduplicate(dedupeKey, requestWithRetry)
      : requestWithRetry;

    // Execute the request. Control-plane calls the auth lane depends on
    // (`bypassQueue`, e.g. the device-secret mint) run DIRECTLY — a queued mint
    // could never acquire a slot when every slot is parked awaiting it.
    const result = config.bypassQueue
      ? await finalRequest()
      : await this.requestQueue.enqueue(finalRequest);

    // Cache the result if caching is enabled
    if (cache && cacheKey && result) {
      this.cache.set(cacheKey, result, cacheTTL);
      this.warnIfCacheOversized();
    }

    return result;
  }

  /**
   * Soft cache-size guard. Emits a single throttled telemetry warning when the
   * identity-scoped response cache grows past {@link CACHE_SOFT_MAX_ENTRIES}.
   *
   * This intentionally does NOT evict: the {@link TTLCache} already bounds
   * memory by TTL (and the global cleanup interval sweeps expired entries), so
   * an LRU here would only risk thrashing a legitimately warm cache. The point
   * is observability — if entry count climbs and stays high, an identity tag or
   * cache key is folding in volatile data (a per-request nonce, an undecodable
   * rotating token) and the cache is no longer doing its job. Surfacing that via
   * the logger lets a consumer with `enableLogging` catch the regression in the
   * field instead of debugging silent memory growth.
   */
  private warnIfCacheOversized(): void {
    const size = this.cache.size();
    if (size <= CACHE_SOFT_MAX_ENTRIES) {
      return;
    }
    const now = Date.now();
    if (now < this.cacheSizeWarningSilentUntil) {
      return;
    }
    this.cacheSizeWarningSilentUntil = now + CACHE_SIZE_WARNING_THROTTLE_MS;
    this.logger.warn(
      'Response cache exceeded soft entry limit — possible identity-tag or cache-key bloat',
      { size, softLimit: CACHE_SOFT_MAX_ENTRIES },
    );
  }

  /**
   * Upload via XMLHttpRequest (React Native FormData workaround).
   *
   * Expo SDK 56's "winter fetch" cannot serialize RN file descriptors
   * (`{uri, type, name}`) — `convertFormDataAsync` rejects them as
   * `Unsupported FormDataPart implementation`. RN's native XHR streams
   * the file from disk correctly, so multipart uploads go through XHR
   * on RN only.
   *
   * Returns a standard `Response` so downstream parsing in `request()`
   * (status checks, 401/403 retries, JSON/blob/text parsing) is identical
   * to the fetch path.
   */
  private uploadViaXHR(
    url: string,
    method: string,
    headers: Record<string, string>,
    body: FormData,
    abortSignal: AbortSignal,
    timeout: number,
    withCredentials: boolean,
  ): Promise<Response> {
    return new Promise<Response>((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open(method, url, true);
      // Only send ambient cookies to the configured API origin. Absolute
      // caller-supplied URLs can target arbitrary origins, so they must not
      // receive credential-bearing requests by default.
      xhr.withCredentials = withCredentials;

      // Forward headers but skip Content-Type — XHR sets the multipart
      // boundary automatically and overriding it breaks the upload.
      for (const [key, value] of Object.entries(headers)) {
        if (key.toLowerCase() === 'content-type') continue;
        try {
          xhr.setRequestHeader(key, value);
        } catch (headerError) {
          // Some headers (e.g. forbidden header names) cannot be set —
          // log and continue rather than failing the whole upload.
          this.logger.warn('XHR setRequestHeader failed:', key, headerError);
        }
      }

      xhr.responseType = 'text';
      if (timeout > 0) {
        xhr.timeout = timeout;
      }

      const onAbort = (): void => {
        try { xhr.abort(); } catch { /* xhr already finished */ }
      };
      if (abortSignal.aborted) {
        reject(new DOMException('The user aborted a request.', 'AbortError'));
        return;
      }
      abortSignal.addEventListener('abort', onAbort);

      const cleanup = (): void => {
        abortSignal.removeEventListener('abort', onAbort);
      };

      xhr.onload = (): void => {
        cleanup();
        const responseHeaders = HttpService.parseXHRHeaders(xhr.getAllResponseHeaders());
        resolve(new Response(xhr.responseText, {
          status: xhr.status,
          statusText: xhr.statusText,
          headers: responseHeaders,
        }));
      };
      xhr.onerror = (): void => {
        cleanup();
        reject(new TypeError('Network request failed'));
      };
      xhr.ontimeout = (): void => {
        cleanup();
        reject(new DOMException('The request timed out.', 'TimeoutError'));
      };
      xhr.onabort = (): void => {
        cleanup();
        reject(new DOMException('The user aborted a request.', 'AbortError'));
      };

      xhr.send(body);
    });
  }

  /**
   * Parse raw header string from `XMLHttpRequest.getAllResponseHeaders()`
   * into a `Headers`-compatible object.
   */
  private static parseXHRHeaders(rawHeaders: string): Headers {
    const headers = new Headers();
    if (!rawHeaders) return headers;
    // RFC 7230 line terminator is CRLF; some XHR implementations use LF only.
    const lines = rawHeaders.trim().split(/\r?\n/);
    for (const line of lines) {
      const colonIndex = line.indexOf(':');
      if (colonIndex <= 0) continue;
      const key = line.slice(0, colonIndex).trim();
      const value = line.slice(colonIndex + 1).trim();
      if (key) {
        try {
          headers.append(key, value);
        } catch {
          // Invalid header name/value — skip.
        }
      }
    }
    return headers;
  }

  /**
   * Delimiter that separates the logical `method:url[:data]` portion of a
   * cache key from its identity suffix. Always APPENDED, never used to parse
   * a key apart, so the `method:url` prefix stays intact for
   * `clearCacheByPrefix` sweeps and `clearCacheEntry` base-key matching.
   * The `clearCacheEntry` callsites all pass fixed, dataless logical keys
   * (`GET:/users/<id>`, `GET:/session/user/<sessionId>`,
   * `GET:/auth/grants`), so this readable suffix can never be
   * ambiguous with a serialized request body.
   */
  private static readonly CACHE_IDENTITY_DELIM = ' id=';

  /**
   * The keys whose presence beside `data` makes a body a PAGE rather than a
   * payload — see {@link unwrapResponse} for why this list is narrow.
   *
   *  - `pagination` — the offset-paginated house envelope (`sendPaginated`).
   *  - `nextCursor` — the keyset-paginated one (the account audit trails).
   *
   * Membership is decided by key PRESENCE, never by value: the last page sends
   * `nextCursor: null`, and an envelope that collapsed into a bare payload
   * exactly when the stream ended would be a worse bug than the one this fixes.
   */
  private static readonly PAGE_ENVELOPE_KEYS: readonly string[] = ['pagination', 'nextCursor'];

  /**
   * Derive a stable, non-sensitive identity discriminator for cache scoping.
   *
   * Thin instance wrapper over the pure {@link computeIdentityTag} helper —
   * binds it to this instance's live access token. See that function's docs for
   * the full resolution contract (anon fallback, decoded `userId || id`,
   * token-hash fallback for undecodable tokens).
   */
  private computeIdentityTag(): string {
    return computeIdentityTag(this.tokenStore.getAccessToken());
  }

  /**
   * Generate cache key efficiently
   * Uses a content-addressed hash for large payloads so two requests with
   * the same shape but different values never collide on the same key
   * (which would silently serve stale data — e.g. paginated search results,
   * large object updates).
   *
   * The key is identity-scoped: the logical `method:url[:data]` portion is
   * suffixed with ` id=<identityTag>` so two callers with different
   * identities (anon vs authed, or two different users) never share an entry.
   * The identity tag is placed at the END so the key still STARTS with
   * `method:url`, preserving the prefix-based invalidation in
   * `clearCacheByPrefix` (e.g. `GET:/session/user/`) and the base-key matching
   * in `clearCacheEntry`.
   */
  private generateCacheKey(method: string, url: string, data?: unknown): string {
    return `${this.generateBaseCacheKey(method, url, data)}${HttpService.CACHE_IDENTITY_DELIM}${this.computeIdentityTag()}`;
  }

  /**
   * Build the identity-agnostic portion of a cache key (`method:url[:data]`).
   * Kept separate so identity scoping is applied in exactly one place
   * (`generateCacheKey`) and cannot drift between the cache and dedupe paths.
   */
  private generateBaseCacheKey(method: string, url: string, data?: unknown): string {
    if (!data || (typeof data === 'object' && Object.keys(data).length === 0)) {
      return `${method}:${url}`;
    }

    // For small objects, the full serialization IS the key — fastest and
    // guaranteed to be content-addressed.
    const dataStr = JSON.stringify(data);
    if (dataStr.length < 1000) {
      return `${method}:${url}:${dataStr}`;
    }

    // For large payloads, hash the full serialized string so the key remains
    // content-addressed (any byte change yields a different hash). Previous
    // implementation hashed `keys + length` which collided for any two
    // payloads with the same top-level keys and serialized length.
    return `${method}:${url}:${fnv1a32(dataStr)}`;
  }

  /**
   * Build full URL with query params
   */
  private buildURL(url: string, params?: Record<string, unknown>): string {
    const base = /^https?:\/\//i.test(url)
      ? url
      : `${this.baseURL.replace(/\/+$/, '')}/${url.replace(/^\/+/, '')}`;
    
    if (!params || Object.keys(params).length === 0) {
      return base;
    }

    const searchParams = new URLSearchParams();
    Object.entries(params).forEach(([key, value]) => {
      if (value !== undefined && value !== null) {
        searchParams.append(key, String(value));
      }
    });

    const queryString = searchParams.toString();
    return queryString ? `${base}${base.includes('?') ? '&' : '?'}${queryString}` : base;
  }

  private getCredentialsMode(url: string): RequestCredentials {
    return this.shouldSendCredentials(url) ? 'include' : 'omit';
  }

  private shouldSendCredentials(url: string): boolean {
    try {
      return new URL(url).origin === new URL(this.baseURL).origin;
    } catch {
      return false;
    }
  }

  /**
   * Fetch CSRF token from server (with deduplication)
   * Required for state-changing requests (POST, PUT, PATCH, DELETE)
   */
  private async fetchCsrfToken(): Promise<string | null> {
    // Return cached token if available
    const cachedToken = this.tokenStore.getCsrfToken();
    if (cachedToken) {
      this.logger.debug('Using cached CSRF token');
      return cachedToken;
    }

    // Deduplicate concurrent CSRF token fetches
    const existingPromise = this.tokenStore.getCsrfTokenFetchPromise();
    if (existingPromise) {
      this.logger.debug('Waiting for existing CSRF fetch');
      return existingPromise;
    }

    const fetchPromise = (async () => {
      for (let attempt = 1; attempt <= CSRF_FETCH_MAX_ATTEMPTS; attempt++) {
        try {
          this.logger.debug('Fetching CSRF token from:', `${this.baseURL}/csrf-token`, `(attempt ${attempt})`);

          // Use AbortController for timeout (more compatible than AbortSignal.timeout)
          const controller = new AbortController();
          const timeoutId = setTimeout(() => controller.abort(), CSRF_FETCH_TIMEOUT_MS);

          const response = await fetch(`${this.baseURL}/csrf-token`, {
            method: 'GET',
            headers: { 'Accept': 'application/json' },
            credentials: 'include', // Required to receive and send cookies
            signal: controller.signal,
          });

          clearTimeout(timeoutId);

          this.logger.debug('CSRF fetch response:', response.status, response.ok);

          if (response.ok) {
            const data = await response.json() as { csrfToken?: string };
            const token = data.csrfToken || null;
            this.logger.debug('CSRF response data:', {
              hasCsrfToken: typeof token === 'string' && token.length > 0,
              csrfTokenLength: token?.length,
            });
            this.tokenStore.setCsrfToken(token);
            this.logger.debug('CSRF token fetched');
            return token;
          }

          // Also check response header for CSRF token
          const headerToken = response.headers.get('X-CSRF-Token');
          if (headerToken) {
            this.tokenStore.setCsrfToken(headerToken);
            this.logger.debug('CSRF token from header');
            return headerToken;
          }

          this.logger.debug('CSRF fetch failed with status:', response.status);
          this.logger.warn('Failed to fetch CSRF token:', response.status);
        } catch (error) {
          this.logger.debug('CSRF fetch error:', error);
          this.logger.warn('CSRF token fetch error:', error);
        }
        // Brief backoff before the next attempt.
        if (attempt < CSRF_FETCH_MAX_ATTEMPTS) {
          await new Promise(resolve => setTimeout(resolve, CSRF_FETCH_RETRY_DELAY_MS));
        }
      }
      return null;
    })().finally(() => {
      this.tokenStore.setCsrfTokenFetchPromise(null);
    });

    this.tokenStore.setCsrfTokenFetchPromise(fetchPromise);
    return fetchPromise;
  }

  /**
   * Get auth header with automatic token refresh
   */
  private async getAuthHeader(): Promise<string | null> {
    const accessToken = this.syncAccessTokenFromProvider();
    if (!accessToken) {
      return null;
    }

    try {
      const decoded = jwtDecode<JwtPayload>(accessToken);
      const currentTime = Math.floor(Date.now() / 1000);

      // If the token expires within the refresh lead window, refresh it.
      if (decoded.exp && decoded.exp - currentTime < TOKEN_REFRESH_LEAD_SECONDS) {
        const refreshed = await this.refreshAccessToken('preflight');
        if (refreshed) return `Bearer ${refreshed}`;
        if (decoded.exp > currentTime) {
          return `Bearer ${accessToken}`;
        }
        // Refresh failed — don't use an expired token (would cause 401 loop)
        return null;
      }

      return `Bearer ${accessToken}`;
    } catch (error) {
      this.logger.error('Error processing token:', error);
      return null;
    }
  }

  async refreshAccessToken(reason: AuthRefreshReason): Promise<string | null> {
    if (!this.authRefreshHandler) {
      return null;
    }

    // Post-failure cooldown. A genuinely EXPIRED current token uses a much
    // shorter cooldown than a still-valid (proactive, near-expiry) one: an
    // expired token is unusable, so re-mint as soon as the endpoint is reachable
    // again rather than waiting out the full window while requests carry a stale
    // bearer. Both cooldowns are measured from the last failure, so the moment a
    // still-valid token crosses `exp` mid-cooldown the shorter window applies.
    const cooldownMs = this.isAccessTokenExpired()
      ? EXPIRED_TOKEN_REFRESH_COOLDOWN_MS
      : TOKEN_REFRESH_COOLDOWN_MS;
    if (Date.now() - this.lastRefreshFailureAt < cooldownMs) {
      return null;
    }

    if (!this.tokenRefreshPromise) {
      this.tokenRefreshPromise = this.authRefreshHandler(reason)
        .then((newToken) => {
          if (!newToken) {
            this.lastRefreshFailureAt = Date.now();
            return null;
          }
          if (this.tokenStore.getAccessToken() !== newToken) {
            this.tokenStore.setTokens(newToken);
            this.notifyTokenChange();
          }
          // A success clears the failure timestamp so the next refresh is never
          // throttled by a stale cooldown.
          this.lastRefreshFailureAt = 0;
          this.logger.debug('Token refreshed via the auth refresh handler');
          return newToken;
        })
        .catch((error) => {
          this.logger.warn('Token refresh failed:', error);
          this.lastRefreshFailureAt = Date.now();
          return null;
        })
        .finally(() => {
          this.tokenRefreshPromise = null;
        });
    }

    return this.tokenRefreshPromise;
  }

  /**
   * Whether the CURRENT stored access token is already past its `exp`. Drives
   * the shorter post-failure refresh cooldown ({@link EXPIRED_TOKEN_REFRESH_COOLDOWN_MS}):
   * a still-valid (near-expiry) token can wait out the full cooldown, but an
   * expired one must re-mint promptly. Returns `false` for an absent or
   * opaque/no-`exp` token — no proof it is expired, so keep the conservative
   * (longer) cooldown and avoid an unnecessary retry loop.
   */
  private isAccessTokenExpired(): boolean {
    const token = this.tokenStore.getAccessToken();
    if (!token) {
      return false;
    }
    try {
      const decoded = jwtDecode<JwtPayload>(token);
      return typeof decoded.exp === 'number' && decoded.exp <= Math.floor(Date.now() / 1000);
    } catch {
      return false;
    }
  }

  /**
   * PROCESS-WIDE single-flight for the rotating device-secret mint
   * (`POST /session/device/token`).
   *
   * The server rotates the presented `deviceSecret` on every successful mint, so
   * two concurrent mints would double-rotate and the durable store could end up
   * holding a superseded secret → a later cold-boot mint 401s → the user is
   * signed out. Every mint lane (the re-mint handler behind `refreshAccessToken`,
   * the device-first cold boot, the socket token transport, the tab-focus
   * reconcile) funnels its `refreshDeviceSecretArm` call through here, so
   * concurrent callers await the SAME in-flight mint and all receive its result —
   * exactly one server rotation.
   *
   * Distinct from {@link tokenRefreshPromise} (which dedups the FULL re-mint
   * handler incl. the native shared-key arm + the failure cooldown): this inner
   * guard serializes the rotation itself across BOTH the handler and the
   * handler-independent cold boot, which never runs through `refreshAccessToken`.
   */
  runSingleFlightDeviceSecretMint(
    mint: () => Promise<DeviceSecretMintOutcome>,
  ): Promise<DeviceSecretMintOutcome> {
    if (!this.deviceSecretMintInFlight) {
      this.deviceSecretMintInFlight = mint().finally(() => {
        this.deviceSecretMintInFlight = null;
      });
    }
    return this.deviceSecretMintInFlight;
  }

  /**
   * Unwrap the standardized API response envelope — EXCEPT when the envelope is
   * a page, in which case it travels whole.
   *
   * `{ data: <payload> }` is the house success envelope (`sendSuccess`), and
   * reducing it to `<payload>` is what every call site in the SDK expects. But
   * the reduction DISCARDS every sibling key, silently, and a page's siblings
   * are the only thing that says where the next page starts. That is how
   * `GET /accounts/:id/audit` lost its `nextCursor`: the caller received a bare
   * array, `getNextPageParam` read `undefined`, and pagination was dead past the
   * first page with nothing to show that it was.
   *
   * ## Why the rule is narrow, and not "any sibling key survives"
   *
   * "An object carrying `data` plus anything else is not an envelope" is the
   * tempting general rule, and it is wrong here: this API already answers
   * `{ data, count }` on ~15 routes, plus `{ data, source }`, `{ data, reason }`
   * and `{ data, credentialRevoked }`, and a dozen measured Console call sites
   * type those as the bare payload (`Array<ProviderConnection>`,
   * `AccountBillingState | null`, …). Preserving those envelopes would hand every
   * one of them an object where it expects its payload — at runtime only, since
   * the response type is a call-site assertion. So the rule names PAGINATION
   * specifically: `data` beside {@link PAGE_ENVELOPE_KEYS} is a page.
   *
   * A route whose sibling key genuinely matters to its caller belongs in that
   * list, or should not be a sibling of `data` at all — the cursor-paginated
   * surfaces already in the SDK (`{ follows, nextCursor }`,
   * `{ records, nextCursor }`) sidestep this by never using `data`.
   */
  private unwrapResponse(responseData: unknown): unknown {
    if (!responseData || typeof responseData !== 'object' || !('data' in responseData)) {
      // Not the success envelope (or not an object at all) — as-is.
      return responseData;
    }

    // A page travels whole: its cursor/pagination sibling is unrecoverable
    // information, not decoration.
    if (HttpService.PAGE_ENVELOPE_KEYS.some((key) => key in responseData)) {
      return responseData;
    }

    // Regular success envelope: `{ data: ... }` -> the payload.
    return Array.isArray(responseData) ? responseData : responseData.data;
  }

  /**
   * Update request metrics
   */
  private updateMetrics(success: boolean, duration: number): void {
    this.requestMetrics.totalRequests++;
    if (success) {
      this.requestMetrics.successfulRequests++;
    } else {
      this.requestMetrics.failedRequests++;
    }

    const alpha = 0.1;
    this.requestMetrics.averageResponseTime =
      this.requestMetrics.averageResponseTime * (1 - alpha) + duration * alpha;
  }

  // Convenience methods
  async get<T = unknown>(url: string, config?: Omit<RequestConfig, 'method' | 'url'>): Promise<T> {
    return this.request<T>({ method: 'GET', url, ...config });
  }

  async post<T = unknown>(url: string, data?: unknown, config?: Omit<RequestConfig, 'method' | 'url' | 'data'>): Promise<T> {
    return this.request<T>({ method: 'POST', url, data, ...config });
  }

  async put<T = unknown>(url: string, data?: unknown, config?: Omit<RequestConfig, 'method' | 'url' | 'data'>): Promise<T> {
    return this.request<T>({ method: 'PUT', url, data, ...config });
  }

  async patch<T = unknown>(url: string, data?: unknown, config?: Omit<RequestConfig, 'method' | 'url' | 'data'>): Promise<T> {
    return this.request<T>({ method: 'PATCH', url, data, ...config });
  }

  async delete<T = unknown>(url: string, config?: Omit<RequestConfig, 'method' | 'url'>): Promise<T> {
    return this.request<T>({ method: 'DELETE', url, ...config });
  }

  // Token management
  setTokens(accessToken: string): void {
    this.tokenStore.setTokens(accessToken);
    this.notifyTokenChange();
  }

  setAuthRefreshHandler(handler: AuthRefreshHandler | null): void {
    this.authRefreshHandler = handler;
  }

  setAccessTokenProvider(provider: AccessTokenProvider | null): void {
    this.accessTokenProvider = provider;
  }

  clearTokens(): void {
    this.tokenStore.clearTokens();
    this.tokenStore.clearCsrfToken();
    // Drop the response cache on logout. The cache is identity-scoped, so a
    // different user could never read these entries, but a logged-out client
    // must not keep the previous session's personalized data resident in
    // memory (privacy + correct logout semantics). We do NOT clear on
    // `setTokens` because a silent token refresh re-issues a token for the
    // SAME user — the identity tag is unchanged and the warm cache is still
    // valid; clearing there would defeat caching as refreshes fire near
    // every token expiry.
    this.cache.clear();
    this.notifyTokenChange();
  }

  /**
   * Subscribe to access-token changes on this instance.
   *
   * Fires on every mutation of the access token — `setTokens`, `clearTokens`,
   * a successful silent refresh, and the internal 401-driven clear — passing
   * the resulting token (or `null` when cleared). Returns an unsubscribe
   * function; call it on teardown to avoid leaks.
   *
   * This is the single hook downstream code (e.g. @oxyhq/services' OxyProvider)
   * uses to keep an external token sink — such as the shared `oxyClient`
   * singleton — in lockstep with the active session, regardless of which code
   * path mutated the token.
   */
  addTokenChangeListener(listener: (accessToken: string | null) => void): () => void {
    this._tokenChangeListeners.add(listener);
    return () => {
      this._tokenChangeListeners.delete(listener);
    };
  }

  /**
   * Notify all token-change listeners with the current access token.
   * Listener exceptions are isolated so one bad subscriber cannot break token
   * propagation to the others or to the calling auth flow.
   * @internal
   */
  private notifyTokenChange(): void {
    if (this._tokenChangeListeners.size === 0) return;
    const accessToken = this.tokenStore.getAccessToken();
    for (const listener of this._tokenChangeListeners) {
      try {
        listener(accessToken);
      } catch (error) {
        this.logger.error('Token change listener threw:', error);
      }
    }
  }

  getAccessToken(): string | null {
    return this.tokenStore.getAccessToken();
  }

  hasAccessToken(): boolean {
    return this.tokenStore.hasAccessToken();
  }

  getBaseURL(): string {
    return this.baseURL;
  }

  // Cache management
  clearCache(): void {
    this.cache.clear();
  }

  /**
   * Delete a cache entry by its LOGICAL key (`method:url[:data]`).
   *
   * Because the response cache is identity-scoped — stored keys carry an
   * ` id=<identityTag>` suffix — a caller passing the logical key
   * `GET:/users/<id>` must invalidate that resource for EVERY identity that
   * cached it (e.g. `updateProfile` busting a user representation that may be
   * cached under both the owner's id and a viewer's id). We therefore delete
   * the exact key (for any pre-existing un-suffixed entries) AND every
   * identity-scoped variant `<key> id=*`.
   */
  clearCacheEntry(key: string): void {
    this.cache.delete(key);
    const identityVariantPrefix = `${key}${HttpService.CACHE_IDENTITY_DELIM}`;
    for (const existing of this.cache.keys()) {
      if (existing.startsWith(identityVariantPrefix)) {
        this.cache.delete(existing);
      }
    }
  }

  /**
   * Delete every cache entry whose key starts with `prefix`.
   *
   * Used by mutations that don't know the exact downstream cache keys —
   * e.g. `updateProfile` invalidating all `GET:/session/user/*` entries
   * without having to track every active session ID. Returns the number of
   * deleted entries (for observability in tests).
   */
  clearCacheByPrefix(prefix: string): number {
    let removed = 0;
    for (const key of this.cache.keys()) {
      if (key.startsWith(prefix)) {
        this.cache.delete(key);
        removed++;
      }
    }
    return removed;
  }

  getCacheStats() {
    const cacheStats = this.cache.getStats();
    const total = this.requestMetrics.cacheHits + this.requestMetrics.cacheMisses;
    return {
      size: cacheStats.size,
      hits: this.requestMetrics.cacheHits,
      misses: this.requestMetrics.cacheMisses,
      hitRate: total > 0 ? this.requestMetrics.cacheHits / total : 0,
    };
  }

  getMetrics() {
    return { ...this.requestMetrics };
  }

  // Test-only utility — clears tokens on this instance
  __resetTokensForTests(): void {
    this.tokenStore.clearTokens();
    this.tokenStore.clearCsrfToken();
  }
}
