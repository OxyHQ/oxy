/**
 * The multipart surface of `S3Service` (ADR 0041 stage 4b), against the REAL
 * SDK command classes with only `S3Client.send` stubbed:
 *
 *  - a multipart upload is opened with the SERVER's Content-Type, disposition
 *    and Cache-Control;
 *  - a part URL signs the part's exact Content-Length;
 *  - `listParts` follows pagination and answers `null` for an upload S3 forgot;
 *  - `copyFile` copies an object over 5 GiB by `UploadPartCopy` ranges that
 *    cover it exactly, keeping its headers — whether the caller knew the size
 *    or S3 refused the single copy — and aborts what it started on failure.
 */

const sendMock = jest.fn();

jest.mock('@aws-sdk/client-s3', () => {
  const actual = jest.requireActual('@aws-sdk/client-s3');
  return { ...actual, S3Client: jest.fn(() => ({ send: sendMock })) };
});

const signed: { command: unknown; options: unknown }[] = [];
jest.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: jest.fn(async (_client: unknown, command: unknown, options: unknown) => {
    signed.push({ command, options });
    return 'https://signed.example/part';
  }),
}));

import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CopyObjectCommand,
  CreateMultipartUploadCommand,
  HeadObjectCommand,
  ListPartsCommand,
  UploadPartCommand,
  UploadPartCopyCommand,
} from '@aws-sdk/client-s3';
import { S3Service, SINGLE_COPY_MAX_BYTES } from '../s3Service';

const GiB = 1024 ** 3;

function makeService(): S3Service {
  return new S3Service({ bucketName: 'media-test', region: 'us-west-2' });
}

function sent<T>(type: new (...args: never[]) => T): T[] {
  return sendMock.mock.calls.map(([command]) => command).filter((c) => c instanceof type) as T[];
}

beforeEach(() => {
  sendMock.mockReset();
  signed.length = 0;
});

describe('multipart uploads', () => {
  it('opens with the headers the server chose', async () => {
    sendMock.mockResolvedValueOnce({ UploadId: 'u-1' });
    const id = await makeService().createMultipartUpload('content/a.zip', {
      contentType: 'application/zip',
      contentDisposition: 'attachment',
      cacheControl: 'public, max-age=31536000, immutable',
    });
    expect(id).toBe('u-1');
    expect(sent(CreateMultipartUploadCommand)[0].input).toMatchObject({
      Key: 'content/a.zip',
      ContentType: 'application/zip',
      ContentDisposition: 'attachment',
      CacheControl: 'public, max-age=31536000, immutable',
    });
  });

  it('signs a part URL for exactly one part size', async () => {
    await makeService().getPresignedUploadPartUrl('content/a.zip', 'u-1', 3, {
      expiresIn: 3600,
      contentLength: 8 * 1024 * 1024,
    });
    const [{ command, options }] = signed;
    expect(command).toBeInstanceOf(UploadPartCommand);
    expect((command as UploadPartCommand).input).toMatchObject({
      UploadId: 'u-1',
      PartNumber: 3,
      ContentLength: 8 * 1024 * 1024,
    });
    expect(
      (options as { signableHeaders: Set<string> }).signableHeaders.has('content-length'),
    ).toBe(true);
  });

  it('lists every page of parts, and null for an upload S3 no longer has', async () => {
    sendMock
      .mockResolvedValueOnce({
        Parts: [{ PartNumber: 2, Size: 5, ETag: '"b"' }],
        IsTruncated: true,
        NextPartNumberMarker: '2',
      })
      .mockResolvedValueOnce({
        Parts: [{ PartNumber: 1, Size: 9, ETag: '"a"' }],
        IsTruncated: false,
      });
    expect(await makeService().listParts('k', 'u')).toEqual([
      { partNumber: 1, size: 9, etag: '"a"' },
      { partNumber: 2, size: 5, etag: '"b"' },
    ]);
    expect(sent(ListPartsCommand)[1].input.PartNumberMarker).toBe('2');

    sendMock.mockRejectedValueOnce(Object.assign(new Error('gone'), { name: 'NoSuchUpload' }));
    expect(await makeService().listParts('k', 'u')).toBeNull();
  });

  it('treats aborting a vanished upload as done', async () => {
    sendMock.mockRejectedValueOnce(Object.assign(new Error('gone'), { name: 'NoSuchUpload' }));
    await expect(makeService().abortMultipartUpload('k', 'u')).resolves.toBeUndefined();
  });
});

describe('copying an object larger than one CopyObject', () => {
  function answerLargeCopy(size: number) {
    sendMock.mockImplementation(async (command: unknown) => {
      if (command instanceof HeadObjectCommand) {
        return {
          ContentLength: size,
          ContentType: 'video/mp4',
          ContentDisposition: 'inline',
          CacheControl: 'immutable',
        };
      }
      if (command instanceof CreateMultipartUploadCommand) return { UploadId: 'copy-1' };
      if (command instanceof UploadPartCopyCommand) {
        return { CopyPartResult: { ETag: `"p${command.input.PartNumber}"` } };
      }
      return {};
    });
  }

  function expectRangesCover(size: number) {
    const ranges = sent(UploadPartCopyCommand).map((command) => {
      const [, start, end] = /bytes=(\d+)-(\d+)/.exec(String(command.input.CopySourceRange)) ?? [];
      return { part: command.input.PartNumber as number, start: Number(start), end: Number(end) };
    });
    ranges.sort((a, b) => a.part - b.part);
    expect(ranges[0].start).toBe(0);
    for (let i = 1; i < ranges.length; i++) expect(ranges[i].start).toBe(ranges[i - 1].end + 1);
    expect(ranges.at(-1)?.end).toBe(size - 1);
    const complete = sent(CompleteMultipartUploadCommand)[0].input;
    expect(complete.MultipartUpload?.Parts?.map((part) => part.PartNumber)).toEqual(
      ranges.map((range) => range.part),
    );
  }

  it('copies by part ranges when the size is known, keeping the headers', async () => {
    const size = 6 * GiB + 123;
    answerLargeCopy(size);
    await makeService().copyFile('content/big.mp4', 'public/content/big.mp4', { sizeHint: size });
    expect(sent(CopyObjectCommand)).toHaveLength(0);
    expect(sent(CreateMultipartUploadCommand)[0].input).toMatchObject({
      Key: 'public/content/big.mp4',
      ContentType: 'video/mp4',
      ContentDisposition: 'inline',
      CacheControl: 'immutable',
    });
    expectRangesCover(size);
  });

  it('falls back to part ranges when S3 refuses the single copy as too large', async () => {
    const size = SINGLE_COPY_MAX_BYTES + 1;
    answerLargeCopy(size);
    const base = sendMock.getMockImplementation();
    sendMock.mockImplementation(async (command: unknown) => {
      if (command instanceof CopyObjectCommand) {
        throw Object.assign(
          new Error(
            'The specified copy source is larger than the maximum allowable size for a copy source: 5368709120',
          ),
          { name: 'InvalidRequest' },
        );
      }
      return base?.(command);
    });
    await makeService().copyFile('a', 'b');
    expectRangesCover(size);
  });

  it('aborts the destination upload when a part fails', async () => {
    const size = 6 * GiB;
    answerLargeCopy(size);
    const base = sendMock.getMockImplementation();
    sendMock.mockImplementation(async (command: unknown) => {
      if (command instanceof UploadPartCopyCommand && command.input.PartNumber === 2) {
        throw new Error('boom');
      }
      return base?.(command);
    });
    await expect(makeService().copyFile('a', 'b', { sizeHint: size })).rejects.toThrow(/boom/);
    expect(sent(AbortMultipartUploadCommand)[0].input).toMatchObject({
      Key: 'b',
      UploadId: 'copy-1',
    });
    expect(sent(CompleteMultipartUploadCommand)).toHaveLength(0);
  });

  it('copies a small object in one request', async () => {
    sendMock.mockResolvedValue({});
    await makeService().copyFile('a', 'b', { sizeHint: GiB });
    expect(sent(CopyObjectCommand)).toHaveLength(1);
    expect(sent(UploadPartCopyCommand)).toHaveLength(0);
  });
});
