/**
 * Regression: every purely pre-session public SDK endpoint must pass `skipAuth`
 * so a pending refresh handler cannot self-await (see httpServiceAuthSelfAwait).
 */
import { OxyServices } from '../../OxyServices';

describe('pre-session public endpoints use skipAuth', () => {
  let oxy: OxyServices;
  let makeRequest: jest.SpyInstance;

  beforeEach(() => {
    oxy = new OxyServices({ baseURL: 'http://test.invalid' });
    makeRequest = jest.spyOn(oxy, 'request').mockResolvedValue({} as never);
  });

  afterEach(() => jest.restoreAllMocks());

  it('getPublicApplication skips auth preflight', async () => {
    makeRequest.mockResolvedValueOnce({ application: { id: 'app-1', name: 'App' } });
    await oxy.apps.getPublic('oxy_dk_test');
    expect(makeRequest).toHaveBeenCalledWith(
      'GET',
      '/auth/oauth/client/oxy_dk_test',
      undefined,
      expect.objectContaining({ skipAuth: true }),
    );
  });

  it('getUserByPublicKey skips auth preflight', async () => {
    makeRequest.mockResolvedValueOnce({ id: 'u1', username: 'alice' });
    await oxy.users.byPublicKey('abc123');
    expect(makeRequest).toHaveBeenCalledWith(
      'GET',
      '/auth/user/abc123',
      undefined,
      expect.objectContaining({ skipAuth: true }),
    );
  });

});
