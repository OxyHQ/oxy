/**
 * `oxy.apps` — applications.
 *
 * Two unrelated surfaces share the word "app":
 * - the applications an ACCOUNT owns and manages (`/applications`): the OAuth
 *   clients, their credentials and usage — `apps.list/get/create/update/delete`,
 *   `apps.credentials.*`, `apps.usage`. Access derives from the caller's
 *   `AccountMember` on the owning account (`oxy.accounts`).
 * - the THIRD-PARTY applications this user granted access to through the
 *   consent flow — `apps.connected.*` — and the public identity of a requesting
 *   application for consent screens — `apps.getPublic`.
 *
 * Reference applications by their `_id` (`applicationId`), credentials by their
 * `credentialId`. A connected app is keyed by `applicationId`, never a
 * credential/client id, so a grant and its revocation survive credential
 * rotation.
 */
import type { OxyContext } from '../client/context';
import type { AccountMember, AccountSuccessResult } from './accounts';

const SHORT_TTL = 60 * 1000;
const MEDIUM_TTL = 2 * 60 * 1000;
const LONG_TTL = 5 * 60 * 1000;

const enc = encodeURIComponent;

// ---------------------------------------------------------------------------
// Application (owned by an account) types
// ---------------------------------------------------------------------------

/**
 * Application classification. Set only by Oxy platform staff — never editable
 * through the normal member-facing update path.
 */
export type ApplicationType = 'first_party' | 'third_party' | 'internal' | 'system';

/** Lifecycle status of an application. */
export type ApplicationStatus = 'active' | 'suspended' | 'deleted' | 'pending_review';

/**
 * Credential kind.
 *
 * The first three are OAuth clients: the `oxy_dk_…` `publicKey` is the
 * `client_id`, and any secret is presented BESIDE it. `service` credentials
 * additionally mint service tokens.
 *
 * `machine` is the OpenAI-SDK-compatible API key (issue #972 §2.3): its
 * credential material is ONE `oxy_sk_…` bearer string returned in `token`
 * exactly once on create/rotate, never in `secret`.
 */
export type ApplicationCredentialType = 'public' | 'confidential' | 'service' | 'machine';

/** Deployment environment an application credential is scoped to. */
export type ApplicationEnvironment = 'development' | 'staging' | 'production';

/** Application credential lifecycle status. */
export type ApplicationCredentialStatus = 'active' | 'deprecated' | 'revoked';

/**
 * Client-facing Application shape returned by the `/applications` API. An
 * application is the OAuth client; it is OWNED by an account
 * (`ownerAccountId`), and the caller's access derives from their `AccountMember`
 * on that owning account (with inheritance).
 */
export interface Application {
  _id: string;
  name: string;
  description?: string;
  websiteUrl?: string;
  /** Public privacy-policy URL, rendered as a legal link on the OAuth consent screen. */
  privacyPolicyUrl?: string;
  /** Public terms-of-service URL, rendered as a legal link on the OAuth consent screen. */
  termsUrl?: string;
  icon?: string;
  type: ApplicationType;
  status: ApplicationStatus;
  isOfficial: boolean;
  isInternal: boolean;
  capabilities: string[];
  redirectUris: string[];
  scopes: string[];
  webhookUrl?: string;
  devWebhookUrl?: string;
  createdByUserId: string;
  /**
   * The account that owns this application (account `_id`). Access to the
   * application derives from the caller's `AccountMember` on this account, with
   * inheritance up the account tree.
   */
  ownerAccountId: string;
  createdAt: string;
  updatedAt: string;
  /**
   * The caller's effective membership in the OWNING account (direct or
   * inherited), embedded by the API on list/detail responses, or `null` when the
   * caller has no membership. Use `callerMembership.permissions` to gate UI.
   */
  callerMembership?: AccountMember | null;
}

/**
 * Client-facing ApplicationCredential shape (an application's OAuth client
 * credentials). The raw secret is NEVER part of this shape — it is returned
 * exactly once, separately, at creation/rotation.
 */
export interface ApplicationCredential {
  _id: string;
  applicationId: string;
  name: string;
  publicKey: string;
  /**
   * `oxy_sk_<id>` — the PUBLIC lookup half of a `machine` credential's bearer
   * token, present only on that type. Safe to render: the secret half is 256
   * bits that were shown exactly once and are never returned again.
   */
  tokenPrefix?: string;
  type: ApplicationCredentialType;
  environment: ApplicationEnvironment;
  scopes: string[];
  status: ApplicationCredentialStatus;
  lastUsedAt?: string;
  expiresAt?: string;
  /**
   * Audit link to the credential this one was rotated FROM. Populated on
   * credentials created via rotation; absent on original credentials.
   */
  rotatedFromCredentialId?: string;
  createdByUserId: string;
  createdAt: string;
  updatedAt: string;
}

/** Input accepted by `apps.create`. Staff-only fields are not settable here. */
export interface CreateApplicationInput {
  name: string;
  description?: string;
  websiteUrl?: string;
  /** Public privacy-policy URL (absolute `https://`). Shown on the OAuth consent screen. */
  privacyPolicyUrl?: string;
  /** Public terms-of-service URL (absolute `https://`). Shown on the OAuth consent screen. */
  termsUrl?: string;
  icon?: string;
  redirectUris?: string[];
  scopes?: string[];
  /**
   * Owning account `_id`. Omitted → the API defaults to the caller's personal
   * account.
   */
  ownerAccountId?: string;
}

/** Input accepted by `apps.update`. Staff-only fields are not settable here. */
export interface UpdateApplicationInput {
  name?: string;
  description?: string;
  websiteUrl?: string;
  /** Public privacy-policy URL (absolute `https://`, or `''` to clear). Shown on the OAuth consent screen. */
  privacyPolicyUrl?: string;
  /** Public terms-of-service URL (absolute `https://`, or `''` to clear). Shown on the OAuth consent screen. */
  termsUrl?: string;
  icon?: string;
  redirectUris?: string[];
  scopes?: string[];
  webhookUrl?: string;
  devWebhookUrl?: string;
  status?: ApplicationStatus;
}

/** Input accepted by `apps.credentials.create`. */
export interface CreateApplicationCredentialInput {
  name: string;
  type: ApplicationCredentialType;
  environment: ApplicationEnvironment;
  scopes?: string[];
  /**
   * Lifetime of a `machine` credential, in seconds — 60 to 730 days. Omit for a
   * key that does not expire on its own.
   *
   * **`machine` only.** On every other credential type `expires_at` means the
   * rotation grace deadline, so a caller setting it at creation would make a
   * brand-new credential indistinguishable from a rotated one. The server
   * REJECTS it for those types rather than ignoring it, so sending it with the
   * wrong `type` is a 400, not a silently dropped field.
   */
  expiresInSeconds?: number;
}

/** Input accepted by `apps.credentials.rotate`. */
export interface RotateApplicationCredentialInput {
  /**
   * How long the superseded `machine` token keeps working, in seconds — 1 to 30
   * days. Omitting it revokes the previous token the instant the replacement is
   * minted, which is the safe default for a leaked key.
   *
   * **`machine` only, and opt-in.** `confidential`/`service` credentials always
   * retire on the platform's fixed seven-day grace and the server REJECTS this
   * field for them, so their contract is unchanged.
   */
  graceSeconds?: number;
}

/**
 * Result of creating an application credential — credential material is returned
 * ONCE and can never be read back.
 *
 * Exactly one of the two fields carries it, decided by
 * {@link ApplicationCredentialType}: `secret` for a `confidential`/`service`
 * client, `token` for a `machine` API key, and NEITHER for a `public` client
 * (`secret` is `null`). They are separate fields rather than one, so a surface
 * that renders "the secret" cannot silently render an API key's bearer token
 * under the wrong label, or a `null` where a token should be.
 */
export interface ApplicationCredentialWithSecret {
  credential: ApplicationCredential;
  /** The OAuth client secret. `null` for `public` and `machine` credentials. */
  secret: string | null;
  /** The full `oxy_sk_…` bearer token. Present ONLY for a `machine` credential. */
  token?: string;
}

/**
 * Result of rotating an application credential. Extends the create result with
 * audit fields: the new credential material is returned ONCE, plus `rotatedFrom`
 * (the previous credential's `credentialId`) and `graceExpiresAt`.
 */
export interface RotateApplicationCredentialResult extends ApplicationCredentialWithSecret {
  /** The previous credential's `credentialId` that this rotation supersedes. */
  rotatedFrom: string;
  /**
   * ISO timestamp at which the rotated-from credential stops being honoured, or
   * `null` when no grace window was configured and it was revoked outright.
   *
   * Nullable because a `machine` credential's grace is OPT-IN (issue #972 §2.3):
   * rotating an API key without asking for a window kills the old token
   * immediately, and there is then no deadline to report. The OAuth/service
   * types always carry their fixed seven-day deadline.
   */
  graceExpiresAt: string | null;
}

/** Time window for application usage statistics. */
export type ApplicationUsagePeriod = '24h' | '7d' | '30d' | '90d';

/** Aggregate totals for an application over the requested period. */
export interface ApplicationUsageSummary {
  totalRequests: number;
  totalTokens: number;
  totalCredits: number;
  avgResponseTime: number;
  successfulRequests: number;
  errorRequests: number;
}

/** Per-day usage bucket. `_id` is the day key (e.g. `YYYY-MM-DD`). */
export interface ApplicationUsageByDay {
  _id: string;
  requests: number;
  tokens: number;
  credits: number;
}

/** Per-endpoint usage bucket. `_id` is the endpoint identifier. */
export interface ApplicationUsageByEndpoint {
  _id: string;
  requests: number;
  tokens: number;
}

/** Usage statistics for an application over a period. */
export interface ApplicationUsageStats {
  summary: ApplicationUsageSummary;
  byDay: ApplicationUsageByDay[];
  byEndpoint: ApplicationUsageByEndpoint[];
}


// ---------------------------------------------------------------------------
// OAuth consent (connected apps) types
// ---------------------------------------------------------------------------

/**
 * Sanitized, PUBLIC application identity returned by the API when resolving a
 * cross-app/OAuth client to a registered application.
 *
 * This shape carries NO sensitive or membership fields — it is safe to display
 * unauthenticated in consent/authorize screens and device-flow approval UIs. The
 * API resolves a `client_id` (OAuth credential public key) to the owning
 * application and projects only the fields below. `id` is the application's
 * `_id` as a string.
 */
export interface PublicApplication {
  /** The application's Mongo `_id` as a string. */
  id: string;
  /** Human-readable application name shown to the user. */
  name: string;
  /** Optional short description of what the application does. */
  description?: string;
  /** Optional icon URL for the application. */
  icon?: string;
  /** Optional public website/homepage URL for the application. */
  websiteUrl?: string;
  /** Optional public privacy-policy URL, rendered as a legal link on the consent screen. */
  privacyPolicyUrl?: string;
  /** Optional public terms-of-service URL, rendered as a legal link on the consent screen. */
  termsUrl?: string;
  /** Application classification (set by Oxy platform staff). */
  type: ApplicationType;
  /** Whether the application is an officially endorsed Oxy application. */
  isOfficial: boolean;
  /** Whether the application is an internal Oxy ecosystem application. */
  isInternal: boolean;
  /** OAuth scopes the application is configured to request. */
  scopes: string[];
  /** Optional display name of the developer/owner organisation. */
  developerName?: string;
}

/**
 * A connected (OAuth-authorized) application from the current user's point of
 * view: an application the user has granted access to via the consent flow.
 *
 * Returned by `GET /auth/grants` and rendered in the user-facing "Connected
 * apps" management surface. Keyed by `applicationId` (the application's Mongo
 * `_id`) rather than a credential/client id, so the grant — and a subsequent
 * `apps.connected.revoke` — survive credential
 * rotation. This is a display shape: it carries the application's name/logo and
 * the granted scopes, never any membership or credential material.
 */
export interface ConnectedApp {
  /** The connected application's Mongo `_id`. Use this to revoke the grant. */
  applicationId: string;
  /** Human-readable application name shown to the user. */
  name: string;
  /** Optional logo URL for the application. */
  logoUrl?: string;
  /** OAuth scopes the user has granted to the application. */
  scopes: string[];
  /** ISO timestamp of when the user first authorized the application. */
  firstGrantedAt: string;
  /** ISO timestamp of when the grant was last exercised. */
  lastUsedAt: string;
}

/** An external MCP client authorized for one exact app resource and account. */
export interface ConnectedMcpClient {
  id: string;
  appSlug: string;
  resource: string;
  scopes: string[];
  clientId: string;
  clientName: string;
  createdAt: string;
  lastUsedAt: string;
}


/** `oxy.apps.credentials` — an application's OAuth client credentials. */
export class AppCredentialsApi {
  constructor(private readonly ctx: OxyContext) {}

  /**
   * List an application's OAuth credentials. The response NEVER includes
   * secrets.
   * @param applicationId - The application's `_id`.
   */
  async list(applicationId: string): Promise<ApplicationCredential[]> {
    const res = await this.ctx.request<{ credentials?: ApplicationCredential[] }>(
      'GET',
      credentialsPath(applicationId),
      undefined,
      { cache: true, cacheTTL: MEDIUM_TTL },
    );
    return res.credentials ?? [];
  }

  /**
   * Create an application credential. The plaintext `secret` is returned
   * exactly ONCE; the server stores only a hash and will never return it again.
   * @param applicationId - The application's `_id`.
   * @param data - Credential configuration.
   */
  async create(applicationId: string, data: CreateApplicationCredentialInput): Promise<ApplicationCredentialWithSecret> {
    const result = await this.ctx.request<ApplicationCredentialWithSecret>('POST', credentialsPath(applicationId), data, {
      cache: false,
    });
    this.ctx.oxy.cache.delete(`GET:${credentialsPath(applicationId)}`);
    return result;
  }

  /**
   * Rotate an application credential's secret. The new plaintext `secret` is
   * returned exactly ONCE, along with audit fields: `rotatedFrom` (the previous
   * credentialId) and `graceExpiresAt` (the end of the window during which the
   * old credential is still honoured).
   * @param applicationId - The application's `_id`.
   * @param credentialId - The credential's `_id`.
   * @param options - `graceSeconds` keeps a superseded `machine` token working
   *   for that long. Omitted, the previous token dies the moment the
   *   replacement is minted.
   */
  async rotate(
    applicationId: string,
    credentialId: string,
    options?: RotateApplicationCredentialInput,
  ): Promise<RotateApplicationCredentialResult> {
    const result = await this.ctx.request<RotateApplicationCredentialResult>(
      'POST',
      `${credentialsPath(applicationId)}/${enc(credentialId)}/rotate`,
      options,
      { cache: false },
    );
    this.ctx.oxy.cache.delete(`GET:${credentialsPath(applicationId)}`);
    return result;
  }

  /**
   * Revoke an application credential (`status='revoked'`). Revoked credentials
   * can no longer authenticate.
   * @param applicationId - The application's `_id`.
   * @param credentialId - The credential's `_id`.
   */
  async revoke(applicationId: string, credentialId: string): Promise<AccountSuccessResult> {
    const result = await this.ctx.request<AccountSuccessResult>(
      'DELETE',
      `${credentialsPath(applicationId)}/${enc(credentialId)}`,
      undefined,
      { cache: false },
    );
    this.ctx.oxy.cache.delete(`GET:${credentialsPath(applicationId)}`);
    return result;
  }
}

/** `oxy.apps.connected` — third-party apps (and MCP clients) this user authorized. */
export class ConnectedAppsApi {
  constructor(private readonly ctx: OxyContext) {}

  /**
   * The applications this user granted access to through the consent flow,
   * with the granted scopes and when the grant was first made and last used.
   * `GET /auth/grants`, briefly cached; `revoke` busts it.
   */
  async list(): Promise<ConnectedApp[]> {
    return this.ctx.request<ConnectedApp[]>('GET', '/auth/grants', undefined, { cache: true, cacheTTL: SHORT_TTL });
  }

  /**
   * Revoke this user's grant for a connected application. After this the
   * application can no longer act on the user's behalf until re-authorized.
   * @param applicationId - The connected application's `_id` (a
   *   `ConnectedApp.applicationId`, NOT a credential/client id).
   */
  async revoke(applicationId: string): Promise<void> {
    await this.ctx.request<{ revoked: boolean }>('DELETE', `/auth/grants/${applicationId}`, undefined, { cache: false });
    this.ctx.oxy.cache.delete('GET:/auth/grants');
  }

  /** Resource-bound external MCP connections for the active Oxy account. */
  async mcpClients(): Promise<ConnectedMcpClient[]> {
    const res = await this.ctx.request<{ grants: ConnectedMcpClient[] }>('GET', '/auth/mcp/oauth/grants', undefined, {
      cache: true,
      cacheTTL: SHORT_TTL,
    });
    return res.grants;
  }

  /** Revoke one external MCP connection and every token in its family. */
  async revokeMcpClient(grantId: string): Promise<void> {
    await this.ctx.request<void>('DELETE', `/auth/mcp/oauth/grants/${enc(grantId)}`, undefined, { cache: false });
    this.ctx.oxy.cache.delete('GET:/auth/mcp/oauth/grants');
  }
}

export class AppsApi {
  /** An application's OAuth client credentials. */
  readonly credentials: AppCredentialsApi;
  /** Third-party apps (and MCP clients) this user authorized. */
  readonly connected: ConnectedAppsApi;

  constructor(private readonly ctx: OxyContext) {
    this.credentials = new AppCredentialsApi(ctx);
    this.connected = new ConnectedAppsApi(ctx);
  }

  /**
   * The applications an account owns. `GET /applications?ownerAccountId=<id>`.
   * @param accountId - The owning account's `_id`.
   */
  async list(accountId: string): Promise<Application[]> {
    const res = await this.ctx.request<{ applications?: Application[] }>(
      'GET',
      `/applications?ownerAccountId=${enc(accountId)}`,
      undefined,
      { cache: true, cacheTTL: MEDIUM_TTL },
    );
    return res.applications ?? [];
  }

  /**
   * Fetch a single application by id.
   * @param applicationId - The application's `_id`.
   */
  async get(applicationId: string): Promise<Application> {
    const res = await this.ctx.request<{ application: Application }>('GET', appPath(applicationId), undefined, {
      cache: true,
      cacheTTL: LONG_TTL,
    });
    return res.application;
  }

  /**
   * Create an application owned by an account.
   * @param data - Application configuration. `ownerAccountId` defaults to the
   *   caller's personal account when omitted. Staff-only fields are ignored.
   */
  async create(data: CreateApplicationInput): Promise<Application> {
    const res = await this.ctx.request<{ application: Application }>('POST', '/applications', data, { cache: false });
    this.invalidateLists();
    return res.application;
  }

  /**
   * Update an application's mutable fields.
   * @param applicationId - The application's `_id`.
   * @param data - Subset of updatable fields. Staff-only fields are ignored.
   */
  async update(applicationId: string, data: UpdateApplicationInput): Promise<Application> {
    const res = await this.ctx.request<{ application: Application }>('PATCH', appPath(applicationId), data, {
      cache: false,
    });
    this.invalidateLists([`GET:${appPath(applicationId)}`]);
    return res.application;
  }

  /**
   * Soft-delete an application.
   * @param applicationId - The application's `_id`.
   */
  async delete(applicationId: string): Promise<AccountSuccessResult> {
    const result = await this.ctx.request<AccountSuccessResult>('DELETE', appPath(applicationId), undefined, {
      cache: false,
    });
    this.invalidateLists([`GET:${appPath(applicationId)}`, `GET:${credentialsPath(applicationId)}`]);
    return result;
  }

  /**
   * Usage statistics for an application.
   * @param applicationId - The application's `_id`.
   * @param period - Time window (defaults to the server default).
   */
  async usage(applicationId: string, period?: ApplicationUsagePeriod): Promise<ApplicationUsageStats> {
    return this.ctx.request<ApplicationUsageStats>(
      'GET',
      `${appPath(applicationId)}/usage`,
      period ? { period } : undefined,
      { cache: true, cacheTTL: SHORT_TTL },
    );
  }

  /**
   * Resolve an OAuth `client_id` (an active credential's public key) to the
   * owning application's PUBLIC identity. No authentication required — only
   * sanitized, display-safe metadata; use it to render the requesting app in
   * consent, authorize, and device-flow approval screens before any session
   * exists.
   */
  async getPublic(clientId: string): Promise<PublicApplication> {
    const res = await this.ctx.request<{ application: PublicApplication }>(
      'GET',
      `/auth/oauth/client/${enc(clientId)}`,
      undefined,
      // Public client metadata (pre-session consent UI) — skip the bearer preflight.
      { cache: true, cacheTTL: MEDIUM_TTL, skipAuth: true },
    );
    return res.application;
  }

  /**
   * Bust every cached application list — the unscoped entry and every
   * owner-scoped `GET:/applications?ownerAccountId=<id>` variant — plus any
   * extra keys, in one pass. The `?` prefix never matches the
   * `GET:/applications/<id>…` detail keys.
   */
  private invalidateLists(extraKeys: string[] = []): void {
    this.ctx.http.invalidateCache({ keys: ['GET:/applications', ...extraKeys], prefixes: ['GET:/applications?'] });
  }
}

function appPath(applicationId: string): string {
  return `/applications/${enc(applicationId)}`;
}

function credentialsPath(applicationId: string): string {
  return `${appPath(applicationId)}/credentials`;
}
