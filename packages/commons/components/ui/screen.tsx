import React, { useMemo } from 'react';
import { RefreshControl, StyleSheet, type StyleProp, type ViewStyle } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Screen as BloomScreen, ScreenScrollView } from '@oxy.so/bloom/screen';
import { useMinimizeOnScroll, useTabBarFootprint } from '@oxy.so/bloom/tab-bar';
import { useTheme } from '@oxy.so/bloom/theme';

/** Horizontal gutter shared by every Commons screen. */
export const SCREEN_PADDING = 22;
/** Vertical air between top-level sections. */
export const SECTION_GAP = 32;

/**
 * Air between the end of a screen's content and the top of the floating bar.
 *
 * Sized so the last row also clears the ID screen's FAB, which sits in the same
 * corner one footprint up — the same job the single hardcoded 120 used to do
 * for the native bar and the FAB together.
 */
const SCREEN_BOTTOM_CLEARANCE = 44;

/**
 * Top air above a screen's first element, ON TOP of the safe-area inset.
 *
 * PRESERVED GEOMETRY, NOT A DESIGN. The retired `ScreenContentWrapper` padded
 * its scroller by a `headerHeight` state whose initial estimate was
 * `insets.top + 10 + 44 + 10`, then kept that estimate forever: the only writer
 * was a `headerHeight` shared value on the old `ScrollContext`, and NOTHING in
 * the app ever wrote to it. The old `Screen` then added another 8. So every
 * screen has been sitting at `insets.top + 72`, and 64 of that is clearance for
 * a floating header this app does not render.
 *
 * That is very probably too much, and it is deliberately NOT changed here: this
 * commit moves the machinery to Bloom without moving a pixel, so a visual
 * regression can only come from Bloom. Tightening it is a one-line change to
 * this constant, and it wants a device to judge.
 */
const SCREEN_TOP_AIR = 72;

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
  /** Overlaid top chrome. Bloom measures it and reserves its footprint. */
  header?: React.ReactNode;
  /** `false` while a navigator retains this screen off-screen. */
  active?: boolean;
}

/**
 * The canonical Commons scroll surface: a single vertical scroller on the flat
 * `background` (no stacked cards), with a generous 22pt gutter, a 32pt rhythm
 * between sections, and a tab-bar-clearing bottom inset.
 *
 * It is a COMPOSITION of Bloom's `Screen` + `ScreenScrollView`, not a
 * reimplementation: Bloom owns the scroll offset, the collapse progress, the
 * measured chrome footprints, keyboard handling and scroll restoration. What
 * stays here is the two things Bloom cannot know — this app's gutter and
 * section rhythm, and the bridge to a tab bar that the NAVIGATOR renders rather
 * than this screen.
 *
 * That bridge is `useMinimizeOnScroll()` passed as `ScreenScrollView`'s
 * `handler`. The hand-rolled predecessor carried a comment explaining that it
 * could not use that hook, because "two handlers cannot both own `onScroll`";
 * Bloom 4 composes them with `useComposedEventHandler`, on the UI thread, so
 * the workaround — a second copy of the direction/threshold logic driving
 * `setMinimized` by hand — is deleted rather than ported.
 */
export function Screen({
  children,
  refreshing = false,
  onRefresh,
  padded = true,
  gap = SECTION_GAP,
  contentStyle,
  header,
  active,
}: ScreenProps) {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const bottomPad = useScreenBottomPad();
  const minimizeOnScroll = useMinimizeOnScroll();

  const topPad = header ? 0 : insets.top + SCREEN_TOP_AIR;

  const contentContainerStyle = useMemo(
    () => [
      styles.content,
      padded ? { paddingHorizontal: SCREEN_PADDING, gap } : null,
      { paddingTop: topPad },
      contentStyle,
    ],
    [padded, gap, topPad, contentStyle],
  );

  return (
    <BloomScreen header={header} active={active} contentClearance={bottomPad}>
      <ScreenScrollView
        handler={minimizeOnScroll}
        active={active}
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
