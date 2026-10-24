import React from 'react';
import { KeyboardAwareScrollView } from 'react-native-keyboard-controller';
import { StyleSheet, type ViewStyle } from 'react-native';
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
  /**
   * Add the top safe-area inset to the content's own `paddingTop`. For screens
   * with no navigator header (every Settings stack screen): without it the
   * first element — the title — renders under the status bar. Auth/onboarding
   * steps that already pad their container with the inset leave this off.
   */
  reserveTopInset?: boolean;
}

export function KeyboardAwareScrollViewWrapper({
  children,
  style,
  contentContainerStyle,
  extraKeyboardSpace = 20,
  bottomOffset,
  keyboardShouldPersistTaps = 'handled',
  reserveTabBarFootprint = false,
  reserveTopInset = false,
}: KeyboardAwareScrollViewWrapperProps) {
  const insets = useSafeAreaInsets();
  const tabBarBottomPad = useScreenBottomPad();
  const reservedBottom = reserveTabBarFootprint ? tabBarBottomPad : insets.bottom;
  const callerStyle = StyleSheet.flatten(contentContainerStyle);
  // Added to the caller's own bottom padding and applied AFTER its style. It
  // used to sit before it, so every caller that sets `padding` (all of them)
  // replaced the tab bar's footprint with its own 16-22pt, and the last control
  // of the screen (Delete account, Create backup, Continue) sat under the
  // floating tab bar.
  const callerBottomPadding = Number(
    callerStyle?.paddingBottom ?? callerStyle?.paddingVertical ?? callerStyle?.padding ?? 0,
  );
  const bottomPadding = reservedBottom + callerBottomPadding;
  // Added to the caller's own top padding rather than replacing it, so a
  // screen keeps its air below the status bar instead of butting against it.
  const callerTopPadding = callerStyle?.paddingTop;
  const topPadding = reserveTopInset
    ? insets.top + (typeof callerTopPadding === 'number' ? callerTopPadding : 0)
    : undefined;

  return (
    <KeyboardAwareScrollView
      style={[styles.container, style]}
      contentContainerStyle={[
        styles.contentContainer,
        contentContainerStyle,
        { paddingBottom: bottomPadding },
        topPadding === undefined ? null : { paddingTop: topPadding },
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
