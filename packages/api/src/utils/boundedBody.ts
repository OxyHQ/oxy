import type { IncomingMessage } from 'http';

/** Read at most `maxBytes` from an HTTP response body. */
export function readBoundedBody(
  response: IncomingMessage,
  options: { maxBytes: number; stopMarker?: string },
): Promise<string> {
  const { maxBytes, stopMarker } = options;
  const marker = stopMarker?.toLowerCase();
  const carrySize = marker ? marker.length - 1 : 0;

  return new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalSize = 0;
    let settled = false;
    let carry: Buffer = Buffer.alloc(0);

    const finish = (): void => {
      if (settled) return;
      settled = true;
      response.destroy();
      resolve(Buffer.concat(chunks).toString('utf8'));
    };

    response.on('data', (chunk: Buffer) => {
      if (settled) return;
      totalSize += chunk.length;
      chunks.push(chunk);
      if (marker) {
        const window = carry.length > 0 ? Buffer.concat([carry, chunk]) : chunk;
        if (window.toString('latin1').toLowerCase().includes(marker)) {
          finish();
          return;
        }
        carry = window.length > carrySize ? window.subarray(window.length - carrySize) : window;
      }
      if (totalSize > maxBytes) finish();
    });
    response.on('end', () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
    response.on('error', (error: Error) => {
      if (settled) return;
      settled = true;
      reject(error);
    });
  });
}
