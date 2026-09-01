/**
 * Device-boot mixin tests. Stubs `makeRequest` so the tests run with no network
 * and asserts `mintFromDeviceSecret`'s route/shape, contract validation, and the
 * `skipAuth` flag on the bearer-less mint call, plus `provisionBackgroundCredential`'s
 * route/options, contract validation and its 404-tolerant degrade.
 */
import type {
  DeviceBackgroundCredentialResponse,
  DeviceTokenMintResponse,
} from '@oxyhq/contracts';
import { OxyServices } from '../../OxyServices';

describe('OxyServices.deviceBoot', () => {
  let oxy: OxyServices;
  let makeRequest: jest.SpyInstance;

  beforeEach(() => {
    oxy = new OxyServices({ baseURL: 'http://test.invalid' });
    makeRequest = jest.spyOn(oxy, 'makeRequest');
  });

  afterEach(() => jest.restoreAllMocks());

  describe('mintFromDeviceSecret', () => {
    const MINT: DeviceTokenMintResponse = {
      accessToken: 'access-minted',
      expiresAt: '2030-01-01T00:00:00.000Z',
      nextDeviceSecret: 'ds-next-secret',
      state: {
        deviceId: 'dev-1',
        accounts: [{ accountId: 'user-1', sessionId: 'sess-1', authuser: 0 }],
        activeAccountId: 'user-1',
        revision: 3,
        updatedAt: 1_700_000_000_000,
      },
    };

    it('POSTs deviceId + deviceSecret with skipAuth + retry:false + bypassQueue (no bearer, no cache, single attempt, never queued) and returns the validated mint', async () => {
      makeRequest.mockResolvedValueOnce(MINT);
      const result = await oxy.mintFromDeviceSecret('dev-1', 'ds-current-secret');
      expect(result).toEqual(MINT);
      // `retry: false` — the scheduler/401 lane own backoff; HttpService's inner
      // retry here would only multiply cold-boot latency on a slow network.
      // `bypassQueue: true` — the mint is the control-plane call the auth lane
      // depends on; it must never wait for a RequestQueue slot (deadlock).
      expect(makeRequest).toHaveBeenCalledWith(
        'POST',
        '/session/device/token',
        { deviceId: 'dev-1', deviceSecret: 'ds-current-secret' },
        { cache: false, skipAuth: true, retry: false, bypassQueue: true },
      );
    });

    it('throws on an unexpected response shape (missing state / nextDeviceSecret)', async () => {
      makeRequest.mockResolvedValueOnce({ accessToken: 'a', expiresAt: 'b' });
      await expect(oxy.mintFromDeviceSecret('dev-1', 'ds')).rejects.toThrow();
    });

    it('propagates a rejected request (e.g. 401 invalid_device_secret)', async () => {
      const err = Object.assign(new Error('invalid_device_secret'), { status: 401 });
      makeRequest.mockRejectedValueOnce(err);
      await expect(oxy.mintFromDeviceSecret('dev-1', 'ds')).rejects.toThrow('invalid_device_secret');
    });

    it('propagates a 401 no_active_session so the caller can resolve signed-out', async () => {
      const err = Object.assign(new Error('no_active_session'), { status: 401 });
      makeRequest.mockRejectedValueOnce(err);
      await expect(oxy.mintFromDeviceSecret('dev-1', 'ds')).rejects.toThrow('no_active_session');
    });
  });

  describe('provisionBackgroundCredential', () => {
    const CREDENTIAL: DeviceBackgroundCredentialResponse = {
      deviceId: 'dev-1',
      secret: 'bg-secret',
      accountId: 'user-1',
      expiresAt: '2030-01-01T00:00:00.000Z',
    };

    /** `HttpService` annotates its rejections with both `status` and `response.status`. */
    const httpError = (status: number, message: string) =>
      Object.assign(new Error(message), {
        status,
        response: { status, statusText: message },
      });

    it('POSTs to the background-credential route with NO body and no cache, and returns the validated credential', async () => {
      makeRequest.mockResolvedValueOnce(CREDENTIAL);
      const result = await oxy.provisionBackgroundCredential();
      expect(result).toEqual(CREDENTIAL);
      // No body: the server derives BOTH the deviceId and the account from the
      // validated bearer. Normal authenticated path — no skipAuth (a 401 belongs
      // in the ordinary re-mint lane), no bypassQueue (not control-plane).
      expect(makeRequest).toHaveBeenCalledWith(
        'POST',
        '/session/device/background-credential',
        undefined,
        { cache: false },
      );
    });

    it('returns null on 404 (endpoint absent) instead of throwing, so an SDK ahead of the API degrades to "no background session"', async () => {
      makeRequest.mockRejectedValueOnce(httpError(404, 'HTTP 404: Not Found'));
      await expect(oxy.provisionBackgroundCredential()).resolves.toBeNull();
    });

    it('throws on an unexpected response shape (missing secret)', async () => {
      makeRequest.mockResolvedValueOnce({
        deviceId: 'dev-1',
        accountId: 'user-1',
        expiresAt: '2030-01-01T00:00:00.000Z',
      });
      await expect(oxy.provisionBackgroundCredential()).rejects.toThrow();
    });

    it('propagates a non-404 failure (401 / 500) — only an absent endpoint degrades quietly', async () => {
      makeRequest.mockRejectedValueOnce(httpError(401, 'unauthorized'));
      await expect(oxy.provisionBackgroundCredential()).rejects.toThrow('unauthorized');

      makeRequest.mockRejectedValueOnce(httpError(500, 'server exploded'));
      await expect(oxy.provisionBackgroundCredential()).rejects.toThrow('server exploded');
    });
  });
});
