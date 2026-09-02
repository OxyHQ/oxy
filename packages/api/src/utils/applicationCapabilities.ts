/**
 * Platform capability vocabulary for `Application.capabilities`.
 *
 * Capabilities are STAFF-CONTROLLED, opaque platform flags: the Console /
 * member-RBAC update path silently drops them for non-staff callers (see
 * `middleware/requireStaff.ts` and `routes/applications.ts`), so a self-service
 * third-party app can never grant itself one. That makes the capability list the
 * REGISTRY-BASED answer to "which registered application may act as X" — the
 * same shape of authority as `isTrustedApplication()`. Never gate a platform
 * behaviour on a hardcoded client id, bundle id or application name.
 *
 * Intentionally dependency-free (no Mongoose) so it is trivially unit-testable
 * and importable without loading a model.
 */

export const APPLICATION_CAPABILITIES = [
  /**
   * The application is an IDENTITY-APPROVAL surface: a vault that holds the
   * user's local identity key and can review and cryptographically sign an
   * authorization request (today: Commons by Oxy). Push delivery of a pending
   * sign-in request targets ONLY installs registered by an application carrying
   * this capability.
   */
  'identity:approval',
  /** The application may coordinate delegated agents and request capability tickets. */
  'agency:coordinate',
] as const;

export type ApplicationCapability = (typeof APPLICATION_CAPABILITIES)[number];

/** See the vocabulary entry above. */
export const IDENTITY_APPROVAL_CAPABILITY: ApplicationCapability = 'identity:approval';
export const AGENCY_COORDINATE_CAPABILITY: ApplicationCapability = 'agency:coordinate';

/**
 * Predicate: does this application carry `capability`?
 *
 * Accepts a bare shape (not a Mongoose document) so callers can test lean query
 * results. A missing / non-array `capabilities` reads as "no capabilities" —
 * fails closed.
 */
export function hasApplicationCapability(
  application: { capabilities?: string[] | null },
  capability: ApplicationCapability
): boolean {
  return Array.isArray(application.capabilities) && application.capabilities.includes(capability);
}
