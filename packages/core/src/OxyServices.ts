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
import { HttpService, type AuthRefreshReason, type RequestOptions } from './HttpService';
import type { OxyConfig as OxyConfigBase } from './models/interfaces';
import { toOxyApiError } from './OxyServices.errors';
import type { HttpMethod, OxyContext } from './client/context';
import { SessionApi } from './api/session';
import { AuthApi } from './api/auth';
import { UsersApi } from './api/users';
import { FollowsApi } from './api/follows';
import { PrivacyApi } from './api/privacy';
import { NotificationsApi } from './api/notifications';
import { AssetsApi } from './api/assets';
import { IdentityApi } from './api/identity';
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

export interface OxyConfig extends OxyConfigBase {
  /** Oxy Cloud (file CDN) origin. Default `https://cloud.oxy.so`. */
  cloudURL?: string;
}

/** An HTTP client for an app's own backend, bound to this client's session. */
export interface LinkedHttpClient {
  client: HttpService;
  dispose(): void;
}

/** Default Oxy Cloud URL — used when no `cloudURL` is given. */
export const OXY_CLOUD_URL = 'https://cloud.oxy.so';

/** Default Oxy API URL. */
export const OXY_API_URL = 'https://api.oxy.so';

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
  async request<T>(method: HttpMethod, url: string, data?: unknown, options: RequestOptions = {}): Promise<T> {
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
    const client = new HttpService({ ...config, enableCache: config.enableCache ?? false });

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

  /** Release this client: its cache stops being swept and its session ends. */
  dispose(): void {
    this.http.dispose();
  }

  // ── Namespaces (created on first access) ─────────────────────────────────

  private _session?: SessionApi;
  private _auth?: AuthApi;
  private _users?: UsersApi;
  private _follows?: FollowsApi;
  private _privacy?: PrivacyApi;
  private _notifications?: NotificationsApi;
  private _assets?: AssetsApi;
  private _identity?: IdentityApi;
  private _accounts?: AccountsApi;
  private _apps?: AppsApi;
  private _linkedAccounts?: LinkedAccountsApi;
  private _agency?: AgencyApi;
  private _store?: StoreApi;
  private _billing?: BillingApi;
  private _reputation?: ReputationApi;
  private _civic?: CivicApi;
  private _nodes?: NodesApi;
  private _devices?: DevicesApi;
  private _topics?: TopicsApi;
  private _appData?: AppDataApi;
  private _contacts?: ContactsApi;

  /** This client's auth state (token, user id) and its server session. */
  get session(): SessionApi {
    if (!this._session) this._session = new SessionApi(this.context);
    return this._session;
  }
  /** Signing in, signing up, and the account's credentials. */
  get auth(): AuthApi {
    if (!this._auth) this._auth = new AuthApi(this.context);
    return this._auth;
  }
  /** People and their profiles. */
  get users(): UsersApi {
    if (!this._users) this._users = new UsersApi(this.context);
    return this._users;
  }
  /** The follow graph: people and every other followable target. */
  get follows(): FollowsApi {
    if (!this._follows) this._follows = new FollowsApi(this.context);
    return this._follows;
  }
  /** Privacy settings, blocks and restrictions. */
  get privacy(): PrivacyApi {
    if (!this._privacy) this._privacy = new PrivacyApi(this.context);
    return this._privacy;
  }
  /** The in-app inbox and push tokens. */
  get notifications(): NotificationsApi {
    if (!this._notifications) this._notifications = new NotificationsApi(this.context);
    return this._notifications;
  }
  /** Files: upload, link, URLs, content. */
  get assets(): AssetsApi {
    if (!this._assets) this._assets = new AssetsApi(this.context);
    return this._assets;
  }
  /** DID, keys, identity links, domains, backup and the signed export. */
  get identity(): IdentityApi {
    if (!this._identity) this._identity = new IdentityApi(this.context);
    return this._identity;
  }
  /** The account graph: accounts and their members. */
  get accounts(): AccountsApi {
    if (!this._accounts) this._accounts = new AccountsApi(this.context);
    return this._accounts;
  }
  /** Applications an account owns, and the ones this user granted access. */
  get apps(): AppsApi {
    if (!this._apps) this._apps = new AppsApi(this.context);
    return this._apps;
  }
  /** External accounts (Mastodon, Bluesky) linked by OAuth. */
  get linkedAccounts(): LinkedAccountsApi {
    if (!this._linkedAccounts) this._linkedAccounts = new LinkedAccountsApi(this.context);
    return this._linkedAccounts;
  }
  /** Delegated capabilities for agents. */
  get agency(): AgencyApi {
    if (!this._agency) this._agency = new AgencyApi(this.context);
    return this._agency;
  }
  /** The app store: storefront, reviews, and a publisher's listing. */
  get store(): StoreApi {
    if (!this._store) this._store = new StoreApi(this.context);
    return this._store;
  }
  /** Subscription, wallet and payments. */
  get billing(): BillingApi {
    if (!this._billing) this._billing = new BillingApi(this.context);
    return this._billing;
  }
  /** Oxy Trust reputation (read-only for people; apps award it). */
  get reputation(): ReputationApi {
    if (!this._reputation) this._reputation = new ReputationApi(this.context);
    return this._reputation;
  }
  /** Oxy ID: cards, attestations, vouching, personhood, credentials. */
  get civic(): CivicApi {
    if (!this._civic) this._civic = new CivicApi(this.context);
    return this._civic;
  }
  /** The user's personal data node. */
  get nodes(): NodesApi {
    if (!this._nodes) this._nodes = new NodesApi(this.context);
    return this._nodes;
  }
  /** This user's devices, their sessions, and device sign-in. */
  get devices(): DevicesApi {
    if (!this._devices) this._devices = new DevicesApi(this.context);
    return this._devices;
  }
  get topics(): TopicsApi {
    if (!this._topics) this._topics = new TopicsApi(this.context);
    return this._topics;
  }
  /** Per-app key/value data stored on the user's account. */
  get appData(): AppDataApi {
    if (!this._appData) this._appData = new AppDataApi(this.context);
    return this._appData;
  }
  get contacts(): ContactsApi {
    if (!this._contacts) this._contacts = new ContactsApi(this.context);
    return this._contacts;
  }
}

