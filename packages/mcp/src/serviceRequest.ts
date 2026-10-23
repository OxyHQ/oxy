import { z } from 'zod';

const DEFAULT_TIMEOUT_MS = 10_000;

/** Own products inject the core service client; external callers keep explicit credentials. */
export type OxyMcpServiceAuthentication =
  | {
      transport: { fetch: typeof fetch };
      getServiceToken?: never;
      invalidateServiceToken?: never;
      fetch?: never;
    }
  | {
      transport?: never;
      getServiceToken: () => Promise<string>;
      invalidateServiceToken?: () => void | Promise<void>;
      fetch?: typeof fetch;
    };

export type OxyMcpServiceRequestOptions = OxyMcpServiceAuthentication & {
  /** Exact endpoint for this environment. */
  endpoint: string;
  timeoutMs?: number;
};

export function validateOxyEndpoint(value: string): string {
  const url = new URL(value);
  const loopback =
    url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
  if (url.protocol !== 'https:' && !(loopback && url.protocol === 'http:')) {
    throw new Error('Oxy MCP endpoints must use HTTPS outside local development');
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error('Oxy MCP endpoints cannot contain credentials, query or fragment');
  }
  return value;
}

function timeout(options: OxyMcpServiceRequestOptions): number {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) {
    throw new Error('Oxy MCP request timeout must be between 1 and 60000 milliseconds');
  }
  return timeoutMs;
}

const oauthErrorSchema = z
  .object({
    error: z.string().trim().min(1),
    error_description: z.string().trim().min(1).optional(),
    /** Oxy's non-OAuth refusals (`{ error, message }`), e.g. a catalogue it could not parse. */
    message: z.string().trim().min(1).optional(),
  })
  .passthrough();

/** An OAuth-shaped refusal from Oxy, carried with its code so callers can branch. */
export class OxyMcpRequestError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'OxyMcpRequestError';
  }
}

/**
 * POST JSON to Oxy through the shared transport, or an explicit external token.
 * The shared transport owns refresh; the legacy callback lane retries one 401.
 *
 * Never cached: every call here is an authorization decision (is this token
 * still live, may this account still be acted as), and a cached answer would
 * outlive a revocation.
 */
export async function postOxyServiceJson(
  body: Record<string, unknown>,
  options: OxyMcpServiceRequestOptions,
): Promise<unknown> {
  const endpoint = validateOxyEndpoint(options.endpoint);
  const timeoutMs = timeout(options);
  if (
    options.transport &&
    (options.getServiceToken || options.invalidateServiceToken || options.fetch)
  ) {
    throw new Error('Provide one Oxy MCP authentication transport');
  }
  const fetcher = options.transport
    ? options.transport.fetch.bind(options.transport)
    : (options.fetch ?? globalThis.fetch);

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const serviceToken = options.transport ? undefined : await options.getServiceToken();
    if (serviceToken !== undefined && !serviceToken.trim())
      throw new Error('Oxy service token is unavailable');
    const response = await fetcher(endpoint, {
      method: 'POST',
      redirect: 'error',
      credentials: 'omit',
      cache: 'no-store',
      headers: {
        ...(serviceToken === undefined ? {} : { authorization: `Bearer ${serviceToken}` }),
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (
      !options.transport &&
      response.status === 401 &&
      attempt === 0 &&
      options.invalidateServiceToken
    ) {
      await response.body?.cancel().catch(() => undefined);
      await options.invalidateServiceToken();
      continue;
    }
    if (!response.ok) {
      const payload = (await response.json().catch(() => null)) as unknown;
      const parsed = oauthErrorSchema.safeParse(payload);
      throw new OxyMcpRequestError(
        response.status,
        parsed.success ? parsed.data.error : 'request_failed',
        parsed.success
          ? (parsed.data.error_description ??
              parsed.data.message?.slice(0, 500) ??
              parsed.data.error)
          : `Oxy MCP request failed (${response.status})`,
      );
    }
    return (await response.json()) as unknown;
  }

  throw new Error('Oxy MCP request failed after service-token refresh');
}
