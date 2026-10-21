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
