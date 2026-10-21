/**
 * Oxy Files moves from S3 to R2 (ADR 0047). While it does, R2 is the store and
 * the S3 bucket is the LEGACY store: never written, but a delete must reach it
 * too (R2's on-read migration would copy the object back), a listing must
 * include it, and a copy whose source is still only there takes it from there.
 */

jest.mock('../../utils/logger', () => ({
  logger: { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

// The multipart manager needs a real client's endpoint resolution; here it is
// one PutObject through the fake bucket, which is what it does for a small body.
jest.mock('@aws-sdk/lib-storage', () => {
  const { PutObjectCommand } = jest.requireActual('@aws-sdk/client-s3');
  return {
    Upload: class {
      constructor(
        private readonly options: {
          client: { send: (c: unknown) => Promise<unknown> };
          params: Record<string, unknown>;
        },
      ) {}
      done() {
        return this.options.client.send(new PutObjectCommand(this.options.params));
      }
    },
  };
});

import { Readable } from 'node:stream';
import { S3Service } from '../s3Service';
import { objectStorageConfigFromEnv } from '../s3ServiceSingleton';

type Sent = { name: string; input: Record<string, unknown> };

/** An in-memory bucket answering the S3 commands S3Service sends. */
function fakeBucket(
  objects: Record<string, { body: string; contentType?: string; cacheControl?: string }>,
) {
  const sent: Sent[] = [];
  const notFound = () =>
    Object.assign(new Error('NoSuchKey'), {
      name: 'NoSuchKey',
      $metadata: { httpStatusCode: 404 },
    });
  const send = jest.fn(
    async (command: { constructor: { name: string }; input: Record<string, unknown> }) => {
      const name = command.constructor.name;
      const input = command.input;
      sent.push({ name, input });
      const key = input.Key as string;
      switch (name) {
        case 'DeleteObjectCommand':
          delete objects[key];
          return {};
        case 'ListObjectsV2Command': {
          const prefix = (input.Prefix as string) ?? '';
          const keys = Object.keys(objects)
            .filter((k) => k.startsWith(prefix))
            .sort();
          return {
            Contents: keys
              .slice(0, (input.MaxKeys as number) ?? 1000)
              .map((Key) => ({ Key, Size: objects[Key]!.body.length, LastModified: new Date(0) })),
          };
        }
        case 'CopyObjectCommand': {
          const source = (input.CopySource as string).split('/').slice(1).join('/');
          if (!objects[source]) throw notFound();
          objects[key] = { ...objects[source]! };
          return {};
        }
        case 'GetObjectCommand': {
          const object = objects[key];
          if (!object) throw notFound();
          return {
            Body: Readable.from([Buffer.from(object.body)]),
            ContentType: object.contentType,
            CacheControl: object.cacheControl,
            Metadata: {},
          };
        }
        case 'PutObjectCommand': {
          const body = input.Body as Buffer | Readable;
          const chunks: Buffer[] = [];
          if (Buffer.isBuffer(body)) chunks.push(body);
          else for await (const chunk of body) chunks.push(Buffer.from(chunk));
          objects[key] = {
            body: Buffer.concat(chunks).toString(),
            contentType: input.ContentType as string,
            cacheControl: input.CacheControl as string,
          };
          return { ETag: '"e"' };
        }
        default:
          throw new Error(`unexpected ${name}`);
      }
    },
  );
  return { send, sent, objects };
}

function storeOver(
  bucket: ReturnType<typeof fakeBucket>,
  config: { bucketName: string; legacy?: S3Service },
  listener?: { enqueueDeletedKey: jest.Mock },
) {
  const service = new S3Service(
    {
      region: 'auto',
      bucketName: config.bucketName,
      accessKeyId: 'k',
      secretAccessKey: 's',
      endpointUrl: 'https://acct.r2.cloudflarestorage.com',
    },
    listener,
    config.legacy,
  );
  (service as unknown as { s3Client: unknown }).s3Client = { send: bucket.send };
  return service;
}

describe('the legacy store while Oxy Files migrates to R2', () => {
  it('a delete removes the object from BOTH stores, then tells the CDN once', async () => {
    const s3 = fakeBucket({ 'public/content/a.png': { body: 'a' } });
    const r2 = fakeBucket({ 'public/content/a.png': { body: 'a' } });
    const listener = { enqueueDeletedKey: jest.fn() };
    const legacy = storeOver(s3, { bucketName: 'old' });
    const store = storeOver(r2, { bucketName: 'oxy-files', legacy }, listener);

    await store.deleteFile('public/content/a.png');

    expect(r2.objects).toEqual({});
    expect(s3.objects).toEqual({});
    expect(listener.enqueueDeletedKey).toHaveBeenCalledTimes(1);
  });

  it('a delete that fails in the legacy store fails, so the caller retries it', async () => {
    const s3 = fakeBucket({});
    s3.send.mockRejectedValueOnce(new Error('AccessDenied'));
    const r2 = fakeBucket({ k: { body: 'x' } });
    const listener = { enqueueDeletedKey: jest.fn() };
    const store = storeOver(
      r2,
      { bucketName: 'oxy-files', legacy: storeOver(s3, { bucketName: 'old' }) },
      listener,
    );
    await expect(store.deleteFile('k')).rejects.toThrow(/AccessDenied/);
    expect(listener.enqueueDeletedKey).not.toHaveBeenCalled();
  });

  it('a listing includes what only the legacy store holds, once', async () => {
    const s3 = fakeBucket({
      'variants/x/thumb.webp': { body: '1' },
      'variants/x/w320.webp': { body: '2' },
    });
    const r2 = fakeBucket({
      'variants/x/thumb.webp': { body: '1' },
      'variants/x/hls/master.m3u8': { body: '3' },
    });
    const store = storeOver(r2, {
      bucketName: 'oxy-files',
      legacy: storeOver(s3, { bucketName: 'old' }),
    });
    const keys = (await store.listFiles('variants/x/')).map((item) => item.key).sort();
    expect(keys).toEqual([
      'variants/x/hls/master.m3u8',
      'variants/x/thumb.webp',
      'variants/x/w320.webp',
    ]);
  });

  it('a copy whose source is not migrated yet takes it from the legacy store, keeping its headers', async () => {
    const s3 = fakeBucket({
      'content/a.png': {
        body: 'bytes',
        contentType: 'image/png',
        cacheControl: 'public, max-age=31536000, immutable',
      },
    });
    const r2 = fakeBucket({});
    const store = storeOver(r2, {
      bucketName: 'oxy-files',
      legacy: storeOver(s3, { bucketName: 'old' }),
    });

    await store.copyFile('content/a.png', 'public/content/a.png');

    expect(r2.objects['public/content/a.png']).toEqual({
      body: 'bytes',
      contentType: 'image/png',
      cacheControl: 'public, max-age=31536000, immutable',
    });
    expect(r2.objects['content/a.png']?.contentType).toBe('image/png');
    expect(s3.sent.map((call) => call.name)).not.toContain('PutObjectCommand');
  });

  it('a copy of a source neither store holds still fails', async () => {
    const store = storeOver(fakeBucket({}), {
      bucketName: 'oxy-files',
      legacy: storeOver(fakeBucket({}), { bucketName: 'old' }),
    });
    await expect(
      store.copyFile('content/missing.png', 'public/content/missing.png'),
    ).rejects.toThrow(/copy/i);
  });

  it('without a legacy store nothing is mirrored', async () => {
    const r2 = fakeBucket({ k: { body: 'x' } });
    const store = storeOver(r2, { bucketName: 'oxy-files' });
    await store.deleteFile('k');
    await expect(store.copyFile('missing', 'dest')).rejects.toThrow();
    expect(r2.sent.map((call) => call.name)).toEqual(['DeleteObjectCommand', 'CopyObjectCommand']);
  });
});

describe('which store the environment names', () => {
  const R2 = {
    R2_BUCKET: 'oxy-files',
    R2_ENDPOINT: 'https://acct.r2.cloudflarestorage.com',
    R2_ACCESS_KEY_ID: 'id',
    R2_SECRET_ACCESS_KEY: 'secret',
  };

  it('before the cutover: the S3 bucket, with the task role', () => {
    expect(objectStorageConfigFromEnv({ AWS_S3_BUCKET: 'old', AWS_REGION: 'us-west-2' })).toEqual({
      primary: {
        region: 'us-west-2',
        bucketName: 'old',
        accessKeyId: undefined,
        secretAccessKey: undefined,
        endpointUrl: undefined,
      },
    });
  });

  it('during the migration: R2, with the S3 bucket as the legacy store', () => {
    const config = objectStorageConfigFromEnv({
      ...R2,
      AWS_S3_BUCKET: 'old',
      AWS_REGION: 'us-west-2',
    });
    expect(config.primary).toEqual({
      region: 'auto',
      endpointUrl: R2.R2_ENDPOINT,
      bucketName: 'oxy-files',
      accessKeyId: 'id',
      secretAccessKey: 'secret',
    });
    expect(config.legacy).toMatchObject({ bucketName: 'old', region: 'us-west-2' });
    expect(config.legacy?.accessKeyId).toBeUndefined();
  });

  it('after it: R2 alone', () => {
    expect(objectStorageConfigFromEnv({ ...R2 }).legacy).toBeUndefined();
  });

  it('refuses half an R2 configuration rather than writing somewhere else', () => {
    expect(() =>
      objectStorageConfigFromEnv({ R2_BUCKET: 'oxy-files', AWS_S3_BUCKET: 'old' }),
    ).toThrow(/R2_ENDPOINT, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY are not/);
  });

  it('never reads AWS_ENDPOINT_URL or AWS keys for R2 — every AWS client in the process reads those', () => {
    const config = objectStorageConfigFromEnv({
      ...R2,
      AWS_ENDPOINT_URL: 'https://elsewhere',
      AWS_ACCESS_KEY_ID: 'aws',
      AWS_SECRET_ACCESS_KEY: 'aws',
    });
    expect(config.primary.endpointUrl).toBe(R2.R2_ENDPOINT);
    expect(config.primary.accessKeyId).toBe('id');
  });
});
