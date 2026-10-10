import React, { useMemo, memo } from 'react';
import { StyleSheet, Text, type TextProps } from 'react-native';
import { useColors } from '@/hooks/useColors';

export type ThemedTextProps = TextProps & {
  lightColor?: string;
  darkColor?: string;
  type?: 'default' | 'title' | 'defaultSemiBold' | 'subtitle' | 'link';
};

const ThemedTextComponent = ({ style, type = 'default', ...rest }: ThemedTextProps) => {
  const colors = useColors();

  const textStyle = useMemo(
    () => [
      { color: type === 'link' ? colors.tint : colors.text },
      type === 'default' ? styles.default : undefined,
      type === 'title' ? styles.title : undefined,
      type === 'defaultSemiBold' ? styles.defaultSemiBold : undefined,
      type === 'subtitle' ? styles.subtitle : undefined,
      type === 'link' ? styles.link : undefined,
      style,
    ],
    [colors.text, colors.tint, type, style],
  );

  return <Text style={textStyle} {...rest} />;
};

ThemedTextComponent.displayName = 'ThemedText';

export const ThemedText = memo(ThemedTextComponent);

const styles = StyleSheet.create({
  default: {
    fontSize: 16,
    lineHeight: 24,
  },
  defaultSemiBold: {
    fontSize: 16,
    lineHeight: 24,
    fontWeight: '600',
  },
  title: {
    fontSize: 32,
    fontWeight: 'bold',
    lineHeight: 32,
  },
  subtitle: {
    fontSize: 20,
    fontWeight: 'bold',
  },
  link: {
    lineHeight: 30,
    fontSize: 16,
  },
});
