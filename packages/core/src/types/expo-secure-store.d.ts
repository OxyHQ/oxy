declare module 'expo-secure-store' {
  export interface SecureStoreOptions {
    keychainAccessible?: number;
    keychainAccessGroup?: string;
    keychainService?: string;
    requireAuthentication?: boolean;
  }

  export const WHEN_UNLOCKED: number;
  export const AFTER_FIRST_UNLOCK: number;
  export const WHEN_UNLOCKED_THIS_DEVICE_ONLY: number;
  export const AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY: number;

  export function getItemAsync(key: string, options?: SecureStoreOptions): Promise<string | null>;
  export function setItemAsync(
    key: string,
    value: string,
    options?: SecureStoreOptions,
  ): Promise<void>;
  export function deleteItemAsync(key: string, options?: SecureStoreOptions): Promise<void>;
}
