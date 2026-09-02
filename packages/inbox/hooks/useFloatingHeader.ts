/**
 * The floating-header scroll treatment shared by the inbox, subscriptions and
 * search screens.
 *
 * The header sits above the list rather than beside it, so the content scrolls
 * behind its gradient. That needs the header's real height as the list's top
 * padding, and the header's height is only known once it has laid out — hence
 * measuring it rather than hardcoding a number that every font-size or
 * safe-area change would invalidate.
 *
 * `onLayout` is idempotent on purpose: `setState` with the same value on every
 * layout pass is what turns a resize into "Maximum update depth exceeded".
 */

import { useCallback, useState } from 'react';
import { StyleSheet, type LayoutChangeEvent } from 'react-native';

export function useFloatingHeader() {
  const [headerHeight, setHeaderHeight] = useState(0);

  const onHeaderLayout = useCallback((e: LayoutChangeEvent) => {
    const next = Math.round(e.nativeEvent.layout.height);
    setHeaderHeight((prev) => (prev === next ? prev : next));
  }, []);

  return { headerHeight, onHeaderLayout, floatingHeaderStyle: styles.floatingHeader };
}

const styles = StyleSheet.create({
  floatingHeader: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    zIndex: 10,
  },
});
