import { useMemo } from 'react';
import { useTheme } from '@oxy.so/bloom/theme';
import type { ThemeColors } from '@oxy.so/bloom/theme';
import { DomainColors, type DomainColorKey } from '@/constants/theme';

/** Bloom theme colors merged with Commons domain colors. */
export type AppColors = ThemeColors & Record<DomainColorKey, string>;

/**
 * Single hook that gives every Commons component a merged colour palette:
 * Bloom's ThemeColors (background, text, border, …) plus the Commons
 * DomainColors (identity badge and informational icon tints).
 */
export function useColors(): AppColors {
  const { mode, colors } = useTheme();

  return useMemo<AppColors>(() => {
    const domain = DomainColors[mode];
    return { ...colors, ...domain };
  }, [mode, colors]);
}
