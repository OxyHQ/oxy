import { createAwsWorkloadCredentialProvider } from '../index';
import { defaultProvider } from '@aws-sdk/credential-provider-node';
import { fromIni } from '@aws-sdk/credential-provider-ini';
jest.mock('@aws-sdk/credential-provider-node', () => ({ defaultProvider: jest.fn() }));
jest.mock('@aws-sdk/credential-provider-ini', () => ({ fromIni: jest.fn() }));
const factory = defaultProvider as jest.Mock;
const profileFactory = fromIni as jest.Mock;
const temporary = () => ({
  accessKeyId: 'temporary',
  secretAccessKey: 'secret',
  sessionToken: 'proof',
  expiration: new Date(Date.now() + 60_000),
});
beforeEach(() => {
  jest.clearAllMocks();
});
it('uses only the explicitly named profile and returns temporary credentials', async () => {
  profileFactory.mockReturnValue(async () => temporary());
  const credentials = createAwsWorkloadCredentialProvider({ profile: 'oxy-billing' });
  expect(await credentials()).toEqual({
    AccessKeyId: 'temporary',
    SecretAccessKey: 'secret',
    Token: 'proof',
  });
  expect(profileFactory).toHaveBeenCalledWith({ profile: 'oxy-billing' });
  expect(factory).not.toHaveBeenCalled();
});
it('does not fall back to an available ambient workload when a selected profile fails', async () => {
  factory.mockReturnValue(async () => temporary());
  profileFactory.mockReturnValue(async () => {
    throw new Error('Profile unavailable');
  });
  await expect(
    createAwsWorkloadCredentialProvider({ profile: 'missing-billing' })(),
  ).rejects.toThrow('Profile unavailable');
  expect(factory).not.toHaveBeenCalled();
});
it('rejects an empty explicit profile rather than resolving ambient credentials', () => {
  expect(() => createAwsWorkloadCredentialProvider({ profile: ' ' })).toThrow('must not be empty');
  expect(factory).not.toHaveBeenCalled();
  expect(profileFactory).not.toHaveBeenCalled();
});
it('preserves the default temporary role chain when no profile was explicitly selected', async () => {
  factory.mockReturnValue(async () => temporary());
  expect(await createAwsWorkloadCredentialProvider()()).toMatchObject({ Token: 'proof' });
  expect(factory).toHaveBeenCalledWith({});
  expect(profileFactory).not.toHaveBeenCalled();
});
it.each([undefined, 'oxy-billing'])(
  'refuses long-lived IAM user keys and expired credentials (%s)',
  async (profile) => {
    for (const fields of [{}, { sessionToken: 'proof', expiration: new Date(0) }]) {
      const provider = async () => ({ accessKeyId: 'key', secretAccessKey: 'secret', ...fields });
      factory.mockReturnValue(provider);
      profileFactory.mockReturnValue(provider);
      await expect(createAwsWorkloadCredentialProvider({ profile })()).rejects.toThrow(
        'temporary AWS role',
      );
    }
  },
);
