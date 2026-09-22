import { Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import type { BloomThemeStorage } from '@oxy.so/bloom/theme';

/**
 * Where Bloom persists this app's theme mode and colour preset.
 *
 * A NEW key, deliberately. Commons used to persist a bare mode string under
 * `oxy_theme_preference` from its own `ThemeModeProvider`; Bloom persists a
 * `{ mode, colorPreset }` JSON object. Reusing the key would hand Bloom a value
 * it cannot parse on every existing install. Nothing is lost by starting clean:
 * the old provider exposed `setThemeMode`/`toggleTheme` and NOTHING in the app
 * ever called them, so no install can hold anything but the default.
 */
export const THEME_PERSIST_KEY = 'oxy.commons.theme';

/**
 * The storage adapter Bloom pairs with {@link THEME_PERSIST_KEY}.
 *
 * Commons is native-only (no web build — see `platforms` in app.config.js), so
 * AsyncStorage is the real path and the `localStorage` branch exists only for
 * Jest's jsdom environment and any future web target. Bloom awaits both, so an
 * async adapter needs no consumer-side branching; with `persistKey` + `storage`
 * both set it also gates its subtree until the read resolves, which is what
 * stops a native cold start flashing the default palette.
 */
export const themeStorage: BloomThemeStorage = {
  getItem(key) {
    if (Platform.OS === 'web') {
      try {
        return globalThis.localStorage?.getItem(key) ?? null;
      } catch {
        return null;
      }
    }
    return AsyncStorage.getItem(key);
  },
  setItem(key, value) {
    if (Platform.OS === 'web') {
      try {
        globalThis.localStorage?.setItem(key, value);
      } catch {
        // A private window or blocked site data: the preference simply does not
        // survive the session. Never fatal.
      }
      return;
    }
    return AsyncStorage.setItem(key, value);
  },
  removeItem(key) {
    if (Platform.OS === 'web') {
      try {
        globalThis.localStorage?.removeItem(key);
      } catch {
        // Same as setItem.
      }
      return;
    }
    return AsyncStorage.removeItem(key);
  },
};
