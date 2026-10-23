import type { HttpService, ResponseRequest } from './HttpService';

/** Adapt a product SDK's fetch calls to the session owner's raw-response lane. */
export function createAuthenticatedFetch(
  client: HttpService,
  baseURL: string,
  options: { prepare?: () => Promise<void>; disposed?: () => boolean } = {},
): typeof globalThis.fetch {
  return async (input, init) => {
    if (options.disposed?.()) throw new Error('The authenticated transport has been disposed');
    const request = typeof Request !== 'undefined' && input instanceof Request ? input : undefined;
    const url = new URL(request?.url ?? String(input), `${baseURL.replace(/\/$/, '')}/`);
    if (url.origin !== new URL(baseURL).origin || url.username || url.password)
      throw new Error('Authenticated fetch must target the configured API origin');
    const method = (init?.method ?? request?.method ?? 'GET').toUpperCase();
    if (!['GET', 'HEAD', 'OPTIONS', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method))
      throw new Error('Unsupported authenticated request method');
    const signal = init?.signal ?? request?.signal ?? undefined;
    if (signal?.aborted) throw signal.reason ?? new Error('Request aborted');
    const config: ResponseRequest = {
      url: url.href,
      method: method as ResponseRequest['method'],
      headers: new Headers(init?.headers ?? request?.headers),
      body: init?.body === undefined ? (request?.body ?? undefined) : (init.body ?? undefined),
      signal,
    };
    if (options.prepare) await options.prepare();
    if (options.disposed?.()) throw new Error('The authenticated transport has been disposed');
    return client.requestAuthenticatedResponse(config);
  };
}
