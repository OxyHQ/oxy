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

import { assertSafePublicUrl, readResponseBody, safeFetch } from '@oxy.so/core/server';

/** Largest response body the flow will buffer. Identity documents are small. */
const LINKED_ACCOUNT_MAX_RESPONSE_BYTES = 1024 * 1024;

/** Identity/OAuth documents only: limit parser work independently of wire bytes.
 * Applied before atproto's transitive Zod 3 receives any JSON response.
 */
export const LINKED_ACCOUNT_JSON_LIMITS = {
  nodes: 16_384,
  collection: 2_048,
  depth: 64,
} as const;

export class LinkedAccountJsonBudgetError extends Error {
  constructor() {
    super('Identity provider JSON exceeds the linked-accounts complexity limit');
    this.name = 'LinkedAccountJsonBudgetError';
  }
}

function assertJsonBudget(payload: Uint8Array): void {
  let parsed: unknown;
  try {
    // WHATWG Response.json() accepts a UTF-8 BOM, regardless of Content-Type.
    // Decode identically so neither a BOM nor a misleading header skips the guard.
    parsed = JSON.parse(new TextDecoder().decode(payload));
  } catch {
    // Preserve non-JSON bodies and their existing downstream error behaviour.
    return;
  }
  assertJsonValueBudget(parsed);
}

function assertJsonValueBudget(parsed: unknown): void {
  let nodes = 1;
  const pending: Array<{ value: unknown; depth: number }> = [{ value: parsed, depth: 0 }];
  while (pending.length) {
    const entry = pending.pop();
    if (!entry) break;
    const { value, depth } = entry;
    if (depth > LINKED_ACCOUNT_JSON_LIMITS.depth) throw new LinkedAccountJsonBudgetError();
    if (value === null || typeof value !== 'object') continue;
    const children = Array.isArray(value) ? value : Object.keys(value);
    if (children.length > LINKED_ACCOUNT_JSON_LIMITS.collection)
      throw new LinkedAccountJsonBudgetError();
    nodes += children.length;
    if (nodes > LINKED_ACCOUNT_JSON_LIMITS.nodes) throw new LinkedAccountJsonBudgetError();
    for (const child of children)
      pending.push({
        value: Array.isArray(value) ? child : (value as Record<string, unknown>)[child as string],
        depth: depth + 1,
      });
  }
}

/** Recheck OAuth store restores before the upstream DPoP JWK parser runs.
 * Current state contains locally generated keys; this also fences older rows.
 */
export function assertLinkedAccountStateBudget(value: unknown): void {
  assertJsonValueBudget(value);
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return;
  const jwk = (value as Record<string, unknown>).dpopJwk;
  if (typeof jwk === 'string') {
    const bytes = Buffer.from(jwk);
    if (bytes.length > LINKED_ACCOUNT_MAX_RESPONSE_BYTES) throw new LinkedAccountJsonBudgetError();
    assertJsonBudget(bytes);
  }
}

/** Socket inactivity limit while waiting for response headers or body bytes. */
const HEADERS_TIMEOUT_MS = 8_000;

/** Absolute deadline for the complete request, including response-body consumption. */
const REQUEST_TIMEOUT_MS = 15_000;

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

/**
 * `fetch` on top of `safeFetch`. GETs follow up to five (re-validated)
 * redirects unless the request says otherwise; any other method follows none,
 * because a redirected POST re-sends a credential to a host nobody chose.
 */
const safeWhatwgFetch: typeof fetch = async (input, init) => {
  const request = new Request(input, init);
  const method = request.method.toUpperCase();
  const body =
    method === 'GET' || method === 'HEAD' ? undefined : Buffer.from(await request.arrayBuffer());
  const headers = headersToRecord(request.headers);
  if (!Object.keys(headers).some((key) => key.toLowerCase() === 'user-agent')) {
    headers['User-Agent'] = USER_AGENT;
  }
  if (body !== undefined) headers['Content-Length'] = String(body.byteLength);
  const followRedirects = method === 'GET' && request.redirect === 'follow';
  const controller = new AbortController();
  const abort = () => controller.abort(request.signal.reason);
  if (request.signal.aborted) abort();
  else request.signal.addEventListener('abort', abort, { once: true });
  const timeout = setTimeout(
    () => controller.abort(new Error('linked-account request timed out')),
    REQUEST_TIMEOUT_MS,
  );

  let result: Awaited<ReturnType<typeof safeFetch>>;
  let payload: Buffer;
  try {
    result = await safeFetch(request.url, {
      method,
      headers,
      body,
      maxRedirects: followRedirects ? 5 : 0,
      headersTimeoutMs: HEADERS_TIMEOUT_MS,
      signal: controller.signal,
    });
    const read = await readResponseBody(result.response, {
      maxBytes: LINKED_ACCOUNT_MAX_RESPONSE_BYTES,
      timeoutMs: REQUEST_TIMEOUT_MS,
    });
    if (read.kind === 'too_large') {
      throw new Error('response body exceeds the linked-accounts limit');
    }
    if (read.kind === 'timeout') throw new Error('linked-account request timed out');
    if (read.kind === 'error') throw read.error;
    payload = read.body;
  } finally {
    clearTimeout(timeout);
    request.signal.removeEventListener('abort', abort);
  }
  assertJsonBudget(payload);
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
