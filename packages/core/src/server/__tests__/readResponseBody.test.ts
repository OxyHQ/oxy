import { PassThrough } from 'node:stream';
import { readResponseBody } from '../readResponseBody';

describe('@oxy.so/core/server readResponseBody', () => {
  it('reads a body that ends within its limits, settling once with no listeners left', async () => {
    const stream = new PassThrough();
    const pending = readResponseBody(stream, { maxBytes: 8, timeoutMs: 1_000 });
    stream.write('ab');
    stream.end('cd');
    expect(await pending).toEqual({ kind: 'ok', body: Buffer.from('abcd') });
    expect(stream.listenerCount('data') + stream.listenerCount('end')).toBe(0);
  });

  it('answers too_large one byte past the cap and destroys the stream', async () => {
    const stream = new PassThrough();
    const pending = readResponseBody(stream, { maxBytes: 3, timeoutMs: 1_000 });
    stream.write('abcd');
    expect(await pending).toEqual({ kind: 'too_large' });
    expect(stream.destroyed).toBe(true);
  });

  it('answers timeout for a body that stalls after its first bytes and destroys the stream', async () => {
    jest.useFakeTimers();
    try {
      const stream = new PassThrough();
      const pending = readResponseBody(stream, { maxBytes: 1_024, timeoutMs: 5_000 });
      stream.write('{"partial":');
      await jest.advanceTimersByTimeAsync(5_000);
      expect(await pending).toEqual({ kind: 'timeout' });
      expect(stream.destroyed).toBe(true);
      expect(jest.getTimerCount()).toBe(0);
    } finally {
      jest.useRealTimers();
    }
  });
});
