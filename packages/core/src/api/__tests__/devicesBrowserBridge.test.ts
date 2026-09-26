/**
 * The browser bridge client (ADR 0029 D2): the three bridge calls, and the
 * device proof a sign-in carries once a device credential provider is wired.
 * `makeRequest` is stubbed — no network.
 */
import { OxyServices } from '../../OxyServices';

const CHALLENGE = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';
const BRIDGE_OPTIONS = { cache: false, skipAuth: true, retry: false, bypassQueue: true };
const LOGIN = {
  accessToken: 'access',
  sessionId: 'sess-1',
  deviceId: 'dev-1',
  expiresAt: '2030-01-01T00:00:00.000Z',
  user: { id: 'user-1', username: 'alice' },
};

describe('OxyServices — browser bridge', () => {
  let oxy: OxyServices;
  let makeRequest: jest.SpyInstance;

  beforeEach(() => {
    oxy = new OxyServices({ baseURL: 'http://test.invalid' });
    makeRequest = jest.spyOn(oxy, 'request');
  });

  afterEach(() => jest.restoreAllMocks());

  it('registers, asks for a join code and joins without a bearer', async () => {
    makeRequest.mockResolvedValueOnce({ deviceId: 'dev-1', deviceSecret: 'auth-secret' });
    expect(await oxy.devices.registerBrowser()).toEqual({ deviceId: 'dev-1', deviceSecret: 'auth-secret' });
    expect(makeRequest).toHaveBeenLastCalledWith('POST', '/session/device/register', {}, BRIDGE_OPTIONS);

    const joinCodeRequest = {
      deviceId: 'dev-1',
      deviceSecret: 'auth-secret',
      clientId: 'oxy_dk_1',
      redirectUri: 'https://mention.earth',
      codeChallenge: CHALLENGE,
      codeChallengeMethod: 'S256' as const,
    };
    makeRequest.mockResolvedValueOnce({ code: 'code-1', expiresIn: 60 });
    expect(await oxy.devices.requestJoinCode(joinCodeRequest)).toEqual({ code: 'code-1', expiresIn: 60 });
    expect(makeRequest).toHaveBeenLastCalledWith('POST', '/session/device/join-code', joinCodeRequest, BRIDGE_OPTIONS);

    const joinRequest = { code: 'code-1', codeVerifier: 'v'.repeat(43), clientId: 'oxy_dk_1', redirectUri: 'https://mention.earth' };
    makeRequest.mockResolvedValueOnce({ deviceId: 'dev-1', deviceSecret: 'app-secret' });
    expect(await oxy.devices.joinBrowser(joinRequest)).toEqual({ deviceId: 'dev-1', deviceSecret: 'app-secret' });
    expect(makeRequest).toHaveBeenLastCalledWith('POST', '/session/device/join', joinRequest, BRIDGE_OPTIONS);
  });

  it('refuses a malformed bridge response and surfaces a rejected secret', async () => {
    makeRequest.mockResolvedValueOnce({ deviceId: 'dev-1' });
    await expect(oxy.devices.registerBrowser()).rejects.toThrow('unexpected response shape');
    makeRequest.mockRejectedValueOnce(Object.assign(new Error('invalid_device_secret'), { status: 401 }));
    await expect(
      oxy.devices.requestJoinCode({
        deviceId: 'dev-1',
        deviceSecret: 'stale',
        clientId: 'c',
        redirectUri: 'https://a.example',
        codeChallenge: CHALLENGE,
        codeChallengeMethod: 'S256',
      }),
    ).rejects.toThrow('invalid_device_secret');
  });

  describe('device proof on sign-ins', () => {
    it('sends nothing without a provider', async () => {
      makeRequest.mockResolvedValueOnce(LOGIN);
      await oxy.auth.password.signIn({ identifier: 'alice', password: 'pw' });
      expect(makeRequest.mock.calls[0][2]).toEqual({ identifier: 'alice', password: 'pw' });
    });

    it('attaches the held credential to a claim, a password sign-in and a sign-up', async () => {
      const dispose = oxy.session.setDeviceCredentialProvider(async () => ({ deviceId: 'dev-1', deviceSecret: 'app-secret' }));
      const device = { deviceId: 'dev-1', deviceSecret: 'app-secret' };

      makeRequest.mockResolvedValueOnce(LOGIN);
      await oxy.auth.claimSession('st-1', { plantTokens: false });
      expect(makeRequest.mock.calls[0][2]).toEqual({ sessionToken: 'st-1', device });

      makeRequest.mockResolvedValueOnce(LOGIN);
      await oxy.auth.password.signIn({ identifier: 'alice', password: 'pw', deviceName: 'Chrome' });
      expect(makeRequest.mock.calls[1][2]).toEqual({ identifier: 'alice', password: 'pw', deviceName: 'Chrome', device });

      makeRequest.mockResolvedValueOnce(LOGIN);
      await oxy.auth.signUp({ username: 'alice', email: 'a@b.c', emailTicket: 't' });
      expect(makeRequest.mock.calls[2][2]).toEqual({ username: 'alice', email: 'a@b.c', emailTicket: 't', device });

      dispose();
      makeRequest.mockResolvedValueOnce(LOGIN);
      await oxy.auth.password.signIn({ identifier: 'alice', password: 'pw' });
      expect(makeRequest.mock.calls[3][2]).toEqual({ identifier: 'alice', password: 'pw' });
    });

    it('an explicit null opts out, and a failing provider is no proof', async () => {
      oxy.session.setDeviceCredentialProvider(() => ({ deviceId: 'dev-1', deviceSecret: 'app-secret' }));
      makeRequest.mockResolvedValueOnce(LOGIN);
      await oxy.auth.claimSession('st-1', { plantTokens: false, device: null });
      expect(makeRequest.mock.calls[0][2]).toEqual({ sessionToken: 'st-1' });

      oxy.session.setDeviceCredentialProvider(async () => {
        throw new Error('storage unavailable');
      });
      expect(await oxy.session.readDeviceProof()).toBeNull();
      oxy.session.setDeviceCredentialProvider(() => ({ deviceId: '', deviceSecret: 'x' }));
      expect(await oxy.session.readDeviceProof()).toBeNull();
    });
  });
});
