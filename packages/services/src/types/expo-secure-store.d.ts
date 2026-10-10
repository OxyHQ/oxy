declare module 'expo-secure-store' {
  export interface SecureStoreOptions {
    keychainAccessible?:
      | 'WHEN_UNLOCKED'
      | 'AFTER_FIRST_UNLOCK'
      | 'WHEN_UNLOCKED_THIS_DEVICE_ONLY'
      | 'AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY'
      | 'WHEN_PASSCODE_SET_THIS_DEVICE_ONLY';
    requireAuthentication?: boolean;
    authenticationPrompt?: string;
    showModal?: boolean;
    keychainService?: string;
  }

  export const WHEN_UNLOCKED: 'WHEN_UNLOCKED';
  export const AFTER_FIRST_UNLOCK: 'AFTER_FIRST_UNLOCK';
  export const WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'WHEN_UNLOCKED_THIS_DEVICE_ONLY';
  export const AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY: 'AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY';
  export const WHEN_PASSCODE_SET_THIS_DEVICE_ONLY: 'WHEN_PASSCODE_SET_THIS_DEVICE_ONLY';

  export function setItemAsync(
    key: string,
    value: string,
    options?: SecureStoreOptions,
  ): Promise<void>;
  export function getItemAsync(key: string, options?: SecureStoreOptions): Promise<string | null>;
  export function deleteItemAsync(key: string, options?: SecureStoreOptions): Promise<void>;
  export function isAvailableAsync(): Promise<boolean>;
}
