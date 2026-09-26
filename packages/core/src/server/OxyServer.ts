/**
 * `OxyServer` — the Oxy client for a backend.
 *
 * ```ts
 * import { OxyServer } from '@oxy.so/core/server';
 *
 * const oxy = new OxyServer({
 *   baseURL: 'https://api.oxy.so',
 *   serviceAuth: { apiKey: process.env.OXY_SERVICE_API_KEY!, apiSecret: process.env.OXY_SERVICE_API_SECRET! },
 * });
 *
 * app.use('/api', oxy.middleware.auth());
 * io.use(oxy.middleware.socket());
 * app.use('/internal', oxy.middleware.service(), oxy.middleware.requireScope('files:read'));
 *
 * const people = await oxy.users.getMany(ids);           // service lane when available
 * const meta = await oxy.assets.metadataByIds(fileIds);  // service-only
 * ```
 *
 * Everything `OxyServices` has, plus the service-token lane (a key pair from
 * `serviceAuth` / `configureServiceAuth`, or — with neither — the process's
 * attested workload identity, ADR 0026), the Express / Socket.IO middleware,
 * account events, and the service-only methods of `assets`, `notifications`,
 * `linkedAccounts`, `agency` and `reputation`.
 *
 * Node only.
 */
import { jwtDecode } from 'jwt-decode';
import { loadNodeCrypto } from '@oxy.so/protocol';
import { OxyServices, type OxyConfig } from '../OxyServices';
import type { HttpMethod, ServiceLane } from '../client/context';
import type { RequestOptions } from '../HttpService';
import { logger } from '../logger';
import { canAttestWorkloadIdentity, requestWorkloadServiceToken } from './workloadIdentity';
import {
  createOxyMiddleware,
  OXY_ACCOUNT_DELETED_EVENT_URI,
  OXY_JWT_ISSUER,
  OxyAccountEventError,
  parseJsonSegment,
  resolveServiceTokenPublicKey,
  type OxyAccountEvent,
  type OxyAccountEventFeedPage,
  type OxyMiddleware,
  type ServiceActingAsVerification,
  type ServiceTokenJwksCache,
  type ServiceTokenPublicJwk,
  type VerifyAccountEventOptions,
} from './middleware';
import {
  ServerAgencyApi,
  ServerAssetsApi,
  ServerLinkedAccountsApi,
  ServerNotificationsApi,
  ServerReputationApi,
} from './namespaces';

export interface OxyServerConfig extends OxyConfig {
  /** This service's application credential. Omit to use workload identity (ADR 0026). */
  serviceAuth?: { apiKey: string; apiSecret: string };
  /**
   * How this backend identifies itself on requests that carry no user session.
   *
   * - `'never'` (default): such requests go out anonymous.
   * - `'when-anonymous'`: they carry this process's service token instead —
   *   from `serviceAuth`, or, with none, from workload attestation (ADR 0026).
   *   A user session, when there is one, still wins; `skipAuth` requests stay
   *   unauthenticated; a process that can produce no service token (a local
   *   checkout) keeps sending them anonymous.
   *
   * Why a server wants it: oxy-api charges anonymous traffic to the SOURCE
   * ADDRESS (`rl:general`, and a +500 ms `slowDown` per request past 100 in 15
   * minutes), and a fleet leaves through one NAT address, so every anonymous
   * read a backend makes shares — and past the threshold pays for — one budget.
   * A first-party service token is exempt and charged to its own application.
   * Measured from Mention's task (2026-09-25): `GET /users/:id` 543–575 ms
   * anonymous past the threshold, `POST /users/by-ids` 19–24 ms with the
   * service token.
   */
  serviceIdentity?: 'never' | 'when-anonymous';
}

/**
 * How long a failed service-token mint sends session-less requests anonymous
 * before the next attempt, under `serviceIdentity: 'when-anonymous'`.
 */
export const ANONYMOUS_SERVICE_TOKEN_RETRY_MS = 30_000;

/** `POST /auth/service-token`. */
export interface ServiceTokenResponse {
  token: string;
  expiresIn: number;
  appName: string;
}

/**
 * Sentinel error raised when a service token is asked for with a known apiKey
 * but a non-matching secret: credential drift in the caller, or a cross-tenant
 * cache lookup attempt. Surface as a 401-equivalent.
 */
export class ServiceCredentialMismatchError extends Error {
  constructor() {
    super('Service credential mismatch: provided secret does not match the secret stored for this apiKey');
    this.name = 'ServiceCredentialMismatchError';
  }
}

/**
 * One cache entry per SHA-256(apiKey) → issued token + the secret that produced
 * it, kept as a Buffer for a constant-time compare on every hit, so an attacker
 * who learned a peer's apiKey cannot extract its cached token by guessing.
 */
interface ServiceTokenCacheEntry {
  token: string;
  /** Expiry as ms since epoch. */
  expiresAt: number;
  secretBuf: Buffer;
  /** In-flight mint (deduplicates concurrent callers). */
  pending: Promise<string> | null;
  /** The raw apiKey, so `invalidateServiceToken(apiKey)` stays synchronous. Never logged. */
  apiKey: string;
}

const WORKLOAD_CACHE_KEY = 'workload-identity';
/** A token is reused until 60s before expiry (clock drift). */
const TOKEN_REUSE_MARGIN_MS = 60_000;

/** Bound on remembered `appId:userId` delegation answers. */
const ACTING_AS_CACHE_MAX = 1000;
/** A positive grant is reused for 5 minutes — the revocation latency window. */
const ACTING_AS_GRANT_TTL_MS = 5 * 60 * 1000;
/** A negative answer (or a failed lookup) is reused for 1 minute. */
const ACTING_AS_DENIAL_TTL_MS = 60 * 1000;

export class OxyServer extends OxyServices {
  private readonly serviceTokens = new Map<string, ServiceTokenCacheEntry>();
  private serviceApiKey: string | null = null;
  private serviceApiSecret: string | null = null;
  private readonly actingAs = new Map<string, { result: ServiceActingAsVerification | null; expiresAt: number }>();
  private readonly actingAsPending = new Map<string, Promise<ServiceActingAsVerification | null>>();
  /** Public keys only; never private material. */
  private readonly jwksCache: ServiceTokenJwksCache = { keys: new Map(), expiresAt: 0, lastAttemptAt: 0 };
  /**
   * Before this instant a request without a user session does not try to mint
   * a service token and goes out anonymous. Set after a failed mint.
   */
  private anonymousServiceTokenRetryAt = 0;

  /**
   * Express and Socket.IO middleware.
   *
   * - `auth(options)` — Express: resolve the caller (user session or service
   *   token) onto `req.userId` / `req.user` / `req.serviceApp`.
   * - `socket(options)` — Socket.IO: the same for a handshake.
   * - `service(options)` — Express: service tokens only.
   * - `requireScope(scope)` — Express, after `auth`/`service`: the service
   *   token (and its delegation, if any) must hold `scope`.
   */
  readonly middleware: OxyMiddleware;

  constructor(config: OxyServerConfig) {
    super(config);
    if (config.serviceAuth) {
      this.configureServiceAuth(config.serviceAuth.apiKey, config.serviceAuth.apiSecret);
    }
    const server = this;
    const serviceLane: ServiceLane = {
      get available() {
        return server.canMintServiceToken();
      },
      request: (...args) => this.serviceRequest(...args),
    };
    this.context.service = serviceLane;
    if (config.serviceIdentity === 'when-anonymous') {
      this.http.setAnonymousAuthProvider(() => this.serviceTokenForAnonymousRequest());
    }
    this.middleware = createOxyMiddleware({
      get baseURL() {
        return server.baseURL;
      },
      jwksCache: this.jwksCache,
      validateSession: (sessionId, options) => this.session.validate(sessionId, options),
      verifyActingAs: (appId, userId) => this.verifyActingAs(appId, userId),
    });
  }

  // ── Server-side namespaces ───────────────────────────────────────────────

  private _serverAssets?: ServerAssetsApi;
  private _serverNotifications?: ServerNotificationsApi;
  private _serverLinkedAccounts?: ServerLinkedAccountsApi;
  private _serverAgency?: ServerAgencyApi;
  private _serverReputation?: ServerReputationApi;

  /** Files, plus the service-only metadata and linked-URL lookups. */
  override get assets(): ServerAssetsApi {
    if (!this._serverAssets) this._serverAssets = new ServerAssetsApi(this.context);
    return this._serverAssets;
  }
  /** The inbox and push tokens, plus `create`. */
  override get notifications(): ServerNotificationsApi {
    if (!this._serverNotifications) this._serverNotifications = new ServerNotificationsApi(this.context);
    return this._serverNotifications;
  }
  /** Linked external accounts, plus `forUser`. */
  override get linkedAccounts(): ServerLinkedAccountsApi {
    if (!this._serverLinkedAccounts) this._serverLinkedAccounts = new ServerLinkedAccountsApi(this.context);
    return this._serverLinkedAccounts;
  }
  /** Delegated capabilities, plus `introspectRequesterAssertion`. */
  override get agency(): ServerAgencyApi {
    if (!this._serverAgency) this._serverAgency = new ServerAgencyApi(this.context);
    return this._serverAgency;
  }
  /** Reputation reads, plus `award`. */
  override get reputation(): ServerReputationApi {
    if (!this._serverReputation) this._serverReputation = new ServerReputationApi(this.context);
    return this._serverReputation;
  }

  // ── Service token ────────────────────────────────────────────────────────

  /**
   * Set this service's application credential. Each `(apiKey, apiSecret)` pair
   * is cached independently, so a multi-tenant host switching credentials
   * cannot leak one tenant's token to another.
   */
  configureServiceAuth(apiKey: string, apiSecret: string): void {
    this.serviceApiKey = apiKey;
    this.serviceApiSecret = apiSecret;
  }

  /**
   * A service token (short-lived, cached and refreshed per credential pair;
   * concurrent callers share one mint).
   *
   * With no credential configured or passed, the token comes from the process's
   * attested workload identity (ADR 0026); with neither, this throws.
   *
   * If the cache already holds a token for `apiKey` but `apiSecret` does not
   * constant-time match the secret that produced it, this throws
   * {@link ServiceCredentialMismatchError} rather than return the cached token.
   */
  async serviceToken(apiKey?: string, apiSecret?: string): Promise<string> {
    const key = apiKey || this.serviceApiKey;
    const secret = apiSecret || this.serviceApiSecret;

    if (!key || !secret) {
      // No credential — prove what this process IS instead. The fallback, not the
      // preference: a deployment that still has a credential keeps using it.
      if (canAttestWorkloadIdentity()) {
        return this.workloadServiceToken();
      }
      throw new Error('Service credentials not provided. Pass serviceAuth, call configureServiceAuth(), or pass apiKey and apiSecret.');
    }

    // The apiKey is the credential's PUBLIC id (`oxy_dk_…`, the OAuth
    // client_id), so it keys the in-memory cache as is; the secret never does.
    const cacheKey = key;
    const now = Date.now();
    const providedSecretBuf = Buffer.from(secret, 'utf8');

    let entry = this.serviceTokens.get(cacheKey);

    if (entry) {
      // Verify the secret on every hit, fresh token or not. Constant-time, and
      // run on equal-length inputs even when the lengths differ.
      const nodeCrypto = await loadNodeCrypto();
      const stored = entry.secretBuf;
      const lengthMatch = stored.length === providedSecretBuf.length;
      const compareBuf = lengthMatch ? providedSecretBuf : Buffer.alloc(stored.length);
      const equal = nodeCrypto.timingSafeEqual(stored, compareBuf);
      if (!lengthMatch || !equal) {
        logger.warn('[oxy.auth] Service token cache hit with mismatched secret', {
          component: 'auth',
          method: 'serviceToken',
        });
        throw new ServiceCredentialMismatchError();
      }
      if (entry.token && entry.expiresAt > now + TOKEN_REUSE_MARGIN_MS) {
        return entry.token;
      }
      if (entry.pending) {
        return entry.pending;
      }
    } else {
      // Seed an empty entry so concurrent callers serialize on one promise.
      entry = { token: '', expiresAt: 0, secretBuf: providedSecretBuf, pending: null, apiKey: key };
      this.serviceTokens.set(cacheKey, entry);
    }

    const pending = this.mintServiceToken(key, secret, cacheKey, providedSecretBuf);
    entry.pending = pending;
    try {
      return await pending;
    } catch (error) {
      // Never keep an entry that never held a token: a wrong first secret must
      // not make the right one fail locally as a mismatch later.
      const failed = this.serviceTokens.get(cacheKey);
      if (failed?.pending === pending && !failed.token) {
        this.serviceTokens.delete(cacheKey);
      }
      throw error;
    } finally {
      const settled = this.serviceTokens.get(cacheKey);
      if (settled?.pending === pending) settled.pending = null;
    }
  }

  /**
   * Forget cached service token(s) so the next `serviceToken()` mints anew —
   * the way back from a 401 after a credential was revoked or rotated.
   *
   * `apiKey` clears that credential's entry; with none, the configured
   * credential's; with neither, every entry. Synchronous.
   */
  invalidateServiceToken(apiKey?: string): void {
    const targetKey = apiKey ?? this.serviceApiKey;
    if (!targetKey) {
      this.serviceTokens.clear();
      return;
    }
    this.serviceTokens.delete(targetKey);
  }

  /**
   * One request with this service's token. `actAs` sends `X-Oxy-User-Id`: the
   * request is on behalf of that user (the API checks the delegation grant).
   * Never cached unless `cache` says so. Rejects with `OxyApiError`.
   */
  async serviceRequest<T>(
    method: HttpMethod,
    url: string,
    data?: unknown,
    options: RequestOptions & { actAs?: string } = {},
  ): Promise<T> {
    const { actAs, headers, ...rest } = options;
    const token = await this.serviceToken();
    const merged: Record<string, string> = { ...headers, Authorization: `Bearer ${token}` };
    if (actAs) merged['X-Oxy-User-Id'] = actAs;
    return this.request<T>(method, url, data, { cache: false, ...rest, headers: merged });
  }

  // ── Delegation and account events ────────────────────────────────────────

  /**
   * Whether service app `appId` holds an active delegation grant to act for
   * `userId`; the grant's scopes, or `null`. Used by `middleware.auth()` for
   * `X-Oxy-User-Id`.
   *
   * Answers are cached per `appId:userId` (a grant for 5 minutes — the
   * revocation window; a denial or failed lookup for 1 minute), bounded to the
   * 1000 most recent pairs, and concurrent lookups of one pair share a single
   * request.
   */
  async verifyActingAs(appId: string, userId: string): Promise<ServiceActingAsVerification | null> {
    const cacheKey = `${appId}:${userId}`;
    const cached = this.actingAs.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      // Refresh recency for the LRU bound.
      this.actingAs.delete(cacheKey);
      this.actingAs.set(cacheKey, cached);
      return cached.result;
    }
    const inflight = this.actingAsPending.get(cacheKey);
    if (inflight) return inflight;

    const lookup = this.lookupActingAs(appId, userId).finally(() => {
      this.actingAsPending.delete(cacheKey);
    });
    this.actingAsPending.set(cacheKey, lookup);
    return lookup;
  }

  /**
   * Account events addressed to this application (Oxy account deletions every
   * relying application must honour, OxyHQ/Mention#1169).
   */
  readonly accountEvents = {
    /**
     * Verify an account event token — a webhook body, or a feed entry's `token`
     * — and return the event. Throws {@link OxyAccountEventError} unless it is
     * an EdDSA `secevent+jwt` from Oxy's key set, issued by `oxy-auth`,
     * addressed to this application, carrying exactly one known event. Be
     * idempotent on `eventId`: Oxy delivers at least once.
     */
    verify: (token: string, options: VerifyAccountEventOptions = {}): Promise<OxyAccountEvent> =>
      this.verifyAccountEvent(token, options),
    /**
     * One page of account events for this application, oldest first — the pull
     * feed behind the webhook. Verify each entry's `token` before acting on it.
     */
    list: async (options: { after?: string; limit?: number } = {}): Promise<OxyAccountEventFeedPage> => {
      const query: Record<string, string> = {};
      if (options.after) query.after = options.after;
      if (options.limit !== undefined) query.limit = String(options.limit);
      return this.serviceRequest<OxyAccountEventFeedPage>('GET', '/account-events', query);
    },
  };

  // ── Internals ────────────────────────────────────────────────────────────

  /**
   * The bearer for a request with no user session, under `serviceIdentity:
   * 'when-anonymous'`: this process's service token, or `null` to send the
   * request anonymous.
   *
   * `null`, never a throw, whenever there is no token to offer:
   * - no key pair and no attestable workload (a local checkout);
   * - the mint failed. The request still goes out, anonymous, and so does every
   *   request for the next {@link ANONYMOUS_SERVICE_TOKEN_RETRY_MS}, so an Oxy
   *   refusing attestation is asked once per window rather than once per read.
   *
   * The token comes from {@link serviceToken}: cached and single-flight, so
   * concurrent reads share one mint.
   */
  private async serviceTokenForAnonymousRequest(): Promise<string | null> {
    if (Date.now() < this.anonymousServiceTokenRetryAt) return null;
    if (!this.canMintServiceToken()) return null;
    try {
      return await this.serviceToken();
    } catch (error) {
      this.anonymousServiceTokenRetryAt = Date.now() + ANONYMOUS_SERVICE_TOKEN_RETRY_MS;
      logger.warn('[oxy.auth] No service token for a request without a session; sending it anonymous', {
        component: 'auth',
        method: 'serviceTokenForAnonymousRequest',
        retryInMs: ANONYMOUS_SERVICE_TOKEN_RETRY_MS,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  private canMintServiceToken(): boolean {
    return Boolean(this.serviceApiKey && this.serviceApiSecret) || canAttestWorkloadIdentity();
  }

  private async mintServiceToken(key: string, secret: string, cacheKey: string, secretBuf: Buffer): Promise<string> {
    const response = await this.request<ServiceTokenResponse>(
      'POST',
      '/auth/service-token',
      { apiKey: key, apiSecret: secret },
      { cache: false, retry: false, skipAuth: true },
    );
    const expiresAt = Date.now() + response.expiresIn * 1000;
    const entry = this.serviceTokens.get(cacheKey);
    if (entry) {
      entry.token = response.token;
      entry.expiresAt = expiresAt;
      entry.secretBuf = secretBuf;
    } else {
      this.serviceTokens.set(cacheKey, { token: response.token, expiresAt, secretBuf, pending: null, apiKey: key });
    }
    return response.token;
  }

  /** A token obtained by attestation, cached like a credential's (one identity per process). */
  private async workloadServiceToken(): Promise<string> {
    const entry = this.serviceTokens.get(WORKLOAD_CACHE_KEY);
    if (entry?.token && entry.expiresAt > Date.now() + TOKEN_REUSE_MARGIN_MS) return entry.token;
    if (entry?.pending) return entry.pending;

    const seeded = entry ?? { token: '', expiresAt: 0, secretBuf: Buffer.alloc(0), pending: null, apiKey: WORKLOAD_CACHE_KEY };
    this.serviceTokens.set(WORKLOAD_CACHE_KEY, seeded);

    const pending = (async () => {
      const granted = await requestWorkloadServiceToken({ baseUrl: this.baseURL });
      const current = this.serviceTokens.get(WORKLOAD_CACHE_KEY);
      if (current) {
        current.token = granted.token;
        current.expiresAt = Date.now() + granted.expiresIn * 1000;
      }
      return granted.token;
    })();
    seeded.pending = pending;

    try {
      return await pending;
    } catch (error) {
      const failed = this.serviceTokens.get(WORKLOAD_CACHE_KEY);
      if (failed?.pending === pending && !failed.token) this.serviceTokens.delete(WORKLOAD_CACHE_KEY);
      throw error;
    } finally {
      const settled = this.serviceTokens.get(WORKLOAD_CACHE_KEY);
      if (settled?.pending === pending) settled.pending = null;
    }
  }

  private async lookupActingAs(appId: string, userId: string): Promise<ServiceActingAsVerification | null> {
    try {
      // The verify endpoint admits only a platform-trusted caller, so this
      // carries the VERIFIER's own service token. No retry and a short timeout:
      // it runs inside request-handling middleware, and a retry loop would
      // multiply the latency of every delegated request. A verifier with no
      // credential throws here and is refused below — a host that cannot prove
      // who it is has no business learning who delegated to whom.
      const serviceToken = await this.serviceToken();
      const result = await this.request<ServiceActingAsVerification>(
        'GET',
        '/internal/service-acting-as/verify',
        { appId, userId },
        { cache: false, retry: false, timeout: 5000, headers: { Authorization: `Bearer ${serviceToken}` } },
      );
      const verified: ServiceActingAsVerification | null = result?.authorized
        ? { authorized: true, scopes: Array.isArray(result.scopes) ? result.scopes : [] }
        : null;
      this.rememberActingAs(`${appId}:${userId}`, verified, ACTING_AS_GRANT_TTL_MS);
      return verified;
    } catch (error) {
      logger.warn('[oxy.auth] verifyActingAs lookup failed — caching negative result', {
        component: 'auth',
        method: 'verifyActingAs',
        appId,
        userId,
      }, error);
      this.rememberActingAs(`${appId}:${userId}`, null, ACTING_AS_DENIAL_TTL_MS);
      return null;
    }
  }

  private rememberActingAs(cacheKey: string, result: ServiceActingAsVerification | null, ttlMs: number): void {
    this.actingAs.delete(cacheKey);
    this.actingAs.set(cacheKey, { result, expiresAt: Date.now() + ttlMs });
    if (this.actingAs.size > ACTING_AS_CACHE_MAX) {
      const oldest = this.actingAs.keys().next().value;
      if (oldest !== undefined) this.actingAs.delete(oldest);
    }
  }

  private async verifyAccountEvent(token: string, options: VerifyAccountEventOptions): Promise<OxyAccountEvent> {
    if (typeof token !== 'string' || token.length === 0 || token.length > 16 * 1024) {
      throw new OxyAccountEventError('Account event token is missing or oversized');
    }
    const parts = token.split('.');
    if (parts.length !== 3 || parts.some((part) => part.length === 0)) {
      throw new OxyAccountEventError('Account event token is not a compact JWS');
    }
    const [headerB64, payloadB64, signatureB64] = parts as [string, string, string];
    let header: Record<string, unknown>;
    let payload: Record<string, unknown>;
    try {
      header = parseJsonSegment(headerB64);
      payload = parseJsonSegment(payloadB64);
    } catch {
      throw new OxyAccountEventError('Account event token is malformed');
    }
    if (
      Object.keys(header).length !== 3
      || header.alg !== 'EdDSA'
      || header.typ !== 'secevent+jwt'
      || typeof header.kid !== 'string'
      || !/^[A-Za-z0-9._-]{1,128}$/.test(header.kid)
    ) {
      throw new OxyAccountEventError('Account event token header is not supported');
    }

    const nodeCrypto = await loadNodeCrypto();
    let jwk: ServiceTokenPublicJwk;
    try {
      jwk = await resolveServiceTokenPublicKey(
        header.kid,
        options.jwksUrl ?? new URL('/.well-known/jwks.json', this.baseURL).toString(),
        this.jwksCache,
      );
    } catch (error) {
      throw new OxyAccountEventError(
        error instanceof Error ? error.message.replace('Service token', 'Account event') : 'Signing key is unavailable',
      );
    }
    const signature = Buffer.from(signatureB64, 'base64url');
    if (signature.toString('base64url') !== signatureB64 || signature.length !== 64) {
      throw new OxyAccountEventError('Account event token signature is malformed');
    }
    let verified = false;
    try {
      const publicKey = nodeCrypto.createPublicKey({ key: jwk as unknown as import('node:crypto').JsonWebKey, format: 'jwk' });
      verified = nodeCrypto.verify(null, Buffer.from(`${headerB64}.${payloadB64}`), publicKey, signature);
    } catch {
      verified = false;
    }
    if (!verified) throw new OxyAccountEventError('Account event token signature is invalid');

    if (payload.iss !== OXY_JWT_ISSUER) {
      throw new OxyAccountEventError('Account event token issuer is not Oxy');
    }
    const audience = options.audience ?? await this.configuredServiceAppId();
    if (typeof payload.aud !== 'string' || payload.aud !== audience) {
      throw new OxyAccountEventError('Account event token is addressed to another application');
    }
    if (typeof payload.jti !== 'string' || payload.jti.length === 0 || payload.jti.length > 128) {
      throw new OxyAccountEventError('Account event token has no event id');
    }
    if (typeof payload.iat !== 'number' || !Number.isFinite(payload.iat)) {
      throw new OxyAccountEventError('Account event token has no issue time');
    }
    const events = payload.events;
    if (typeof events !== 'object' || events === null || Array.isArray(events)) {
      throw new OxyAccountEventError('Account event token carries no events');
    }
    const entries = Object.entries(events as Record<string, unknown>);
    const deleted = (events as Record<string, unknown>)[OXY_ACCOUNT_DELETED_EVENT_URI];
    if (entries.length !== 1 || typeof deleted !== 'object' || deleted === null || Array.isArray(deleted)) {
      throw new OxyAccountEventError('Account event token carries an unknown event');
    }
    const body = deleted as Record<string, unknown>;
    if (typeof body.userId !== 'string' || body.userId.length === 0 || body.userId.length > 128) {
      throw new OxyAccountEventError('Account event names no account');
    }
    if (typeof body.occurredAt !== 'string' || Number.isNaN(Date.parse(body.occurredAt))) {
      throw new OxyAccountEventError('Account event has no occurrence time');
    }
    if (body.username !== undefined && body.username !== null && typeof body.username !== 'string') {
      throw new OxyAccountEventError('Account event username is malformed');
    }
    return {
      eventId: payload.jti,
      type: 'account.deleted',
      userId: body.userId,
      username: typeof body.username === 'string' ? body.username : null,
      occurredAt: body.occurredAt,
      retained: body.retained === true,
      applicationId: payload.aud,
      issuedAt: payload.iat,
    };
  }

  /** The `appId` claim of this service's own token. */
  private async configuredServiceAppId(): Promise<string> {
    const serviceToken = await this.serviceToken();
    const appId = jwtDecode<{ appId?: unknown }>(serviceToken).appId;
    if (typeof appId !== 'string' || appId.length === 0) {
      throw new OxyAccountEventError('No audience given and the service credential names no application');
    }
    return appId;
  }
}

