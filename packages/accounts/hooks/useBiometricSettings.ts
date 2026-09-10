/**
 * Hook for managing biometric authentication settings
 * 
 * Provides functionality to:
 * - Load biometric login preference from user settings
 * - Save biometric login preference
 * - Check if biometrics can be enabled (hardware + enrolled)
 * - Toggle biometric login on/off
 */

import { useState, useEffect, useCallback } from 'react';
import { Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useOxy, usePrivacySettings, useUpdatePrivacySettings } from '@oxy.so/services';
import { alert, toast } from '@oxy.so/bloom';

import {
  canUseBiometrics,
  hasBiometricHardware,
  isBiometricEnrolled,
  getSupportedTypes,
  authenticate,
  getAuthenticationTypeName,
  getErrorMessage,
} from '@/lib/biometricAuth';

export interface BiometricSettingsState {
  enabled: boolean;
  canEnable: boolean;
  hasHardware: boolean;
  isEnrolled: boolean;
  supportedTypes: string[];
  isLoading: boolean;
  isSaving: boolean;
  error: string | null;
}

export function useBiometricSettings() {
  const { user } = useOxy();
  const [canEnable, setCanEnable] = useState(false);
  const [hasHardware, setHasHardware] = useState(false);
  const [isEnrolled, setIsEnrolled] = useState(false);
  const [supportedTypes, setSupportedTypes] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

  // Load privacy settings using TanStack Query hook
  const { data: privacySettings, isLoading: isLoadingPrivacy, error: privacyError } = usePrivacySettings(user?.id, {
    enabled: !!user?.id && Platform.OS !== 'web',
  });

  // Update privacy settings mutation
  const updatePrivacyMutation = useUpdatePrivacySettings();

  // Load biometric settings and check device capabilities
  useEffect(() => {
    const loadCapabilities = async () => {
      try {
        setError(null);

        // Check device capabilities
        const hardwareAvailable = await hasBiometricHardware();
        const enrolled = await isBiometricEnrolled();
        const canUse = await canUseBiometrics();
        const types = await getSupportedTypes();

        setHasHardware(hardwareAvailable);
        setIsEnrolled(enrolled);
        setCanEnable(canUse);
        setSupportedTypes(types.map(getAuthenticationTypeName));
      } catch (err) {
        console.error('[useBiometricSettings] Error loading capabilities:', err);
        setError(err instanceof Error ? err.message : 'Failed to load biometric capabilities');
      }
    };

    loadCapabilities();
  }, []);

  // Local fallback state for when API is unavailable
  const [localEnabled, setLocalEnabled] = useState<boolean | null>(null);

  // Cast privacy settings to a record for accessing dynamic keys
  const privacyRecord = privacySettings as Record<string, unknown> | undefined;

  // Sync privacy settings with local storage when loaded
  useEffect(() => {
    if (Platform.OS === 'web') return;

    if (privacyRecord) {
      const biometricEnabled = (privacyRecord?.biometricLogin as boolean | undefined) ?? false;
      // Sync with local storage
      if (biometricEnabled) {
        AsyncStorage.setItem('oxy_biometric_enabled', 'true').catch(() => {});
      } else {
        AsyncStorage.removeItem('oxy_biometric_enabled').catch(() => {});
      }
    } else if (privacyError) {
      // Fallback to local storage on error
      AsyncStorage.getItem('oxy_biometric_enabled')
        .then((localPref) => {
          if (!privacyRecord && localPref !== null) {
            // Use local storage as fallback when API is unavailable
            setLocalEnabled(localPref === 'true');
          }
        })
        .catch(() => {});
    }
  }, [privacySettings, privacyError]);

  // Determine enabled state from privacy settings, falling back to local storage
  const enabled = Platform.OS === 'web'
    ? false
    : ((privacyRecord?.biometricLogin as boolean | undefined) ?? localEnabled ?? false);

  const isLoading = isLoadingPrivacy;
  const isSaving = updatePrivacyMutation.isPending;

  /**
   * Toggle biometric login on/off
   * When enabling, requires biometric authentication to confirm
   */
  const toggleBiometricLogin = useCallback(async (value: boolean) => {
    if (!user?.id) {
      toast.error('User not available');
      return;
    }

    // If disabling, just update the setting
    if (!value) {
      try {
        setError(null);
        await updatePrivacyMutation.mutateAsync({ settings: { biometricLogin: false }, userId: user.id });

        // Remove local preference
        await AsyncStorage.removeItem('oxy_biometric_enabled');
      } catch (err) {
        console.error('[useBiometricSettings] Failed to disable biometric login:', err);
        const errorMsg = err instanceof Error ? err.message : 'Failed to disable biometric login';
        setError(errorMsg);
        toast.error(errorMsg);
      }
      return;
    }

    // If enabling, check if biometrics can be used
    if (!canEnable) {
      if (!hasHardware) {
        toast.error('Biometric authentication is not available on this device.');
        return;
      }
      if (!isEnrolled) {
        alert(
          'Not Set Up',
          'Please set up Face ID, Touch ID, or fingerprint in your device settings first.',
          [
            { text: 'Cancel', style: 'cancel' },
            { text: 'Open Settings', onPress: () => {
              // Surface guidance as a non-blocking toast — opening device
              // settings programmatically is platform-specific and out of
              // scope here.
              toast.info('Go to your device settings to set up biometric authentication.');
            }},
          ]
        );
        return;
      }
    }

    // Authenticate with biometrics before enabling
    try {
      setError(null);

      const authResult = await authenticate(
        'Enable biometric login to protect your identity'
      );

      if (!authResult.success) {
        const errorMsg = getErrorMessage(authResult.error);
        setError(errorMsg);
        toast.error(errorMsg);
        return;
      }

      // Save the setting using mutation
      await updatePrivacyMutation.mutateAsync({ settings: { biometricLogin: true }, userId: user.id });

      // Also store locally for quick access during sign-in
      await AsyncStorage.setItem('oxy_biometric_enabled', 'true');
    } catch (err) {
      console.error('[useBiometricSettings] Failed to enable biometric login:', err);
      const errorMsg = err instanceof Error ? err.message : 'Failed to enable biometric login';
      setError(errorMsg);
      toast.error(errorMsg);
    }
  }, [user?.id, updatePrivacyMutation, canEnable, hasHardware, isEnrolled, alert]);

  /**
   * Refresh device capabilities (useful after user sets up biometrics)
   */
  const refreshCapabilities = useCallback(async () => {
    try {
      const hardwareAvailable = await hasBiometricHardware();
      const enrolled = await isBiometricEnrolled();
      const canUse = await canUseBiometrics();
      const types = await getSupportedTypes();

      setHasHardware(hardwareAvailable);
      setIsEnrolled(enrolled);
      setCanEnable(canUse);
      setSupportedTypes(types.map(getAuthenticationTypeName));
    } catch (err) {
      console.error('[useBiometricSettings] Error refreshing capabilities:', err);
    }
  }, []);

  return {
    enabled,
    canEnable,
    hasHardware,
    isEnrolled,
    supportedTypes,
    isLoading,
    isSaving,
    error,
    toggleBiometricLogin,
    refreshCapabilities,
  };
}

