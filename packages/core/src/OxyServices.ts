import { createAuthenticatedFetch } from './authenticatedFetch';
import { SafetyApi } from './api/safety';
import { ContentClaimsApi } from './api/contentClaims';
/**
 * `OxyServices` — the Oxy API client.
 *
 * ```ts
 * import { OxyServices } from '@oxy.so/core';
 *
 * const oxy = new OxyServices({ baseURL: 'https://api.oxy.so' });
 *
 * const me = await oxy.users.me();
 * const people = await oxy.users.getMany(ids);
 * const { id } = await oxy.assets.upload(file);
 * await oxy.follows.follow(userId);
 * ```
 *
 * The client itself is small — the transport (`request`, `http`), the response
 * cache, and `createLinkedClient` for an app's own backend. Everything else is a
 * namespace (`oxy.users`, `oxy.assets`, …), created on first access and kept for
 * the client's life.
 *
 * Servers use `OxyServer` from `@oxy.so/core/server`: the same client plus the
 * service-token lane and the Express / Socket.IO middleware.
 */
import {
  HttpService,
  type AuthRefreshReason,
  type RequestOptions,
  type ResponsePayload,
} from './HttpService';
import type { OxyConfig as OxyConfigBase } from './models/interfaces';
import { toOxyApiError } from './OxyServices.errors';
import type { HttpMethod, OxyContext } from './client/context';
import { assertCallOptions, type CallOptions, sendWithCallOptions } from './client/callOptions';
import { SessionApi } from './api/session';
import { AuthApi } from './api/auth';
import { UsersApi } from './api/users';
import { FollowsApi } from './api/follows';
import { PrivacyApi } from './api/privacy';
import { NotificationsApi } from './api/notifications';
import { AssetsApi } from './api/assets';
import { IdentityApi } from './api/identity';
import { OrganizationsApi } from './api/organizations';
import { AccountsApi } from './api/accounts';
import { AppsApi } from './api/apps';
import { LinkedAccountsApi } from './api/linkedAccounts';
import { AgencyApi } from './api/agency';
import { StoreApi } from './api/store';
import { BillingApi } from './api/billing';
import { ReputationApi } from './api/reputation';
import { CivicApi } from './api/civic';
import { NodesApi } from './api/nodes';
import { DevicesApi } from './api/devices';
import { TopicsApi } from './api/topics';
import { AppDataApi } from './api/appData';
import { ContactsApi } from './api/contacts';
import { ConsoleApi } from './api/console';

export interface OxyConfig extends OxyConfigBase {
  /** Oxy Cloud (file CDN) origin. Default `https://cloud.oxy.so`. */
  cloudURL?: string;
}

/** An HTTP client for an app's own backend, bound to this client's session. */
export interface LinkedHttpClient {
  client: HttpService;
  /** Origin-bound fetch for a product SDK; session and refresh stay in Oxy. */
  fetch: typeof globalThis.fetch;
  /** Same origin/session fences; public endpoints may be called while signed out. */
  fetchOptional: typeof globalThis.fetch;
  /** Resolve afresh for each socket handshake; HTTP↔WS must preserve host, port and TLS. */
  getAccessToken(target: string | URL, options?: { signal?: AbortSignal }): Promise<string>;
  dispose(): void;
}

/** Default Oxy Cloud URL — used when no `cloudURL` is given. */
export const OXY_CLOUD_URL = 'https://cloud.oxy.so';

/** Default Oxy API URL. */
export const OXY_API_URL = 'https://api.oxy.so';

/**
 * The namespaces a call scope ({@link OxyServices.withCallOptions}) carries:
 * every one but `session`, which is the client's auth state rather than a call.
 */
export type OxyCallScopeNamespace =
  | 'auth'
  | 'users'
  | 'follows'
  | 'privacy'
  | 'notifications'
  | 'assets'
  | 'identity'
  | 'safety'
  | 'contentClaims'
  | 'organizations'
  | 'accounts'
  | 'apps'
  | 'linkedAccounts'
  | 'agency'
  | 'store'
  | 'billing'
  | 'reputation'
  | 'civic'
  | 'nodes'
  | 'devices'
  | 'topics'
  | 'appData'
  | 'console'
  | 'contacts';

/**
 * The namespaces of a client — an `OxyServer`'s server namespaces included —
 * whose every request carries one set of {@link CallOptions}.
 */
export type OxyCallScope<T extends OxyServices = OxyServices> = Pick<T, OxyCallScopeNamespace>;

export class OxyServices {
  /** The transport. Every namespace call goes through it. */
  readonly http: HttpService;
  readonly config: Readonly<OxyConfig>;
  /** Oxy Cloud (file CDN) origin. */
  readonly cloudURL: string;

  /** Shared with every namespace; see `client/context.ts`. */
  protected readonly context: OxyContext;

  constructor(config: OxyConfig) {
    if (!config || typeof config !== 'object') {
      throw new Error('OxyConfig is required');
    }
    this.config = config;
    this.cloudURL = config.cloudURL || OXY_CLOUD_URL;
    this.http = new HttpService(config);
    this.context = {
      oxy: this,
      http: this.http,
      request: (method, url, data, options) => this.request(method, url, data, options),
      service: null,
    };
  }

  /** The Oxy API origin this client talks to. */
  get baseURL(): string {
    return this.http.getBaseURL();
  }

  /**
   * One authenticated request to the Oxy API — the primitive every namespace is
   * built on, for the routes no namespace covers yet. GET sends `data` as the
   * query string, every other method as the body. Rejects with `OxyApiError`.
   */
  async request<T>(
    method: HttpMethod,
    url: string,
    data?: unknown,
    options: RequestOptions = {},
  ): Promise<ResponsePayload<T>> {
    try {
      return await this.http.request<T>({
        method,
        url,
        data: method !== 'GET' ? data : undefined,
        params: method === 'GET' ? (data as Record<string, unknown> | undefined) : undefined,
        ...options,
      });
    } catch (error) {
      throw toOxyApiError(error);
    }
  }

  /** `GET /health`. */
  async health(): Promise<{ status: string; timestamp?: string; [key: string]: unknown }> {
    return this.request('GET', '/health', undefined, { cache: false, retry: false, timeout: 5000 });
  }

  /** The response cache (GETs only, identity-scoped). */
  readonly cache = {
    /** Drop every cached response. */
    clear: (): void => this.http.clearCache(),
    /** Drop one cached response by key (`GET:/path`), every identity's variant. */
    delete: (key: string): void => this.http.clearCacheEntry(key),
    /** Drop every cached response whose key starts with `prefix`; returns how many. */
    deletePrefix: (prefix: string): number => this.http.clearCacheByPrefix(prefix),
    stats: () => this.http.getCacheStats(),
  };

  /**
   * An HTTP client for an app's own backend (e.g. `https://api.syra.fm`) that
   * shares this client's session: its bearer follows this session's token and
   * its 401 refresh delegates here.
   *
   * GET caching is OFF by default: the SDK cannot invalidate another backend's
   * resources, so caching there belongs to the consumer's own layer (React
   * Query). Pass `enableCache: true` to opt in.
   */
  createLinkedClient(config: OxyConfig): LinkedHttpClient {
    const client = new HttpService(
      { ...config, enableCache: config.enableCache ?? false },
      this.http,
    );

    const syncToken = (accessToken: string | null): void => {
      const current = client.getAccessToken();
      if (accessToken) {
        if (current !== accessToken) client.setTokens(accessToken);
        return;
      }
      if (current) client.clearTokens();
    };

    syncToken(this.http.getAccessToken());
    const unsubscribe = this.http.addTokenChangeListener(syncToken);
    client.setAccessTokenProvider(() => this.http.getAccessToken());
    client.setAuthRefreshHandler(async (reason: AuthRefreshReason) => {
      const refreshed = await this.http.refreshAccessToken(reason);
      if (!refreshed) return null;
      syncToken(refreshed);
      return refreshed;
    });

    let disposed = false;
    return {
      client,
      fetch: createAuthenticatedFetch(client, config.baseURL ?? OXY_API_URL, {
        disposed: () => disposed,
      }),
      fetchOptional: createAuthenticatedFetch(client, config.baseURL ?? OXY_API_URL, {
        disposed: () => disposed,
        session: 'optional',
      }),
      getAccessToken: async (target, options) => {
        if (disposed) throw new Error('The linked client has been disposed');
        const token = await client.getAuthenticatedAccessToken(target, options);
        if (disposed) throw new Error('The linked client has been disposed');
        return token;
      },
      dispose: () => {
        disposed = true;
        unsubscribe();
        client.setAuthRefreshHandler(null);
        client.setAccessTokenProvider(null);
        client.clearTokens();
      },
    };
  }

  /** Release this client: its cache stops being swept and its session ends. */
  dispose(): void {
    this.http.dispose();
  }

  // ── Namespaces (created on first access) ─────────────────────────────────

  /** Each namespace, created on first access and kept for the client's life. */
  private readonly namespaceInstances = new Map<string, unknown>();

  /** The namespace `name`, created with this client's context on first access. */
  protected namespace<T>(name: string, create: (context: OxyContext) => T): T {
    let instance = this.namespaceInstances.get(name) as T | undefined;
    if (instance === undefined) {
      instance = create(this.context);
      this.namespaceInstances.set(name, instance);
    }
    return instance;
  }

  /**
   * This client's namespaces with per-call transport options: every request
   * made through them carries `options`, on top of what each method sets.
   *
   * ```ts
   * // One slow write, one tight read — one client.
   * await oxy.withCallOptions({ timeout: 60_000 }).assets.setVisibility(id, 'public');
   * const page = await oxy.withCallOptions({ deadline: 2_500 }).users.byUsername(name);
   * // A server's own namespaces too:
   * await server.withCallOptions({ retry: false }).assets.references.add(refs);
   * ```
   *
   * - `timeout` / `deadline` replace the method's own and the client's.
   * - `retry: false` sends each request once; `retry: true` never re-enables
   *   a request the method sends once on purpose.
   * - `signal` aborts the call; a method's own signal still applies too.
   *
   * The scope is a view, not a client: it shares this client's session,
   * cache, credentials and service lane, holds no resource and needs no
   * disposal. A namespace one call makes into another (`privacy` reading
   * `users.me()`) keeps the options. `session` is not part of it.
   */
  withCallOptions(options: CallOptions): OxyCallScope<this> {
    assertCallOptions(options);
    const scope: CallOptions = { ...options };
    const base = this.context;
    const lane = base.service;
    const view = Object.create(this) as this;
    const context: OxyContext = {
      oxy: view,
      http: base.http,
      request: (method, url, data, requestOptions) =>
        sendWithCallOptions(requestOptions, scope, (merged) =>
          base.request(method, url, data, merged),
        ),
      service: lane && {
        get available() {
          return lane.available;
        },
        request: (method, url, data, requestOptions) =>
          sendWithCallOptions(requestOptions, scope, (merged) =>
            lane.request(method, url, data, merged),
          ),
      },
    };
    // The view's own namespaces are built on the scoped context; everything
    // else (http, cache, config, credentials) is this client's, by prototype.
    Object.defineProperties(view, {
      context: { value: context },
      namespaceInstances: { value: new Map<string, unknown>() },
      session: { get: () => this.session },
    });
    return view;
  }

  /** This client's auth state (token, user id) and its server session. */
  get session(): SessionApi {
    return this.namespace('session', (context) => new SessionApi(context));
  }
  /** Signing in, signing up, and the account's credentials. */
  get auth(): AuthApi {
    return this.namespace('auth', (context) => new AuthApi(context));
  }
  /** People and their profiles. */
  get users(): UsersApi {
    return this.namespace('users', (context) => new UsersApi(context));
  }
  /** The follow graph: people and every other followable target. */
  get follows(): FollowsApi {
    return this.namespace('follows', (context) => new FollowsApi(context));
  }
  /** Privacy settings, blocks and restrictions. */
  get privacy(): PrivacyApi {
    return this.namespace('privacy', (context) => new PrivacyApi(context));
  }
  /** The in-app inbox and push tokens. */
  get notifications(): NotificationsApi {
    return this.namespace('notifications', (context) => new NotificationsApi(context));
  }
  /** Files: upload, link, URLs, content. */
  get assets(): AssetsApi {
    return this.namespace('assets', (context) => new AssetsApi(context));
  }
  /** DID, keys, identity links, domains, backup and the signed export. */
  get identity(): IdentityApi {
    return this.namespace('identity', (context) => new IdentityApi(context));
  }
  /** The account graph: accounts and their members. */
  get safety(): SafetyApi {
    return this.namespace('safety', (context) => new SafetyApi(context));
  }
  /** Content claims: an owner's counter-notice to a takedown (ADR 0043 D10). */
  get contentClaims(): ContentClaimsApi {
    return this.namespace('contentClaims', (context) => new ContentClaimsApi(context));
  }

  get organizations(): OrganizationsApi {
    return this.namespace('organizations', (context) => new OrganizationsApi(context));
  }

  get accounts(): AccountsApi {
    return this.namespace('accounts', (context) => new AccountsApi(context));
  }
  /** Applications an account owns, and the ones this user granted access. */
  get apps(): AppsApi {
    return this.namespace('apps', (context) => new AppsApi(context));
  }
  /** External accounts (Mastodon, Bluesky) linked by OAuth. */
  get linkedAccounts(): LinkedAccountsApi {
    return this.namespace('linkedAccounts', (context) => new LinkedAccountsApi(context));
  }
  /** Delegated capabilities for agents. */
  get agency(): AgencyApi {
    return this.namespace('agency', (context) => new AgencyApi(context));
  }
  /** The app store: storefront, reviews, and a publisher's listing. */
  get store(): StoreApi {
    return this.namespace('store', (context) => new StoreApi(context));
  }
  /** Subscription, wallet and payments. */
  get billing(): BillingApi {
    return this.namespace('billing', (context) => new BillingApi(context));
  }
  /** Oxy Trust reputation (read-only for people; apps award it). */
  get reputation(): ReputationApi {
    return this.namespace('reputation', (context) => new ReputationApi(context));
  }
  /** Oxy ID: cards, attestations, vouching, personhood, credentials. */
  get civic(): CivicApi {
    return this.namespace('civic', (context) => new CivicApi(context));
  }
  /** The user's personal data node. */
  get nodes(): NodesApi {
    return this.namespace('nodes', (context) => new NodesApi(context));
  }
  /** This user's devices, their sessions, and device sign-in. */
  get devices(): DevicesApi {
    return this.namespace('devices', (context) => new DevicesApi(context));
  }
  get topics(): TopicsApi {
    return this.namespace('topics', (context) => new TopicsApi(context));
  }
  /** Per-app key/value data stored on the user's account. */
  get appData(): AppDataApi {
    return this.namespace('appData', (context) => new AppDataApi(context));
  }
  /** Oxy Console: first-run onboarding (terms and use cases) for the signed-in person. */
  get console(): ConsoleApi {
    return this.namespace('console', (context) => new ConsoleApi(context));
  }
  get contacts(): ContactsApi {
    return this.namespace('contacts', (context) => new ContactsApi(context));
  }
}
