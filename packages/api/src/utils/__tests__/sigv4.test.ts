/**
 * SigV4 verification and aws-chunked decoding for the recording ingest (ADR
 * 0043 stage 4c), against requests the REAL `@aws-sdk/client-s3` signs: the
 * SDK's request handler is replaced by one that captures the signed request,
 * so nothing is sent anywhere.
 */

import { Readable, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { parseSigV4Authorization, SigV4Error, verifySigV4, type SigV4Request } from '../sigv4';
import { AwsChunkedDecoder } from '../awsChunked';

const SECRET = 'a-recording-target-secret-of-forty-chars-';

interface Captured {
  method: string;
  path: string;
  query: Record<string, string | string[] | null>;
  headers: Record<string, string>;
}

async function signedPut(options: { at?: Date; secret?: string } = {}): Promise<SigV4Request> {
  let captured: Captured | undefined;
  const client = new S3Client({
    endpoint: 'https://api.oxy.so/assets/recording-ingest',
    region: 'us-east-1',
    forcePathStyle: true,
    credentials: { accessKeyId: 'target-1', secretAccessKey: options.secret ?? SECRET },
    requestChecksumCalculation: 'WHEN_REQUIRED',
    systemClockOffset: options.at ? options.at.getTime() - Date.now() : 0,
    requestHandler: {
      handle: async (request: Captured) => {
        captured = request;
        throw new Error('captured');
      },
    } as never,
  });
  await client
    .send(
      new PutObjectCommand({
        Bucket: 'oxy-recordings',
        Key: 'target-1/recording.ogg',
        Body: Buffer.from('hello'),
        ContentType: 'audio/ogg',
      }),
    )
    .catch(() => undefined);
  if (!captured) throw new Error('nothing captured');
  const query = new URLSearchParams(
    Object.entries(captured.query ?? {}).flatMap(([key, value]) =>
      value === null
        ? [[key, '']]
        : Array.isArray(value)
          ? value.map((v) => [key, v])
          : [[key, value]],
    ),
  ).toString();
  return {
    method: captured.method,
    rawUrl: `${captured.path}${query ? `?${query}` : ''}`,
    headers: Object.fromEntries(
      Object.entries(captured.headers).map(([name, value]) => [name.toLowerCase(), value]),
    ),
  };
}

function verify(request: SigV4Request, secret = SECRET, now = new Date()) {
  const auth = parseSigV4Authorization(request.headers.authorization as string);
  return verifySigV4(request, auth, secret, now);
}

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    if (error instanceof SigV4Error) return error.code;
    throw error;
  }
  return 'accepted';
}

describe('verifySigV4 against the AWS SDK', () => {
  it('accepts what the SDK signed, and names the access key and payload hash', async () => {
    const request = await signedPut();
    expect(request.rawUrl.split('?')[0]).toBe(
      '/assets/recording-ingest/oxy-recordings/target-1/recording.ogg',
    );
    expect(parseSigV4Authorization(request.headers.authorization as string)).toMatchObject({
      accessKeyId: 'target-1',
      region: 'us-east-1',
      service: 's3',
    });
    expect(verify(request).payloadHash).toMatch(/^[0-9a-f]{64}$|^UNSIGNED-PAYLOAD$/);
  });

  it('refuses another secret, a changed path or header, and a stale request', async () => {
    const request = await signedPut();
    expect(codeOf(() => verify(request, 'another-secret'))).toBe('SignatureDoesNotMatch');
    expect(
      codeOf(() =>
        verify({ ...request, rawUrl: request.rawUrl.replace('target-1/', 'target-2/') }),
      ),
    ).toBe('SignatureDoesNotMatch');
    expect(
      codeOf(() =>
        verify({ ...request, headers: { ...request.headers, 'content-type': 'video/mp4' } }),
      ),
    ).toBe('SignatureDoesNotMatch');
    expect(codeOf(() => verify(request, SECRET, new Date(Date.now() + 20 * 60 * 1000)))).toBe(
      'RequestTimeTooSkewed',
    );
  });

  it('refuses an unsigned request, a malformed header and signed streaming payloads', async () => {
    expect(codeOf(() => parseSigV4Authorization(undefined))).toBe('MissingSecurityHeader');
    expect(codeOf(() => parseSigV4Authorization('AWS4-HMAC-SHA256 Credential=x'))).toBe(
      'AuthorizationHeaderMalformed',
    );
    const request = await signedPut();
    expect(
      codeOf(() =>
        verify({
          ...request,
          headers: {
            ...request.headers,
            'x-amz-content-sha256': 'STREAMING-AWS4-HMAC-SHA256-PAYLOAD',
          },
        }),
      ),
    ).toBe('NotImplemented');
  });
});

async function decode(
  chunks: string[],
): Promise<{ body: string; trailers: Record<string, string> }> {
  const decoder = new AwsChunkedDecoder();
  const parts: Buffer[] = [];
  await pipeline(
    Readable.from(chunks.map((chunk) => Buffer.from(chunk, 'latin1'))),
    decoder,
    new Writable({
      write(chunk: Buffer, _encoding, callback) {
        parts.push(Buffer.from(chunk));
        callback();
      },
    }),
  );
  return { body: Buffer.concat(parts).toString('latin1'), trailers: decoder.trailers };
}

describe('AwsChunkedDecoder', () => {
  it('yields the payload and collects the trailing checksum, across chunk boundaries', async () => {
    const decoded = await decode([
      '5\r\nhel',
      'lo\r\n3\r',
      '\n wo\r\n0\r\nx-amz-checksum-crc32:AAAA\r\n\r\n',
    ]);
    expect(decoded).toEqual({ body: 'hello wo', trailers: { 'x-amz-checksum-crc32': 'AAAA' } });
  });

  it('refuses signed chunks and a body that ends early', async () => {
    await expect(decode(['5;chunk-signature=abc\r\nhello\r\n0\r\n\r\n'])).rejects.toThrow(/Signed/);
    await expect(decode(['5\r\nhel'])).rejects.toThrow(/ended early/);
  });
});
