import { describe, expect, it } from 'bun:test';
import { base64UrlToBuffer, bufferToBase64Url } from '../base64url';

describe('base64url', () => {
  it('round-trips every byte value, at every padding length', () => {
    for (let length = 0; length <= 64; length += 1) {
      const bytes = Uint8Array.from({ length }, (_, i) => (i * 37 + length) % 256);
      const encoded = bufferToBase64Url(bytes);
      expect(encoded).toMatch(/^[A-Za-z0-9_-]*$/);
      expect(new Uint8Array(base64UrlToBuffer(encoded))).toEqual(bytes);
    }
  });

  it('matches the RFC 4648 base64url alphabet (no +, /, or padding)', () => {
    expect(bufferToBase64Url(Uint8Array.from([0xfb, 0xff, 0xbf]))).toBe('-_-_');
    expect(new Uint8Array(base64UrlToBuffer('-_-_'))).toEqual(Uint8Array.from([0xfb, 0xff, 0xbf]));
  });

  it('accepts padded input too', () => {
    expect(new Uint8Array(base64UrlToBuffer('AQ=='))).toEqual(Uint8Array.from([1]));
  });

  it('encodes a view without leaking the rest of its buffer', () => {
    const backing = Uint8Array.from([9, 1, 2, 9]);
    expect(bufferToBase64Url(backing.subarray(1, 3))).toBe(bufferToBase64Url(Uint8Array.from([1, 2])));
  });
});
