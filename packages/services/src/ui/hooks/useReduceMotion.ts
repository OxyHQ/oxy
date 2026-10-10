/**
 * useReduceMotion
 *
 * Reactive boolean reflecting the OS "reduce motion" accessibility preference.
 * Wraps `AccessibilityInfo` as an external store via `useSyncExternalStore` — the
 * effect-free, React-Compiler-safe way to read an external mutable source. The
 * initial value is read asynchronously once (the platform API is a Promise) and
 * cached module-side; subsequent changes arrive via the `reduceMotionChanged`
 * event. Mirrors the `useOnlineStatus` pattern.
 *
 * Consumers use it to pin entrance/stagger animations off under reduce-motion.
 */

import { useSyncExternalStore } from 'react';
import { AccessibilityInfo } from 'react-native';

let cachedReduceMotion = false;
let initialized = false;
const listeners = new Set<() => void>();

const notifyAll = (): void => {
  for (const listener of listeners) listener();
};

const setCached = (value: boolean): void => {
  if (cachedReduceMotion === value) return;
  cachedReduceMotion = value;
  notifyAll();
};

const subscribeReduceMotion = (notify: () => void): (() => void) => {
  // Populate the cache the first time anyone subscribes (the platform read is
  // async, so it cannot be a synchronous `getSnapshot`).
  if (!initialized) {
    initialized = true;
    AccessibilityInfo.isReduceMotionEnabled()
      .then(setCached)
      .catch(() => {
        // No preference available — the `false` default stands.
      });
  }
  listeners.add(notify);
  const sub = AccessibilityInfo.addEventListener('reduceMotionChanged', setCached);
  return () => {
    listeners.delete(notify);
    sub.remove();
  };
};

const getSnapshot = (): boolean => cachedReduceMotion;

// SSR/web-first paint: assume motion is allowed (no reduce) until the async read
// resolves — matches the prior default.
const getServerSnapshot = (): boolean => false;

export function useReduceMotion(): boolean {
  return useSyncExternalStore(subscribeReduceMotion, getSnapshot, getServerSnapshot);
}
