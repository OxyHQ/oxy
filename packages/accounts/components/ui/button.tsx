import type { ReactNode } from 'react';
import type { ViewStyle, TextStyle } from 'react-native';
import { Button as BloomButton } from '@oxy.so/bloom/button';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost';

export interface ButtonProps {
  children: ReactNode;
  onPress?: () => void;
  variant?: ButtonVariant;
  disabled?: boolean;
  loading?: boolean;
  style?: ViewStyle;
  textStyle?: TextStyle;
  testID?: string;
}

export function Button({
  children,
  onPress,
  variant = 'primary',
  disabled = false,
  loading = false,
  style,
  textStyle,
  testID,
}: ButtonProps) {
  return (
    <BloomButton
      onPress={onPress}
      variant={variant}
      disabled={disabled}
      loading={loading}
      style={style}
      textStyle={textStyle}
      testID={testID}
    >
      {children}
    </BloomButton>
  );
}
