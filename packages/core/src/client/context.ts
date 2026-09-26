/**
 * What every API namespace is built on.
 *
 * `OxyServices` creates ONE context and hands it to each namespace it creates
 * (lazily, on first access). It is the namespaces' only way into the client, so
 * the plumbing they share — the transport, the service-token lane, cross-cache
 * invalidation — never becomes public surface on `OxyServices` itself.
 */
import type { HttpService, RequestOptions } from '../HttpService';
import type { OxyServices } from '../OxyServices';

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/**
 * The service-token lane. Installed only by `OxyServer`
 * (`@oxy.so/core/server`); `null` on every client. A namespace whose route
 * accepts a service token as well as a user session (e.g. `users.getMany`)
 * prefers it when present.
 */
export interface ServiceLane {
  /** Whether a service token can be minted here (a key pair, or workload identity). */
  readonly available: boolean;
  request<T>(method: HttpMethod, url: string, data?: unknown, options?: RequestOptions & { actAs?: string }): Promise<T>;
}

export interface OxyContext {
  /** The client this context belongs to — for calls into other namespaces. */
  readonly oxy: OxyServices;
  readonly http: HttpService;
  /** `oxy.request`: user bearer, rejects with `OxyApiError`. */
  request<T>(method: HttpMethod, url: string, data?: unknown, options?: RequestOptions): Promise<T>;
  /** The service-token lane, or `null` outside a server. */
  service: ServiceLane | null;
}
