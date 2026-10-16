/**
 * Decoding an `aws-chunked` request body (`Content-Encoding: aws-chunked`,
 * `x-amz-content-sha256: STREAMING-UNSIGNED-PAYLOAD-TRAILER`) — what an AWS SDK
 * sends when it computes a flexible checksum over a streamed upload:
 *
 *   <hex size>\r\n<bytes>\r\n … 0\r\n<trailer: value>\r\n\r\n
 *
 * Only the payload comes out; the trailing checksum header is collected for
 * the caller. Chunk extensions (`;chunk-signature=…`) belong to SIGNED
 * streaming, which `sigv4.ts` refuses before a body is read, so a chunk line
 * carrying one is an error here.
 */

import { Transform, type TransformCallback } from 'node:stream';

const MAX_LINE = 4096;

export class AwsChunkedDecoder extends Transform {
  private buffer: Buffer = Buffer.alloc(0);
  private remaining = -1;
  private state: 'size' | 'data' | 'data-crlf' | 'trailer' | 'done' = 'size';
  /** The trailing headers (lowercased names), once the body ended. */
  readonly trailers: Record<string, string> = {};

  _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
    try {
      this.drain();
      callback();
    } catch (error) {
      callback(error as Error);
    }
  }

  _flush(callback: TransformCallback): void {
    if (this.state !== 'done') {
      callback(new Error('The aws-chunked body ended early'));
      return;
    }
    callback();
  }

  private line(): string | null {
    const end = this.buffer.indexOf('\r\n');
    if (end < 0) {
      if (this.buffer.length > MAX_LINE) throw new Error('An aws-chunked line is too long');
      return null;
    }
    const text = this.buffer.subarray(0, end).toString('latin1');
    this.buffer = this.buffer.subarray(end + 2);
    return text;
  }

  private drain(): void {
    for (;;) {
      if (this.state === 'size') {
        const text = this.line();
        if (text === null) return;
        if (text.includes(';')) throw new Error('Signed aws-chunked bodies are not supported');
        if (!/^[0-9a-fA-F]{1,16}$/.test(text)) throw new Error('Malformed aws-chunked size');
        this.remaining = Number.parseInt(text, 16);
        this.state = this.remaining === 0 ? 'trailer' : 'data';
      } else if (this.state === 'data') {
        if (this.buffer.length === 0) return;
        const take = Math.min(this.remaining, this.buffer.length);
        this.push(this.buffer.subarray(0, take));
        this.buffer = this.buffer.subarray(take);
        this.remaining -= take;
        if (this.remaining === 0) this.state = 'data-crlf';
      } else if (this.state === 'data-crlf') {
        if (this.buffer.length < 2) return;
        if (this.buffer[0] !== 0x0d || this.buffer[1] !== 0x0a) {
          throw new Error('Malformed aws-chunked chunk end');
        }
        this.buffer = this.buffer.subarray(2);
        this.state = 'size';
      } else if (this.state === 'trailer') {
        const text = this.line();
        if (text === null) return;
        if (text === '') {
          this.state = 'done';
          continue;
        }
        const colon = text.indexOf(':');
        if (colon <= 0) throw new Error('Malformed aws-chunked trailer');
        this.trailers[text.slice(0, colon).trim().toLowerCase()] = text.slice(colon + 1).trim();
      } else {
        // Anything after the final CRLF is ignored.
        this.buffer = Buffer.alloc(0);
        return;
      }
    }
  }
}
