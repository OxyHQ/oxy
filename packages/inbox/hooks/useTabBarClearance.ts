import { useTabBarFootprint } from '@oxyhq/bloom/tab-bar';

import { useIsDesktopLayout } from '@/hooks/useIsDesktopLayout';

/**
 * Breathing margin (px) between the end of a screen's scrollable content and
 * the top of the floating bar, so the last row never sits flush against it.
 */
const CLEARANCE = 12;

/**
 * Vertical space (px) a scrollable tab screen must leave free at its bottom for
 * the floating tab bar: Bloom's own footprint — the expanded pill plus the gap
 * it keeps from the window edge, with the bottom safe-area inset ALREADY folded
 * in — plus this app's clearance.
 *
 * ZERO in the desktop layout, where no bar is rendered. Reserving the footprint
 * unconditionally would strand a dead ~82px band under the content of every
 * wide-viewport screen with nothing in it. It is gated on the same
 * `useIsDesktopLayout()` the bar itself is, so the reserved space and the bar
 * can never disagree, and both react to a window resize.
 *
 * A hook rather than a constant because the footprint depends on the safe-area
 * inset, and Bloom's own measurement rather than a copied number so it cannot
 * drift the moment the bar changes by a pixel.
 *
 * NEVER add `insets.bottom` to the result: Bloom folds the inset into the bar's
 * own bottom gap, so adding it again counts the home indicator twice and
 * strands a band of dead space under every list.
 */
export function useTabBarClearance(): number {
  // Both hooks run unconditionally, so the hook order is stable across the
  // resize that flips the layout.
  const footprint = useTabBarFootprint();
  const isDesktopLayout = useIsDesktopLayout();

  return isDesktopLayout ? 0 : footprint + CLEARANCE;
}
