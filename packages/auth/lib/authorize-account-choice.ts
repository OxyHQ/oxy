/**
 * Whether the authorize page shows the account chooser before consent.
 *
 * An external MCP grant always needs an explicit account choice: the consent
 * context is resolved for the exact account the person picks. That choice must
 * not depend on the device already having an active context. A browser can hold
 * a session token while the device directory has no active context (a session
 * from another surface, a directory not populated yet); gating the chooser on
 * `activeContext` left such a request with no chooser, no consent and no error,
 * only "We couldn't load the details of this request". The chooser is also the
 * way out of that state: its "use another account" row goes to sign-in.
 *
 * An ordinary OAuth request keeps the old rule: the chooser only when the device
 * offers more than one account, which implies an active one.
 */
export function showsAccountChoice(input: {
  isMcpOAuth: boolean;
  /** The request is still pending (not approved, denied or expired). */
  actionable: boolean;
  chooserDismissed: boolean;
  hasActiveContext: boolean;
  contextCount: number;
}): boolean {
  if (!input.actionable || input.chooserDismissed) return false;
  if (input.isMcpOAuth) return true;
  return input.hasActiveContext && input.contextCount > 1;
}
