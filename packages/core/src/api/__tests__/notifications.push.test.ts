/**
 * Push-token registration: Expo push tokens only (never raw APNs/FCM device
 * tokens), sent with the user's bearer.
 */
import { OxyServices } from '../../OxyServices';

describe('oxy.notifications push tokens', () => {
  let oxy: OxyServices;
  let request: jest.SpyInstance;

  beforeEach(() => {
    oxy = new OxyServices({ baseURL: 'http://test.invalid' });
    request = jest.spyOn(oxy, 'request');
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('registerPushToken / unregisterPushToken', () => {
    const expoToken = 'ExponentPushToken[abc123XYZ]';

    it('POSTs the Expo push token with a bearer', async () => {
      request.mockResolvedValue({ registered: true });

      await expect(
        oxy.notifications.registerPushToken({ expoPushToken: expoToken, platform: 'ios' }),
      ).resolves.toBeUndefined();

      expect(request).toHaveBeenCalledWith(
        'POST',
        '/notifications/push-token',
        { token: expoToken, platform: 'ios' },
        { cache: false },
      );
      // Push registration is per-identity — the bearer preflight must run.
      expect(request.mock.calls[0][3]).not.toHaveProperty('skipAuth');
    });

    it('omits deviceId/clientId entirely when not provided', async () => {
      request.mockResolvedValue({ registered: true });

      await oxy.notifications.registerPushToken({ expoPushToken: expoToken, platform: 'android' });

      // `toHaveBeenCalledWith` ignores explicitly-undefined keys, so assert the
      // literal key set: the server reads PRESENCE of these optional fields.
      expect(Object.keys(request.mock.calls[0][2])).toEqual(['token', 'platform']);
    });

    it('sends deviceId and clientId when provided', async () => {
      request.mockResolvedValue({ registered: true });

      await oxy.notifications.registerPushToken({
        expoPushToken: expoToken,
        platform: 'ios',
        deviceId: 'dev-1',
        clientId: 'oxy_dk_commons',
      });

      expect(request.mock.calls[0][2]).toEqual({
        token: expoToken,
        platform: 'ios',
        deviceId: 'dev-1',
        clientId: 'oxy_dk_commons',
      });
    });

    it('accepts the ExpoPushToken spelling as well', async () => {
      request.mockResolvedValue({ registered: true });

      await oxy.notifications.registerPushToken({ expoPushToken: 'ExpoPushToken[abc123]', platform: 'web' });

      expect(request).toHaveBeenCalled();
    });

    it.each([
      // The exact inbox hazard: getDevicePushTokenAsync's raw FCM/APNs token.
      ['a raw FCM token', 'fMEP0vJqS0y5:APA91bH-longopaquestring'],
      ['a raw APNs hex token', '740f4707bebcf74f9b7c25d48e3358945f6aa01da5ddb387462c7eaf61bb78ad'],
      ['an empty string', ''],
      ['a truncated wrapper', 'ExponentPushToken['],
      ['an empty wrapper', 'ExponentPushToken[]'],
      ['a token with whitespace inside', 'ExponentPushToken[abc 123]'],
      ['surrounding whitespace', ' ExponentPushToken[abc123] '],
    ])('rejects %s without sending a request', async (_label, token) => {
      await expect(
        oxy.notifications.registerPushToken({ expoPushToken: token, platform: 'ios' }),
      ).rejects.toThrow(/Expo push token/);

      expect(request).not.toHaveBeenCalled();
    });

    it('DELETEs the token on unregister', async () => {
      request.mockResolvedValue({ unregistered: true });

      await expect(oxy.notifications.unregisterPushToken(expoToken)).resolves.toBeUndefined();

      expect(request).toHaveBeenCalledWith(
        'DELETE',
        '/notifications/push-token',
        { token: expoToken },
        { cache: false },
      );
    });

    it('surfaces a server rejection through the shared error handler', async () => {
      request.mockRejectedValue(new Error('Unknown client'));

      await expect(
        oxy.notifications.registerPushToken({ expoPushToken: expoToken, platform: 'ios' }),
      ).rejects.toThrow('Unknown client');
    });
  });
});
