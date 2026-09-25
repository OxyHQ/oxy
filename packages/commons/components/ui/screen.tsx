import React, { useMemo } from 'react';
import { RefreshControl, StyleSheet, type StyleProp, type ViewStyle } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Screen as BloomScreen, ScreenScrollView } from '@oxy.so/bloom/screen';
import { useMinimizeOnScroll, useTabBarFootprint } from '@oxy.so/bloom/tab-bar';
import { useTheme } from '@oxy.so/bloom/theme';

/** Horizontal gutter shared by every Commons screen. */
export const SCREEN_PADDING = 22;
/** Vertical air between top-level sections. */
const SECTION_GAP = 32;

/**
 * Air between the end of a screen's content and the top of the floating bar.
 * Sized so the last row also clears the ID screen's FAB, which sits one
 * footprint up in the same corner.
 */
const SCREEN_BOTTOM_CLEARANCE = 44;

/**
 * Top air above a screen's first element, ON TOP of the safe-area inset.
 * Preserved geometry, not a design: 64 of it is clearance for a floating header
 * this app does not render. Probably too much, but tightening it wants a device
 * to judge.
 */
const SCREEN_TOP_AIR = 72;

/**
 * Bottom inset every Commons screen leaves free for the floating tab bar.
 *
 * A hook because the footprint depends on the device's bottom safe-area inset;
 * `useTabBarFootprint()` is the bar's own measurement, so this cannot drift from
 * where the bar actually sits.
 *
 * NEVER add `insets.bottom` to the result: Bloom folds the inset into the bar's
 * own gap, so adding it again counts the home indicator twice and strands a
 * visible band of dead space under every screen.
 */
export function useScreenBottomPad(): number {
  return useTabBarFootprint() + SCREEN_BOTTOM_CLEARANCE;
}

interface ScreenProps {
  children: React.ReactNode;
  refreshing?: boolean;
  onRefresh?: () => void;
  /** Air between direct children of the content column. */
  gap?: number;
  contentStyle?: StyleProp<ViewStyle>;
}

/**
 * The canonical Commons scroll surface: a single vertical scroller on the flat
 * `background` (no stacked cards), with a 22pt gutter, a 32pt rhythm between
 * sections, and a tab-bar-clearing bottom inset.
 *
 * A composition of Bloom's `Screen` + `ScreenScrollView`: Bloom owns scrolling,
 * chrome footprints, keyboard handling and restoration. What stays here is what
 * Bloom cannot know — this app's gutter and rhythm, and `useMinimizeOnScroll()`
 * as the bridge to a tab bar the NAVIGATOR renders rather than this screen.
 */
export function Screen({
  children,
  refreshing = false,
  onRefresh,
  gap = SECTION_GAP,
  contentStyle,
}: ScreenProps) {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const bottomPad = useScreenBottomPad();
  const minimizeOnScroll = useMinimizeOnScroll();

  const topPad = insets.top + SCREEN_TOP_AIR;

  const contentContainerStyle = useMemo(
    () => [
      styles.content,
      { paddingHorizontal: SCREEN_PADDING, gap, paddingTop: topPad },
      contentStyle,
    ],
    [gap, topPad, contentStyle],
  );

  return (
    <BloomScreen contentClearance={bottomPad}>
      <ScreenScrollView
        handler={minimizeOnScroll}
        contentContainerStyle={contentContainerStyle}
        showsVerticalScrollIndicator={false}
        nestedScrollEnabled
        refreshControl={
          onRefresh ? (
            <RefreshControl
              refreshing={refreshing}
              onRefresh={onRefresh}
              tintColor={colors.tint}
              colors={[colors.tint]}
              progressViewOffset={topPad + 8}
              progressBackgroundColor={colors.background}
            />
          ) : undefined
        }
      >
        {children}
      </ScreenScrollView>
    </BloomScreen>
  );
}

const styles = StyleSheet.create({
  content: {
    flexGrow: 1,
    paddingBottom: 20,
  },
});
