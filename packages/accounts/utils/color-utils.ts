/**
 * Darkens a color by a specified factor
 * Returns a darker version of the color
 */
export const darkenColor = (color: string, factor: number = 0.6): string => {
  // Remove # if present
  const hex = color.replace('#', '');

  // Convert to RGB
  const r = parseInt(hex.substring(0, 2), 16);
  const g = parseInt(hex.substring(2, 4), 16);
  const b = parseInt(hex.substring(4, 6), 16);

  // Darken by factor
  const newR = Math.max(0, Math.round(r * (1 - factor)));
  const newG = Math.max(0, Math.round(g * (1 - factor)));
  const newB = Math.max(0, Math.round(b * (1 - factor)));

  return `#${newR.toString(16).padStart(2, '0')}${newG.toString(16).padStart(2, '0')}${newB.toString(16).padStart(2, '0')}`;
};

/**
 * Normalizes a color scheme value to ensure it's always 'light' or 'dark'
 * Handles null/undefined cases with proper fallback chain
 *
 * @param colorScheme - The color scheme from useColorScheme() hook (may be null/undefined)
 * @param theme - Optional theme prop as fallback
 * @returns Normalized 'light' | 'dark' color scheme
 *
 * @example
 * ```ts
 * const colorScheme = normalizeColorScheme(useColorScheme(), theme);
 * ```
 */
export const normalizeColorScheme = (
  colorScheme?: string | null,
  theme?: string,
): 'light' | 'dark' => {
  // First try the colorScheme from hook
  if (colorScheme === 'light' || colorScheme === 'dark') {
    return colorScheme;
  }

  // Fallback to theme prop
  if (theme === 'light' || theme === 'dark') {
    return theme;
  }

  // Default to light
  return 'light';
};
