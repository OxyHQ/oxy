/**
 * `auth.registerKey` sends the account's username with the key: the server
 * writes both in one insert, so an account never exists without a username.
 */
import { OxyServices } from '../../OxyServices';

jest.mock('../../crypto/internal', () => ({
  ...jest.requireActual('../../crypto/internal'),
  solveRegistrationPow: jest.fn(async () => 'nonce-1'),
}));

describe('auth.registerKey', () => {
  afterEach(() => jest.restoreAllMocks());

  it('posts the username with the key, signature, timestamp and proof-of-work', async () => {
    const oxy = new OxyServices({ baseURL: 'http://test.invalid' });
    const request = jest
      .spyOn(oxy, 'request')
      .mockResolvedValue({ message: 'Identity registered successfully', user: { id: 'u1' } } as never);

    const res = await oxy.auth.registerKey('pub-1', 'sig-1', 1_700_000_000_000, 'alice');

    expect(res.user).toEqual({ id: 'u1' });
    expect(request).toHaveBeenCalledWith(
      'POST',
      '/auth/register',
      { publicKey: 'pub-1', signature: 'sig-1', timestamp: 1_700_000_000_000, username: 'alice', powNonce: 'nonce-1' },
      expect.objectContaining({ skipAuth: true, cache: false }),
    );
  });
});
