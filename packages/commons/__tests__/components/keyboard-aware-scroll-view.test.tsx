/**
 * `reserveTopInset` keeps a header-less screen's first element below the
 * status bar. Commons' Settings stack renders no navigator header, so the
 * "Delete account" title sat under the status bar (OxyHQ/oxy#1375 item 24).
 */
import React from 'react';
import { render } from '@testing-library/react';

const TOP_INSET = 44;
const captured: { contentContainerStyle?: unknown; bottomOffset?: number }[] = [];

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: TOP_INSET, right: 0, bottom: 34, left: 0 }),
}));
jest.mock('react-native-keyboard-controller', () => ({
  KeyboardAwareScrollView: (props: { contentContainerStyle?: unknown; bottomOffset?: number }) => {
    captured.push(props);
    return null;
  },
}));
jest.mock('@oxy.so/bloom/layout', () => ({ useBottomEdgeInset: () => 0 }));
jest.mock('@oxy.so/bloom/tab-bar', () => ({
  useTabBarFootprint: () => 82,
  useMinimizeOnScroll: () => undefined,
}));
jest.mock('@oxy.so/bloom/screen', () => ({ Screen: () => null, ScreenScrollView: () => null }));
jest.mock('@oxy.so/bloom/theme', () => ({ useTheme: () => ({ colors: {} }) }));

import { KeyboardAwareScrollViewWrapper } from '@/components/ui/keyboard-aware-scroll-view';

/** The effective content style, flattened the way React Native applies it. */
function effectiveContentStyle(): Record<string, unknown> {
  const latest = captured[captured.length - 1];
  const styles = ([] as unknown[]).concat(latest?.contentContainerStyle ?? []);
  return Object.assign({}, ...styles.filter(Boolean));
}

describe('KeyboardAwareScrollViewWrapper', () => {
  beforeEach(() => {
    captured.length = 0;
  });

  it("adds the top safe-area inset to the caller's own top padding", () => {
    render(
      <KeyboardAwareScrollViewWrapper
        reserveTabBarFootprint
        reserveTopInset
        contentContainerStyle={{ paddingTop: 24 }}
      >
        {null}
      </KeyboardAwareScrollViewWrapper>,
    );
    expect(effectiveContentStyle().paddingTop).toBe(TOP_INSET + 24);
  });

  it('clears the status bar when the caller sets no top padding', () => {
    render(
      <KeyboardAwareScrollViewWrapper reserveTopInset contentContainerStyle={{ padding: 16 }}>
        {null}
      </KeyboardAwareScrollViewWrapper>,
    );
    expect(effectiveContentStyle().paddingTop).toBe(TOP_INSET);
  });

  it('leaves the top alone for steps that pad their own container', () => {
    render(
      <KeyboardAwareScrollViewWrapper contentContainerStyle={{ paddingTop: 24 }}>
        {null}
      </KeyboardAwareScrollViewWrapper>,
    );
    expect(effectiveContentStyle().paddingTop).toBe(24);
  });

  it('forwards bottomOffset to the keyboard-aware scroller', () => {
    render(
      <KeyboardAwareScrollViewWrapper bottomOffset={120}>{null}</KeyboardAwareScrollViewWrapper>,
    );
    expect(captured[captured.length - 1]?.bottomOffset).toBe(120);
  });

  // The tab bar's footprint used to come BEFORE the caller's style, so the
  // `padding: 22` every tab screen passes replaced it, and Delete account,
  // Create backup and Continue sat under the floating tab bar.
  describe('bottom padding', () => {
    // useScreenBottomPad = footprint (82) + SCREEN_BOTTOM_CLEARANCE (44).
    const TAB_SCREEN_PAD = 82 + 44;

    it("adds the tab bar's footprint to the caller's own padding", () => {
      render(
        <KeyboardAwareScrollViewWrapper
          reserveTabBarFootprint
          contentContainerStyle={{ padding: 22 }}
        >
          {null}
        </KeyboardAwareScrollViewWrapper>,
      );
      expect(effectiveContentStyle().paddingBottom).toBe(TAB_SCREEN_PAD + 22);
    });

    it('honours an explicit paddingBottom over the shorthand', () => {
      render(
        <KeyboardAwareScrollViewWrapper
          reserveTabBarFootprint
          contentContainerStyle={{ padding: 22, paddingBottom: 8 }}
        >
          {null}
        </KeyboardAwareScrollViewWrapper>,
      );
      expect(effectiveContentStyle().paddingBottom).toBe(TAB_SCREEN_PAD + 8);
    });

    it('off the tab bar, adds the bottom safe-area inset instead', () => {
      render(
        <KeyboardAwareScrollViewWrapper contentContainerStyle={{ padding: 24 }}>
          {null}
        </KeyboardAwareScrollViewWrapper>,
      );
      expect(effectiveContentStyle().paddingBottom).toBe(34 + 24);
    });
  });
});
