import AsyncStorage from '@react-native-async-storage/async-storage';
import type { BloomThemeStorage } from '@oxy.so/bloom/theme';

/** Storage key under which Bloom persists the theme mode + color preset. */
export const THEME_PERSIST_KEY = '{{APP_SLUG}}.theme';

/**
 * Cross-platform storage adapter for `BloomThemeProvider`. AsyncStorage is
 * backed by localStorage on web and native storage on device, and satisfies the
 * `BloomThemeStorage` contract directly.
 */
export const themeStorage: BloomThemeStorage = AsyncStorage;
