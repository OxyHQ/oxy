import { S3Service } from '../s3Service';

describe('presigned admitted upload (offline signing)', () => {
  it('binds exact body size, checksum and conditional creation in the real SDK signature', async () => {
    const service = new S3Service({accessKeyId:'synthetic-test',secretAccessKey:'synthetic-test',bucketName:'synthetic-only',region:'us-west-2'});
    const checksum = Buffer.alloc(32).toString('base64');
    const url = new URL(await service.getPresignedUploadUrl('synthetic-object', {
      contentLength:123, ifNoneMatch:'*', checksumSHA256:checksum, expiresIn:60,
    }));
    expect(url.searchParams.get('X-Amz-SignedHeaders')?.split(';')).toEqual(expect.arrayContaining(['content-length','if-none-match']));
    expect(url.searchParams.get('x-amz-checksum-sha256')).toBe(checksum);
    expect(url.searchParams.get('X-Amz-Expires')).toBe('60');
  });
});
