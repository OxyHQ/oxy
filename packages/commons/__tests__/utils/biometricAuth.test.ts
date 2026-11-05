/**
 * The local confirmation gate counts the device's screen lock, not only
 * enrolled biometrics. It used to require `hasHardwareAsync && isEnrolledAsync`,
 * so a phone protected by a PIN alone could never approve a sign-in, rotate its
 * key or create a backup, although `authenticateAsync` would have asked for the
 * PIN.
 */

const SecurityLevel = { NONE: 0, SECRET: 1, BIOMETRIC_WEAK: 2, BIOMETRIC_STRONG: 3 };

const localAuth = {
  SecurityLevel,
  AuthenticationType: { FINGERPRINT: 1, FACIAL_RECOGNITION: 2, IRIS: 3 },
  hasHardwareAsync: jest.fn(async () => true),
  isEnrolledAsync: jest.fn(async () => true),
  getEnrolledLevelAsync: jest.fn(async () => SecurityLevel.BIOMETRIC_STRONG),
  supportedAuthenticationTypesAsync: jest.fn(async () => []),
  authenticateAsync: jest.fn(async () => ({ success: true })),
  cancelAuthenticate: jest.fn(async () => undefined),
};

jest.mock('expo-local-authentication', () => localAuth, { virtual: true });

import { Platform } from 'react-native';
import { authenticate, hasLocalConfirmation, requestLocalConfirmation } from '@/lib/biometricAuth';

/** A phone with a PIN and no fingerprint or face enrolled. */
function screenLockOnly() {
  localAuth.hasHardwareAsync.mockResolvedValue(true);
  localAuth.isEnrolledAsync.mockResolvedValue(false);
  localAuth.getEnrolledLevelAsync.mockResolvedValue(SecurityLevel.SECRET);
}

/** A phone with no screen lock and no biometrics at all. */
function noLock() {
  localAuth.hasHardwareAsync.mockResolvedValue(true);
  localAuth.isEnrolledAsync.mockResolvedValue(false);
  localAuth.getEnrolledLevelAsync.mockResolvedValue(SecurityLevel.NONE);
}

describe('local confirmation', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (Platform as { OS: string }).OS = 'android';
    localAuth.authenticateAsync.mockResolvedValue({ success: true });
  });

  describe('a phone with only a screen lock', () => {
    beforeEach(screenLockOnly);

    it('can confirm', async () => {
      await expect(hasLocalConfirmation()).resolves.toBe(true);
    });

    it('prompts, with the screen-lock fallback, and confirms', async () => {
      await expect(requestLocalConfirmation('Confirm it is you')).resolves.toEqual({
        outcome: 'confirmed',
      });
      expect(localAuth.authenticateAsync).toHaveBeenCalledWith(
        expect.objectContaining({
          promptMessage: 'Confirm it is you',
          disableDeviceFallback: false,
        }),
      );
    });

    it('authenticate() prompts too', async () => {
      await expect(authenticate('Rotate')).resolves.toEqual({ success: true });
      expect(localAuth.authenticateAsync).toHaveBeenCalledTimes(1);
    });

    it('also works without any biometric hardware', async () => {
      localAuth.hasHardwareAsync.mockResolvedValue(false);
      await expect(requestLocalConfirmation('Confirm')).resolves.toEqual({ outcome: 'confirmed' });
    });

    it('reports a dismissed prompt as declined, never as confirmed', async () => {
      localAuth.authenticateAsync.mockResolvedValue({ success: false, error: 'user_cancel' });
      await expect(requestLocalConfirmation('Confirm')).resolves.toEqual({ outcome: 'declined' });
    });
  });

  describe('a phone with no screen lock', () => {
    beforeEach(noLock);

    it('cannot confirm, and nothing is prompted', async () => {
      await expect(hasLocalConfirmation()).resolves.toBe(false);
      await expect(requestLocalConfirmation('Confirm')).resolves.toEqual({
        outcome: 'unavailable',
        reason: 'no_enrollment',
      });
      expect(localAuth.authenticateAsync).not.toHaveBeenCalled();
    });

    it('authenticate() fails without prompting', async () => {
      await expect(authenticate('Rotate')).resolves.toEqual({
        success: false,
        error: 'passcode_not_set',
      });
      expect(localAuth.authenticateAsync).not.toHaveBeenCalled();
    });
  });

  it('a phone with biometrics enrolled still prompts', async () => {
    localAuth.getEnrolledLevelAsync.mockResolvedValue(SecurityLevel.BIOMETRIC_STRONG);
    await expect(requestLocalConfirmation('Confirm')).resolves.toEqual({ outcome: 'confirmed' });
    expect(localAuth.authenticateAsync).toHaveBeenCalledTimes(1);
  });

  it('web has no local confirmation', async () => {
    (Platform as { OS: string }).OS = 'web';
    await expect(hasLocalConfirmation()).resolves.toBe(false);
    await expect(requestLocalConfirmation('Confirm')).resolves.toEqual({
      outcome: 'unavailable',
      reason: 'unsupported_platform',
    });
  });
});
