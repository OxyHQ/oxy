/**
 * The one bounded, deadlined body read behind every federation response body
 * (an actor or collection `Response`, a failed delivery's preview).
 *
 * The transports bound a request up to its response headers; from there the
 * reader owns the stream, and a remote that sends headers and then stalls (or
 * trickles) the body would hold a plain read loop forever. This caps the bytes
 * AND gives the whole body one deadline, cancelling the source on every early
 * exit. It reads through a {@link BodyChunkSource} so a WHATWG reader and a
 * Node async iterator share it.
 */

/** One `read()` step: a WHATWG `ReadableStreamDefaultReader` and an async iterator both return it. */
interface BodyChunk {
  done?: boolean;
  value?: Uint8Array;
}

/** Where the chunks come from, and how to release the stream when a read ends early. */
export interface BodyChunkSource {
  read(): Promise<BodyChunk>;
  cancel(): void;
}

/** Limits for {@link readBodyChunks}. */
export interface BodyReadLimits {
  /** Largest body accepted, in bytes. */
  maxBytes: number;
  /** Deadline for the WHOLE body, from the call until the source ends, in milliseconds. */
  timeoutMs: number;
  /**
   * `reject` (the default) throws {@link ResponseBodyTooLargeError} past the cap;
   * `truncate` stops there and returns the first `maxBytes` (a preview).
   */
  overflow?: 'reject' | 'truncate';
}

/** Thrown when a body exceeds its byte cap under `overflow: 'reject'`. */
export class ResponseBodyTooLargeError extends Error {
  constructor(public readonly maxBytes: number) {
    super(`Remote response exceeds ${maxBytes} byte limit`);
    this.name = 'ResponseBodyTooLargeError';
  }
}

/** Thrown when a body does not end within its deadline; this attempt failed, a retry may not. */
export class ResponseBodyTimeoutError extends Error {
  constructor(public readonly timeoutMs: number) {
    super(`Remote response body did not end within ${timeoutMs} ms`);
    this.name = 'ResponseBodyTimeoutError';
  }
}

/**
 * Read `source` into one Buffer, at most `maxBytes` and within `timeoutMs`.
 * The deadline timer is cleared on every path; the source is cancelled on a
 * cap, a deadline, a read error, or a truncated preview.
 */
export async function readBodyChunks(
  source: BodyChunkSource,
  limits: BodyReadLimits,
): Promise<Buffer> {
  const { maxBytes, timeoutMs, overflow = 'reject' } = limits;
  const chunks: Buffer[] = [];
  let total = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new ResponseBodyTimeoutError(timeoutMs)), timeoutMs);
  });
  try {
    for (;;) {
      // `Promise.race` subscribes to both, so neither the deadline nor a read
      // that rejects once the source is cancelled goes unhandled.
      const { done, value } = await Promise.race([source.read(), deadline]);
      if (done || !value) break;
      const buffer = Buffer.isBuffer(value)
        ? value
        : Buffer.from(value.buffer, value.byteOffset, value.byteLength);
      if (total + buffer.length > maxBytes) {
        if (overflow === 'reject') throw new ResponseBodyTooLargeError(maxBytes);
        chunks.push(buffer.subarray(0, maxBytes - total));
        total = maxBytes;
        source.cancel();
        break;
      }
      total += buffer.length;
      chunks.push(buffer);
    }
  } catch (err) {
    source.cancel();
    throw err;
  } finally {
    clearTimeout(timer);
  }
  return Buffer.concat(chunks, total);
}

/** Deadline for a whole response body once its headers arrived, by default. */
const RESPONSE_BODY_TIMEOUT_MS = 10_000;

/** Limits for {@link readBoundedResponseText} / {@link readBoundedResponseJson}. */
export interface ResponseBodyLimits {
  /** Largest body accepted, in bytes; a larger declared or actual body throws. */
  maxBytes: number;
  /** Deadline for the whole body, in milliseconds (default 10 s). */
  timeoutMs?: number;
}

/**
 * A WHATWG `Response` body as UTF-8 text, within {@link ResponseBodyLimits}.
 * A fetch's own timeout ends at the headers, so without the body deadline a
 * remote that stalls mid-body would hold the reader open. A declared
 * `Content-Length` over the cap is refused before any byte is read.
 */
export async function readBoundedResponseText(
  res: Response,
  limits: ResponseBodyLimits,
): Promise<string> {
  const { maxBytes, timeoutMs = RESPONSE_BODY_TIMEOUT_MS } = limits;
  const contentLength = res.headers.get('content-length');
  if (contentLength) {
    const declaredBytes = Number(contentLength);
    if (Number.isFinite(declaredBytes) && declaredBytes > maxBytes) {
      await res.body?.cancel().catch(() => {});
      throw new ResponseBodyTooLargeError(maxBytes);
    }
  }

  if (!res.body) return '';

  const reader = res.body.getReader();
  const body = await readBodyChunks(
    { read: () => reader.read(), cancel: () => void reader.cancel().catch(() => {}) },
    { maxBytes, timeoutMs },
  );
  return new TextDecoder('utf-8', { fatal: true }).decode(body);
}

/**
 * A WHATWG `Response` body as a JSON object, within {@link ResponseBodyLimits}.
 * Throws when the body is empty, is not JSON, or is JSON but not an object.
 */
export async function readBoundedResponseJson(
  res: Response,
  limits: ResponseBodyLimits,
): Promise<Record<string, unknown>> {
  const body = await readBoundedResponseText(res, limits);
  // An empty body is a REMOTE's answer, not a parser error. Without this,
  // `JSON.parse('')` throws a SyntaxError whose message names a column number,
  // which is a worse thing to find in a federation log than the fact that the
  // instance sent nothing.
  if (body.length === 0) throw new Error('Remote response has no body');
  const value: unknown = JSON.parse(body);
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Remote response is not a JSON object');
  }
  return value as Record<string, unknown>;
}
