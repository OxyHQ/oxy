import { createAwsWorkloadCredentialProvider } from '../index';
jest.mock('@aws-sdk/credential-provider-ini', () => {
  throw new Error('Profile peer is unavailable');
});
jest.mock('@aws-sdk/credential-provider-node', () => ({
  defaultProvider: () => async () => ({
    accessKeyId: 'temporary',
    secretAccessKey: 'secret',
    sessionToken: 'proof',
    expiration: new Date(Date.now() + 60_000),
  }),
}));
it('resolves ambient credentials without loading the optional profile peer', async () => {
  await expect(createAwsWorkloadCredentialProvider()()).resolves.toMatchObject({ Token: 'proof' });
});
it('fails without ambient fallback if the explicit profile peer cannot load', async () => {
  await expect(createAwsWorkloadCredentialProvider({ profile: 'billing' })()).rejects.toThrow(
    'Profile peer is unavailable',
  );
});
