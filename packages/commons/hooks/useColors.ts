import { useMemo } from 'react';
import { useTheme } from '@oxy.so/bloom/theme';
import type { ThemeColors } from '@oxy.so/bloom/theme';
import { DomainColors, type DomainColorKey } from '@/constants/theme';

/** Bloom theme colors merged with accounts-specific domain colors. */
export type AppColors = ThemeColors & Record<DomainColorKey, string>;

/**
 * Single hook that gives every component in the accounts app a merged colour
 * palette: Bloom's ThemeColors (background, text, border, …) plus the
 * accounts-specific DomainColors (sidebar icons, banners, identity badges).
 */
export function useColors(): AppColors {
  const { mode, colors } = useTheme();

  return useMemo<AppColors>(() => {
    const domain = DomainColors[mode];
    return { ...colors, ...domain };
  }, [mode, colors]);
}
