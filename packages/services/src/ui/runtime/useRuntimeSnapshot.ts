import { useCallback, useRef, useSyncExternalStore } from 'react';
import type { OxyRuntime } from './createOxyRuntime';
import type { OxyRuntimeSnapshot } from './types';

/**
 * Subscribe to the whole runtime snapshot.
 *
 * The runtime publishes a frozen object only when a fact actually changed, so
 * identity comparison is exact: a locale change, a dialog opening or an
 * unrelated query settling does not wake anything subscribed here.
 */
export function useRuntimeSnapshot(runtime: OxyRuntime): OxyRuntimeSnapshot {
  return useSyncExternalStore(runtime.subscribe, runtime.getSnapshot, runtime.getSnapshot);
}

/**
 * Subscribe to one derived value of the runtime snapshot.
 *
 * The selection is cached against the snapshot it was computed from, which is
 * what makes a selector returning a fresh object (`{user, isAuthenticated}`)
 * safe here: `useSyncExternalStore` calls `getSnapshot` several times per
 * commit and would otherwise see a new object every call and loop.
 *
 * `selector` must be stable — hoist it to module scope or wrap it in
 * `useCallback`. An inline arrow re-subscribes on every render.
 */
export function useRuntimeSelector<T>(
  runtime: OxyRuntime,
  selector: (snapshot: OxyRuntimeSnapshot) => T,
  isEqual?: (a: T, b: T) => boolean,
): T {
  const cache = useRef<{ snapshot: OxyRuntimeSnapshot; value: T } | null>(null);

  const getSelection = useCallback((): T => {
    const snapshot = runtime.getSnapshot();
    const cached = cache.current;
    if (cached !== null && cached.snapshot === snapshot) {
      return cached.value;
    }
    const value = selector(snapshot);
    if (cached !== null && isEqual?.(cached.value, value) === true) {
      // Same value under the caller's equality: keep the PREVIOUS reference so a
      // structurally-equal recomputation does not read as a change.
      cache.current = { snapshot, value: cached.value };
      return cached.value;
    }
    cache.current = { snapshot, value };
    return value;
  }, [runtime, selector, isEqual]);

  return useSyncExternalStore(runtime.subscribe, getSelection, getSelection);
}
