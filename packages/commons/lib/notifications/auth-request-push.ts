/**
 * The UNTRUSTED "Sign in with Oxy" push payload (issue #691, Phase 4).
 *
 * When a desktop starts a "Continue with Oxy" request, the platform delivers a
 * deliberately minimal notification to the user's known Commons installation:
 *
 *   { type: 'oxy_commons_auth_request',
 *     approvalUrl: 'oxycommons://approve?v=1&code=<authorizeCode>' }
 *
 * SECURITY — the payload is attacker-influencable and carries NOTHING worth
 * displaying:
 *   - The notification has no approve action. Tapping it can only OPEN the
 *     existing approval route; approval itself still requires the biometric
 *     gate + the on-device identity signature.
 *   - Nothing from the payload is ever rendered. The approval screen re-resolves
 *     the requesting application server-side from the code
 *     (`auth.commons.approvalInfo`), which is the only trusted identity source.
 *   - The `approvalUrl` is parsed with the SAME strict, dependency-free
 *     {@link parseApprovalLink} the QR scanner and deep links use, so the
 *     accepted scheme/host set is defined exactly once. Anything else — a
 *     foreign scheme, a missing code, a stale link, a non-string — yields `null`
 *     and the tap is dropped without navigating anywhere.
 */

import { parseApprovalLink } from '@/lib/commons-signin/parse-approval-link';

/** The only `data.type` Commons acts on. Any other push is not ours. */
export const COMMONS_AUTH_REQUEST_PUSH_TYPE = 'oxy_commons_auth_request';

/**
 * Extract the public authorize code from a notification's `content.data`.
 *
 * @param data - The raw, untrusted payload from the notification response.
 * @returns The authorize code, or `null` when this is not a usable Commons
 *   auth-request push (which the caller must treat as "do nothing").
 */
export function authRequestCodeFromPush(data: unknown): string | null {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    return null;
  }

  const { type, approvalUrl } = data as { type?: unknown; approvalUrl?: unknown };
  if (type !== COMMONS_AUTH_REQUEST_PUSH_TYPE || typeof approvalUrl !== 'string') {
    return null;
  }

  const parsed = parseApprovalLink(approvalUrl);
  // `expired` is dropped alongside `invalid` on purpose: a stale link has
  // nothing left to approve, and the whole point of this surface is that an
  // untrusted payload can only ever produce a usable code or nothing at all.
  return parsed.ok ? parsed.code : null;
}

/**
 * Codes this app session has already routed to the approval screen.
 *
 * An authorize code is single-use, so handling one twice in a session is always
 * a duplicate — which is reachable because the OS can hand the SAME launching
 * tap to both the cold-launch replay and a freshly attached response listener.
 * Claiming is the tiebreaker: whichever path gets there first navigates, the
 * other no-ops. Module-scoped and only ever touched from event handlers /
 * effects, never during render.
 */
const claimedAuthRequestCodes = new Set<string>();

/**
 * Claim a code for navigation.
 *
 * @returns `true` when the caller owns this code and should navigate; `false`
 *   when it was already handled in this app session.
 */
export function claimAuthRequestCode(code: string): boolean {
  if (claimedAuthRequestCodes.has(code)) {
    return false;
  }
  claimedAuthRequestCodes.add(code);
  return true;
}
