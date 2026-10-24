import { seedPublicClientCredential } from '../seedPublicClientCredential';

describe('own application public sign-in client', () => {
  it('creates a public production identifier without internal permission scopes', () => {
    expect(
      seedPublicClientCredential({
        applicationId: 'native-authenticator',
        publicKey: 'oxy_dk_fixture',
        createdByUserId: 'oxy',
      }),
    ).toEqual({
      applicationId: 'native-authenticator',
      publicKey: 'oxy_dk_fixture',
      createdByUserId: 'oxy',
      name: 'Production',
      type: 'public',
      environment: 'production',
      secretHash: null,
      status: 'active',
      scopes: [],
    });
  });
});
