/**
 * What Commons does AFTER a successful "Sign in with Oxy" approval.
 *
 *   'return-to-caller' — background Commons so the OS returns to the app/site
 *                        that launched it. Only possible on Android, and only
 *                        for the same-device deep-link handoff (Commons was
 *                        foregrounded by the caller's intent).
 *   'close'            — dismiss the sheet and stay in Commons. Used for the
 *                        cross-device QR scanner and push paths (there is no
 *                        caller to return to on THIS device) and on iOS, where
 *                        no programmatic backgrounding exists.
 */
export type ApprovedAction = 'return-to-caller' | 'close';

/** Threaded by the in-app scanner so we can tell it apart from a deep link. */
export const SCANNER_SOURCE = 'scanner';

/**
 * Threaded by a tapped auth-request push (warm or cold launch). A push is the
 * cross-device path by construction: the request started on another device, so
 * there is nothing on this phone to return to. Without it, approving from a push
 * on Android ran `BackHandler.exitApp()` and closed Commons.
 */
export const PUSH_SOURCE = 'push';

/**
 * Decide the post-approval behavior.
 *
 * The discriminator is the explicit `source` route param — the scanner threads
 * `source=scanner` and a tapped push `source=push` when they open the approval
 * route; an external deep link (`oxycommons://approve?…` /
 * `commons://approve?…`) never carries it. We
 * do NOT infer the path from navigation history (ambiguous on warm launches).
 *
 * @param source     - The `source` route param (`'scanner'` / `'push'`).
 * @param platformOS - `Platform.OS` of the running device.
 */
export function resolveApprovedAction(
  source: string | undefined,
  platformOS: string,
): ApprovedAction {
  const crossDevice = source === SCANNER_SOURCE || source === PUSH_SOURCE;
  // A same-device deep-link handoff on Android is the only case where a caller
  // exists on THIS device AND the OS can return to it (by backgrounding us).
  if (!crossDevice && platformOS === 'android') {
    return 'return-to-caller';
  }
  return 'close';
}
