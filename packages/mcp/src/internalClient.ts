import { isLoopbackOrigin } from '@oxy.so/contracts';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

export interface InternalCatalogMcpClientOptions {
  endpoint: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

/** No OAuth provider or durable session: a fresh Capability proof per operation. */
export function createInternalCatalogMcpClient(options: InternalCatalogMcpClientOptions) {
  const endpoint = new URL(options.endpoint);
  const loopback = isLoopbackOrigin(endpoint.href);
  if ((endpoint.protocol !== 'https:' && !(loopback && endpoint.protocol === 'http:'))
    || endpoint.username || endpoint.password || endpoint.search || endpoint.hash || endpoint.pathname !== '/_oxy/mcp') {
    throw new Error('Internal MCP endpoint must be the trusted HTTPS /_oxy/mcp resource');
  }
  const timeoutMs = options.timeoutMs ?? 5000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000) throw new Error('Invalid internal MCP timeout');
  const invoke = async <T>(ticket: string, signal: AbortSignal | undefined, execute: (client: Client, signal: AbortSignal) => Promise<T>): Promise<T> => {
    signal?.throwIfAborted();
    if (!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(ticket)) throw new Error('A Capability ticket is required');
    const controller = new AbortController();
    const abort = () => controller.abort(signal?.reason);
    signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => controller.abort(new Error('Internal MCP request timed out')), timeoutMs);
    const client = new Client({ name: 'oxy-internal-catalog', version: '1.0.0' });
    const transport = new StreamableHTTPClientTransport(endpoint, {
      requestInit: { headers: { Authorization: `Capability ${ticket}` }, signal: controller.signal,
        redirect: 'error', credentials: 'omit', cache: 'no-store' },
      ...(options.fetch ? { fetch: options.fetch } : {}),
      reconnectionOptions: { maxRetries: 0, initialReconnectionDelay: 1000, maxReconnectionDelay: 1000, reconnectionDelayGrowFactor: 1 },
    });
    try {
      await client.connect(transport, { signal: controller.signal, timeout: timeoutMs });
      controller.signal.throwIfAborted();
      return await execute(client, controller.signal);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      await client.close();
    }
  };
  return Object.freeze({
    listTools(ticket: string, options: { signal?: AbortSignal } = {}) {
      return invoke(ticket, options.signal, (client, signal) => client.listTools(undefined, { signal, timeout: timeoutMs }));
    },
    callTool(ticket: string, name: string, input: Readonly<Record<string, unknown>>, options: { signal?: AbortSignal } = {}) {
      return invoke(ticket, options.signal, (client, signal) => client.callTool({ name, arguments: input }, undefined, { signal, timeout: timeoutMs }));
    },
  });
}
