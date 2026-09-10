/**
 * The injected HTTP transport the node {@link ./nodeClient.NodeClient} and the
 * {@link ./didWebResolver} drive — plus the bounded-read helpers that make a
 * response stream safe to consume.
 *
 * The protocol package is app-agnostic and MUST NOT depend on `@oxy.so/core`
 * (core depends on protocol). So instead of importing `@oxy.so/core/server`'s
 * `safeFetch` directly, the node client/resolver accept a {@link NodeFetch} —
 * Oxy supplies an adapter over `safeFetch` (HTTPS-only, DNS-pinned, private-IP
 * denylist, bounded redirects); a test supplies an in-process stub. Either way
 * the SSRF/transport policy stays in the injected implementation, and the
 * bounded body read (the cap that stops a malicious node streaming forever)
 * stays here, close to the parsing.
 *
 * A Node `IncomingMessage` (what `safeFetch` returns) satisfies
 * {@link NodeFetchResponse.body} directly — it is an `AsyncIterable<Buffer>`,
 * and `Buffer` is a `Uint8Array`.
 */

/** Per-request options the client passes to the injected transport. */
export interface NodeFetchInit {
  /** HTTP method (`GET` / `POST` / `PUT`). */
  method: string;
  /** Request headers. */
  headers?: Record<string, string>;
  /** Request body (for `POST` / `PUT`); omitted for `GET`. */
  body?: Uint8Array;
  /** Time-to-first-byte deadline in milliseconds. */
  headersTimeoutMs?: number;
  /** Redirect budget (each hop re-validated by the implementation). */
  maxRedirects?: number;
}

/** The streamed, non-redirect response the transport returns. */
export interface NodeFetchResponse {
  /** HTTP status code. */
  status: number;
  /** Response headers (a Node `IncomingHttpHeaders` satisfies this). */
  headers: Record<string, string | string[] | undefined>;
  /** Async-iterable byte body — read with the bounded helpers below. */
  body: AsyncIterable<Uint8Array>;
  /** Release the underlying stream when a bounded read is cut short. */
  destroy(): void;
}

/**
 * The injected transport. Oxy adapts `@oxy.so/core/server`'s `safeFetch` to this
 * shape; tests pass an in-process stub.
 */
export type NodeFetch = (url: string, init: NodeFetchInit) => Promise<NodeFetchResponse>;

/** Thrown when a response body exceeds the caller's byte ceiling. */
export class ResponseTooLargeError extends Error {
  constructor(public readonly maxBytes: number) {
    super(`response exceeded ${maxBytes} bytes`);
    this.name = 'ResponseTooLargeError';
  }
}

/**
 * Read a response body into a single buffer, aborting (and destroying the
 * stream) the moment it exceeds `maxBytes`. The bound is the defence against a
 * node that streams an unbounded body.
 */
export async function readBoundedBytes(res: NodeFetchResponse, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for await (const chunk of res.body) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += buf.length;
      if (total > maxBytes) {
        throw new ResponseTooLargeError(maxBytes);
      }
      chunks.push(buf);
    }
  } catch (err) {
    res.destroy();
    throw err;
  }
  return Buffer.concat(chunks);
}

/** Read a bounded response body and parse it as JSON. */
export async function readBoundedJson(res: NodeFetchResponse, maxBytes: number): Promise<unknown> {
  const bytes = await readBoundedBytes(res, maxBytes);
  return JSON.parse(bytes.toString('utf8'));
}
