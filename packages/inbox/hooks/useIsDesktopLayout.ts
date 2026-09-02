import { useWindowDimensions } from 'react-native';

/**
 * Viewport width (px) at or above which the app lays out as a desktop: the
 * mailbox drawer becomes `permanent` and the floating tab bar is not rendered.
 */
export const DESKTOP_BREAKPOINT = 900;

/**
 * Whether the app is in its wide, desktop layout.
 *
 * This is the SINGLE source of truth for that question, and it is what keeps
 * the two pieces of navigation from ever disagreeing: the drawer is permanent
 * exactly when this is true, and the floating tab bar renders exactly when it
 * is false. Split across two independent conditions, a viewport could end up
 * with both a permanent sidebar and a floating bar, or with neither.
 *
 * `useWindowDimensions()` re-renders on resize, so a browser window dragged
 * across the breakpoint — or a tablet rotated across it — gains and loses the
 * bar, and the space reserved for it, cleanly rather than keeping whatever was
 * true at mount.
 *
 * There is deliberately NO platform check. A wide native tablet is a wide
 * layout: it gets the permanent drawer and no bar, exactly as the web does at
 * the same width. Gating this on `Platform.OS === 'web'` would leave an iPad
 * with a floating pill stretched across the full screen, since Bloom derives
 * the bar's item width from the window width. Phones never reach the
 * breakpoint, so they are unaffected.
 *
 * `drawerType: 'permanent'` is fully supported on native — react-native-drawer-
 * layout's `Drawer.native.tsx` branches on it in nine places: the pan gesture
 * is disabled, the drawer is laid out in flow (`position: 'relative'`) beside
 * the content instead of over it, and no dimming overlay is rendered.
 */
export function useIsDesktopLayout(): boolean {
  const { width } = useWindowDimensions();
  return width >= DESKTOP_BREAKPOINT;
}
