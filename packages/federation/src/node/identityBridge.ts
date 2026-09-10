/**
 * The network-neutral identity bridge — the DEFAULT implementation of the
 * actor↔Oxy-user seam.
 *
 * The DATA is Oxy's: a remote actor is minted/updated as a `type:'federated'` Oxy
 * user via `PUT /users/resolve`, and permanently-gone actors are archived
 * (`POST /federation/actor-gone`) or hard-deleted (`POST /federation/actor-delete`)
 * on the Oxy side. Those are service-scoped oxy-api calls (scope `federation:write`),
 * so the transport is injected ({@link IdentityBridgeConfig.makeServiceRequest} —
 * for Mention, `getServiceOxyClient().makeServiceRequest`). Private keys and
 * canonical identity never enter this package.
 *
 * App-owned side effects are injected too: a post-resolve cache invalidation hook
 * ({@link IdentityBridgeConfig.onUserResolved}) and the banner mirror
 * ({@link IdentityBridgeConfig.mirrorBanner}, which uses the app's own media
 * pipeline). The banner mirror is best-effort: a failure there must never discard
 * an already-successful user resolution.
 */

import { getErrorMessage, getErrorStatus } from '@oxy.so/core';
import type { NormalizedExternalActor } from '../index';

/** The HTTP methods the service-scoped oxy-api transport is invoked with. */
export type ServiceRequestMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/** The service-scoped request transport oxy-api calls go through (`{ data }`-unwrapped). */
export type ServiceRequest = <T>(method: ServiceRequestMethod, path: string, body?: unknown) => Promise<T>;

/** Minimal logging sink the identity bridge writes to. */
export interface IdentityBridgeLogger {
  info(message: string, meta?: unknown): void;
  warn(message: string, meta?: unknown): void;
}

/** Adapters the identity bridge is built from. */
export interface IdentityBridgeConfig {
  /** Service-scoped oxy-api request transport (unwraps the API's `{ data }` envelope). */
  makeServiceRequest: ServiceRequest;
  /**
   * Called with the resolved Oxy user id after a successful `PUT /users/resolve`
   * (before the banner mirror). For Mention: evict the warm user-summary cache.
   */
  onUserResolved?: (oxyUserId: string) => Promise<void> | void;
  /**
   * Mirror the actor's remote banner into a durable app-owned asset. Best-effort:
   * MUST NOT throw (it handles its own errors); a failure never drops the resolved
   * user. Absent ⇒ banners are not mirrored.
   */
  mirrorBanner?: (bannerUrl: string, oxyUserId: string, actorUri: string) => Promise<void>;
  /** Diagnostics sink. */
  logger: IdentityBridgeLogger;
}

/**
 * Outcome discriminant of {@link IdentityBridge.reportActorGone}. NEVER thrown —
 * both callers (the live 410 tombstone and the one-shot prune sweep) are
 * fail-soft, so the transient/retryable case is surfaced as a value (`'failed'`).
 *
 *  - `archived` — Oxy archived a previously-active identity (removed from search).
 *  - `already`  — the identity was already archived (idempotent no-op, still 200).
 *  - `skipped`  — nothing to report, or a PERMANENT client error (400/403/404/409).
 *  - `failed`   — a genuinely transient failure (5xx, 408/429, network). Retryable.
 */
export type ReportActorGoneOutcome = 'archived' | 'already' | 'skipped' | 'failed';

/**
 * Outcome discriminant of {@link IdentityBridge.deleteActorIdentity}. NEVER thrown.
 *
 *  - `deleted` — oxy-api hard-deleted a live Oxy identity (+ follow edges/blocks).
 *  - `absent`  — the identity was already gone (200, `deleted:false`). Oxy side clean.
 *  - `skipped` — nothing to delete, or a PERMANENT client error (400/403/409).
 *  - `failed`  — a genuinely transient failure (5xx, 408/429, network). Retryable.
 */
export type DeleteActorIdentityOutcome = 'deleted' | 'absent' | 'skipped' | 'failed';

/** The `{ data }`-unwrapped body oxy-api returns for a 200 `POST /federation/actor-gone`. */
interface ActorGoneResponse {
  oxyUserId: string;
  accountStatus: 'archived';
  alreadyArchived: boolean;
}

/** The `{ data }`-unwrapped body oxy-api returns for a 200 `POST /federation/actor-delete`. */
interface ActorDeleteResponse {
  oxyUserId: string;
  deleted: boolean;
  followEdgesRemoved: number;
}

const ACTOR_GONE_PATH = '/federation/actor-gone';
const ACTOR_DELETE_PATH = '/federation/actor-delete';

/** The actor↔Oxy-user identity bridge. */
export interface IdentityBridge {
  /**
   * Resolve/mint the Oxy user a normalized external actor maps to, via
   * `PUT /users/resolve` (service-scoped). Returns the resolved id, or `null` when
   * Oxy is unreachable / returns no id (callers must then skip, never persisting an
   * orphan). Mirrors the banner after resolution (best-effort).
   */
  resolveExternalUser(
    actor: NormalizedExternalActor,
    opts?: { forceAvatarRefresh?: boolean },
  ): Promise<string | null>;
  /** Ask oxy-api to ARCHIVE the identity of a permanently-gone actor (reversible). */
  reportActorGone(oxyUserId: string): Promise<ReportActorGoneOutcome>;
  /** Ask oxy-api to HARD-DELETE the identity of a permanently-gone actor (irreversible). */
  deleteActorIdentity(oxyUserId: string): Promise<DeleteActorIdentityOutcome>;
}

/** True for a PERMANENT (non-retryable) 4xx: 400/403/404/409, but NOT 408/429. */
function isPermanentClientError(httpStatus: number | undefined): boolean {
  return (
    httpStatus !== undefined &&
    httpStatus >= 400 &&
    httpStatus < 500 &&
    httpStatus !== 408 &&
    httpStatus !== 429
  );
}

/** Build the network-neutral identity bridge from an app's adapters. */
export function createIdentityBridge(config: IdentityBridgeConfig): IdentityBridge {
  return {
    async resolveExternalUser(actor, opts = {}): Promise<string | null> {
      const forceAvatarRefresh = opts.forceAvatarRefresh ?? false;
      try {
        // The connector owns deriving the canonical `local@domain` username and the
        // instance domain for its protocol, so this bridge stays protocol-agnostic:
        // it never has to guess a domain out of a bare atproto handle or a hostless
        // DID. oxy-api binds the two (username domain must equal `domain`).
        const oxyUser = await config.makeServiceRequest<{ _id?: string; id?: string } | null>(
          'PUT',
          '/users/resolve',
          {
            type: 'federated',
            username: actor.federatedUsername,
            actorUri: actor.externalId,
            domain: actor.instanceDomain,
            displayName: actor.displayName,
            avatar: actor.avatarUrl,
            bio: actor.bio,
            // On refresh, tell Oxy to re-download and replace the avatar even if it
            // already stored a file ID. Coordinated with oxy-api's
            // `refresh` / `forceAvatarRefresh` flag on PUT /users/resolve.
            refresh: forceAvatarRefresh,
            forceAvatarRefresh,
          },
        );
        const oxyId = String(oxyUser?._id || oxyUser?.id || '');
        if (!oxyId) return null;

        // A re-resolve can refresh the federated actor's display name / avatar in
        // Oxy. Let the app evict any warm cache so the next read is fresh.
        if (config.onUserResolved) {
          await config.onUserResolved(oxyId);
        }

        if (actor.bannerUrl && config.mirrorBanner) {
          // Best-effort on the live path: the mirror handles its own failures.
          await config.mirrorBanner(actor.bannerUrl, oxyId, actor.externalId);
        }

        return oxyId;
      } catch (resolveErr) {
        config.logger.warn(`Failed to resolve Oxy user for ${actor.externalId}:`, resolveErr);
        return null;
      }
    },

    async reportActorGone(oxyUserId): Promise<ReportActorGoneOutcome> {
      const id = oxyUserId.trim();
      if (!id) return 'skipped';

      try {
        const data = await config.makeServiceRequest<ActorGoneResponse>('POST', ACTOR_GONE_PATH, {
          oxyUserId: id,
        });
        const alreadyArchived = data?.alreadyArchived === true;
        config.logger.info(`[Federation] oxy-api archived gone actor ${id}`, { alreadyArchived });
        return alreadyArchived ? 'already' : 'archived';
      } catch (error) {
        const httpStatus = getErrorStatus(error);
        const reason = getErrorMessage(error);
        if (isPermanentClientError(httpStatus)) {
          config.logger.warn(`[Federation] actor-gone report for ${id} rejected (HTTP ${httpStatus}, permanent)`, {
            reason,
          });
          return 'skipped';
        }
        config.logger.warn(`[Federation] actor-gone report for ${id} failed transiently; leaving for retry`, {
          status: httpStatus,
          reason,
        });
        return 'failed';
      }
    },

    async deleteActorIdentity(oxyUserId): Promise<DeleteActorIdentityOutcome> {
      const id = oxyUserId.trim();
      if (!id) return 'skipped';

      try {
        const data = await config.makeServiceRequest<ActorDeleteResponse>('POST', ACTOR_DELETE_PATH, {
          oxyUserId: id,
        });
        const deleted = data?.deleted === true;
        config.logger.info(
          `[Federation] oxy-api ${deleted ? 'hard-deleted' : 'found no'} identity for gone actor ${id}`,
          { followEdgesRemoved: data?.followEdgesRemoved ?? 0 },
        );
        return deleted ? 'deleted' : 'absent';
      } catch (error) {
        const httpStatus = getErrorStatus(error);
        const reason = getErrorMessage(error);
        if (isPermanentClientError(httpStatus)) {
          config.logger.warn(`[Federation] actor-delete for ${id} rejected (HTTP ${httpStatus}, permanent)`, {
            reason,
          });
          return 'skipped';
        }
        config.logger.warn(`[Federation] actor-delete for ${id} failed transiently; leaving for retry`, {
          status: httpStatus,
          reason,
        });
        return 'failed';
      }
    },
  };
}
