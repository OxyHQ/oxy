import type { APPLICATION_TYPES } from '../db/schema/applications';

/** The `applications.type` closed value set, derived from the column itself. */
type ApplicationType = (typeof APPLICATION_TYPES)[number];

/**
 * Pure predicate: is this Application part of the platform-trusted set?
 *
 * "Trusted" means a first-party / internal / system / official application whose
 * trust fields are staff-controlled (`type`, `isOfficial`, `isInternal` are
 * never settable via the Console / member RBAC path — see `requireStaff`).
 * Ordinary self-service `third_party` applications are NOT trusted even while
 * `status: 'active'`, so `status: 'active'` alone is never a trust boundary.
 *
 * This is the single source of truth for trust-gated decisions that must agree:
 *  - Trusted/third-party CORS + device-first bootstrap origin derivation
 *    (`config/dynamicOriginRegistry.ts`).
 *  - OAuth consent auto-approve (trusted apps skip the consent screen entirely).
 *  - Service-credential creation + service-token minting (`applications.ts`,
 *    `auth.ts`) — bearer credentials for Oxy-to-Oxy/internal routes.
 *  - Requiring an Origin proof before showing official branding on the device
 *    consent UI (`auth.ts` `POST /session/create`).
 */
export function isTrustedApplication(
  app: { isOfficial?: boolean; isInternal?: boolean; type?: ApplicationType }
): boolean {
  return Boolean(
    app.isOfficial ||
      app.isInternal ||
      app.type === 'first_party' ||
      app.type === 'internal' ||
      app.type === 'system'
  );
}
