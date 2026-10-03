import { OxyServer } from '../OxyServer';

describe('acting-as cache freshness', () => {
  afterEach(() => jest.useRealTimers());
  it('a successful HTTP denial expires with the denial TTL, not the grant TTL', async () => {
    jest.useFakeTimers();
    const server = new OxyServer({ baseURL: 'https://test.invalid' });
    jest.spyOn(server, 'serviceToken').mockResolvedValue('verifier-token');
    const request = jest.spyOn(server as unknown as { request: jest.Mock }, 'request')
      .mockResolvedValueOnce({ authorized: false, epoch: '1', scopes: [] })
      .mockResolvedValueOnce({ authorized: true, epoch: '1', scopes: ['user:read'] });
    expect(await server.verifyActingAs('app-a', 'user-a', { cache: true })).toBeNull();
    jest.advanceTimersByTime(9_999);
    expect(await server.verifyActingAs('app-a', 'user-a', { cache: true })).toBeNull();
    expect(request).toHaveBeenCalledTimes(1);
    jest.advanceTimersByTime(1);
    expect(await server.verifyActingAs('app-a', 'user-a', { cache: true }))
      .toEqual({ authorized: true, epoch: '1', scopes: ['user:read'] });
    expect(request).toHaveBeenCalledTimes(2);
  });
  it('isolates denials by application and account', async () => {
    const server = new OxyServer({ baseURL: 'https://test.invalid' });
    jest.spyOn(server, 'serviceToken').mockResolvedValue('verifier-token');
    const request = jest.spyOn(server as unknown as { request: jest.Mock }, 'request')
      .mockResolvedValueOnce({ authorized: false, scopes: [], epoch: '1' })
      .mockResolvedValue({ authorized: true, epoch: '1', scopes: ['user:read'] });
    expect(await server.verifyActingAs('app-a', 'user-a', { cache: true })).toBeNull();
    expect(await server.verifyActingAs('app-b', 'user-a', { cache: true })).not.toBeNull();
    expect(await server.verifyActingAs('app-a', 'user-b', { cache: true })).not.toBeNull();
    expect(request).toHaveBeenCalledTimes(3);
  });
});
