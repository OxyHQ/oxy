/**
 * Calling Oxy AS the person behind a request.
 *
 * A backend's `OxyServer` is a process singleton authenticated as the backend
 * itself; a user's bearer must never be planted on it (`setTokens`,
 * `session.setAccessToken`), because every concurrent request would then speak
 * as that user. A read that must be answered for the person — their own
 * account graph, an application they manage, their profile — goes through an
 * {@link OxyUserClient}: every namespace of `OxyServices`, bound to that one
 * bearer, sharing no mutable state with the server.
 *
 * ```ts
 * // Express, after oxy.middleware.auth():
 * const node = await oxy.withUser(req, (user) => user.accounts.get(accountId));
 * ```
 *
 * What makes it safe to create one per request:
 *
 * - **No response cache.** The client is built with `enableCache: false`, so
 *   one person's answers are never served to anyone, including the same
 *   person's next request, and nothing is registered with the module-wide
 *   cache sweep.
 * - **Exactly this bearer, every time.** Every request carries it as an
 *   explicit `Authorization` header: never refreshed (that is the user's own
 *   client's job), never dropped for an expired or opaque token, never
 *   replaced by the server's service token. Oxy answers a revoked or expired
 *   bearer 401, which the access readers map to `ACCESS_SESSION_REQUIRED`.
 * - **Deterministic end.** `withUser` disposes the client when the callback
 *   settles, so a reference that escapes the callback holds no bearer. A
 *   client from `asUser` that is never disposed holds no global resource
 *   either; it is collected with its last reference.
 *
 * Node only; reachable solely from `@oxy.so/core/server`.
 */

import { OxyServices, type OxyConfig } from '../OxyServices';
import type { HttpMethod } from '../client/context';
import type { RequestOptions, ResponsePayload } from '../HttpService';
import { isBearerToken, OxyAccessError, type OxyCallerRequest } from './callerAuthority';

/**
 * Whose bearer a user client carries: a request `middleware.auth()` resolved
 * to a user session (its `req.accessToken`), or a bearer string the caller has
 * already verified (a Socket.IO handshake's `socket.accessToken`, say).
 */
export type OxyUserSource = string | OxyCallerRequest;

/** The transport settings a user client inherits from its server; never auth, cache or app identity. */
const INHERITED_TRANSPORT_KEYS = [
  'baseURL',
  'cloudURL',
  'requestTimeout',
  'enableRetry',
  'maxRetries',
  'retryDelay',
  'maxConcurrentRequests',
  'requestQueueSize',
  'enableLogging',
  'logLevel',
  'onRequestStart',
  'onRequestEnd',
  'onRequestError',
] as const satisfies readonly (keyof OxyConfig)[];

/** The transport half of a server config, for a user client. */
export function userClientConfig(config: Readonly<OxyConfig>): OxyConfig {
  const transport: Partial<Record<keyof OxyConfig, unknown>> = {};
  for (const key of INHERITED_TRANSPORT_KEYS) {
    if (config[key] !== undefined) transport[key] = config[key];
  }
  return { ...(transport as OxyConfig), enableCache: false };
}

/**
 * The user bearer `source` carries. Throws `OxyAccessError`
 * (`ACCESS_SESSION_REQUIRED`) for a request with no user session — anonymous,
 * or authenticated by a SERVICE token, whose bearer is the calling service's
 * and never a person's.
 */
export function userBearerOf(source: OxyUserSource): string {
  if (typeof source === 'string') {
    if (!isBearerToken(source)) {
      throw new OxyAccessError('ACCESS_SESSION_REQUIRED', 'A user client needs a bearer token');
    }
    return source;
  }
  if (source.serviceApp) {
    throw new OxyAccessError(
      'ACCESS_SESSION_REQUIRED',
      'This request is authenticated by a service token; a user client needs a person’s session',
    );
  }
  const token = source.accessToken;
  if (typeof token !== 'string' || !isBearerToken(token)) {
    throw new OxyAccessError(
      'ACCESS_SESSION_REQUIRED',
      'No verified user session on this request; mount middleware.auth() first',
    );
  }
  return token;
}

/**
 * Every `OxyServices` namespace, authenticated as one person. Create it with
 * `OxyServer.withUser` (disposed for you) or `OxyServer.asUser` (dispose it
 * yourself); the constructor is not part of the public contract.
 */
export class OxyUserClient extends OxyServices {
  private bearer: string | null;

  /** @internal Use `OxyServer.asUser` / `OxyServer.withUser`. */
  constructor(config: OxyConfig, accessToken: string) {
    super(config);
    this.bearer = accessToken;
    // For the namespaces that read the session's identity (`session.userId`).
    this.http.setTokens(accessToken);
  }

  /**
   * Every namespace call goes through here: it carries this client's bearer
   * explicitly, which also keeps the response out of any cache and out of
   * request de-duplication. Rejects once the client is disposed.
   */
  override async request<T>(
    method: HttpMethod,
    url: string,
    data?: unknown,
    options: RequestOptions = {},
  ): Promise<ResponsePayload<T>> {
    const bearer = this.bearer;
    if (!bearer) throw new Error('This Oxy user client has been disposed');
    // This client speaks as its person only: no caller-supplied credential,
    // in any letter case, rides along.
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(options.headers ?? {})) {
      if (name.toLowerCase() !== 'authorization') headers[name] = value;
    }
    headers.Authorization = `Bearer ${bearer}`;
    return super.request<T>(method, url, data, { ...options, headers });
  }

  /** Forget the bearer: every later call rejects. */
  override dispose(): void {
    this.bearer = null;
    super.dispose();
  }
}
