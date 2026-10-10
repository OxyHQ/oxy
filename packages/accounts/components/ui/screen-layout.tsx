import React from 'react';
import { View, ScrollView, StyleSheet, Platform, useWindowDimensions } from 'react-native';
import { useColors } from '@/hooks/useColors';
import { DesktopSidebar } from './desktop-sidebar';

interface ScreenLayoutProps {
  children: React.ReactNode;
  showTopBar?: boolean;
  topBarContent?: React.ReactNode;
}

export function ScreenLayout({ children, showTopBar = false, topBarContent }: ScreenLayoutProps) {
  const { width } = useWindowDimensions();
  const colors = useColors();
  const isDesktop = Platform.OS === 'web' && width >= 768;

  if (isDesktop) {
    return (
      <View style={[styles.container, { backgroundColor: colors.background }]}>
        {showTopBar && topBarContent && (
          <View
            style={[
              styles.desktopTopBar,
              { backgroundColor: colors.background, borderBottomColor: colors.border },
            ]}
          >
            {topBarContent}
          </View>
        )}
        <View style={styles.desktopBody}>
          <DesktopSidebar />
          <ScrollView
            style={styles.desktopMain}
            contentContainerStyle={styles.desktopMainContent}
            showsVerticalScrollIndicator={false}
          >
            {children}
          </ScrollView>
        </View>
      </View>
    );
  }

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <ScrollView
        style={styles.scrollView}
        contentContainerStyle={styles.mobileContent}
        showsVerticalScrollIndicator={false}
      >
        {children}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  desktopTopBar: {
    height: 64,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 24,
    borderBottomWidth: 1,
  },
  desktopBody: {
    flex: 1,
    flexDirection: 'row',
  },
  desktopMain: {
    flex: 1,
  },
  desktopMainContent: {
    padding: 24,
  },
  scrollView: {
    flex: 1,
  },
  mobileContent: {
    padding: 16,
  },
});
