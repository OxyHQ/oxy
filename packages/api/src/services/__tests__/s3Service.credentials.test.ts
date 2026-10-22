/**
 * Production runs on the ECS task role: with no static keys in the env the S3
 * client must be built WITHOUT `credentials`, so the SDK's default provider
 * chain resolves the role. Passing empty strings instead would sign every
 * request with an empty key. Local dev still sets both keys explicitly.
 */

const s3ClientConfigs: Record<string, unknown>[] = [];

jest.mock('@aws-sdk/client-s3', () => {
  const actual = jest.requireActual('@aws-sdk/client-s3');
  return {
    ...actual,
    S3Client: jest.fn((config: Record<string, unknown>) => {
      s3ClientConfigs.push(config);
      return { send: jest.fn() };
    }),
  };
});

import { S3Service } from '../s3Service';

const BASE = { bucketName: 'media-test', region: 'us-west-2' };

beforeEach(() => {
  s3ClientConfigs.length = 0;
});

describe('S3Service — credential source', () => {
  it('passes static credentials when both keys are configured', () => {
    new S3Service({ ...BASE, accessKeyId: 'key', secretAccessKey: 'secret' });
    expect(s3ClientConfigs[0]).toMatchObject({
      region: 'us-west-2',
      credentials: { accessKeyId: 'key', secretAccessKey: 'secret' },
    });
  });

  it.each([
    ['no keys', {}],
    ['only an access key id', { accessKeyId: 'key' }],
    ['empty keys', { accessKeyId: '', secretAccessKey: '' }],
  ])('omits credentials with %s, leaving the default provider chain', (_label, keys) => {
    new S3Service({ ...BASE, ...keys });
    expect(s3ClientConfigs[0]).toMatchObject({ region: 'us-west-2' });
    expect(s3ClientConfigs[0]).not.toHaveProperty('credentials');
  });

  it("the shared singleton signs with R2's bucket token, never the AWS keys in the env", () => {
    const saved = { ...process.env };
    process.env.AWS_ACCESS_KEY_ID = 'aws-key';
    process.env.AWS_SECRET_ACCESS_KEY = 'aws-secret';
    process.env.R2_BUCKET = 'oxy-files';
    process.env.R2_ENDPOINT = 'https://acct.r2.cloudflarestorage.com';
    process.env.R2_ACCESS_KEY_ID = 'r2-id';
    process.env.R2_SECRET_ACCESS_KEY = 'r2-secret';
    try {
      jest.isolateModules(() => {
        // biome-ignore lint/style/noCommonJs: required inside jest.isolateModules to get a fresh module registry
        require('../s3ServiceSingleton');
      });
    } finally {
      process.env = saved;
    }
    expect(s3ClientConfigs).toHaveLength(1);
    expect(s3ClientConfigs[0]).toMatchObject({
      region: 'auto',
      endpoint: 'https://acct.r2.cloudflarestorage.com',
      credentials: { accessKeyId: 'r2-id', secretAccessKey: 'r2-secret' },
    });
  });
});
