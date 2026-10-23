import { createAwsWorkloadCredentialProvider } from '../index';
import { defaultProvider } from '@aws-sdk/credential-provider-node';
jest.mock('@aws-sdk/credential-provider-node', () => ({ defaultProvider: jest.fn() }));
const factory = defaultProvider as jest.Mock;
it('uses a temporary assumed role from the standard credential chain', async () => {
  factory.mockReturnValue(async () => ({
    accessKeyId: 'temporary',
    secretAccessKey: 'secret',
    sessionToken: 'proof',
    expiration: new Date(Date.now() + 60_000),
  }));
  const credentials = createAwsWorkloadCredentialProvider({ profile: 'oxy-development' });
  expect(await credentials()).toEqual({
    AccessKeyId: 'temporary',
    SecretAccessKey: 'secret',
    Token: 'proof',
  });
  expect(factory).toHaveBeenCalledWith({ profile: 'oxy-development' });
});
it('refuses long-lived IAM user keys and expired role credentials', async () => {
  for (const fields of [{}, { sessionToken: 'proof', expiration: new Date(0) }]) {
    factory.mockReturnValue(async () => ({
      accessKeyId: 'key',
      secretAccessKey: 'secret',
      ...fields,
    }));
    await expect(createAwsWorkloadCredentialProvider()()).rejects.toThrow('temporary AWS role');
  }
});
