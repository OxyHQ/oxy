import { Animated, Platform, type ShadowStyleIOS, type ViewStyle } from 'react-native';

const SHADOW_COLOR = '#000000';
const SHADOW_OPACITY = 0.24;
const MD3_SHADOW_OPACITY = 0.3;
const MD3_SHADOW_COLOR = '#000000';

export default function shadow(
  elevation: number | Animated.Value = 0,
  isV3 = false
): ViewStyle | ShadowStyleIOS {
  return isV3 ? v3Shadow(elevation) : v2Shadow(elevation);
}

function v2Shadow(elevation: number | Animated.Value = 0): ViewStyle | ShadowStyleIOS {
  if (elevation instanceof Animated.Value) {
    const inputRange = [0, 1, 2, 3, 8, 24];

    if (Platform.OS === 'ios') {
      return {
        shadowColor: SHADOW_COLOR,
        shadowOffset: {
          width: 0,
          height: elevation.interpolate({
            inputRange,
            outputRange: [0, 0.5, 0.75, 2, 7, 23],
          }),
        },
        shadowOpacity: elevation.interpolate({
          inputRange: [0, 1],
          outputRange: [0, SHADOW_OPACITY],
          extrapolate: 'clamp',
        }),
        shadowRadius: elevation.interpolate({
          inputRange,
          outputRange: [0, 0.75, 1.5, 3, 8, 24],
        }),
      } as unknown as ShadowStyleIOS;
    }
      return {
        elevation: elevation.interpolate({
          inputRange,
          outputRange: [0, 1, 2, 3, 8, 24],
        }) as unknown as number,
      };
  }
    if (elevation === 0) {
      return {};
    }

    let height: number;
    let radius: number;
    switch (elevation) {
      case 1:
        height = 0.5;
        radius = 0.75;
        break;
      case 2:
        height = 0.75;
        radius = 1.5;
        break;
      default:
        height = elevation - 1;
        radius = elevation;
    }

    if (Platform.OS === 'ios') {
      return {
        shadowColor: SHADOW_COLOR,
        shadowOffset: {
          width: 0,
          height,
        },
        shadowOpacity: SHADOW_OPACITY,
        shadowRadius: radius,
      } as ShadowStyleIOS;
    }
      return {
        elevation: elevation,
      };
}

function v3Shadow(elevation: number | Animated.Value = 0): ViewStyle | ShadowStyleIOS {
  const inputRange = [0, 1, 2, 3, 4, 5];
  const shadowHeight = [0, 1, 2, 4, 6, 8];
  const shadowRadius = [0, 3, 6, 8, 10, 12];

  if (elevation instanceof Animated.Value) {
    if (Platform.OS === 'ios') {
      return {
        shadowColor: MD3_SHADOW_COLOR,
        shadowOffset: {
          width: 0,
          height: elevation.interpolate({
            inputRange,
            outputRange: shadowHeight,
          }),
        },
        shadowOpacity: elevation.interpolate({
          inputRange: [0, 1],
          outputRange: [0, MD3_SHADOW_OPACITY],
          extrapolate: 'clamp',
        }),
        shadowRadius: elevation.interpolate({
          inputRange,
          outputRange: shadowRadius,
        }),
      } as unknown as ShadowStyleIOS;
    }
      return {
        elevation: elevation.interpolate({
          inputRange,
          outputRange: [0, 1, 2, 3, 4, 5],
        }) as unknown as number,
      };
  }
    if (Platform.OS === 'ios') {
      return {
        shadowColor: MD3_SHADOW_COLOR,
        shadowOpacity: elevation ? MD3_SHADOW_OPACITY : 0,
        shadowOffset: {
          width: 0,
          height: shadowHeight[elevation] || 0,
        },
        shadowRadius: shadowRadius[elevation] || 0,
      } as ShadowStyleIOS;
    }
      return {
        elevation: elevation || 0,
      };
}
