import { promises as fsPromises } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { getEventListeners } from 'node:events';
import {
  createServer,
  type IncomingHttpHeaders,
  type Server,
  type ServerResponse,
} from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import type { S3Client } from '@aws-sdk/client-s3';
import { S3Service } from '../s3Service';

/** Real SDK transport: failures happen after HTTP bytes arrive, not in a mocked send/Upload. */
interface RequestRecord {
  method: string;
  url: URL;
  headers: IncomingHttpHeaders;
  body: Buffer;
}

let directory: string;
let server: Server;
let service: S3Service;
let requests: RequestRecord[];
let handler: (request: RequestRecord, response: ServerResponse) => void;
let serverErrors: unknown[];

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'oxy-transfer-test-'));
  requests = [];
  serverErrors = [];
  handler = (_request, response) => response.end();
  server = createServer(async (request, response) => {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const record = {
        method: request.method ?? '',
        url: new URL(request.url ?? '/', 'http://127.0.0.1'),
        headers: request.headers,
        body: Buffer.concat(chunks),
      };
      requests.push(record);
      handler(record, response);
    } catch (error) {
      // A caller cancellation deliberately interrupts in-flight request bodies.
      if (!request.aborted) serverErrors.push(error);
      response.destroy();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing local S3 address');
  service = new S3Service({
    bucketName: 'media-test',
    region: 'us-west-2',
    endpointUrl: `http://127.0.0.1:${address.port}`,
    accessKeyId: 'test-access-key',
    secretAccessKey: 'test-secret-key',
  });
});

afterEach(async () => {
  jest.restoreAllMocks();
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  await rm(directory, { recursive: true, force: true });
  expect(serverErrors).toEqual([]);
});

function s3Error(response: ServerResponse, status: number, code: string): void {
  response.writeHead(status, { 'content-type': 'application/xml' });
  response.end(`<Error><Code>${code}</Code><Message>Injected transport failure</Message></Error>`);
}

function multipart(request: RequestRecord, response: ServerResponse): boolean {
  if (request.method === 'POST' && request.url.searchParams.has('uploads')) {
    response.setHeader('content-type', 'application/xml');
    response.end(
      '<InitiateMultipartUploadResult><UploadId>upload-1</UploadId></InitiateMultipartUploadResult>',
    );
    return true;
  }
  if (request.method === 'POST' && request.url.searchParams.has('uploadId')) {
    response.setHeader('content-type', 'application/xml');
    response.end(
      '<CompleteMultipartUploadResult><ETag>"complete"</ETag></CompleteMultipartUploadResult>',
    );
    return true;
  }
  if (request.method === 'DELETE' && request.url.searchParams.has('uploadId')) {
    response.writeHead(204);
    response.end();
    return true;
  }
  return false;
}

async function localFile(bytes: Buffer): Promise<string> {
  const file = join(directory, 'encoded.mp4');
  await writeFile(file, bytes);
  return file;
}

describe('replayable file uploads', () => {
  it('replays the complete small PUT after a transient response without losing object headers', async () => {
    const controller = new AbortController();
    const bytes = Buffer.from('a complete encoded video, including its index');
    handler = (_request, response) => {
      if (requests.length === 1) return s3Error(response, 503, 'ServiceUnavailable');
      response.setHeader('etag', '"complete"');
      response.end();
    };
    const uploaded = await service.uploadFile('encoded.mp4', await localFile(bytes), {
      contentType: 'video/mp4',
      cacheControl: 'public, max-age=31536000, immutable',
      metadata: { profile: 'video-v2' },
      abortSignal: controller.signal,
    });
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
    expect(uploaded.key).toBe('encoded.mp4');
    expect(requests).toHaveLength(2);
    for (const request of requests) {
      expect(request.method).toBe('PUT');
      expect(request.body).toEqual(bytes);
      expect(request.headers['content-type']).toBe('video/mp4');
      expect(request.headers['cache-control']).toBe('public, max-age=31536000, immutable');
      expect(request.headers['x-amz-meta-profile']).toBe('video-v2');
    }
  });

  it('retries only the failed multipart part with identical bytes and completes the object', async () => {
    const partSize = 5 * 1024 * 1024;
    const bytes = Buffer.concat([Buffer.alloc(partSize, 0x5a), Buffer.alloc(1024 * 1024, 0xa5)]);
    let firstPartAttempts = 0;
    handler = (request, response) => {
      if (multipart(request, response)) return;
      if (request.url.searchParams.get('partNumber') === '1' && ++firstPartAttempts === 1) {
        return s3Error(response, 503, 'ServiceUnavailable');
      }
      response.setHeader('etag', `"part-${request.url.searchParams.get('partNumber')}"`);
      response.end();
    };
    await service.uploadFile('encoded.mp4', await localFile(bytes));
    const first = requests.filter((request) => request.url.searchParams.get('partNumber') === '1');
    const second = requests.filter((request) => request.url.searchParams.get('partNumber') === '2');
    expect(first).toHaveLength(2);
    expect(second).toHaveLength(1);
    // Native byte comparison avoids constructing megabyte-sized Jest diffs.
    for (const request of first)
      expect(request.body.equals(bytes.subarray(0, partSize))).toBe(true);
    expect(second[0].body.equals(bytes.subarray(partSize))).toBe(true);
    expect(
      requests.filter(
        (request) => request.method === 'POST' && request.url.searchParams.has('uploadId'),
      ),
    ).toHaveLength(1);
    expect(requests.filter((request) => request.method === 'DELETE')).toHaveLength(0);
  });

  it('aborts multipart storage on a nonretryable part failure and never completes it', async () => {
    const controller = new AbortController();
    handler = (request, response) => {
      if (multipart(request, response)) return;
      s3Error(response, 403, 'AccessDenied');
    };
    await expect(
      service.uploadFile('encoded.mp4', await localFile(Buffer.alloc(6 * 1024 * 1024)), {
        abortSignal: controller.signal,
      }),
    ).rejects.toThrow(/AccessDenied|Injected transport failure/);
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
    const parts = requests.filter((request) => request.url.searchParams.has('partNumber'));
    expect(parts.length).toBeGreaterThan(0);
    expect(new Set(parts.map((request) => request.url.searchParams.get('partNumber'))).size).toBe(
      parts.length,
    );
    expect(
      requests.filter(
        (request) =>
          request.method === 'DELETE' && request.url.searchParams.get('uploadId') === 'upload-1',
      ),
    ).toHaveLength(1);
    expect(
      requests.filter(
        (request) => request.method === 'POST' && request.url.searchParams.has('uploadId'),
      ),
    ).toHaveLength(0);
  });

  it('does not retry a denied small PUT', async () => {
    handler = (_request, response) => s3Error(response, 403, 'AccessDenied');
    await expect(
      service.uploadFile('encoded.mp4', await localFile(Buffer.from('denied'))),
    ).rejects.toThrow(/AccessDenied|Injected transport failure/);
    expect(requests).toHaveLength(1);
  });

  it('bounds pending parts after cancellation, destroys the source and eventually discards multipart storage', async () => {
    // Upload.abort() rejects its public promise before SDK requests settle.
    // Exercise the real transport inactivity bound without waiting two minutes.
    const { s3Client } = service as unknown as { s3Client: S3Client };
    s3Client.config.requestHandler.updateHttpClientConfig('socketTimeout', 250);
    const controller = new AbortController();
    let confirmAbort: (() => void) | undefined;
    const abortSeen = new Promise<void>((resolve) => {
      confirmAbort = resolve;
    });
    const source = Readable.from(
      (async function* () {
        for (let index = 0; index < 20; index++) yield Buffer.alloc(5 * 1024 * 1024, index);
      })(),
    );
    handler = (request, response) => {
      if (request.method === 'DELETE') confirmAbort?.();
      if (multipart(request, response)) return;
      // The SDK has opened multipart storage and sent at least one whole part.
      // Keep its response pending while the caller cancels the operation.
      controller.abort();
    };
    await expect(
      service.uploadStream('encoded.mp4', source, { abortSignal: controller.signal }),
    ).rejects.toThrow();
    expect(source.destroyed).toBe(true);
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        abortSeen,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new Error('Multipart cancellation was not cleaned up')),
            5_000,
          );
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
    expect(requests.some((request) => request.url.searchParams.has('partNumber'))).toBe(true);
    expect(requests.filter((request) => request.method === 'DELETE')).toHaveLength(1);
    expect(
      requests.filter(
        (request) => request.method === 'POST' && request.url.searchParams.has('uploadId'),
      ),
    ).toHaveLength(0);
  });

  it('disposes a live source already cancelled before upload without issuing HTTP', async () => {
    const controller = new AbortController();
    controller.abort();
    const source = new PassThrough();
    source.write('bytes waiting for an upload consumer');
    try {
      await expect(
        service.uploadStream('encoded.mp4', source, { abortSignal: controller.signal }),
      ).rejects.toThrow();
      expect(source.destroyed).toBe(true);
      expect(requests).toHaveLength(0);
      expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
    } finally {
      source.destroy();
    }
  });
});

describe('bounded source downloads', () => {
  const bytes = Buffer.alloc(64 * 1024, 0x42);
  const options = { maxBytes: bytes.length, timeoutMs: 5_000 };

  function interrupt(response: ServerResponse): void {
    response.writeHead(200, { 'content-length': bytes.length });
    response.flushHeaders();
    response.write(bytes.subarray(0, 1024));
    const timer = setTimeout(() => response.destroy(), 20);
    response.once('close', () => clearTimeout(timer));
  }

  it('restarts an interrupted body from byte zero and returns the exact complete source', async () => {
    handler = (_request, response) => {
      if (requests.length === 1) return interrupt(response);
      response.writeHead(200, { 'content-length': bytes.length });
      response.end(bytes);
    };
    const destination = join(directory, 'source');
    await service.downloadFile('original', destination, options);
    expect(requests).toHaveLength(2);
    expect(requests.every((request) => request.method === 'GET')).toBe(true);
    expect(await readFile(destination)).toEqual(bytes);
  });

  it('bounds interrupted-body attempts and removes the partial source on exhaustion', async () => {
    handler = (_request, response) => interrupt(response);
    const destination = join(directory, 'source');
    await expect(service.downloadFile('original', destination, options)).rejects.toThrow();
    expect(requests).toHaveLength(2);
    await expect(readFile(destination)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each([true, false])(
    'rejects oversized sources without retry (Content-Length=%s)',
    async (declared) => {
      handler = (_request, response) => {
        if (declared) response.setHeader('content-length', bytes.length);
        else response.setHeader('transfer-encoding', 'chunked');
        response.end(bytes);
      };
      const destination = join(directory, 'source');
      await expect(
        service.downloadFile('original', destination, { ...options, maxBytes: 1024 }),
      ).rejects.toThrow();
      expect(requests).toHaveLength(1);
      await expect(readFile(destination)).rejects.toMatchObject({ code: 'ENOENT' });
    },
  );

  it('expires one deadline for a stalled body and removes its partial source', async () => {
    handler = (_request, response) => {
      response.writeHead(200, { 'content-length': bytes.length });
      response.write(bytes.subarray(0, 1024));
    };
    const destination = join(directory, 'source');
    await expect(
      service.downloadFile('original', destination, { ...options, timeoutMs: 1_000 }),
    ).rejects.toThrow();
    expect(requests).toHaveLength(1);
    await expect(readFile(destination)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('cancels an in-flight body without retry and cleans up the partial source', async () => {
    const controller = new AbortController();
    handler = (_request, response) => {
      response.writeHead(200, { 'content-length': bytes.length });
      response.write(bytes.subarray(0, 1024));
      const timer = setTimeout(() => controller.abort(), 20);
      response.once('close', () => clearTimeout(timer));
    };
    const destination = join(directory, 'source');
    await expect(
      service.downloadFile('original', destination, { ...options, abortSignal: controller.signal }),
    ).rejects.toThrow();
    expect(requests).toHaveLength(1);
    await expect(readFile(destination)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('does not retry a denied GET or leave a destination behind', async () => {
    handler = (_request, response) => s3Error(response, 403, 'AccessDenied');
    const destination = join(directory, 'source');
    await expect(service.downloadFile('original', destination, options)).rejects.toThrow(
      /AccessDenied|Injected transport failure/,
    );
    expect(requests).toHaveLength(1);
    await expect(readFile(destination)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

it('stops a source when another writer consumes disk headroom and removes the partial file', async () => {
  const actualSpace = await fsPromises.statfs(directory);
  const space = jest.spyOn(fsPromises, 'statfs');
  space
    .mockResolvedValueOnce(actualSpace)
    .mockResolvedValueOnce(actualSpace)
    .mockResolvedValue({ ...actualSpace, bavail: 0 });
  const source = Buffer.alloc(3 * 1024 * 1024, 0x42);
  handler = (_request, response) => response.end(source);
  const destination = join(directory, 'source');
  await expect(
    service.downloadFile('original', destination, {
      maxBytes: source.length,
      timeoutMs: 5000,
      minFreeBytes: 2 * 1024 ** 3,
    }),
  ).rejects.toMatchObject({ cause: { code: 'ENOSPC' } });
  expect(space).toHaveBeenCalledTimes(3);
  expect(requests).toHaveLength(1);
  await expect(readFile(destination)).rejects.toMatchObject({ code: 'ENOENT' });
});

it('refuses acquisition before GET when shared disk already lacks headroom', async () => {
  const actualSpace = await fsPromises.statfs(directory);
  jest.spyOn(fsPromises, 'statfs').mockResolvedValue({ ...actualSpace, bavail: 0 });
  const destination = join(directory, 'source');
  await expect(
    service.downloadFile('original', destination, {
      maxBytes: 1024,
      timeoutMs: 5000,
      minFreeBytes: 2 * 1024 ** 3,
    }),
  ).rejects.toMatchObject({ cause: { code: 'ENOSPC' } });
  expect(requests).toHaveLength(0);
  await expect(readFile(destination)).rejects.toMatchObject({ code: 'ENOENT' });
});
