import React, { useMemo } from 'react';
import { RefreshControl, StyleSheet, type StyleProp, type ViewStyle } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useBottomEdgeInset } from '@oxy.so/bloom/layout';
import { Screen as BloomScreen, ScreenScrollView } from '@oxy.so/bloom/screen';
import { useMinimizeOnScroll, useTabBarFootprint } from '@oxy.so/bloom/tab-bar';
import { useTheme } from '@oxy.so/bloom/theme';

/** Horizontal gutter shared by every Commons screen. */
export const SCREEN_PADDING = 22;
/** Vertical air between top-level sections. */
const SECTION_GAP = 32;

/** Air between the end of a screen's content and the top of the floating bar. */
const SCREEN_BOTTOM_CLEARANCE = 44;

/**
 * Diameter of a `size="md"` Bloom `Fab` (Bloom's `FAB_METRICS.md`, which the
 * package does not export). A screen that uses {@link useFabClearance} passes
 * `size="md"` to its FAB so the two cannot disagree.
 */
export const FAB_MD_DIAMETER = 50;
/** Air between the last line of content and the top of the FAB. */
const FAB_CLEARANCE_GAP = 16;

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

/**
 * Bottom inset for a screen whose content scrolls under a bottom-anchored Bloom
 * `Fab` (`size="md"`), so the last line can be scrolled clear of it.
 *
 * `SCREEN_BOTTOM_CLEARANCE` alone does not do it: the FAB sits `fabOffset`
 * above the bottom edge's claimed inset (the floating tab bar's footprint),
 * which is where Bloom anchors it, and its top is a whole diameter above that.
 * On the ID screen that left "You hold the private key. No one can lock you
 * out." under the QR button. The inputs are the same two numbers `Fab` itself
 * positions from, read at the same place in the tree.
 */
export function useFabClearance(fabOffset: number): number {
  const bottomEdgeInset = useBottomEdgeInset();
  const screenBottomPad = useScreenBottomPad();
  return Math.max(
    screenBottomPad,
    fabOffset + bottomEdgeInset + FAB_MD_DIAMETER + FAB_CLEARANCE_GAP,
  );
}

interface ScreenProps {
  children: React.ReactNode;
  refreshing?: boolean;
  onRefresh?: () => void;
  /** Air between direct children of the content column. */
  gap?: number;
  contentStyle?: StyleProp<ViewStyle>;
  /**
   * Bottom inset the scroller keeps free, instead of {@link useScreenBottomPad}.
   * A screen with a floating FAB passes {@link useFabClearance}'s result.
   */
  bottomClearance?: number;
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
  bottomClearance,
}: ScreenProps) {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const screenBottomPad = useScreenBottomPad();
  const bottomPad = bottomClearance ?? screenBottomPad;
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
