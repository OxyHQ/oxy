/**
 * Language Methods Mixin
 */
import { normalizeLocale, getPrimaryLanguage, getLanguageMetadata, getLanguageName, getNativeLanguageName } from '../utils/languageUtils';
import type { SupportedLanguage } from '../utils/languageUtils';
import type { OxyServicesBase } from '../OxyServices.base';
import { loadAsyncStorage } from '@oxy.so/protocol';
import { logger } from '../logger';

/**
 * Cross-mixin surface consumed by the language methods. `getCurrentUser` is
 * provided by the user mixin at runtime — both live on the composed
 * `OxyServices` instance — but it is not visible on `OxyServicesBase` at the
 * type level. We narrow `this` through this interface (mirroring the
 * `OxyAuthInstance` pattern in `OxyServices.utility.ts`) instead of casting to
 * `any`. Only the fields this mixin reads are declared, keeping it decoupled
 * from the full `User` shape.
 */
interface LanguageMixinCrossAccess {
  getCurrentUser(): Promise<{ languages?: string[] }>;
}

export function OxyServicesLanguageMixin<T extends typeof OxyServicesBase>(Base: T) {
  return class extends Base {
    constructor(...args: any[]) {
      super(...(args as [any]));
    }
    /**
     * Get appropriate storage for the platform (similar to DeviceManager)
     */
    public async getStorage(): Promise<{
      getItem: (key: string) => Promise<string | null>;
      setItem: (key: string, value: string) => Promise<void>;
      removeItem: (key: string) => Promise<void>;
    }> {
      const isReactNative = typeof navigator !== 'undefined' && navigator.product === 'ReactNative';
      
      if (isReactNative) {
        try {
          // `loadAsyncStorage` is per-platform: the RN variant statically imports
          // @react-native-async-storage/async-storage, the default variant throws
          // (never called outside RN because of the `isReactNative` gate above).
          const asyncStorageModule = await loadAsyncStorage();
          const storage = asyncStorageModule.default;
          return {
            getItem: storage.getItem.bind(storage),
            setItem: storage.setItem.bind(storage),
            removeItem: storage.removeItem.bind(storage),
          };
        } catch (error) {
          logger.error('AsyncStorage not available in React Native', error, { component: 'OxyServices.language' });
          throw new Error('AsyncStorage is required in React Native environment');
        }
      } else {
        // Use localStorage for web
        return {
          getItem: async (key: string) => {
            if (typeof window !== 'undefined' && window.localStorage) {
              return localStorage.getItem(key);
            }
            return null;
          },
          setItem: async (key: string, value: string) => {
            if (typeof window !== 'undefined' && window.localStorage) {
              localStorage.setItem(key, value);
            }
          },
          removeItem: async (key: string) => {
            if (typeof window !== 'undefined' && window.localStorage) {
              localStorage.removeItem(key);
            }
          }
        };
      }
    }

    /**
     * Get the current locale from the user profile or local storage.
     * @param storageKeyPrefix - Optional prefix for storage key (default: 'oxy_session')
     * @returns The current BCP-47 locale (e.g., 'en-US') or null if not set
     */
    async getCurrentLanguage(storageKeyPrefix = 'oxy_session'): Promise<string | null> {
      try {
        // First try the authenticated user's primary account locale.
        try {
          const user = await (this as unknown as LanguageMixinCrossAccess).getCurrentUser();
          const primary = getPrimaryLanguage(user);
          if (primary) {
            return primary;
          }
        } catch {
          // Not authenticated or the profile fetch failed — fall through to the
          // locally stored preference below.
        }

        // Fall back to the locally stored locale preference.
        const storage = await this.getStorage();
        const storageKey = `${storageKeyPrefix}_language`;
        const storedLanguage = await storage.getItem(storageKey);
        if (storedLanguage) {
          return normalizeLocale(storedLanguage) ?? storedLanguage;
        }

        return null;
      } catch (error) {
        logger.warn('Failed to get current language', { component: 'OxyServices.language' }, error);
        return null;
      }
    }

    /**
     * Get the current language with metadata (name, nativeName, etc.)
     * @param storageKeyPrefix - Optional prefix for storage key (default: 'oxy_session')
     * @returns Language metadata object or null if not set
     */
    async getCurrentLanguageMetadata(storageKeyPrefix = 'oxy_session'): Promise<SupportedLanguage | null> {
      const languageCode = await this.getCurrentLanguage(storageKeyPrefix);
      return getLanguageMetadata(languageCode);
    }

    /**
     * Get the current language name (e.g., 'English')
     * @param storageKeyPrefix - Optional prefix for storage key (default: 'oxy_session')
     * @returns Language name or null if not set
     */
    async getCurrentLanguageName(storageKeyPrefix = 'oxy_session'): Promise<string | null> {
      const languageCode = await this.getCurrentLanguage(storageKeyPrefix);
      if (!languageCode) return null;
      return getLanguageName(languageCode);
    }

    /**
     * Get the current native language name (e.g., 'Español')
     * @param storageKeyPrefix - Optional prefix for storage key (default: 'oxy_session')
     * @returns Native language name or null if not set
     */
    async getCurrentNativeLanguageName(storageKeyPrefix = 'oxy_session'): Promise<string | null> {
      const languageCode = await this.getCurrentLanguage(storageKeyPrefix);
      if (!languageCode) return null;
      return getNativeLanguageName(languageCode);
    }
  };
}

