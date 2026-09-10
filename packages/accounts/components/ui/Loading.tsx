import type { FC } from 'react';
import type { ViewStyle } from 'react-native';
import { Loading } from '@oxy.so/bloom/loading';

interface LoadingSpinnerProps {
  iconSize?: number;
  color?: string;
  showText?: boolean;
  style?: ViewStyle;
}

// Default to black to preserve historical visual contract. Bloom's Loading
// falls back to `theme.colors.primary` (brand purple) when `color` is
// undefined, which can be unreadable on primary-colored surfaces and is a
// regression from the previous accounts behavior.
const DEFAULT_SPINNER_COLOR = '#000000';

export const LoadingSpinner: FC<LoadingSpinnerProps> = ({
  iconSize = 26,
  color = DEFAULT_SPINNER_COLOR,
  showText = false,
  style,
}) => (
  <Loading
    variant="spinner"
    iconSize={iconSize}
    color={color}
    showText={showText}
    style={style}
  />
);
