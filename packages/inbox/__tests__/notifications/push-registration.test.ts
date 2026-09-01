/**
 * The push-registration orchestration, driven with injected side effects.
 *
 * The contract under test is what leaves the client: an `ExponentPushToken[…]`
 * obtained from the Expo push service, scoped to the registered Inbox
 * application — sent through the SDK's registrar, never an app-local HTTP call.
 * Nothing is sent at all until the platform, the permission, and the token are
 * all in place.
 *
 * The `expo-notifications` adapter behind those facts belongs to
 * `@oxyhq/services` and is covered by that package's own suites. What is
 * asserted here is the wiring Inbox owns: that `registerInboxPushToken` reaches
 * for the SDK adapter (never an app-local copy) and scopes the registration to
 * Inbox's client id.
 */

import type { PushTokenPlatform } from '@oxyhq/core';

import {
  MOCK_EXPO_PUSH_TOKEN,
  __resetNotificationAdapter,
  getExpoPushToken as sdkGetExpoPushToken,
  pushTokenPlatform as sdkPushTokenPlatform,
  requestNotificationPermission as sdkRequestNotificationPermission,
} from '@/__mocks__/oxyhq-services';
import { OXY_CLIENT_ID } from '@/constants/oxy';
import {
  registerInboxPushToken,
  registerInstallationPushToken,
  type PushTokenEnvironment,
  type PushTokenRegistrar,
} from '@/lib/notifications/push-registration';

const EXPO_TOKEN = 'ExponentPushToken[xxxxxxxxxxxxxxxxxxxxxx]';

interface Harness {
  registrar: PushTokenRegistrar & { registerPushToken: jest.Mock };
  environment: PushTokenEnvironment;
  requestNotificationPermission: jest.Mock;
  getExpoPushToken: jest.Mock;
}

function harness(
  overrides: {
    platform?: PushTokenPlatform | null;
    permission?: boolean;
    token?: string | null;
  } = {},
): Harness {
  const requestNotificationPermission = jest.fn(async () => overrides.permission ?? true);
  const getExpoPushToken = jest.fn(async () =>
    overrides.token === undefined ? EXPO_TOKEN : overrides.token,
  );
  const registrar = { registerPushToken: jest.fn(async () => undefined) };

  return {
    registrar,
    environment: {
      requestNotificationPermission,
      getExpoPushToken,
      pushTokenPlatform: () =>
        overrides.platform === undefined ? 'android' : overrides.platform,
    },
    requestNotificationPermission,
    getExpoPushToken,
  };
}

describe('registerInstallationPushToken', () => {
  it('registers the Expo push token through the SDK, scoped to the app', async () => {
    const { registrar, environment } = harness();

    await expect(
      registerInstallationPushToken(registrar, environment, { clientId: OXY_CLIENT_ID }),
    ).resolves.toEqual({ status: 'registered', expoPushToken: EXPO_TOKEN });

    expect(registrar.registerPushToken).toHaveBeenCalledTimes(1);
    expect(registrar.registerPushToken).toHaveBeenCalledWith({
      expoPushToken: EXPO_TOKEN,
      platform: 'android',
      clientId: OXY_CLIENT_ID,
    });
  });

  it('threads the device session id so the server can retire the row with the session', async () => {
    const { registrar, environment } = harness();

    await registerInstallationPushToken(registrar, environment, {
      clientId: OXY_CLIENT_ID,
      deviceId: 'device-9',
    });

    expect(registrar.registerPushToken).toHaveBeenCalledWith(
      expect.objectContaining({ deviceId: 'device-9' }),
    );
  });

  it('omits deviceId entirely rather than sending an empty one', async () => {
    const { registrar, environment } = harness();

    await registerInstallationPushToken(registrar, environment, { clientId: OXY_CLIENT_ID });

    expect(registrar.registerPushToken.mock.calls[0][0]).not.toHaveProperty('deviceId');
  });

  it('only ever sends an Expo push token — the shape the push service accepts', async () => {
    const { registrar, environment } = harness();

    await registerInstallationPushToken(registrar, environment, { clientId: OXY_CLIENT_ID });

    const sent: unknown = registrar.registerPushToken.mock.calls[0][0];
    const token = (sent as { expoPushToken: string }).expoPushToken;
    expect(token).toMatch(/^ExponentPushToken\[.+\]$/);
  });

  it('sends nothing on a platform Inbox cannot deliver push to', async () => {
    const { registrar, environment, requestNotificationPermission } = harness({ platform: null });

    await expect(
      registerInstallationPushToken(registrar, environment, { clientId: OXY_CLIENT_ID }),
    ).resolves.toEqual({ status: 'skipped', reason: 'unsupported-platform' });

    expect(requestNotificationPermission).not.toHaveBeenCalled();
    expect(registrar.registerPushToken).not.toHaveBeenCalled();
  });

  it('sends nothing — and never mints a token — without the OS permission', async () => {
    const { registrar, environment, getExpoPushToken } = harness({ permission: false });

    await expect(
      registerInstallationPushToken(registrar, environment, { clientId: OXY_CLIENT_ID }),
    ).resolves.toEqual({ status: 'skipped', reason: 'permission-not-granted' });

    expect(getExpoPushToken).not.toHaveBeenCalled();
    expect(registrar.registerPushToken).not.toHaveBeenCalled();
  });

  it('sends nothing when no token can be minted (e.g. no EAS project id)', async () => {
    const { registrar, environment } = harness({ token: null });

    await expect(
      registerInstallationPushToken(registrar, environment, { clientId: OXY_CLIENT_ID }),
    ).resolves.toEqual({ status: 'skipped', reason: 'no-token' });

    expect(registrar.registerPushToken).not.toHaveBeenCalled();
  });

  it('propagates a registrar rejection (the SDK rejects a non-Expo token there)', async () => {
    const { registrar, environment } = harness();
    registrar.registerPushToken.mockRejectedValue(new Error('not an Expo push token'));

    await expect(
      registerInstallationPushToken(registrar, environment, { clientId: OXY_CLIENT_ID }),
    ).rejects.toThrow('not an Expo push token');
  });
});

describe('registerInboxPushToken', () => {
  beforeEach(() => {
    __resetNotificationAdapter();
  });

  it("reads the device through the SDK's adapter and scopes it to the Inbox client id", async () => {
    const registrar = { registerPushToken: jest.fn(async () => undefined) };

    await expect(registerInboxPushToken(registrar)).resolves.toEqual({
      status: 'registered',
      expoPushToken: MOCK_EXPO_PUSH_TOKEN,
    });

    // Inbox holds no adapter of its own: every device fact came from
    // `@oxyhq/services`.
    expect(sdkPushTokenPlatform).toHaveBeenCalledTimes(1);
    expect(sdkRequestNotificationPermission).toHaveBeenCalledTimes(1);
    expect(sdkGetExpoPushToken).toHaveBeenCalledTimes(1);

    expect(registrar.registerPushToken).toHaveBeenCalledWith({
      expoPushToken: MOCK_EXPO_PUSH_TOKEN,
      platform: 'ios',
      clientId: OXY_CLIENT_ID,
    });
  });

  it('threads the device session id it is handed', async () => {
    const registrar = { registerPushToken: jest.fn(async () => undefined) };

    await registerInboxPushToken(registrar, 'device-9');

    expect(registrar.registerPushToken).toHaveBeenCalledWith(
      expect.objectContaining({ deviceId: 'device-9' }),
    );
  });

  it('registers nothing on web, where the adapter reports no platform', async () => {
    sdkPushTokenPlatform.mockReturnValue(null);
    const registrar = { registerPushToken: jest.fn(async () => undefined) };

    await expect(registerInboxPushToken(registrar)).resolves.toEqual({
      status: 'skipped',
      reason: 'unsupported-platform',
    });

    expect(sdkRequestNotificationPermission).not.toHaveBeenCalled();
    expect(registrar.registerPushToken).not.toHaveBeenCalled();
  });

  it('registers nothing when the adapter cannot mint a token', async () => {
    // The shipped Inbox config carries an empty `expo.extra.eas.projectId`, so
    // this is the live path today: the SDK adapter logs the reason and yields no
    // token, and Inbox must skip rather than send something unusable.
    sdkGetExpoPushToken.mockResolvedValue(null);
    const registrar = { registerPushToken: jest.fn(async () => undefined) };

    await expect(registerInboxPushToken(registrar)).resolves.toEqual({
      status: 'skipped',
      reason: 'no-token',
    });

    expect(registrar.registerPushToken).not.toHaveBeenCalled();
  });
});
