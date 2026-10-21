import { S3Service } from '../s3Service';

describe('presigned admitted upload (offline signing)', () => {
  it.each([
    ['S3', { region: 'us-west-2' }],
    ['R2', { region: 'auto', endpointUrl: 'https://0123456789abcdef.r2.cloudflarestorage.com' }],
  ])(
    'binds exact body size, checksum and conditional creation in the real SDK signature (%s)',
    async (_store, target) => {
      const service = new S3Service({
        accessKeyId: 'synthetic-test',
        secretAccessKey: 'synthetic-test',
        bucketName: 'synthetic-only',
        ...target,
      });
      const checksum = Buffer.alloc(32).toString('base64');
      const url = new URL(
        await service.getPresignedUploadUrl('synthetic-object', {
          contentLength: 123,
          ifNoneMatch: '*',
          checksumSHA256: checksum,
          expiresIn: 60,
        }),
      );
      expect(url.searchParams.get('X-Amz-SignedHeaders')?.split(';')).toEqual(
        expect.arrayContaining(['content-length', 'if-none-match', 'x-amz-checksum-sha256']),
      );
      // The checksum is a SIGNED HEADER the uploader sends. R2 ignores a
      // query-string checksum and stores bytes that do not hash to it, while a
      // signed header that does not match is refused (400 BadDigest) — measured
      // against R2 for ADR 0047.
      expect(url.searchParams.get('x-amz-checksum-sha256')).toBeNull();
      // Nothing else is checksummed: the SDK's default would add a CRC32 of the
      // EMPTY body the URL was signed with, which a checking store must refuse.
      expect(url.searchParams.get('x-amz-checksum-crc32')).toBeNull();
      expect(url.searchParams.get('x-amz-sdk-checksum-algorithm')).toBeNull();
      expect(url.searchParams.get('X-Amz-Expires')).toBe('60');
    },
  );
});
