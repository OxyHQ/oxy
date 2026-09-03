/**
 * Connected Apps (OAuth consent) Methods Mixin
 *
 * The user-facing OAuth-consent surface: resolving the PUBLIC identity of a
 * requesting application (for consent/authorize/device-flow screens), and
 * viewing/revoking the THIRD-PARTY applications the current user has authorized.
 *
 * This is deliberately separate from account ownership (`OxyServices.accounts.ts`):
 * an account owns and manages its own applications, whereas this mixin is about a
 * user granting/revoking another party's app access to their own data. None of
 * these methods touch the account graph.
 *
 * Reference connected apps by their application `_id` (`applicationId`), NOT a
 * credential/client id, so a grant — and its revocation — survive credential
 * rotation.
 */
import type { OxyServicesBase } from '../OxyServices.base';
// `PublicApplication.type` reuses the canonical Application classification, which
// is owned by the accounts mixin (home of the Application model). Type-only import.
import type { ApplicationType } from './OxyServices.accounts';
import { CACHE_TIMES } from './mixinHelpers';

/**
 * Sanitized, PUBLIC application identity returned by the API when resolving a
 * cross-app/OAuth client to a registered application.
 *
 * This shape carries NO sensitive or membership fields — it is safe to display
 * unauthenticated in consent/authorize screens and device-flow approval UIs. The
 * API resolves a `client_id` (OAuth credential public key) to the owning
 * application and projects only the fields below. `id` is the application's
 * `_id` as a string.
 */
export interface PublicApplication {
  /** The application's Mongo `_id` as a string. */
  id: string;
  /** Human-readable application name shown to the user. */
  name: string;
  /** Optional short description of what the application does. */
  description?: string;
  /** Optional icon URL for the application. */
  icon?: string;
  /** Optional public website/homepage URL for the application. */
  websiteUrl?: string;
  /** Optional public privacy-policy URL, rendered as a legal link on the consent screen. */
  privacyPolicyUrl?: string;
  /** Optional public terms-of-service URL, rendered as a legal link on the consent screen. */
  termsUrl?: string;
  /** Application classification (set by Oxy platform staff). */
  type: ApplicationType;
  /** Whether the application is an officially endorsed Oxy application. */
  isOfficial: boolean;
  /** Whether the application is an internal Oxy ecosystem application. */
  isInternal: boolean;
  /** OAuth scopes the application is configured to request. */
  scopes: string[];
  /** Optional display name of the developer/owner organisation. */
  developerName?: string;
}

/**
 * A connected (OAuth-authorized) application from the current user's point of
 * view: an application the user has granted access to via the consent flow.
 *
 * Returned by `GET /auth/grants` and rendered in the user-facing "Connected
 * apps" management surface. Keyed by `applicationId` (the application's Mongo
 * `_id`) rather than a credential/client id, so the grant — and a subsequent
 * {@link OxyServicesConnectedAppsMixin.revokeAppGrant} — survive credential
 * rotation. This is a display shape: it carries the application's name/logo and
 * the granted scopes, never any membership or credential material.
 */
export interface ConnectedApp {
  /** The connected application's Mongo `_id`. Use this to revoke the grant. */
  applicationId: string;
  /** Human-readable application name shown to the user. */
  name: string;
  /** Optional logo URL for the application. */
  logoUrl?: string;
  /** OAuth scopes the user has granted to the application. */
  scopes: string[];
  /** ISO timestamp of when the user first authorized the application. */
  firstGrantedAt: string;
  /** ISO timestamp of when the grant was last exercised. */
  lastUsedAt: string;
}

/** An external MCP client authorized for one exact app resource and account. */
export interface ConnectedMcpClient {
  id: string;
  appSlug: string;
  resource: string;
  scopes: string[];
  clientId: string;
  clientName: string;
  createdAt: string;
  lastUsedAt: string;
}

export function OxyServicesConnectedAppsMixin<T extends typeof OxyServicesBase>(Base: T) {
  return class extends Base {
    /**
     * Resolve an OAuth client identifier to the owning application's PUBLIC
     * identity. No authentication required — the API returns only sanitized,
     * display-safe metadata ({@link PublicApplication}). Use this to render the
     * requesting application's name/icon in consent, authorize, and device-flow
     * approval UIs before any session exists.
     *
     * @param clientId - The OAuth `client_id` (an active credential's public
     *   key). URL-encoded before being placed in the path.
     */
    async getPublicApplication(clientId: string): Promise<PublicApplication> {
      try {
        const res = await this.makeRequest<{ application: PublicApplication }>(
          'GET',
          `/auth/oauth/client/${encodeURIComponent(clientId)}`,
          undefined,
          {
            cache: true,
            cacheTTL: CACHE_TIMES.MEDIUM,
            // Public client metadata (pre-session consent UI) — skip the bearer preflight.
            skipAuth: true,
          },
        );
        return res.application;
      } catch (error) {
        throw this.handleError(error);
      }
    }

    /**
     * List the OAuth-authorized applications the current user has connected —
     * the third-party apps the user granted access to via the consent flow.
     * Each entry is a {@link ConnectedApp} carrying the application's display
     * identity, the granted scopes, and when the grant was first made and last
     * exercised. Requires an authenticated session.
     *
     * Backed by `GET /auth/grants`. The response is briefly cached
     * (identity-scoped); {@link revokeAppGrant} busts that cache so a revoke is
     * reflected on the next read.
     */
    async listConnectedApps(): Promise<ConnectedApp[]> {
      try {
        return await this.makeRequest<ConnectedApp[]>(
          'GET',
          '/auth/grants',
          undefined,
          { cache: true, cacheTTL: CACHE_TIMES.SHORT },
        );
      } catch (error) {
        throw this.handleError(error);
      }
    }

    /**
     * Revoke the current user's grant for a connected application, identified by
     * its application `_id` (a {@link ConnectedApp.applicationId}, NOT a
     * credential/client id — keyed by application so the revocation survives
     * credential rotation). After this the application can no longer act on the
     * user's behalf until it is re-authorized.
     *
     * Backed by `DELETE /auth/grants/:applicationId`. On success the cached
     * connected-apps list (`GET:/auth/grants`) is invalidated so the next
     * {@link listConnectedApps} read reflects the removal.
     *
     * @param applicationId - The connected application's Mongo `_id`.
     */
    async revokeAppGrant(applicationId: string): Promise<void> {
      try {
        await this.makeRequest<{ revoked: boolean }>(
          'DELETE',
          `/auth/grants/${applicationId}`,
          undefined,
          { cache: false },
        );
        // A revoke removes an entry from the user's connected-apps list; bust
        // the cached `GET /auth/grants` so the next read re-fetches.
        this.clearCacheEntry('GET:/auth/grants');
      } catch (error) {
        throw this.handleError(error);
      }
    }

    /** List resource-bound external MCP connections for the active Oxy account. */
    async listConnectedMcpClients(): Promise<ConnectedMcpClient[]> {
      try {
        const response = await this.makeRequest<{ grants: ConnectedMcpClient[] }>(
          'GET',
          '/auth/mcp/oauth/grants',
          undefined,
          { cache: true, cacheTTL: CACHE_TIMES.SHORT },
        );
        return response.grants;
      } catch (error) {
        throw this.handleError(error);
      }
    }

    /** Revoke one external MCP connection and every token in its family. */
    async revokeConnectedMcpClient(grantId: string): Promise<void> {
      try {
        await this.makeRequest<void>(
          'DELETE',
          `/auth/mcp/oauth/grants/${encodeURIComponent(grantId)}`,
          undefined,
          { cache: false },
        );
        this.clearCacheEntry('GET:/auth/mcp/oauth/grants');
      } catch (error) {
        throw this.handleError(error);
      }
    }
  };
}
