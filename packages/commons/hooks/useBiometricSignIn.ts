/**
 * Hook that wraps key sign-in with a biometric gate.
 *
 * For INTERACTIVE callers (create / import, triggered by an explicit user
 * action): if biometric login is enabled, prompt for biometric authentication
 * before proceeding. The actual sign-in (post-gate) is the silent core from
 * {@link useSilentKeySignIn} — composed here, not duplicated.
 *
 * Callers that run OUTSIDE a user gesture (the network-reconnect scheduler's
 * register-and-connect sync) must NOT use this — a headless biometric prompt
 * with nobody in front of the device never resolves and hangs forever. They call
 * `useSilentKeySignIn` directly. See `useSyncIdentity`.
 */

import { useCallback } from 'react';
import { Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import type { User } from '@oxy.so/core';
import { authenticate, canUseBiometrics, getErrorMessage } from '@/lib/biometricAuth';
import { useSilentKeySignIn } from './useSilentKeySignIn';

export function useBiometricSignIn() {
  const { signInWithKeySilent } = useSilentKeySignIn();

  const signIn = useCallback(
    async (publicKey?: string, deviceName?: string): Promise<User> => {
      // Biometric gate (native only). Interactive sign-in must clear it first.
      if (Platform.OS !== 'web') {
        try {
          const biometricEnabled = await AsyncStorage.getItem('oxy_biometric_enabled');
          if (biometricEnabled === 'true') {
            // Check if biometrics can be used
            const canUse = await canUseBiometrics();
            if (canUse) {
              // Perform biometric authentication
              const authResult = await authenticate("Verify it's you to continue");

              if (!authResult.success) {
                const errorMsg = getErrorMessage(authResult.error);
                throw new Error(errorMsg || 'Biometric authentication failed');
              }
            }
          }
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : '';
          // If it's a user cancellation, throw to prevent proceeding
          if (message.includes('cancelled') || message.includes('cancel') || message.includes('user_cancel')) {
            throw new Error('Authentication cancelled');
          }
          // For other errors, re-throw
          throw err;
        }
      }

      // Gate cleared → the silent key sign-in core.
      return signInWithKeySilent(publicKey, deviceName);
    },
    [signInWithKeySilent],
  );

  return { signIn };
}
