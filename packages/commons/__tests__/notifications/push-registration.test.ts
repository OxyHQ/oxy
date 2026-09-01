import { IDENTITY_APPROVAL_PUSH_CHANNEL } from '@oxyhq/contracts';
import type { PushTokenPlatform, RegisterPushTokenInput } from '@oxyhq/core';
import { ensureNotificationChannel } from '@oxyhq/services';
import {
  registerInstallationPushToken,
  retireInstallationPushToken,
  type PushTokenEnvironment,
  type PushTokenRegistry,
} from '@/lib/notifications/push-registration';

/**
 * Push registration is what makes "Continue with Oxy" on a desktop able to WAKE
 * the vault instead of falling back to a QR — so the contract that matters is
 * what is allowed to leave the device, and when.
 *
 * The orchestration takes every side effect as an injected collaborator, so the
 * rules below are asserted without a device, a permission dialog, or a network.
 */
const EXPO_TOKEN = 'ExponentPushToken[xxxxxxxxxxxxxxxxxxxxxx]';
/** What `getDevicePushTokenAsync()` yields — an APNs token. NEVER registrable. */
const RAW_DEVICE_TOKEN = '740f4707bebcf74f9b7c25d48e3358945f6aa01da5ddb387462c7eaf61bb78ad';

function makeRegistry(): PushTokenRegistry & {
  registerPushToken: jest.Mock<Promise<void>, [RegisterPushTokenInput]>;
  unregisterPushToken: jest.Mock<Promise<void>, [string]>;
} {
  return {
    registerPushToken: jest.fn<Promise<void>, [RegisterPushTokenInput]>(async () => undefined),
    unregisterPushToken: jest.fn<Promise<void>, [string]>(async () => undefined),
  };
}

function makeEnvironment(overrides: Partial<PushTokenEnvironment> = {}): PushTokenEnvironment {
  return {
    hasNotificationPermission: jest.fn<Promise<boolean>, []>(async () => true),
    getExpoPushToken: jest.fn<Promise<string | null>, []>(async () => EXPO_TOKEN),
    pushTokenPlatform: jest.fn<PushTokenPlatform | null, []>(() => 'android'),
    ...overrides,
  };
}

const CHANNEL = { name: 'Sign-in requests', description: 'Alerts when another device asks to sign in as you' };
const OPTIONS = { clientId: 'oxy_dk_commons', deviceId: 'device-1', channel: CHANNEL };

describe('registerInstallationPushToken', () => {
  it('registers the Expo push token, scoped to the calling application', async () => {
    const registry = makeRegistry();

    const outcome = await registerInstallationPushToken(registry, makeEnvironment(), OPTIONS);

    expect(outcome).toEqual({ status: 'registered', expoPushToken: EXPO_TOKEN });
    expect(registry.registerPushToken).toHaveBeenCalledTimes(1);
    expect(registry.registerPushToken).toHaveBeenCalledWith({
      expoPushToken: EXPO_TOKEN,
      platform: 'android',
      clientId: OPTIONS.clientId,
      deviceId: OPTIONS.deviceId,
    });
  });

  it('omits deviceId entirely when the device session has not resolved one', async () => {
    const registry = makeRegistry();

    await registerInstallationPushToken(registry, makeEnvironment(), {
      clientId: OPTIONS.clientId,
      channel: CHANNEL,
    });

    expect(registry.registerPushToken).toHaveBeenCalledWith({
      expoPushToken: EXPO_TOKEN,
      platform: 'android',
      clientId: OPTIONS.clientId,
    });
  });

  it('sends an Expo push token — never a raw APNs/FCM device token', async () => {
    const registry = makeRegistry();

    await registerInstallationPushToken(registry, makeEnvironment(), OPTIONS);

    const [input] = registry.registerPushToken.mock.calls[0];
    expect(input.expoPushToken).toMatch(/^Expo(nent)?PushToken\[.+\]$/);
    expect(input.expoPushToken).not.toBe(RAW_DEVICE_TOKEN);
  });

  it('waits for the OS permission — nothing is sent while it is not granted', async () => {
    const registry = makeRegistry();
    const environment = makeEnvironment({
      hasNotificationPermission: jest.fn<Promise<boolean>, []>(async () => false),
    });

    const outcome = await registerInstallationPushToken(registry, environment, OPTIONS);

    expect(outcome).toEqual({ status: 'skipped', reason: 'permission-not-granted' });
    expect(registry.registerPushToken).not.toHaveBeenCalled();
    // A token is not even minted without permission.
    expect(environment.getExpoPushToken).not.toHaveBeenCalled();
  });

  it('sends nothing when no token can be minted', async () => {
    const registry = makeRegistry();

    const outcome = await registerInstallationPushToken(
      registry,
      makeEnvironment({ getExpoPushToken: jest.fn<Promise<string | null>, []>(async () => null) }),
      OPTIONS,
    );

    expect(outcome).toEqual({ status: 'skipped', reason: 'no-token' });
    expect(registry.registerPushToken).not.toHaveBeenCalled();
  });

  it('sends nothing on a platform Oxy does not deliver push to', async () => {
    const registry = makeRegistry();
    const environment = makeEnvironment({
      pushTokenPlatform: jest.fn<PushTokenPlatform | null, []>(() => null),
    });

    const outcome = await registerInstallationPushToken(registry, environment, OPTIONS);

    expect(outcome).toEqual({ status: 'skipped', reason: 'unsupported-platform' });
    expect(registry.registerPushToken).not.toHaveBeenCalled();
    expect(environment.hasNotificationPermission).not.toHaveBeenCalled();
  });

  it('creates the approval channel before registering, on the id the API sends', async () => {
    const channelMock = ensureNotificationChannel as unknown as jest.Mock;
    const registry = makeRegistry();

    await registerInstallationPushToken(registry, makeEnvironment(), OPTIONS);

    expect(channelMock).toHaveBeenCalledWith(
      expect.objectContaining({ id: IDENTITY_APPROVAL_PUSH_CHANNEL, name: CHANNEL.name }),
    );
    // Android drops a push whose channel does not exist yet, so the ORDER is the
    // guarantee: the channel must exist before the server can ever send to it.
    expect(channelMock.mock.invocationCallOrder[0]).toBeLessThan(
      (registry.registerPushToken as jest.Mock).mock.invocationCallOrder[0],
    );
  });

  it('propagates a registry rejection so the caller can log it', async () => {
    const registry = makeRegistry();
    registry.registerPushToken.mockRejectedValue(new Error('registerPushToken expects an Expo push token'));

    await expect(
      registerInstallationPushToken(registry, makeEnvironment(), OPTIONS),
    ).rejects.toThrow(/Expo push token/);
  });
});

describe('retireInstallationPushToken', () => {
  it("retires this installation's token", async () => {
    const registry = makeRegistry();

    const outcome = await retireInstallationPushToken(registry, makeEnvironment());

    expect(outcome).toEqual({ status: 'retired', expoPushToken: EXPO_TOKEN });
    expect(registry.unregisterPushToken).toHaveBeenCalledWith(EXPO_TOKEN);
  });

  it('does nothing when there is no token to retire', async () => {
    const registry = makeRegistry();

    const outcome = await retireInstallationPushToken(
      registry,
      makeEnvironment({ getExpoPushToken: jest.fn<Promise<string | null>, []>(async () => null) }),
    );

    expect(outcome).toEqual({ status: 'skipped', reason: 'no-token' });
    expect(registry.unregisterPushToken).not.toHaveBeenCalled();
  });
});
