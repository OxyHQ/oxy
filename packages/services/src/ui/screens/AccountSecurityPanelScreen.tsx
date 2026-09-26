/**
 * The frame the account's own security panels render in when presented as a
 * surface (`showBottomSheet('DeleteAccount' | 'LinkCommons' | 'SignInPassword'
 * | 'SignInAuthenticator')`): the panel draws its own large header, so the bar
 * holds only the way back, and the body keeps the dialog's screen gutter.
 */

import type React from 'react';
import { StyleSheet, View } from 'react-native';
import { useSurfaceHeader } from '../hooks/useSurfaceHeader';

/** Bloom's large-title gutter (`screen-margin`), as the account dialog uses. */
const SCREEN_MARGIN = 20;

export const AccountSecurityPanelFrame: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  useSurfaceHeader({});
  return <View style={styles.body}>{children}</View>;
};

const styles = StyleSheet.create({
  body: {
    paddingTop: 4,
    paddingBottom: 20,
    paddingHorizontal: SCREEN_MARGIN,
  },
});
