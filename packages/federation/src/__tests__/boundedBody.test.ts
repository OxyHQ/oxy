import { PassThrough } from 'node:stream';
import {
  type BodyChunkSource,
  readBodyChunks,
  ResponseBodyTimeoutError,
  ResponseBodyTooLargeError,
} from '../node/boundedBody';

function streamSource(): { stream: PassThrough; source: BodyChunkSource } {
  const stream = new PassThrough();
  const iterator = stream[Symbol.asyncIterator]();
  return { stream, source: { read: () => iterator.next(), cancel: () => stream.destroy() } };
}

describe('readBodyChunks', () => {
  it('reads a body that ends within its limits', async () => {
    const { stream, source } = streamSource();
    const pending = readBodyChunks(source, { maxBytes: 8, timeoutMs: 1_000 });
    stream.write('ab');
    stream.end('cd');
    expect((await pending).toString()).toBe('abcd');
  });

  it('rejects one byte past the cap (or truncates a preview) and destroys the stream', async () => {
    const rejected = streamSource();
    const pending = readBodyChunks(rejected.source, { maxBytes: 3, timeoutMs: 1_000 });
    rejected.stream.write('abcd');
    await expect(pending).rejects.toBeInstanceOf(ResponseBodyTooLargeError);
    expect(rejected.stream.destroyed).toBe(true);

    const truncated = streamSource();
    const preview = readBodyChunks(truncated.source, {
      maxBytes: 3,
      timeoutMs: 1_000,
      overflow: 'truncate',
    });
    truncated.stream.write('abcd');
    expect((await preview).toString()).toBe('abc');
    expect(truncated.stream.destroyed).toBe(true);
  });

  it('throws ResponseBodyTimeoutError for a body that stalls and destroys the stream', async () => {
    jest.useFakeTimers();
    try {
      const { stream, source } = streamSource();
      const pending = readBodyChunks(source, { maxBytes: 1_024, timeoutMs: 5_000 });
      stream.write('{"partial":');
      const settled = expect(pending).rejects.toBeInstanceOf(ResponseBodyTimeoutError);
      await jest.advanceTimersByTimeAsync(5_000);
      await settled;
      expect(stream.destroyed).toBe(true);
      expect(jest.getTimerCount()).toBe(0);
    } finally {
      jest.useRealTimers();
    }
  });
});
