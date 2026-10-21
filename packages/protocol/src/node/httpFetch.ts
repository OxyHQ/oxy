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
 * bounded body read (the byte cap and the body deadline that stop a malicious
 * node streaming forever or stalling mid-body) stays here, close to the parsing.
 *
 * A Node `IncomingMessage` (what `safeFetch` returns) satisfies
 * {@link NodeFetchResponse.body} directly — it is an `AsyncIterable<Buffer>`,
 * and `Buffer` is a `Uint8Array`.
 */

import { DEFAULT_CLIENT_BODY_TIMEOUT_MS } from './constants';

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
 * Thrown when a response body does not end within the caller's deadline — a
 * peer that sent its headers and then stalled or trickled the body. Unlike
 * {@link ResponseTooLargeError} this says nothing about the peer's data, only
 * that this attempt ran out of time: a caller treats it as transient and retries.
 */
export class ResponseTimeoutError extends Error {
  constructor(public readonly timeoutMs: number) {
    super(`response body did not end within ${timeoutMs} ms`);
    this.name = 'ResponseTimeoutError';
  }
}

/**
 * Read a response body into a single buffer, at most `maxBytes` and within
 * `timeoutMs` for the WHOLE body (from the call until the stream ends). Past
 * the cap it throws {@link ResponseTooLargeError}, past the deadline
 * {@link ResponseTimeoutError}; on either, or a stream error, the stream is
 * destroyed before the throw, and the deadline timer is cleared on every path.
 *
 * The transport's `headersTimeoutMs` ends at the response headers; this
 * deadline is what stops a node that sends headers and then stalls the body
 * from holding the reader open. `timeoutMs` defaults to
 * {@link DEFAULT_CLIENT_BODY_TIMEOUT_MS}.
 */
export async function readBoundedBytes(
  res: NodeFetchResponse,
  maxBytes: number,
  timeoutMs: number = DEFAULT_CLIENT_BODY_TIMEOUT_MS,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new ResponseTimeoutError(timeoutMs)), timeoutMs);
  });
  const iterator = res.body[Symbol.asyncIterator]();
  try {
    for (;;) {
      // `Promise.race` subscribes to both, so neither the deadline nor a read
      // that rejects once the stream is destroyed goes unhandled.
      const step = await Promise.race([iterator.next(), deadline]);
      if (step.done) break;
      const buf = Buffer.isBuffer(step.value) ? step.value : Buffer.from(step.value);
      total += buf.length;
      if (total > maxBytes) {
        throw new ResponseTooLargeError(maxBytes);
      }
      chunks.push(buf);
    }
  } catch (err) {
    res.destroy();
    throw err;
  } finally {
    clearTimeout(timer);
  }
  return Buffer.concat(chunks, total);
}

/** Read a bounded, deadlined response body and parse it as JSON. */
export async function readBoundedJson(
  res: NodeFetchResponse,
  maxBytes: number,
  timeoutMs: number = DEFAULT_CLIENT_BODY_TIMEOUT_MS,
): Promise<unknown> {
  const bytes = await readBoundedBytes(res, maxBytes, timeoutMs);
  return JSON.parse(bytes.toString('utf8'));
}
