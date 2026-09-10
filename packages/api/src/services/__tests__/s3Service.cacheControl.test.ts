/**
 * Every object we PUT under a content-addressed key must carry a
 * `Cache-Control`, and `S3Service` is the only place that can put one there.
 *
 * This is the gate on the plumbing, and the plumbing is the whole bug: before
 * this, no upload path passed `CacheControl`, so S3 stored the object WITHOUT
 * the header and served it that way through CloudFront. A client that gets no
 * `Cache-Control` falls back to heuristic freshness — a fraction of the
 * object's age — and a rendition minted on demand has `Last-Modified` = now,
 * which makes that fraction ZERO. Every subsequent view then pays a
 * revalidation round trip before it can paint, worst for the newest media.
 *
 * `PutObjectCommand` and `Upload` are the REAL SDK classes here; only the
 * transport (`S3Client.send` / `Upload.done`) is stubbed, so the assertions are
 * against the input the SDK would actually sign, not against a hand-rolled
 * shape that could drift from it.
 */

import { Readable } from 'node:stream';

const sendMock = jest.fn(() => Promise.resolve({}));
const uploadParams: unknown[] = [];

jest.mock('@aws-sdk/client-s3', () => {
  const actual = jest.requireActual('@aws-sdk/client-s3');
  return {
    ...actual,
    S3Client: jest.fn(() => ({ send: sendMock })),
  };
});

jest.mock('@aws-sdk/lib-storage', () => ({
  Upload: jest.fn((options: { params: unknown }) => {
    uploadParams.push(options.params);
    return { done: () => Promise.resolve({}), abort: () => Promise.resolve() };
  }),
}));

import { PutObjectCommand } from '@aws-sdk/client-s3';
import { S3Service } from '../s3Service';
import { IMMUTABLE_ASSET_CACHE_CONTROL } from '../../config/cdn';

function makeService(): S3Service {
  return new S3Service({
    accessKeyId: 'test',
    secretAccessKey: 'test',
    bucketName: 'media-test',
    region: 'us-west-2',
  });
}

/** The input of the single `PutObjectCommand` the service sent. */
function sentPutInput(): Record<string, unknown> {
  expect(sendMock).toHaveBeenCalledTimes(1);
  const command = sendMock.mock.calls[0][0] as unknown;
  expect(command).toBeInstanceOf(PutObjectCommand);
  return (command as PutObjectCommand).input as unknown as Record<string, unknown>;
}

beforeEach(() => {
  sendMock.mockClear();
  uploadParams.length = 0;
});

describe('S3Service — Cache-Control on the stored object', () => {
  it('puts the caller Cache-Control on an uploadBuffer PUT', async () => {
    await makeService().uploadBuffer('public/variants/2026/09/aa/deadbeef/w320.webp', Buffer.from('x'), {
      contentType: 'image/webp',
      cacheControl: IMMUTABLE_ASSET_CACHE_CONTROL,
    });

    expect(sentPutInput()).toMatchObject({
      Key: 'public/variants/2026/09/aa/deadbeef/w320.webp',
      ContentType: 'image/webp',
      CacheControl: 'public, max-age=31536000, immutable',
    });
  });

  it('puts the caller Cache-Control on an uploadFile PUT', async () => {
    await makeService().uploadFile('public/content/2026/09/aa/deadbeef.png', Buffer.from('x'), {
      contentType: 'image/png',
      cacheControl: IMMUTABLE_ASSET_CACHE_CONTROL,
    });

    expect(sentPutInput()).toMatchObject({
      CacheControl: 'public, max-age=31536000, immutable',
    });
  });

  it('puts the caller Cache-Control on the multipart uploadStream params', async () => {
    // The federation media cache streams through this path to a temp key, then
    // promotes it with a server-side `CopyObject` whose default
    // `MetadataDirective: COPY` carries the header onto the content-addressed
    // object. Losing it here loses it on the promoted object too.
    await makeService().uploadStream('cache-tmp/abc', Readable.from([Buffer.from('x')]), {
      contentType: 'image/jpeg',
      cacheControl: IMMUTABLE_ASSET_CACHE_CONTROL,
    });

    expect(uploadParams).toHaveLength(1);
    expect(uploadParams[0]).toMatchObject({
      Key: 'cache-tmp/abc',
      ContentType: 'image/jpeg',
      CacheControl: 'public, max-age=31536000, immutable',
    });
  });

  it('leaves CacheControl undefined when the caller does not ask for one', async () => {
    // Not every object is content-addressed, so the option stays opt-in rather
    // than defaulting to `immutable` for anything that happens to be uploaded.
    await makeService().uploadBuffer('scratch/whatever', Buffer.from('x'), {
      contentType: 'application/octet-stream',
    });

    expect(sentPutInput().CacheControl).toBeUndefined();
  });
});
