import React from 'react';
import { KeyboardAwareScrollView } from 'react-native-keyboard-controller';
import { StyleSheet, ViewStyle } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useScreenBottomPad } from './screen';

interface KeyboardAwareScrollViewWrapperProps {
  children: React.ReactNode;
  style?: ViewStyle | ViewStyle[];
  contentContainerStyle?: ViewStyle | ViewStyle[];
  extraKeyboardSpace?: number;
  /**
   * Space kept between the keyboard and the focused input's caret. Pass the
   * height of whatever sits UNDER the input and must stay visible while typing
   * (a status line, the submit button); the default keeps only the input itself
   * above the keyboard.
   */
  bottomOffset?: number;
  keyboardShouldPersistTaps?: 'always' | 'never' | 'handled';
  /**
   * Reserve space for the floating tab bar (tab screens only). Auth/onboarding
   * screens leave this off and get only the safe-area inset.
   */
  reserveTabBarFootprint?: boolean;
}

export function KeyboardAwareScrollViewWrapper({
  children,
  style,
  contentContainerStyle,
  extraKeyboardSpace = 20,
  bottomOffset,
  keyboardShouldPersistTaps = 'handled',
  reserveTabBarFootprint = false,
}: KeyboardAwareScrollViewWrapperProps) {
  const insets = useSafeAreaInsets();
  const tabBarBottomPad = useScreenBottomPad();
  const bottomPadding = reserveTabBarFootprint ? tabBarBottomPad : insets.bottom;

  return (
    <KeyboardAwareScrollView
      style={[styles.container, style]}
      contentContainerStyle={[
        styles.contentContainer,
        { paddingBottom: bottomPadding },
        contentContainerStyle,
      ]}
      extraKeyboardSpace={extraKeyboardSpace}
      bottomOffset={bottomOffset}
      keyboardShouldPersistTaps={keyboardShouldPersistTaps}
      showsVerticalScrollIndicator={false}
    >
      {children}
    </KeyboardAwareScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  contentContainer: {
    flexGrow: 1,
  },
});

