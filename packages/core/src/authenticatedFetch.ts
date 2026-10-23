import type { HttpService, ResponseRequest } from './HttpService';
import { awaitRequestSignal } from './utils/requestSignal';

/** Adapt a product SDK's fetch calls to the session owner's raw-response lane. */
export function createAuthenticatedFetch(
  client: HttpService,
  baseURL: string,
  options: {
    prepare?: () => Promise<void>;
    disposed?: () => boolean;
    session?: 'required' | 'optional';
    bodyFactory?: () => BodyInit;
  } = {},
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
    const signal = init?.signal === undefined ? request?.signal : (init.signal ?? undefined);
    if (signal?.aborted) throw signal.reason ?? new Error('Request aborted');
    const body = init?.body ?? request?.body ?? undefined;
    if ((method === 'GET' || method === 'HEAD') && (body !== undefined || options.bodyFactory))
      throw new TypeError('GET and HEAD requests cannot have a body');
    if (options.bodyFactory && body !== undefined)
      throw new TypeError('A replayable request cannot also supply a body');
    const config: ResponseRequest = {
      url: url.href,
      method: method as ResponseRequest['method'],
      headers: new Headers(init?.headers ?? request?.headers),
      body,
      bodyFactory: options.bodyFactory,
      signal,
    };
    if (options.prepare) await awaitRequestSignal(options.prepare(), signal);
    if (options.disposed?.()) throw new Error('The authenticated transport has been disposed');
    return options.session === 'optional'
      ? client.requestResponse(config)
      : client.requestAuthenticatedResponse(config);
  };
}
