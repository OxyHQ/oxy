import { BackHandler, Platform } from 'react-native';

/**
 * Per-surface system-back handlers (Android hardware back + web Escape).
 *
 * Bloom's `SurfaceHost` dismisses the whole top surface on back/Escape. The SDK
 * needs the old `BottomSheetRouter` semantics first: pop nav history, step a
 * wizard back, then dismiss. A single global listener delegates to the topmost
 * registered handler so stacked surfaces route correctly.
 */

export type SurfaceBackHandler = () => boolean;

const handlerStack: SurfaceBackHandler[] = [];
let androidSubscription: { remove(): void } | null = null;
let escapeInstalled = false;

function invokeTopHandler(): boolean {
  const handler = handlerStack[handlerStack.length - 1];
  return handler ? handler() : false;
}

/**
 * The Android listener is registered only while a surface is open. Any
 * registered `hardwareBackPress` listener hands Back to JavaScript (React
 * Native's native Back ownership counts listeners, not their answers), so a
 * listener left behind after the first sheet closed routed every later Back
 * through JavaScript: a pushed screen popped only after the JavaScript thread
 * got to it (about 200 ms on a Pixel 8a) instead of natively at once.
 */
function syncAndroidHandler(): void {
  if (Platform.OS !== 'android') return;
  if (handlerStack.length > 0 && !androidSubscription) {
    androidSubscription = BackHandler.addEventListener('hardwareBackPress', invokeTopHandler);
  } else if (handlerStack.length === 0 && androidSubscription) {
    androidSubscription.remove();
    androidSubscription = null;
  }
}

function installEscapeHandler(): void {
  if (escapeInstalled || Platform.OS !== 'web') return;
  if (typeof window === 'undefined') return;
  escapeInstalled = true;
  window.addEventListener(
    'keydown',
    (event) => {
      if (event.key !== 'Escape' || handlerStack.length === 0) return;
      if (!invokeTopHandler()) return;
      event.stopImmediatePropagation();
      event.preventDefault();
    },
    true,
  );
}

/** Register before Bloom's `SurfaceHost` mounts so Escape capture runs first. */
installEscapeHandler();

/** Push a handler for one live surface; returns unregister. */
export function pushSurfaceBackHandler(handler: SurfaceBackHandler): () => void {
  handlerStack.push(handler);
  syncAndroidHandler();
  return () => {
    const index = handlerStack.lastIndexOf(handler);
    if (index >= 0) handlerStack.splice(index, 1);
    syncAndroidHandler();
  };
}

/** Test-only: invoke the top handler. */
export function __invokeTopSurfaceBackForTests(): boolean {
  return invokeTopHandler();
}

/** Test-only reset. */
export function __resetSurfaceBackBridgeForTests(): void {
  handlerStack.length = 0;
  syncAndroidHandler();
}
