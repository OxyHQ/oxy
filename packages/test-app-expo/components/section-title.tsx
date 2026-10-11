import type React from 'react';
import { Text, StyleSheet, type StyleProp, type TextStyle } from 'react-native';
import { useColorScheme } from '@/hooks/use-color-scheme';
import { normalizeColorScheme } from '@/utils/themeUtils';
import { useThemeStyles } from '@/hooks/use-theme-styles';

interface SectionTitleProps {
  title: string;
  theme?: 'light' | 'dark';
  style?: StyleProp<TextStyle>;
}

const SectionTitle: React.FC<SectionTitleProps> = ({ title, theme, style }) => {
  const colorScheme = normalizeColorScheme(useColorScheme(), theme);
  const themeStyles = useThemeStyles(theme || colorScheme, colorScheme);

  return (
    <Text style={[styles.sectionTitle, { color: themeStyles.textColor }, style]}>{title}</Text>
  );
};

const styles = StyleSheet.create({
  sectionTitle: {
    fontSize: 16,
    fontWeight: '600',
  },
});

export default SectionTitle;
