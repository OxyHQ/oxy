/**
 * Bounded, deadlined reads of an upstream response body — the other half of
 * {@link ./safeFetch}.
 *
 * `safeFetch` bounds the request up to the RESPONSE HEADERS
 * (`headersTimeoutMs`); from there the caller owns the stream, and a server
 * that sends its headers and then stalls the body (or trickles it) holds a
 * plain `'data'`/`'end'` reader forever. Every body read from a `safeFetch`
 * response goes through {@link readResponseBody}, which caps the bytes AND
 * gives the whole body one deadline, so no remote server can hold a reader
 * open longer than the caller chose.
 *
 * Node-only, exported solely from `@oxy.so/core/server`.
 */

import type { Readable } from 'node:stream';

/** Limits for {@link readResponseBody}; both are required, so every call site chooses them. */
export interface ReadResponseBodyOptions {
  /** Largest body accepted, in bytes; one byte more is `too_large`. */
  maxBytes: number;
  /** Deadline for the WHOLE body, from the call until `'end'`, in milliseconds. */
  timeoutMs: number;
}

/**
 * What a body read came to. On `ok` the stream has ended; on every other
 * result it has been destroyed, so the caller has nothing left to release.
 * `error` is a stream that failed, or closed before it ended.
 */
export type ReadResponseBodyResult =
  | { kind: 'ok'; body: Buffer }
  | { kind: 'too_large' }
  | { kind: 'timeout' }
  | { kind: 'error'; error: Error };

/** {@link ReadResponseBodyResult} for a JSON body; `value` is unvalidated, the caller checks its shape. */
export type ReadResponseJsonResult<T = unknown> =
  | { kind: 'ok'; value: T }
  | Exclude<ReadResponseBodyResult, { kind: 'ok' }>
  | { kind: 'invalid_json' };

/**
 * Read `response` into one Buffer, at most `maxBytes` and within `timeoutMs`.
 * Never rejects: it settles exactly once, clears its timer and removes its
 * listeners on every path. Past the cap or the deadline the stream is
 * destroyed at once.
 */
export function readResponseBody(
  response: Readable,
  options: ReadResponseBodyOptions,
): Promise<ReadResponseBodyResult> {
  const { maxBytes, timeoutMs } = options;
  return new Promise<ReadResponseBodyResult>((resolve) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;

    const settle = (result: ReadResponseBodyResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      response.off('data', onData);
      response.off('end', onEnd);
      response.off('close', onClose);
      // `onError` stays attached: a destroyed socket can still emit `'error'`,
      // and an `'error'` with no listener would crash the process.
      if (result.kind !== 'ok') response.destroy();
      resolve(result);
    };

    const onData = (chunk: Uint8Array | string): void => {
      const buffer = Buffer.isBuffer(chunk)
        ? chunk
        : typeof chunk === 'string'
          ? Buffer.from(chunk)
          : Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
      total += buffer.length;
      if (total > maxBytes) {
        settle({ kind: 'too_large' });
        return;
      }
      chunks.push(buffer);
    };
    const onEnd = (): void => settle({ kind: 'ok', body: Buffer.concat(chunks, total) });
    const onClose = (): void =>
      settle({ kind: 'error', error: new Error('response closed before the body ended') });
    const onError = (error: Error): void => settle({ kind: 'error', error });

    const timer = setTimeout(() => settle({ kind: 'timeout' }), timeoutMs);
    response.on('data', onData);
    response.on('end', onEnd);
    response.on('close', onClose);
    response.on('error', onError);
  });
}

/** {@link readResponseBody}, then `JSON.parse` the UTF-8 body; an empty body is `invalid_json`. */
export async function readResponseJson<T = unknown>(
  response: Readable,
  options: ReadResponseBodyOptions,
): Promise<ReadResponseJsonResult<T>> {
  const result = await readResponseBody(response, options);
  if (result.kind !== 'ok') return result;
  try {
    return { kind: 'ok', value: JSON.parse(result.body.toString('utf8')) as T };
  } catch {
    return { kind: 'invalid_json' };
  }
}
