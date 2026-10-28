import type { AssetFileAdapter, OxyServices } from '@oxy.so/core';
import { installNativeAssetFiles } from '../nativeAssetFiles.native';

const originalUri = 'file:///capture.mp4';
const mockFiles = new Map<string, { size: number; written: number }>();
const mockReads: number[] = [];
const mockDeleted: string[] = [];
let mockUpload: jest.Mock;
let mockCancel: jest.Mock;
let mockRequest: { url: string; uri: string; options: unknown } | undefined;

jest.mock('expo-file-system', () => {
  const uriOf = (value: string | { uri: string }) =>
    typeof value === 'string' ? value : value.uri;
  class Directory {
    uri: string;
    constructor(base: string, name: string) {
      this.uri = `${base}/${name}`;
    }
    get exists() {
      return false;
    }
    create() {}
    delete() {}
  }
  class File {
    uri: string;
    constructor(base: string | { uri: string }, name?: string) {
      this.uri = name ? `${uriOf(base)}/${name}` : uriOf(base);
    }
    get exists() {
      return mockFiles.has(this.uri);
    }
    get size() {
      return mockFiles.get(this.uri)?.size ?? 0;
    }
    create() {
      mockFiles.set(this.uri, { size: 0, written: 0 });
    }
    delete() {
      mockDeleted.push(this.uri);
      mockFiles.delete(this.uri);
    }
    open() {
      const uri = this.uri;
      let offset = 0;
      let closed = false;
      return {
        get offset() {
          return offset;
        },
        set offset(next: number) {
          offset = next;
        },
        readBytes(length: number) {
          if (closed) throw new Error('Closed');
          mockReads.push(length);
          const size = mockFiles.get(uri)?.size ?? 0;
          const bytes = new Uint8Array(Math.max(0, Math.min(length, size - offset))).fill(7);
          offset += bytes.length;
          return bytes;
        },
        writeBytes(bytes: Uint8Array) {
          if (closed) throw new Error('Closed');
          const file = mockFiles.get(uri);
          if (!file) throw new Error('Missing target');
          file.written += bytes.length;
          file.size += bytes.length;
        },
        close() {
          closed = true;
        },
      };
    }
  }
  return { File, Directory, Paths: { cache: 'file:///cache' } };
});
jest.mock('expo-file-system/legacy', () => ({
  FileSystemUploadType: { BINARY_CONTENT: 0 },
  FileSystemSessionType: { FOREGROUND: 0 },
  createUploadTask: (
    url: string,
    uri: string,
    options: unknown,
    progress: (event: { totalBytesSent: number }) => void,
  ) => {
    mockRequest = { url, uri, options };
    return { uploadAsync: () => mockUpload(uri, progress), cancelAsync: () => mockCancel() };
  },
}));

function adapter(): AssetFileAdapter {
  let installed: AssetFileAdapter | undefined;
  const oxy = {
    assets: {
      installFileAdapter: (value: AssetFileAdapter) => {
        installed = value;
        return () => {};
      },
    },
  } as unknown as OxyServices;
  installNativeAssetFiles(oxy);
  if (!installed) throw new Error('Adapter was not installed');
  return installed;
}

beforeEach(() => {
  mockFiles.clear();
  mockFiles.set(originalUri, { size: 370 * 1024 * 1024, written: 0 });
  mockReads.length = 0;
  mockDeleted.length = 0;
  mockRequest = undefined;
  mockCancel = jest.fn(async () => undefined);
  mockUpload = jest.fn(
    async (uri: string, progress: (event: { totalBytesSent: number }) => void) => {
      progress({ totalBytesSent: mockFiles.get(uri)?.size ?? 0 });
      return { status: 200 };
    },
  );
});

test('reads bounded ranges and streams only a temporary part of a larger-than-heap file', async () => {
  const source = await adapter()(originalUri);
  expect(source.size).toBe(370 * 1024 * 1024);
  const bytes = await source.readRange(16 * 1024 * 1024, 24 * 1024 * 1024);
  expect(bytes.length).toBe(8 * 1024 * 1024);
  expect(bytes[bytes.length - 1]).toBe(7);
  const onProgress = jest.fn();
  await expect(
    source.putPart({
      url: 'https://storage.example/part?signed=1',
      start: 32 * 1024 * 1024,
      end: 40 * 1024 * 1024,
      timeoutMs: 1000,
      onProgress,
    }),
  ).resolves.toEqual({ ok: true });
  expect(Math.max(...mockReads)).toBe(1024 * 1024);
  expect(mockReads.reduce((sum, size) => sum + size, 0)).toBe(16 * 1024 * 1024);
  expect(mockRequest).toMatchObject({
    url: 'https://storage.example/part?signed=1',
    options: { httpMethod: 'PUT', uploadType: 0, sessionType: 0, headers: {} },
  });
  expect(onProgress).toHaveBeenCalledWith(8 * 1024 * 1024);
  expect(mockFiles.has(originalUri)).toBe(true);
  expect(mockFiles.size).toBe(1);
  expect(mockDeleted).toHaveLength(1);
});

test('abort cancels the native transfer and deletes its part while preserving the capture', async () => {
  const source = await adapter()(originalUri);
  const controller = new AbortController();
  mockUpload.mockImplementation(() => new Promise(() => {}));
  const pending = source.putPart({
    url: 'https://storage.example/part',
    start: 0,
    end: 2 * 1024 * 1024,
    timeoutMs: 1000,
    signal: controller.signal,
    onProgress: jest.fn(),
  });
  while (!mockRequest) await Promise.resolve();
  controller.abort();
  await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  expect(mockCancel).toHaveBeenCalledTimes(1);
  expect(mockFiles.size).toBe(1);
  expect(mockFiles.has(originalUri)).toBe(true);
});

test('a stalled native PUT times out and cleans its temporary part', async () => {
  const source = await adapter()(originalUri);
  mockUpload.mockImplementation(() => new Promise(() => {}));
  await expect(
    source.putPart({
      url: 'https://storage.example/part',
      start: 0,
      end: 1024,
      timeoutMs: 5,
      onProgress: jest.fn(),
    }),
  ).resolves.toEqual({ ok: false, status: 0 });
  expect(mockCancel).toHaveBeenCalledTimes(1);
  expect(mockFiles.size).toBe(1);
});
