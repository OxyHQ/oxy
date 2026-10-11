declare module 'buffer' {
  export class Buffer extends Uint8Array {
    constructor(str: string, encoding?: string);
    constructor(size: number);
    constructor(array: Uint8Array);
    constructor(arrayBuffer: ArrayBuffer);
    constructor(array: ReadonlyArray<number>);
    constructor(buffer: Buffer);

    static from(arrayBuffer: ArrayBuffer, byteOffset?: number, length?: number): Buffer;
    static from(data: Uint8Array | ReadonlyArray<number>): Buffer;
    static from(str: string, encoding?: BufferEncoding): Buffer;
    static from(
      object: { valueOf(): string | object } | { [Symbol.toPrimitive](hint: 'string'): string },
      offsetOrEncoding?: number | string,
      length?: number,
    ): Buffer;

    static alloc(size: number, fill?: string | Buffer | number, encoding?: BufferEncoding): Buffer;
    static allocUnsafe(size: number): Buffer;
    static allocUnsafeSlow(size: number): Buffer;

    static isBuffer(obj: unknown): obj is Buffer;
    static isEncoding(encoding: string): encoding is BufferEncoding;
    static byteLength(
      string: string | Buffer | ArrayBuffer | SharedArrayBuffer,
      encoding?: BufferEncoding,
    ): number;
    static concat(list: ReadonlyArray<Uint8Array>, totalLength?: number): Buffer;
    static compare(buf1: Uint8Array, buf2: Uint8Array): number;

    write(string: string, encoding?: BufferEncoding): number;
    write(string: string, offset: number, encoding?: BufferEncoding): number;
    write(string: string, offset: number, length: number, encoding?: BufferEncoding): number;

    toString(encoding?: BufferEncoding, start?: number, end?: number): string;
    toJSON(): { type: 'Buffer'; data: number[] };

    equals(otherBuffer: Uint8Array): boolean;
    compare(
      target: Uint8Array,
      targetStart?: number,
      targetEnd?: number,
      sourceStart?: number,
      sourceEnd?: number,
    ): number;
    copy(
      target: Uint8Array,
      targetStart?: number,
      sourceStart?: number,
      sourceEnd?: number,
    ): number;

    slice(start?: number, end?: number): Buffer;
    subarray(start?: number, end?: number): Buffer;

    readBigInt64BE(offset?: number): bigint;
    readBigInt64LE(offset?: number): bigint;
    readBigUInt64BE(offset?: number): bigint;
    readBigUInt64LE(offset?: number): bigint;
    readDoubleBE(offset?: number): number;
    readDoubleLE(offset?: number): number;
    readFloatBE(offset?: number): number;
    readFloatLE(offset?: number): number;
    readInt8(offset?: number): number;
    readInt16BE(offset?: number): number;
    readInt16LE(offset?: number): number;
    readInt32BE(offset?: number): number;
    readInt32LE(offset?: number): number;
    readIntBE(offset: number, byteLength: number): number;
    readIntLE(offset: number, byteLength: number): number;
    readUInt8(offset?: number): number;
    readUInt16BE(offset?: number): number;
    readUInt16LE(offset?: number): number;
    readUInt32BE(offset?: number): number;
    readUInt32LE(offset?: number): number;
    readUIntBE(offset: number, byteLength: number): number;
    readUIntLE(offset: number, byteLength: number): number;

    swap16(): Buffer;
    swap32(): Buffer;
    swap64(): Buffer;

    writeBigInt64BE(value: bigint, offset?: number): number;
    writeBigInt64LE(value: bigint, offset?: number): number;
    writeBigUInt64BE(value: bigint, offset?: number): number;
    writeBigUInt64LE(value: bigint, offset?: number): number;
    writeDoubleBE(value: number, offset?: number): number;
    writeDoubleLE(value: number, offset?: number): number;
    writeFloatBE(value: number, offset?: number): number;
    writeFloatLE(value: number, offset?: number): number;
    writeInt8(value: number, offset?: number): number;
    writeInt16BE(value: number, offset?: number): number;
    writeInt16LE(value: number, offset?: number): number;
    writeInt32BE(value: number, offset?: number): number;
    writeInt32LE(value: number, offset?: number): number;
    writeIntBE(value: number, offset: number, byteLength: number): number;
    writeIntLE(value: number, offset: number, byteLength: number): number;
    writeUInt8(value: number, offset?: number): number;
    writeUInt16BE(value: number, offset?: number): number;
    writeUInt16LE(value: number, offset?: number): number;
    writeUInt32BE(value: number, offset?: number): number;
    writeUInt32LE(value: number, offset?: number): number;
    writeUIntBE(value: number, offset: number, byteLength: number): number;
    writeUIntLE(value: number, offset: number, byteLength: number): number;

    fill(
      value: string | Uint8Array | number,
      offset?: number,
      end?: number,
      encoding?: BufferEncoding,
    ): this;
    indexOf(
      value: string | number | Uint8Array,
      byteOffset?: number,
      encoding?: BufferEncoding,
    ): number;
    lastIndexOf(
      value: string | number | Uint8Array,
      byteOffset?: number,
      encoding?: BufferEncoding,
    ): number;
    includes(
      value: string | number | Buffer,
      byteOffset?: number,
      encoding?: BufferEncoding,
    ): boolean;
  }

  type BufferEncoding =
    | 'ascii'
    | 'utf8'
    | 'utf-8'
    | 'utf16le'
    | 'ucs2'
    | 'ucs-2'
    | 'base64'
    | 'base64url'
    | 'latin1'
    | 'binary'
    | 'hex';
}
