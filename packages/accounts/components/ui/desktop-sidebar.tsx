import React from 'react';
import { View, StyleSheet } from 'react-native';
import { SidebarContent } from './sidebar-content';

export function DesktopSidebar() {
  return (
    <View style={styles.desktopSidebar}>
      <SidebarContent />
    </View>
  );
}

const styles = StyleSheet.create({
  desktopSidebar: {
    width: '100%',
    padding: 16,
    flex: 1,
    justifyContent: 'center',
  },
});
