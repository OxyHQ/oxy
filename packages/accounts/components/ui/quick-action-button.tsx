import React from 'react';
import { StyleSheet, TouchableOpacity, View } from 'react-native';
import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';
import { darkenColor } from '@/utils/color-utils';
import { useHapticPress } from '@/hooks/use-haptic-press';
import type { MaterialCommunityIconName } from '@/types/icons';

/** Default diameter of the circular badge, used by the bottom action bars. */
const DEFAULT_BADGE_SIZE = 48;

interface QuickActionButtonProps {
  /** MaterialCommunityIcons glyph to render inside the circular badge. */
  icon: MaterialCommunityIconName;
  /** Badge background color; the glyph is rendered in a darkened variant. */
  backgroundColor: string;
  onPress: () => void;
  accessibilityLabel: string;
  /**
   * Diameter of the circular badge in dp. Defaults to {@link DEFAULT_BADGE_SIZE}
   * (the bottom action bars); the home footer passes a smaller 36dp badge.
   */
  size?: number;
  /**
   * Optional override for the icon node — used by the theme toggle, which
   * wraps the glyph in an animated container for its rotate/scale transition.
   * When provided, `icon` is ignored.
   */
  iconNode?: React.ReactNode;
}

/**
 * Circular quick-action button used by the desktop and mobile bottom action
 * bars (reload, devices, theme toggle, scan QR). Consolidates the four
 * identical `TouchableOpacity` + badge blocks that were previously inlined
 * three times across the tabs layout.
 */
export function QuickActionButton({
  icon,
  backgroundColor,
  onPress,
  accessibilityLabel,
  size = DEFAULT_BADGE_SIZE,
  iconNode,
}: QuickActionButtonProps) {
  const handlePressIn = useHapticPress();

  return (
    <TouchableOpacity
      style={styles.circleButton}
      onPressIn={handlePressIn}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
    >
      <View
        style={[
          styles.menuIconContainer,
          { width: size, height: size, borderRadius: size / 2, backgroundColor },
        ]}
      >
        {iconNode ?? (
          <MaterialCommunityIcons name={icon} size={22} color={darkenColor(backgroundColor)} />
        )}
      </View>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  circleButton: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  menuIconContainer: {
    alignItems: 'center',
    justifyContent: 'center',
  },
});
