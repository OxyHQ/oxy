import { idempotencyKeySchema, isLoopbackOrigin } from '@oxy.so/contracts';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
  StreamableHTTPClientTransport,
  StreamableHTTPError,
} from '@modelcontextprotocol/sdk/client/streamableHttp.js';

/**
 * The app refused the call before it ran: the operation did NOT happen.
 *
 * Distinct from every other failure, which may follow a committed effect and
 * so leaves the outcome unknown. Two cases are provably refusals:
 *  - the MCP connection (initialize) failed, so `tools/call` was never sent;
 *  - the call came back with an HTTP status the server only answers before
 *    running a handler: a 4xx other than 408 (authority, ticket, binding,
 *    body) or 503 (the lane or the service is not ready).
 * A 500, 502, 504, a timeout or a reset after the call was sent stays unknown.
 */
export class InternalMcpRefusedError extends Error {
  /** The HTTP status that refused the call; `null` when no answer came. */
  readonly status: number | null;
  /** What refused it: the transport's own error. */
  readonly cause: unknown;
  constructor(message: string, options: { status?: number; cause?: unknown } = {}) {
    super(message);
    this.name = 'InternalMcpRefusedError';
    this.status = options.status ?? null;
    this.cause = options.cause;
  }
}

function refusedBeforeRunning(error: unknown): number | undefined {
  if (!(error instanceof StreamableHTTPError) || typeof error.code !== 'number') return undefined;
  const status = error.code;
  return (status >= 400 && status < 500 && status !== 408) || status === 503 ? status : undefined;
}

export interface InternalCatalogMcpClientOptions {
  endpoint: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

/** No OAuth provider or durable session: a fresh Capability proof per operation. */
export function createInternalCatalogMcpClient(options: InternalCatalogMcpClientOptions) {
  const endpoint = new URL(options.endpoint);
  const loopback = isLoopbackOrigin(endpoint.href);
  if (
    (endpoint.protocol !== 'https:' && !(loopback && endpoint.protocol === 'http:')) ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash ||
    endpoint.pathname !== '/_oxy/mcp'
  ) {
    throw new Error('Internal MCP endpoint must be the trusted HTTPS /_oxy/mcp resource');
  }
  const timeoutMs = options.timeoutMs ?? 5000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000)
    throw new Error('Invalid internal MCP timeout');
  const invoke = async <T>(
    ticket: string,
    signal: AbortSignal | undefined,
    execute: (client: Client, signal: AbortSignal) => Promise<T>,
    idempotencyKey?: string,
  ): Promise<T> => {
    signal?.throwIfAborted();
    if (!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(ticket))
      throw new Error('A Capability ticket is required');
    const headers = new Headers({ Authorization: `Capability ${ticket}` });
    if (idempotencyKey !== undefined)
      headers.set('Idempotency-Key', idempotencyKeySchema.parse(idempotencyKey.trim()));
    const controller = new AbortController();
    const abort = () => controller.abort(signal?.reason);
    signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(
      () => controller.abort(new Error('Internal MCP request timed out')),
      timeoutMs,
    );
    const client = new Client({ name: 'oxy-internal-catalog', version: '1.0.0' });
    const transport = new StreamableHTTPClientTransport(endpoint, {
      requestInit: {
        headers,
        signal: controller.signal,
        redirect: 'error',
        credentials: 'omit',
        cache: 'no-store',
      },
      ...(options.fetch ? { fetch: options.fetch } : {}),
      reconnectionOptions: {
        maxRetries: 0,
        initialReconnectionDelay: 1000,
        maxReconnectionDelay: 1000,
        reconnectionDelayGrowFactor: 1,
      },
    });
    try {
      try {
        await client.connect(transport, { signal: controller.signal, timeout: timeoutMs });
        controller.signal.throwIfAborted();
      } catch (error: unknown) {
        // Nothing was called yet: whatever stopped the connection, the
        // operation did not run.
        const status = refusedBeforeRunning(error);
        throw new InternalMcpRefusedError('Internal MCP connection was refused before the call', {
          ...(status === undefined ? {} : { status }),
          cause: error,
        });
      }
      try {
        return await execute(client, controller.signal);
      } catch (error: unknown) {
        const status = refusedBeforeRunning(error);
        if (status === undefined) throw error;
        throw new InternalMcpRefusedError(`Internal MCP call was refused (HTTP ${status})`, {
          status,
          cause: error,
        });
      }
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      await client.close();
    }
  };
  return Object.freeze({
    listTools(ticket: string, options: { signal?: AbortSignal } = {}) {
      return invoke(ticket, options.signal, (client, signal) =>
        client.listTools(undefined, { signal, timeout: timeoutMs }),
      );
    },
    callTool(
      ticket: string,
      name: string,
      input: Readonly<Record<string, unknown>>,
      options: { signal?: AbortSignal; idempotencyKey?: string } = {},
    ) {
      return invoke(
        ticket,
        options.signal,
        (client, signal) =>
          client.callTool({ name, arguments: input }, undefined, { signal, timeout: timeoutMs }),
        options.idempotencyKey,
      );
    },
  });
}
