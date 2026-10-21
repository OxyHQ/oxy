/**
 * A browser PUTs a large upload's parts to the URL `getPresignedUploadPartUrl`
 * signs, and every Oxy page's CSP admits exactly one storage host in
 * `connect-src`: core's `OXY_FILES_UPLOAD_ORIGIN`. Sign a real part URL with
 * production's endpoint and bucket (oxy-infra `r2.tf`, runbook 61) and require
 * the two to agree. Without this, the API's addressing style (virtual-hosted,
 * bucket first) and the CSP drifted once already: core 6.9.2 named the bare
 * account host, which no URL the API signs ever uses.
 */
import { OXY_FILES_UPLOAD_ORIGIN } from '@oxy.so/core/server';
import { S3Service } from '../s3Service';

const PRODUCTION_R2_ENDPOINT = 'https://fa4392797e57d4e63ceaaf7b1dc687ed.r2.cloudflarestorage.com';
const PRODUCTION_R2_BUCKET = 'oxy-files';

describe('the presigned upload host every Oxy page must allow', () => {
  it('is the origin of the part URLs the API signs in production', async () => {
    const storage = new S3Service({
      bucketName: PRODUCTION_R2_BUCKET,
      region: 'auto',
      endpointUrl: PRODUCTION_R2_ENDPOINT,
      accessKeyId: 'test-key',
      secretAccessKey: 'test-secret',
    });
    const url = await storage.getPresignedUploadPartUrl('staging/abc', 'upload-1', 1, {
      expiresIn: 600,
      contentLength: 8 * 1024 * 1024,
    });
    expect(new URL(url).origin).toBe(OXY_FILES_UPLOAD_ORIGIN);
  });

  it('is the origin of the single presigned PUT too', async () => {
    const storage = new S3Service({
      bucketName: PRODUCTION_R2_BUCKET,
      region: 'auto',
      endpointUrl: PRODUCTION_R2_ENDPOINT,
      accessKeyId: 'test-key',
      secretAccessKey: 'test-secret',
    });
    const url = await storage.getPresignedUploadUrl('staging/abc', { contentType: 'video/mp4' });
    expect(new URL(url).origin).toBe(OXY_FILES_UPLOAD_ORIGIN);
  });
});
