import React from 'react';
import { View, StyleSheet, type StyleProp, type ViewStyle } from 'react-native';
import { useTabBarFootprint } from '@oxy.so/bloom/tab-bar';
import { useBottomEdgeInset } from '@oxy.so/bloom/layout';
import { useColors } from '@/hooks/useColors';
import { ScreenContentWrapper } from '@/components/screen-content-wrapper';

/** Horizontal gutter shared by every Commons screen. */
export const SCREEN_PADDING = 22;
/** Vertical air between top-level sections. */
export const SECTION_GAP = 32;

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
 * Bottom inset every Commons screen leaves free for the floating tab bar.
 *
 * A hook rather than the constant it replaced, because the footprint depends on
 * the device's bottom safe-area inset. `useTabBarFootprint()` is the bar's own
 * measurement — its expanded height plus the gap it holds off the window edge —
 * so this can never drift from where the bar actually sits.
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
  /**
   * Wrap children in the standard padded, section-gapped content column.
   * Set `false` for full-bleed surfaces (camera, edge-to-edge media) that own
   * their own layout.
   */
  padded?: boolean;
  /** Air between direct children of the content column. */
  gap?: number;
  contentStyle?: StyleProp<ViewStyle>;
}

/**
 * The canonical Commons scroll surface: a single vertical scroller on the flat
 * `background` (no stacked cards), with a generous 22pt gutter, a 32pt rhythm
 * between sections, and a tab-bar-clearing bottom inset. Separation between
 * sections is WHITESPACE — the children compose freely (hero, sections, rows).
 */
export function Screen({
  children,
  refreshing,
  onRefresh,
  padded = true,
  gap = SECTION_GAP,
  contentStyle,
}: ScreenProps) {
  const colors = useColors();
  const bottomPad = useScreenBottomPad();

  return (
    <ScreenContentWrapper refreshing={refreshing} onRefresh={onRefresh}>
      <View style={[styles.flex, { backgroundColor: colors.background }]}>
        {padded ? (
          <View style={[styles.content, { gap, paddingBottom: bottomPad }, contentStyle]}>
            {children}
          </View>
        ) : (
          children
        )}
      </View>
    </ScreenContentWrapper>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  content: {
    flexGrow: 1,
    paddingHorizontal: SCREEN_PADDING,
    paddingTop: 8,
  },
});
