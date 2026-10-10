import type React from 'react';
import { View, StyleSheet, type StyleProp, type ViewStyle } from 'react-native';
import SectionTitle from './section-title';
import { useColorScheme } from '@/hooks/use-color-scheme';
import { normalizeColorScheme } from '@/utils/themeUtils';

interface SectionProps {
  title?: string;
  theme?: 'light' | 'dark';
  children: React.ReactNode;
  isFirst?: boolean;
  style?: StyleProp<ViewStyle>;
}

const Section: React.FC<SectionProps> = ({ title, theme, children, isFirst = false, style }) => {
  const colorScheme = normalizeColorScheme(useColorScheme(), theme);

  return (
    <View style={[styles.section, isFirst && styles.firstSection, style]}>
      {title && <SectionTitle title={title} theme={colorScheme} />}
      {children}
    </View>
  );
};

const styles = StyleSheet.create({
  section: {
    marginBottom: 10,
    gap: 12,
  },
  firstSection: {
    marginTop: 8,
  },
});

export default Section;
