/**
 * The app lock applies only where the account turned biometric login on AND
 * the device can still use biometrics; never on the web.
 */
const mockCanUseBiometrics = jest.fn();
const mockPlatform = { OS: 'ios' };

jest.mock('react-native', () => ({ Platform: mockPlatform }));
jest.mock('@/lib/biometricAuth', () => ({
  BIOMETRIC_ENABLED_KEY: 'oxy_biometric_enabled',
  canUseBiometrics: () => mockCanUseBiometrics(),
}));

import AsyncStorage from '@react-native-async-storage/async-storage';
import { isAppLockEnabled } from '@/lib/appLock';

beforeEach(async () => {
  mockPlatform.OS = 'ios';
  mockCanUseBiometrics.mockReset().mockResolvedValue(true);
  await AsyncStorage.clear();
});

describe('isAppLockEnabled', () => {
  it('is off until biometric login is turned on here', async () => {
    expect(await isAppLockEnabled()).toBe(false);
    await AsyncStorage.setItem('oxy_biometric_enabled', 'true');
    expect(await isAppLockEnabled()).toBe(true);
  });

  it('is off on a device that can no longer use biometrics', async () => {
    await AsyncStorage.setItem('oxy_biometric_enabled', 'true');
    mockCanUseBiometrics.mockResolvedValue(false);
    expect(await isAppLockEnabled()).toBe(false);
  });

  it('is off when the check fails, and always on the web', async () => {
    await AsyncStorage.setItem('oxy_biometric_enabled', 'true');
    mockCanUseBiometrics.mockRejectedValue(new Error('module missing'));
    expect(await isAppLockEnabled()).toBe(false);
    mockCanUseBiometrics.mockResolvedValue(true);
    mockPlatform.OS = 'web';
    expect(await isAppLockEnabled()).toBe(false);
  });
});
