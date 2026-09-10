import type React from 'react';
import { ActivityIndicator, StyleSheet } from 'react-native';
import { useTheme } from '@oxy.so/bloom/theme';
import { PressableScale } from '@oxy.so/bloom/pressable-scale';
import { Text } from '@oxy.so/bloom/typography';

export interface SurfaceHeaderActionProps {
  /** Button label (e.g. a translated "Save"). */
  label: string;
  onPress: () => void;
  /** Show a spinner instead of the label (also disables the button). */
  loading?: boolean;
  disabled?: boolean;
}

/**
 * A filled pill action for a surface's nav-header right slot — the canonical
 * "Save" affordance. Pass a memoized instance to `useSurfaceHeader({ right })`
 * so the header does not thrash between renders.
 */
export const SurfaceHeaderAction: React.FC<SurfaceHeaderActionProps> = ({
  label,
  onPress,
  loading,
  disabled,
}) => {
  const { colors } = useTheme();
  const isDisabled = disabled || loading;
  return (
    <PressableScale
      onPress={onPress}
      disabled={isDisabled}
      accessibilityRole="button"
      accessibilityLabel={label}
      style={[styles.button, { backgroundColor: colors.primary, opacity: isDisabled ? 0.5 : 1 }]}
    >
      {loading ? (
        <ActivityIndicator size="small" color={colors.primaryForeground} />
      ) : (
        <Text style={[styles.label, { color: colors.primaryForeground }]}>{label}</Text>
      )}
    </PressableScale>
  );
};

const styles = StyleSheet.create({
  button: {
    height: 36,
    minWidth: 64,
    paddingHorizontal: 14,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
  },
  label: {
    fontSize: 14,
    fontWeight: '600',
    letterSpacing: -0.2,
  },
});
