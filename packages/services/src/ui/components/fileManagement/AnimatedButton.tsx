import type React from 'react';
import { useEffect, useRef } from 'react';
import { TouchableOpacity, Animated, Easing } from 'react-native';
import MaterialCommunityIcons from '../../icons/MaterialCommunityIcons';

interface AnimatedButtonProps {
  isSelected: boolean;
  onPress: () => void;
  icon: string;
  primaryColor: string;
  textColor: string;
  style: Record<string, unknown>;
  accessibilityLabel: string;
}

/**
 * Animated button component for smooth selection transitions
 * Used in file management views for view mode toggles
 */
export const AnimatedButton: React.FC<AnimatedButtonProps> = ({
  isSelected,
  onPress,
  icon,
  primaryColor,
  textColor,
  style,
  accessibilityLabel,
}) => {
  const animatedValue = useRef(new Animated.Value(isSelected ? 1 : 0)).current;

  useEffect(() => {
    Animated.timing(animatedValue, {
      toValue: isSelected ? 1 : 0,
      duration: 200,
      easing: Easing.out(Easing.ease),
      useNativeDriver: false,
    }).start();
  }, [isSelected, animatedValue]);

  const backgroundColor = animatedValue.interpolate({
    inputRange: [0, 1],
    outputRange: ['transparent', primaryColor],
  });

  return (
    <TouchableOpacity
      onPress={onPress}
      activeOpacity={0.7}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ selected: isSelected }}
    >
      <Animated.View style={[style, { backgroundColor }]}>
        <Animated.View>
          <MaterialCommunityIcons
            name={icon as React.ComponentProps<typeof MaterialCommunityIcons>['name']}
            size={16}
            color={isSelected ? '#FFFFFF' : textColor}
          />
        </Animated.View>
      </Animated.View>
    </TouchableOpacity>
  );
};
