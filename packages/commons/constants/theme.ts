/**
 * Decorative domain colours unique to Commons (identity badge and informational
 * icon tints). Generic UI tokens (background, text, border, etc.) come from
 * Bloom's ThemeColors via `useColors()`.
 */

import { Platform } from 'react-native';

// Semantic icon tints for informational list/grouped-item icons, intentionally
// separate from Bloom's `success`/`warning`/`error` status colours, which carry
// alert semantics; these are decorative accents.
export const DomainColors = {
  light: {
    identityIconPublicKey: '#8B5CF6',
    iconSuccess: '#10B981',
    iconInfo: '#3B82F6',
    iconWarning: '#F59E0B',
  },
  dark: {
    identityIconPublicKey: '#A78BFA',
    iconSuccess: '#34D399',
    iconInfo: '#60A5FA',
    iconWarning: '#FBBF24',
  },
} as const;

export type DomainColorKey = keyof typeof DomainColors.light;

export const Fonts = Platform.select({
  ios: {
    /** iOS `UIFontDescriptorSystemDesignDefault` */
    sans: 'system-ui',
    /** iOS `UIFontDescriptorSystemDesignSerif` */
    serif: 'ui-serif',
    /** iOS `UIFontDescriptorSystemDesignRounded` */
    rounded: 'ui-rounded',
    /** iOS `UIFontDescriptorSystemDesignMonospaced` */
    mono: 'ui-monospace',
  },
  default: {
    sans: 'normal',
    serif: 'serif',
    rounded: 'normal',
    mono: 'monospace',
  },
  web: {
    sans: "system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif",
    serif: "Georgia, 'Times New Roman', serif",
    rounded: "'SF Pro Rounded', 'Hiragino Maru Gothic ProN', Meiryo, 'MS PGothic', sans-serif",
    mono: "SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace",
  },
});
