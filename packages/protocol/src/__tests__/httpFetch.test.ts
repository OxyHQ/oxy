import { PassThrough } from 'node:stream';
import {
  type NodeFetchResponse,
  readBoundedBytes,
  ResponseTimeoutError,
  ResponseTooLargeError,
} from '../node/httpFetch';

function streamResponse(): { stream: PassThrough; res: NodeFetchResponse } {
  const stream = new PassThrough();
  return {
    stream,
    res: { status: 200, headers: {}, body: stream, destroy: () => stream.destroy() },
  };
}

describe('readBoundedBytes', () => {
  it('reads a body that ends within its limits', async () => {
    const { stream, res } = streamResponse();
    const pending = readBoundedBytes(res, 8, 1_000);
    stream.write('ab');
    stream.end('cd');
    expect((await pending).toString()).toBe('abcd');
  });

  it('throws ResponseTooLargeError one byte past the cap and destroys the stream', async () => {
    const { stream, res } = streamResponse();
    const pending = readBoundedBytes(res, 3, 1_000);
    stream.write('abcd');
    await expect(pending).rejects.toBeInstanceOf(ResponseTooLargeError);
    expect(stream.destroyed).toBe(true);
  });

  it('throws ResponseTimeoutError for a body that stalls and destroys the stream', async () => {
    jest.useFakeTimers();
    try {
      const { stream, res } = streamResponse();
      const pending = readBoundedBytes(res, 1_024, 5_000);
      stream.write('{"partial":');
      const settled = expect(pending).rejects.toBeInstanceOf(ResponseTimeoutError);
      await jest.advanceTimersByTimeAsync(5_000);
      await settled;
      expect(stream.destroyed).toBe(true);
      expect(jest.getTimerCount()).toBe(0);
    } finally {
      jest.useRealTimers();
    }
  });
});
