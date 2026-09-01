import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from 'react';
import { Appearance, Platform } from 'react-native';
import type { ThemeMode } from '@oxyhq/bloom/theme';

interface ThemeModeContextValue {
  themeMode: ThemeMode;
  setThemeMode: (mode: ThemeMode) => void;
  toggleTheme: () => void;
}

const ThemeModeContext = createContext<ThemeModeContextValue | null>(null);

const STORAGE_KEY = 'oxy_theme_preference';

function loadThemeSync(): ThemeMode {
  if (Platform.OS === 'web' && typeof window !== 'undefined' && window.localStorage) {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (stored === 'light' || stored === 'dark' || stored === 'system') {
      return stored;
    }
  }
  return 'system';
}

function isSystemDark(): boolean {
  if (Platform.OS === 'web' && typeof window !== 'undefined' && window.matchMedia) {
    return window.matchMedia('(prefers-color-scheme: dark)').matches;
  }
  return Appearance.getColorScheme() === 'dark';
}

export function ThemeModeProvider({ children }: { children: ReactNode }) {
  const [themeMode, setThemeModeState] = useState<ThemeMode>(loadThemeSync);
  const [isLoaded, setIsLoaded] = useState(Platform.OS === 'web');

  useEffect(() => {
    if (Platform.OS === 'web') return;
    (async () => {
      try {
        const AsyncStorage = await import('@react-native-async-storage/async-storage').then(
          (m) => m.default,
        );
        const stored = await AsyncStorage.getItem(STORAGE_KEY);
        if (stored === 'light' || stored === 'dark' || stored === 'system') {
          setThemeModeState(stored);
        }
      } catch {
        // Native storage read failed — keep the default.
      } finally {
        setIsLoaded(true);
      }
    })();
  }, []);

  useEffect(() => {
    if (!isLoaded) return;
    (async () => {
      try {
        if (Platform.OS === 'web') {
          window.localStorage?.setItem(STORAGE_KEY, themeMode);
        } else {
          const AsyncStorage = await import('@react-native-async-storage/async-storage').then(
            (m) => m.default,
          );
          await AsyncStorage.setItem(STORAGE_KEY, themeMode);
        }
      } catch {
        // Persistence failure is non-fatal.
      }
    })();
  }, [themeMode, isLoaded]);

  const setThemeMode = useCallback((mode: ThemeMode) => {
    setThemeModeState(mode);
  }, []);

  const toggleTheme = useCallback(() => {
    setThemeModeState((current) => {
      if (current === 'system') {
        return isSystemDark() ? 'light' : 'dark';
      }
      return current === 'dark' ? 'light' : 'dark';
    });
  }, []);

  return (
    <ThemeModeContext.Provider value={{ themeMode, setThemeMode, toggleTheme }}>
      {children}
    </ThemeModeContext.Provider>
  );
}

export function useThemeMode() {
  const ctx = useContext(ThemeModeContext);
  if (!ctx) {
    throw new Error('useThemeMode must be used within ThemeModeProvider');
  }
  return ctx;
}
