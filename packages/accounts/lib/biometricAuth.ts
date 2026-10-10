/**
 * Biometric Authentication Service
 *
 * Provides biometric authentication (FaceID/TouchID/Fingerprint) functionality
 * using expo-local-authentication. This acts as a local security layer to protect
 * access to the private key stored on the device.
 */

import * as LocalAuthentication from 'expo-local-authentication';
import { Platform } from 'react-native';

export type AuthenticationType = LocalAuthentication.AuthenticationType;
export type LocalAuthenticationError = LocalAuthentication.LocalAuthenticationError;

export interface BiometricAuthResult {
  success: boolean;
  error?: LocalAuthenticationError;
  warning?: string;
}

/**
 * Check if biometric hardware is available on the device
 */
export async function hasBiometricHardware(): Promise<boolean> {
  if (Platform.OS === 'web') {
    return false;
  }

  try {
    return await LocalAuthentication.hasHardwareAsync();
  } catch (error) {
    console.error('[BiometricAuth] Error checking hardware:', error);
    return false;
  }
}

/**
 * Check if biometrics are enrolled on the device
 */
export async function isBiometricEnrolled(): Promise<boolean> {
  if (Platform.OS === 'web') {
    return false;
  }

  try {
    return await LocalAuthentication.isEnrolledAsync();
  } catch (error) {
    console.error('[BiometricAuth] Error checking enrollment:', error);
    return false;
  }
}

/**
 * Get the security level of enrolled authentication
 */
export async function getEnrolledLevel(): Promise<LocalAuthentication.SecurityLevel> {
  if (Platform.OS === 'web') {
    return LocalAuthentication.SecurityLevel.NONE;
  }

  try {
    return await LocalAuthentication.getEnrolledLevelAsync();
  } catch (error) {
    console.error('[BiometricAuth] Error getting enrolled level:', error);
    return LocalAuthentication.SecurityLevel.NONE;
  }
}

/**
 * Get supported authentication types on the device
 */
export async function getSupportedTypes(): Promise<AuthenticationType[]> {
  if (Platform.OS === 'web') {
    return [];
  }

  try {
    return await LocalAuthentication.supportedAuthenticationTypesAsync();
  } catch (error) {
    console.error('[BiometricAuth] Error getting supported types:', error);
    return [];
  }
}

/**
 * Check if biometric authentication can be used
 * (hardware available AND enrolled)
 */
export async function canUseBiometrics(): Promise<boolean> {
  if (Platform.OS === 'web') {
    return false;
  }

  const hasHardware = await hasBiometricHardware();
  const isEnrolled = await isBiometricEnrolled();

  return hasHardware && isEnrolled;
}

/**
 * Authenticate user with biometrics
 *
 * @param reason - Reason for authentication (shown to user)
 * @param options - Additional authentication options
 * @returns Promise resolving to authentication result
 */
export async function authenticate(
  reason: string = 'Authenticate to access your identity',
  options?: LocalAuthentication.LocalAuthenticationOptions,
): Promise<BiometricAuthResult> {
  if (Platform.OS === 'web') {
    return {
      success: false,
      error: 'not_available' as LocalAuthenticationError,
    };
  }

  try {
    // Check if biometrics can be used
    const canUse = await canUseBiometrics();
    if (!canUse) {
      const hasHardware = await hasBiometricHardware();
      if (!hasHardware) {
        return {
          success: false,
          error: 'not_available' as LocalAuthenticationError,
        };
      }
      return {
        success: false,
        error: 'not_enrolled' as LocalAuthenticationError,
      };
    }

    // Perform authentication
    const result = await LocalAuthentication.authenticateAsync({
      promptMessage: reason,
      cancelLabel: 'Cancel',
      disableDeviceFallback: false,
      fallbackLabel: 'Use Passcode',
      ...options,
    });

    if (result.success) {
      return { success: true };
    } else {
      return {
        success: false,
        error: result.error,
        warning: result.warning,
      };
    }
  } catch (error) {
    console.error('[BiometricAuth] Authentication error:', error);
    return {
      success: false,
      error: 'unknown' as LocalAuthenticationError,
    };
  }
}

/**
 * Cancel ongoing authentication
 */
export async function cancelAuthenticate(): Promise<void> {
  if (Platform.OS === 'web') {
    return;
  }

  try {
    await LocalAuthentication.cancelAuthenticate();
  } catch (error) {
    console.error('[BiometricAuth] Error canceling authentication:', error);
  }
}

/**
 * Get human-readable name for authentication type
 */
export function getAuthenticationTypeName(type: AuthenticationType): string {
  switch (type) {
    case LocalAuthentication.AuthenticationType.FINGERPRINT:
      return 'Fingerprint';
    case LocalAuthentication.AuthenticationType.FACIAL_RECOGNITION:
      return Platform.OS === 'ios' ? 'Face ID' : 'Face Recognition';
    case LocalAuthentication.AuthenticationType.IRIS:
      return 'Iris';
    default:
      return 'Biometric';
  }
}

/**
 * Get human-readable error message
 */
export function getErrorMessage(error?: LocalAuthenticationError): string {
  if (!error) {
    return 'Authentication failed';
  }

  switch (error) {
    case 'not_available':
      return 'Biometric authentication is not available on this device';
    case 'not_enrolled':
      return 'No biometrics enrolled. Please set up Face ID, Touch ID, or fingerprint in your device settings';
    case 'user_cancel':
      return 'Authentication was cancelled';
    case 'app_cancel':
      return 'Authentication was cancelled by the app';
    case 'system_cancel':
      return 'Authentication was cancelled by the system';
    case 'lockout':
      return 'Too many failed attempts. Please try again later';
    case 'timeout':
      return 'Authentication timed out';
    case 'unable_to_process':
      return 'Unable to process biometric authentication';
    case 'passcode_not_set':
      return 'Device passcode is not set. Please set a passcode in device settings';
    case 'user_fallback':
      return 'User chose to use passcode instead';
    case 'invalid_context':
      return 'Invalid authentication context';
    case 'no_space':
      return 'Not enough storage space for biometric data';
    case 'authentication_failed':
      return 'Biometric authentication failed';
    default:
      return 'Authentication failed';
  }
}
