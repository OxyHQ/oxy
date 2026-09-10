/**
 * Popup opener for the cross-origin passkey hub (b2).
 *
 * On a non-Oxy web origin (e.g. mention.earth) a WebAuthn ceremony can't run
 * locally — the credential's RP ID is bound to `oxy.so`. Instead,
 * `AccountDialogController.startPasskeyHubSignIn` opens a popup at the
 * auth.oxy.so passkey hub, where the SAME ceremony IS a first-party operation.
 *
 * Kept in its own module (mirroring `oauthNavigation.ts`'s
 * `redirectToAuthorize`) so `window.open` sits behind a plain function the
 * controller wiring in `OxyContext` can inject without touching `window`
 * itself, and so a test can substitute a fake opener.
 */

import type { PopupWindowHandle } from '@oxy.so/core';

/**
 * Open a new, EMPTY popup window. Must be called SYNCHRONOUSLY from within a
 * user-gesture handler (before any `await`) — opening it after an async call
 * loses the gesture attribution and the browser silently blocks it. Returns
 * `null` when blocked, or when there is no DOM `window` (native/SSR — the
 * hub-popup flow does not apply there).
 */
export function openPasskeyHubPopup(): PopupWindowHandle | null {
    const win = (globalThis as { window?: Window }).window;
    if (!win) return null;
    return win.open('', '_blank', 'width=420,height=640');
}
