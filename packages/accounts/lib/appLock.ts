/**
 * Whether the app lock applies on this device right now: the account turned
 * on biometric login here (`BIOMETRIC_ENABLED_KEY`, kept by
 * `useBiometricSettings`), and the device can still use biometrics — one with
 * none enrolled, or no hardware, has nothing to unlock with. Never on the web.
 */

import { Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { BIOMETRIC_ENABLED_KEY, canUseBiometrics } from '@/lib/biometricAuth';

export async function isAppLockEnabled(): Promise<boolean> {
  if (Platform.OS === 'web') return false;
  try {
    if ((await AsyncStorage.getItem(BIOMETRIC_ENABLED_KEY)) !== 'true') return false;
    return await canUseBiometrics();
  } catch {
    return false;
  }
}
