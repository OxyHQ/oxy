import { StyleSheet } from 'react-native';

/**
 * Reusable spacing constants for screens across the codebase
 * These values ensure consistent padding and gaps across all screens
 */

// Screen padding - used for all bottom sheet screens
export const SCREEN_PADDING_HORIZONTAL = 16;
export const SCREEN_PADDING_VERTICAL = 16;
export const SCREEN_PADDING_TOP = 24; // Top padding for screen content (accounts for handle)

// Section gaps
export const SECTION_GAP = 24;
export const SECTION_GAP_LARGE = 32;

// Component gaps
export const COMPONENT_GAP = 12;
export const COMPONENT_GAP_SMALL = 8;

// Header padding
export const HEADER_PADDING_TOP_OVERVIEW = 38;
export const HEADER_PADDING_TOP_SETTINGS = 40;

/**
 * Reusable screen content style for all bottom sheet screens
 * Use this for ScrollView contentContainerStyle to ensure consistent padding
 */
export const screenContentStyle = {
  paddingHorizontal: SCREEN_PADDING_HORIZONTAL,
  paddingVertical: SCREEN_PADDING_VERTICAL,
  paddingTop: SCREEN_PADDING_TOP,
  paddingBottom: SCREEN_PADDING_VERTICAL,
};

/**
 * Reusable screen content style for screens that need custom top padding
 */
export const createScreenContentStyle = (topPadding?: number) => ({
  paddingHorizontal: SCREEN_PADDING_HORIZONTAL,
  paddingVertical: SCREEN_PADDING_VERTICAL,
  paddingTop: topPadding ?? SCREEN_PADDING_TOP,
  paddingBottom: SCREEN_PADDING_VERTICAL,
});
