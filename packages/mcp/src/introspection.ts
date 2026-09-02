import { z } from 'zod';
import {
  mcpAccessTokenClaimsSchema,
  type McpAccessTokenClaims,
} from './oauth';

const DEFAULT_TIMEOUT_MS = 10_000;

export interface OxyMcpIntrospectionOptions {
  /** Exact central Oxy introspection endpoint for this environment. */
  endpoint: string;
  /** Returns a live Oxy service token. The caller owns credential storage. */
  getServiceToken: () => Promise<string>;
  /** Invalidates the caller's cached service token before the one allowed retry. */
  invalidateServiceToken?: () => void | Promise<void>;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

function validateEndpoint(value: string): string {
  const url = new URL(value);
  const loopback = url.hostname === 'localhost'
    || url.hostname === '127.0.0.1'
    || url.hostname === '[::1]';
  if (url.protocol !== 'https:' && !(loopback && url.protocol === 'http:')) {
    throw new Error('MCP introspection endpoint must use HTTPS outside local development');
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error('MCP introspection endpoint cannot contain credentials, query or fragment');
  }
  return value;
}

/**
 * Ask Oxy for the live state of a resource-bound MCP access token.
 *
 * Results are deliberately not cached: revoking the grant, service credential,
 * account authority or catalog registration must affect the next app request.
 */
export async function introspectOxyMcpAccessToken(
  token: string,
  options: OxyMcpIntrospectionOptions,
): Promise<McpAccessTokenClaims | null> {
  if (!token.trim()) throw new Error('MCP access token is required for introspection');
  const endpoint = validateEndpoint(options.endpoint);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) {
    throw new Error('MCP introspection timeout must be between 1 and 60000 milliseconds');
  }
  const fetcher = options.fetch ?? globalThis.fetch;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const serviceToken = await options.getServiceToken();
    if (!serviceToken.trim()) throw new Error('Oxy service token is unavailable');
    const response = await fetcher(endpoint, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${serviceToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ token }),
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (response.status === 401 && attempt === 0 && options.invalidateServiceToken) {
      await response.body?.cancel().catch(() => undefined);
      await options.invalidateServiceToken();
      continue;
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error(`Oxy MCP introspection failed (${response.status})`);
    }

    const body = await response.json() as unknown;
    const envelope = z.object({ active: z.boolean() }).passthrough().parse(body);
    return envelope.active ? mcpAccessTokenClaimsSchema.parse(body) : null;
  }

  throw new Error('Oxy MCP introspection failed after service-token refresh');
}
