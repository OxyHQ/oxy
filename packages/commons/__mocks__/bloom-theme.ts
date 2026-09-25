/**
 * Lightweight `@oxy.so/bloom/theme` stub.
 *
 * Provides a `useTheme()` hook whose return value can be flipped between
 * `'light'` and `'dark'` modes via `__setBloomThemeMode()`. Colours are a
 * deterministic, distinct palette per mode so tests can verify merge behaviour
 * without depending on Bloom's real palette evolving.
 */

import type { Theme, ThemeColors, ThemeMode } from '@oxy.so/bloom/theme';

const lightColors: ThemeColors = {
  background: '#FFFFFF',
  backgroundSecondary: '#F5F5F5',
  backgroundTertiary: '#EFEFEF',
  text: '#000000',
  textSecondary: '#333333',
  textTertiary: '#666666',
  border: '#E0E0E0',
  borderLight: '#F0F0F0',
  primary: '#0A7EA4',
  primaryForeground: '#FFFFFF',
  primaryLight: '#5BB8D9',
  primaryDark: '#075A75',
  secondary: '#FF9500',
  secondaryForeground: '#FFFFFF',
  tertiary: '#AF52DE',
  tertiaryForeground: '#FFFFFF',
  tint: '#0A7EA4',
  icon: '#1A73E8',
  iconActive: '#0A7EA4',
  success: '#34C759',
  error: '#FF3B30',
  warning: '#FF9500',
  info: '#5AC8FA',
  primarySubtle: '#E8F0FE',
  primarySubtleForeground: '#0A7EA4',
  negative: '#FF3B30',
  negativeForeground: '#FFFFFF',
  negativeSubtle: '#FFE5E3',
  negativeSubtleForeground: '#7A1A14',
  contrast50: '#80808080',
  card: '#FFFFFF',
  shadow: '#0000001A',
  overlay: '#0000007F',
};

const darkColors: ThemeColors = {
  background: '#000000',
  backgroundSecondary: '#1C1C1E',
  backgroundTertiary: '#2C2C2E',
  text: '#FFFFFF',
  textSecondary: '#CCCCCC',
  textTertiary: '#999999',
  border: '#38383A',
  borderLight: '#48484A',
  primary: '#0A84FF',
  primaryForeground: '#FFFFFF',
  primaryLight: '#5AC8FA',
  primaryDark: '#0040DD',
  secondary: '#FF9F0A',
  secondaryForeground: '#000000',
  tertiary: '#BF5AF2',
  tertiaryForeground: '#FFFFFF',
  tint: '#0A84FF',
  icon: '#8AB4F8',
  iconActive: '#0A84FF',
  success: '#30D158',
  error: '#FF453A',
  warning: '#FF9F0A',
  info: '#64D2FF',
  primarySubtle: '#1C2840',
  primarySubtleForeground: '#0A84FF',
  negative: '#FF453A',
  negativeForeground: '#FFFFFF',
  negativeSubtle: '#3A1A18',
  negativeSubtleForeground: '#FFB3AD',
  contrast50: '#80808080',
  card: '#1C1C1E',
  shadow: '#000000CC',
  overlay: '#000000B3',
};

let currentMode: 'light' | 'dark' = 'light';

export function __setBloomThemeMode(mode: 'light' | 'dark'): void {
  currentMode = mode;
}

export function useTheme(): Theme {
  const mode = currentMode;
  return {
    mode,
    colors: mode === 'dark' ? darkColors : lightColors,
    gradients: {},
    isDark: mode === 'dark',
    isLight: mode === 'light',
  };
}

/** Mirrors Bloom's `parseRgb`: hex or `rgb()`/`rgba()` channels, or null. */
export function parseRgb(color: string): { r: number; g: number; b: number } | null {
  const trimmed = color.trim();
  if (trimmed.startsWith('#')) {
    let hex = trimmed.slice(1);
    if (hex.length === 3) hex = hex.split('').map((c) => c + c).join('');
    if (hex.length !== 6) return null;
    const [r, g, b] = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16));
    return [r, g, b].some(Number.isNaN) ? null : { r, g, b };
  }
  const match = /rgba?\(([^)]+)\)/i.exec(trimmed);
  if (!match) return null;
  const [r, g, b] = match[1].split(/[\s,/]+/).filter(Boolean).map(Number);
  return [r, g, b].some((v) => v === undefined || Number.isNaN(v)) ? null : { r, g, b };
}

/** Mirrors Bloom's `withAlpha`. */
export function withAlpha(color: string, alpha: number): string {
  const rgb = parseRgb(color);
  return rgb ? `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${alpha})` : color;
}

export type { Theme, ThemeColors, ThemeMode };
