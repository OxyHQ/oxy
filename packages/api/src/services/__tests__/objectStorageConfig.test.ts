/**
 * Oxy Files' store is Cloudflare R2 (ADR 0047), configured by its own names —
 * never AWS_ENDPOINT_URL / AWS_ACCESS_KEY_ID, which every AWS client reads.
 */
import { objectStorageConfigFromEnv } from '../s3ServiceSingleton';

const R2 = {
  R2_BUCKET: 'oxy-files',
  R2_ENDPOINT: 'https://acct.r2.cloudflarestorage.com',
  R2_ACCESS_KEY_ID: 'id',
  R2_SECRET_ACCESS_KEY: 'secret',
};

describe('the object store the environment names', () => {
  it("is the R2 bucket, in R2's one region", () => {
    expect(objectStorageConfigFromEnv(R2)).toEqual({
      region: 'auto',
      endpointUrl: R2.R2_ENDPOINT,
      bucketName: 'oxy-files',
      accessKeyId: 'id',
      secretAccessKey: 'secret',
    });
  });

  it('refuses half a configuration rather than writing somewhere else', () => {
    expect(() => objectStorageConfigFromEnv({ R2_BUCKET: 'oxy-files' })).toThrow(
      /R2_ENDPOINT, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY/,
    );
  });

  it('never reads AWS_ENDPOINT_URL or AWS keys', () => {
    const config = objectStorageConfigFromEnv({
      ...R2,
      AWS_ENDPOINT_URL: 'https://elsewhere',
      AWS_ACCESS_KEY_ID: 'aws',
      AWS_SECRET_ACCESS_KEY: 'aws',
      AWS_S3_BUCKET: 'old',
    });
    expect(config.endpointUrl).toBe(R2.R2_ENDPOINT);
    expect(config.accessKeyId).toBe('id');
    expect(config.bucketName).toBe('oxy-files');
  });
});
