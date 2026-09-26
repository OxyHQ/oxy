/**
 * `OxyServer`'s service lane and the service-only namespace methods.
 *
 * Every one of them must go out with THIS service's token — never the user
 * bearer a client might also hold — and `actAs` is the only way a user id rides
 * along (`X-Oxy-User-Id`).
 */
import { OxyServer } from '../OxyServer';
import { OxyServices } from '../../OxyServices';

function server(): OxyServer {
  const oxy = new OxyServer({ baseURL: 'http://test.invalid', serviceAuth: { apiKey: 'oxy_dk_test', apiSecret: 'secret' } });
  jest.spyOn(oxy, 'serviceToken').mockResolvedValue('svc-token');
  return oxy;
}

function captureRequest(oxy: OxyServer, result: unknown) {
  return jest.spyOn(oxy, 'request').mockResolvedValue(result as never);
}

describe('OxyServer service lane', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('is available with a key pair and absent on a plain client', () => {
    const plain = new OxyServices({ baseURL: 'http://test.invalid' });
    expect(Reflect.get(plain, 'context').service).toBeNull();

    const withKeys = new OxyServer({ baseURL: 'http://test.invalid', serviceAuth: { apiKey: 'k', apiSecret: 's' } });
    expect(Reflect.get(withKeys, 'context').service.available).toBe(true);
  });

  it('is unavailable with no key pair and no workload identity', () => {
    const saved = { ...process.env };
    Reflect.deleteProperty(process.env, 'AWS_CONTAINER_CREDENTIALS_RELATIVE_URI');
    Reflect.deleteProperty(process.env, 'AWS_CONTAINER_CREDENTIALS_FULL_URI');
    try {
      const bare = new OxyServer({ baseURL: 'http://test.invalid' });
      expect(Reflect.get(bare, 'context').service.available).toBe(false);
    } finally {
      process.env = saved;
    }
  });

  it('sends the service token, and a user id only through actAs', async () => {
    const oxy = server();
    const request = captureRequest(oxy, { ok: true });

    await oxy.serviceRequest('GET', '/thing', { q: 1 }, { actAs: 'user-1' });

    expect(request).toHaveBeenCalledWith('GET', '/thing', { q: 1 }, {
      cache: false,
      headers: { Authorization: 'Bearer svc-token', 'X-Oxy-User-Id': 'user-1' },
    });
  });

  it('mints the service token without the user preflight', async () => {
    const oxy = new OxyServer({ baseURL: 'http://test.invalid' });
    const request = captureRequest(oxy, { token: 'svc-tok', expiresIn: 3600 });

    await oxy.serviceToken('oxy_dk_svc', 'secret-value');

    expect(request).toHaveBeenCalledWith(
      'POST',
      '/auth/service-token',
      { apiKey: 'oxy_dk_svc', apiSecret: 'secret-value' },
      expect.objectContaining({ skipAuth: true, cache: false, retry: false }),
    );
  });
});

describe('OxyServer service-only namespace methods', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('notifications.create posts with the service token', async () => {
    const oxy = server();
    const request = captureRequest(oxy, { notification: { id: 'n1' } });
    const data = { recipientId: 'u1', actorId: 'u1', type: 'system', entityId: 'u1', entityType: 'profile' };

    await expect(oxy.notifications.create(data as never)).resolves.toEqual({ id: 'n1' });

    expect(request).toHaveBeenCalledWith('POST', '/notifications', data, {
      cache: false,
      headers: { Authorization: 'Bearer svc-token' },
    });
  });

  it('linkedAccounts.forUser reads by user with the service token', async () => {
    const oxy = server();
    const request = captureRequest(oxy, { linkedAccounts: [] });

    await oxy.linkedAccounts.forUser('user/1');

    expect(request).toHaveBeenCalledWith('GET', '/linked-accounts/by-user/user%2F1', undefined, {
      cache: false,
      headers: { Authorization: 'Bearer svc-token' },
    });
  });

  it('reputation.award posts with the service token and drops cached reputation reads', async () => {
    const oxy = server();
    const request = captureRequest(oxy, { transaction: { id: 't1' } });
    const deletePrefix = jest.spyOn(oxy.cache, 'deletePrefix');

    await expect(oxy.reputation.award({ userId: 'u1', actionType: 'x' } as never)).resolves.toEqual({ id: 't1' });

    expect(request.mock.calls[0]?.[3]?.headers).toEqual({ Authorization: 'Bearer svc-token' });
    expect(deletePrefix).toHaveBeenCalledWith('GET:/reputation/');
  });

  it('service-only methods refuse on a plain client', async () => {
    const plain = new OxyServices({ baseURL: 'http://test.invalid' });
    expect('create' in plain.notifications).toBe(false);
    expect('forUser' in plain.linkedAccounts).toBe(false);
    expect('award' in plain.reputation).toBe(false);
    expect('metadataByIds' in plain.assets).toBe(false);
    expect('mintRequesterAssertion' in plain.agency).toBe(false);
    expect('introspectRequesterAssertion' in plain.agency).toBe(false);
  });

  it('keeps one namespace instance per server', () => {
    const oxy = server();
    expect(oxy.assets).toBe(oxy.assets);
    expect(oxy.agency).toBe(oxy.agency);
  });
});
