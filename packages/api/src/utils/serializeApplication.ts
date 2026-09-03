import type { ApplicationType } from '../db/schema/applications';
import { stripSensitiveUrlQueryParams } from './sanitizeUrl';

/**
 * The fields this serializer reads off an application row.
 *
 * Keyed on `id: string` — the Drizzle `applications` row shape — NOT on
 * `Pick<IApplication, '_id' | …>`. A clean cut, deliberately with no dual
 * `_id`/`id` acceptance: `applications` is a Postgres table now, there is
 * exactly one shape to serialize, and accepting both would keep a dead Mongoose
 * branch alive in the one place that decides what a consent screen displays.
 *
 * Structural rather than a `Pick<>` of the table type, so it stays independent
 * of whether the caller selected the whole row or an explicit column subset.
 */
export interface SerializableApplication {
  id: string;
  name: string;
  description?: string | null;
  icon?: string | null;
  websiteUrl?: string | null;
  privacyPolicyUrl?: string | null;
  termsUrl?: string | null;
  type: ApplicationType;
  isOfficial: boolean;
  isInternal: boolean;
  scopes?: string[] | null;
}

/**
 * Public, sanitized projection of an {@link IApplication} suitable for the
 * unauthenticated auth-web consent UI.
 *
 * This is the ONLY shape that may be returned to a relying-party / browser
 * consent screen. It deliberately omits every sensitive or internal field —
 * `webhookSecret`, `webhookUrl`, `createdByUserId`, `capabilities`, redirect
 * URIs, timestamps, etc. — so leaking it cannot disclose secrets or operator
 * identity beyond a best-effort display name for non-official apps.
 */
export interface PublicApplication {
  id: string;
  name: string;
  description?: string;
  icon?: string;
  websiteUrl?: string;
  /** Public privacy-policy URL, rendered as a legal link on the consent screen. */
  privacyPolicyUrl?: string;
  /** Public terms-of-service URL, rendered as a legal link on the consent screen. */
  termsUrl?: string;
  type: ApplicationType;
  isOfficial: boolean;
  isInternal: boolean;
  scopes: string[];
  /**
   * Best-effort display name of the application's owner. ONLY included for
   * non-official applications (official/first-party apps speak for the
   * platform and do not surface a third-party developer attribution).
   */
  developerName?: string;
}

/**
 * Build the sanitized public view of an application.
 *
 * @param app           the resolved Application document
 * @param developerName best-effort owner display name. The caller is
 *                      responsible for fetching it (the serializer never hits
 *                      the database). Only attached for non-official apps.
 *
 * Undefined optional fields are omitted entirely rather than serialized as
 * `null`/`undefined`, keeping the payload tight for the consent UI.
 */
export function serializePublicApplication(
  app: SerializableApplication,
  developerName?: string
): PublicApplication {
  const result: PublicApplication = {
    id: app.id,
    name: app.name,
    type: app.type,
    isOfficial: app.isOfficial,
    isInternal: app.isInternal,
    scopes: Array.isArray(app.scopes) ? [...app.scopes] : [],
  };

  if (app.description !== undefined && app.description !== null) {
    result.description = app.description;
  }
  if (app.icon !== undefined && app.icon !== null) {
    // Rows written before URL sanitisation may still contain a credential in an
    // icon query string. Public reads therefore defend independently of the
    // write path and of the one-time cleanup migration.
    result.icon = stripSensitiveUrlQueryParams(app.icon);
  }
  if (app.websiteUrl !== undefined && app.websiteUrl !== null) {
    result.websiteUrl = app.websiteUrl;
  }
  if (app.privacyPolicyUrl !== undefined && app.privacyPolicyUrl !== null) {
    result.privacyPolicyUrl = app.privacyPolicyUrl;
  }
  if (app.termsUrl !== undefined && app.termsUrl !== null) {
    result.termsUrl = app.termsUrl;
  }

  // Developer attribution is only meaningful for non-official apps, and only
  // when the caller could resolve a name.
  if (!app.isOfficial && developerName !== undefined && developerName !== null && developerName !== '') {
    result.developerName = developerName;
  }

  return result;
}
