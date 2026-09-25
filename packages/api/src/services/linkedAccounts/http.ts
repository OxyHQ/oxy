/**
 * The one outbound HTTP path of the linked-accounts flow.
 *
 * Every URL here is chosen by the user (a Mastodon instance they typed, a
 * Bluesky handle whose DID document names a PDS), so every request goes through
 * `safeFetch` from `@oxy.so/core/server`: real DNS resolution against the
 * private/reserved denylist, the connection pinned to the validated address, and
 * each redirect hop re-validated. It is exposed as a WHATWG `fetch` because the
 * atproto OAuth client takes one, and the Mastodon provider uses the same
 * function so there is exactly one egress rule.
 *
 * Tests replace the whole transport with {@link setLinkedAccountTransportForTesting}
 * — a fake Mastodon server is an in-memory function, not a socket, because
 * `safeFetch` (correctly) refuses loopback.
 */

import { assertSafePublicUrl, safeFetch } from '@oxy.so/core/server';

/** Largest response body the flow will buffer. Identity documents are small. */
const LINKED_ACCOUNT_MAX_RESPONSE_BYTES = 1024 * 1024;

/** Time-to-first-byte per request. */
const HEADERS_TIMEOUT_MS = 8_000;

const USER_AGENT = 'Oxy/1.0 (+https://oxy.so; linked accounts)';

export interface LinkedAccountTransport {
  /** WHATWG-compatible fetch that refuses private and reserved addresses. */
  fetch: typeof fetch;
  /** Resolves when `host` is a public HTTPS-reachable name; rejects otherwise. */
  assertPublicHost(host: string): Promise<void>;
}

export class UnsafeHostError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'UnsafeHostError';
  }
}

function headersToRecord(headers: Headers): Record<string, string> {
  const record: Record<string, string> = {};
  headers.forEach((value, key) => {
    record[key] = value;
  });
  return record;
}

async function readBounded(stream: AsyncIterable<unknown> & { destroy(): void }): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for await (const chunk of stream) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
      total += buffer.byteLength;
      if (total > LINKED_ACCOUNT_MAX_RESPONSE_BYTES) {
        throw new Error('response body exceeds the linked-accounts limit');
      }
      chunks.push(buffer);
    }
  } finally {
    stream.destroy();
  }
  return Buffer.concat(chunks);
}

/**
 * `fetch` on top of `safeFetch`. GETs follow up to five (re-validated)
 * redirects unless the request says otherwise; any other method follows none,
 * because a redirected POST re-sends a credential to a host nobody chose.
 */
const safeWhatwgFetch: typeof fetch = async (input, init) => {
  const request = new Request(input, init);
  const method = request.method.toUpperCase();
  const body = method === 'GET' || method === 'HEAD' ? undefined : Buffer.from(await request.arrayBuffer());
  const headers = headersToRecord(request.headers);
  if (!Object.keys(headers).some((key) => key.toLowerCase() === 'user-agent')) {
    headers['User-Agent'] = USER_AGENT;
  }
  if (body !== undefined) headers['Content-Length'] = String(body.byteLength);
  const followRedirects = method === 'GET' && request.redirect === 'follow';
  const result = await safeFetch(request.url, {
    method,
    headers,
    body,
    maxRedirects: followRedirects ? 5 : 0,
    headersTimeoutMs: HEADERS_TIMEOUT_MS,
    signal: init?.signal ?? undefined,
  });
  const payload = await readBounded(result.response);
  const responseHeaders = new Headers();
  for (const [key, value] of Object.entries(result.headers)) {
    if (Array.isArray(value)) for (const item of value) responseHeaders.append(key, item);
    else if (typeof value === 'string') responseHeaders.set(key, value);
  }
  const nullBody = result.status === 204 || result.status === 304 || method === 'HEAD';
  const response = new Response(nullBody ? null : new Uint8Array(payload), {
    status: result.status,
    headers: responseHeaders,
  });
  // A constructed Response reports url === ''; the atproto client reads it.
  Object.defineProperty(response, 'url', { value: result.finalUrl });
  return response;
};

const productionTransport: LinkedAccountTransport = {
  fetch: safeWhatwgFetch,
  async assertPublicHost(host: string) {
    const verdict = await assertSafePublicUrl(`https://${host}/`);
    if (!verdict.ok) throw new UnsafeHostError(verdict.reason);
  },
};

let transport: LinkedAccountTransport = productionTransport;

export function linkedAccountTransport(): LinkedAccountTransport {
  return transport;
}

/** Test seam: swap the transport; returns a restore function. */
export function setLinkedAccountTransportForTesting(next: LinkedAccountTransport): () => void {
  const previous = transport;
  transport = next;
  return () => {
    transport = previous;
  };
}

/** Read a JSON body, or `null` when it is not JSON. */
export async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}
