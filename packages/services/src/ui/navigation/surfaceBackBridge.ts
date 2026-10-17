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
let androidInstalled = false;
let escapeInstalled = false;

function invokeTopHandler(): boolean {
  const handler = handlerStack[handlerStack.length - 1];
  return handler ? handler() : false;
}

function installAndroidHandler(): void {
  if (androidInstalled || Platform.OS !== 'android') return;
  androidInstalled = true;
  BackHandler.addEventListener('hardwareBackPress', () => {
    if (handlerStack.length === 0) return false;
    return invokeTopHandler();
  });
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
  installAndroidHandler();
  return () => {
    const index = handlerStack.lastIndexOf(handler);
    if (index >= 0) handlerStack.splice(index, 1);
  };
}

/** Test-only: invoke the top handler. */
export function __invokeTopSurfaceBackForTests(): boolean {
  return invokeTopHandler();
}

/** Test-only reset. */
export function __resetSurfaceBackBridgeForTests(): void {
  handlerStack.length = 0;
}
