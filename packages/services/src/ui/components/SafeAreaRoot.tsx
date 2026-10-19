/**
 * The safe-area root `OxyProvider` mounts around everything it renders.
 *
 * On iOS and Android it is react-native-safe-area-context's own
 * `SafeAreaProvider`, which measures the native root view.
 *
 * On web it does NOT measure. From react-native-safe-area-context 5.9, the web
 * provider measures its own element and reports
 * `windowInsets.bottom - (innerHeight - rect.bottom)` as the bottom inset with
 * no upper clamp (likewise `top - rect.top`). `OxyProvider` wraps the app's
 * whole document, and on a page that scrolls that element is taller than the
 * viewport, so everything below the fold became bottom inset: an 844px phone
 * viewport with a 2690px page reported a ~1850px inset, and the mobile account
 * dialog laid itself out empty. Web therefore gets the WINDOW's metrics — what
 * every version before 5.9 reported for a root provider:
 *
 * - insets: CSS `env(safe-area-inset-*)`, read from one fixed, hidden probe
 *   after mount (zero during server rendering and hydration);
 * - frame: the viewport (`useWindowDimensions`), never the document's height.
 *
 * Bloom raises its own web insets to the same `env()` values
 * (`useCssSafeAreaInsets`), so nothing pads twice.
 */
import type { ReactNode } from 'react';
import { useMemo, useSyncExternalStore } from 'react';
import { Platform, StyleSheet, useWindowDimensions, View } from 'react-native';
import {
  type EdgeInsets,
  SafeAreaFrameContext,
  SafeAreaInsetsContext,
  SafeAreaProvider,
} from 'react-native-safe-area-context';

const styles = StyleSheet.create({
  fill: { flex: 1 },
});

export function SafeAreaRoot({ children }: { children?: ReactNode }) {
  if (Platform.OS === 'web') return <WindowSafeAreaProvider>{children}</WindowSafeAreaProvider>;
  return <SafeAreaProvider>{children}</SafeAreaProvider>;
}

/** Web: window metrics, provided through the library's own contexts. */
function WindowSafeAreaProvider({ children }: { children?: ReactNode }) {
  const insets = useSyncExternalStore(subscribeWindowInsets, readWindowInsets, readServerInsets);
  const { width, height } = useWindowDimensions();
  const frame = useMemo(() => ({ x: 0, y: 0, width, height }), [width, height]);
  // The same flex-filling view `SafeAreaProvider` renders, so layout below is unchanged.
  return (
    <View style={styles.fill}>
      <SafeAreaFrameContext.Provider value={frame}>
        <SafeAreaInsetsContext.Provider value={insets}>{children}</SafeAreaInsetsContext.Provider>
      </SafeAreaFrameContext.Provider>
    </View>
  );
}

const ZERO: EdgeInsets = Object.freeze({ top: 0, right: 0, bottom: 0, left: 0 });

let probe: HTMLElement | null = null;
let snapshot: EdgeInsets = ZERO;
const listeners = new Set<() => void>();

function readServerInsets(): EdgeInsets {
  return ZERO;
}

function readWindowInsets(): EdgeInsets {
  return snapshot;
}

function measure(): void {
  if (!probe) return;
  const style = getComputedStyle(probe);
  const next = {
    top: Number.parseFloat(style.paddingTop) || 0,
    right: Number.parseFloat(style.paddingRight) || 0,
    bottom: Number.parseFloat(style.paddingBottom) || 0,
    left: Number.parseFloat(style.paddingLeft) || 0,
  };
  if (
    next.top === snapshot.top &&
    next.right === snapshot.right &&
    next.bottom === snapshot.bottom &&
    next.left === snapshot.left
  ) {
    return;
  }
  snapshot = next.top || next.right || next.bottom || next.left ? next : ZERO;
  for (const listener of listeners) listener();
}

function subscribeWindowInsets(listener: () => void): () => void {
  if (typeof document === 'undefined' || !document.body) return () => {};
  listeners.add(listener);
  if (!probe) {
    probe = document.createElement('div');
    probe.setAttribute('aria-hidden', 'true');
    // Through the CSSOM, which CSP `style-src` does not block.
    probe.style.position = 'fixed';
    probe.style.visibility = 'hidden';
    probe.style.pointerEvents = 'none';
    probe.style.top = '0';
    probe.style.left = '0';
    probe.style.setProperty('padding-top', 'env(safe-area-inset-top, 0px)');
    probe.style.setProperty('padding-right', 'env(safe-area-inset-right, 0px)');
    probe.style.setProperty('padding-bottom', 'env(safe-area-inset-bottom, 0px)');
    probe.style.setProperty('padding-left', 'env(safe-area-inset-left, 0px)');
    document.body.appendChild(probe);
    window.addEventListener('resize', measure);
    window.addEventListener('orientationchange', measure);
  }
  measure();
  return () => {
    listeners.delete(listener);
    if (listeners.size > 0 || !probe) return;
    window.removeEventListener('resize', measure);
    window.removeEventListener('orientationchange', measure);
    probe.remove();
    probe = null;
    snapshot = ZERO;
  };
}
