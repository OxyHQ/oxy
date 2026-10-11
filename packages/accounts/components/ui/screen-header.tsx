import React from 'react';
import {
  View,
  StyleSheet,
  Platform,
  useWindowDimensions,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { ThemedText } from '@/components/themed-text';

interface ScreenHeaderProps {
  title: string;
  subtitle?: string;
  style?: StyleProp<ViewStyle>;
}

export function ScreenHeader({ title, subtitle, style }: ScreenHeaderProps) {
  const { width } = useWindowDimensions();
  const isDesktop = Platform.OS === 'web' && width >= 768;

  return (
    <View style={[isDesktop ? styles.desktopHeader : styles.mobileHeader, style]}>
      <ThemedText style={isDesktop ? styles.title : styles.mobileTitle}>{title}</ThemedText>
      {subtitle && (
        <ThemedText style={isDesktop ? styles.subtitle : styles.mobileSubtitle}>
          {subtitle}
        </ThemedText>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  desktopHeader: {
    marginBottom: 24,
    paddingTop: 24,
    paddingBottom: 4,
  },
  mobileHeader: {
    marginBottom: 20,
    paddingTop: 24,
    paddingBottom: 4,
  },
  title: {
    fontSize: 48,
    lineHeight: 56,
    fontWeight: Platform.OS === 'web' ? 'bold' : undefined,
  },
  subtitle: {
    fontSize: 16,
    opacity: 0.7,
    marginTop: 16,
    lineHeight: 22,
  },
  mobileTitle: {
    fontSize: 40,
    lineHeight: 48,
    fontWeight: Platform.OS === 'web' ? 'bold' : undefined,
  },
  mobileSubtitle: {
    fontSize: 15,
    opacity: 0.6,
    marginTop: 16,
    lineHeight: 21,
  },
});
