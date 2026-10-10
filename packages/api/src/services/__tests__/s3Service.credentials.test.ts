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

  it('the shared singleton omits credentials when the env carries no AWS keys', () => {
    const saved = { ...process.env };
    delete process.env.AWS_ACCESS_KEY_ID;
    delete process.env.AWS_SECRET_ACCESS_KEY;
    process.env.AWS_S3_BUCKET = 'media-test';
    try {
      jest.isolateModules(() => {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        require('../s3ServiceSingleton');
      });
    } finally {
      process.env = saved;
    }
    expect(s3ClientConfigs).toHaveLength(1);
    expect(s3ClientConfigs[0]).not.toHaveProperty('credentials');
  });
});
