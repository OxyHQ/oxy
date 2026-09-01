/**
 * Follow Graph Mixin (`/v2/follows`)
 *
 * The user-owned follow graph: one relationship per user and target, shared by
 * every application, with per-application context on top. This is the SDK half
 * of #809 and the replacement for the per-app follow endpoints each application
 * grew for itself.
 *
 * ## Why this is not `followUser` with more parameters
 *
 * `followUser` answers "does A follow B" and nothing else. This answers "what
 * does this user follow, anywhere, and which applications act on it" — a
 * different question with a different owner. The legacy methods stay for the
 * Mongo-backed social graph they were written for; new kinds (topics, stores,
 * artists, channels) come here, and users will migrate behind an adapter rather
 * than through a flag day.
 *
 * ## Caching
 *
 * Every method is `cache: false`. A follow status is exactly the shape that
 * must never be served stale: the SDK's GET cache is identity-scoped but
 * time-based, and a status cached across a write is the "follow reverts after
 * navigating away and back" bug — which the legacy `followUser` had to fix with
 * explicit invalidation. Not caching at this layer means an app's own store
 * (React Query, Zustand) is the single cache authority, which is the rule the
 * ecosystem already follows for anything written and read in the same session.
 */

import type {
  FollowListPage,
  FollowMutation,
  FollowOptions,
  FollowStatus,
  UnfollowMutation,
} from '@oxyhq/contracts';
import type { OxyServicesBase } from '../OxyServices.base';
import { buildUrl } from '../utils/apiUtils';

export function OxyServicesFollowGraphMixin<T extends typeof OxyServicesBase>(Base: T) {
  return class extends Base {
    constructor(...args: any[]) {
      super(...(args as [any]));
    }

    /**
     * Follow a target. Idempotent — following something already followed
     * returns the same relationship with `created: false`.
     *
     * The follower and the acting application are BOTH derived server-side from
     * the session. There is deliberately no parameter for either: a client that
     * could name them could forge a follow on another user's behalf, or record
     * one as coming from an application it is not.
     *
     * @param targetId - The registered target's id, not its URI. Registration is
     *   a separate operation precisely so following cannot silently create
     *   targets — a typo would otherwise become a permanent row nobody follows.
     * @param options.expiresIn - Seconds until the follow lapses on its own. For
     *   an event, a trial, a topic followed for a week. The server bounds it.
     */
    async followTarget(targetId: string, options?: FollowOptions): Promise<FollowMutation> {
      try {
        return await this.makeRequest<FollowMutation>(
          'PUT',
          `/v2/follows/${encodeURIComponent(targetId)}`,
          options?.expiresIn !== undefined ? { expiresIn: options.expiresIn } : {},
          { cache: false },
        );
      } catch (error) {
        throw this.handleError(error);
      }
    }

    /**
     * Unfollow everywhere.
     *
     * There is no "unfollow here" — that is `setFollowApplicationMode(...,
     * 'disabled')`, and keeping the two distinct is the point of the design. An
     * application that quietly turned a global unfollow into a local one would
     * leave the user believing they had stopped following something they still
     * follow everywhere else.
     *
     * Idempotent: `removed: false` when it was already gone, because the state
     * the caller asked for is the state that holds.
     */
    async unfollowTarget(relationshipId: string): Promise<UnfollowMutation> {
      try {
        return await this.makeRequest<UnfollowMutation>(
          'DELETE',
          `/v2/follows/${encodeURIComponent(relationshipId)}`,
          undefined,
          { cache: false },
        );
      } catch (error) {
        throw this.handleError(error);
      }
    }

    /**
     * The three-part status: globally, in this application, and in effect.
     *
     * Render `effectiveState` on the button and keep the other two for the
     * explanation. A UI that collapses them cannot tell the user why a follow
     * they can see in their list is not showing up in this app's feed.
     */
    async getFollowTargetStatus(targetId: string): Promise<FollowStatus> {
      try {
        return await this.makeRequest<FollowStatus>(
          'GET',
          `/v2/follows/${encodeURIComponent(targetId)}/status`,
          undefined,
          { cache: false },
        );
      } catch (error) {
        throw this.handleError(error);
      }
    }

    /**
     * Turn a relationship off, or back on, in ONE application.
     *
     * Omit `applicationId` and it applies to the calling application, which is
     * the only form an ordinary app should ever need. Naming a DIFFERENT
     * application requires `follows:manage` server-side — acting on another
     * app's behalf is exactly the cross-application authority this design
     * otherwise refuses, so it is a distinct permission and not a parameter an
     * app happens to fill in.
     */
    async setFollowApplicationMode(
      relationshipId: string,
      mode: 'enabled' | 'disabled',
      applicationId?: string,
    ): Promise<{ ok: true }> {
      try {
        return await this.makeRequest(
          'PUT',
          `/v2/follows/${encodeURIComponent(relationshipId)}/context`,
          { mode, ...(applicationId ? { applicationId } : {}) },
          { cache: false },
        );
      } catch (error) {
        throw this.handleError(error);
      }
    }

    /**
     * Drop the override so this application follows the global relationship
     * again. Distinct from setting `enabled`: inheriting means a later global
     * change takes effect here, and an explicit `enabled` means it does not.
     */
    async restoreFollowInheritance(
      relationshipId: string,
      applicationId?: string,
    ): Promise<{ ok: true }> {
      try {
        const path = buildUrl(
          `/v2/follows/${encodeURIComponent(relationshipId)}/context`,
          applicationId ? { applicationId } : {},
        );
        return await this.makeRequest('DELETE', path, undefined, { cache: false });
      } catch (error) {
        throw this.handleError(error);
      }
    }

    /**
     * Resolve a target by canonical URI, registering it the first time anyone
     * asks. The call an application makes on the way into a screen, before it
     * can render a button.
     *
     * Idempotent on the URI, which is what makes two applications describing
     * the same thing — the same fediverse actor, the same topic — arrive at ONE
     * row, and therefore at one relationship per user rather than one per app.
     *
     * `metadata` is a display snapshot (name, handle, icon) and is refreshed
     * only for the application that provides the target: a second application
     * passing its own idea of the name would make the display flip depending on
     * which app last looked.
     */
    async ensureFollowTarget(input: {
      uri: string;
      kind: string;
      metadata?: Record<string, unknown>;
      providerReference?: string;
      localUserId?: string;
    }): Promise<{ id: string; uri: string; kind: string; created: boolean }> {
      try {
        return await this.makeRequest('POST', '/v2/follow-targets', input, { cache: false });
      } catch (error) {
        throw this.handleError(error);
      }
    }

    /**
     * Claim a namespace for the calling application. First come, and idempotent
     * for the holder — an application that registers on every boot must not
     * fail the second time.
     */
    async claimFollowNamespace(
      namespace: string
    ): Promise<{ namespace: string; created: boolean }> {
      try {
        return await this.makeRequest(
          'POST',
          '/v2/follow-targets/namespaces',
          { namespace },
          { cache: false },
        );
      } catch (error) {
        throw this.handleError(error);
      }
    }

    /**
     * Release a namespace the calling application holds, when nothing is
     registered inside it yet.
     *
     * Idempotent when the namespace is already unowned (`released: false`).
     * Exists because claims are first-come and registration runs on boot — a
     * development build with the wrong client id can bind a name permanently
     * unless the holder can give it back.
     */
    async releaseFollowNamespace(
      namespace: string,
    ): Promise<{ namespace: string; released: boolean }> {
      try {
        return await this.makeRequest(
          'DELETE',
          `/v2/follow-targets/namespaces/${encodeURIComponent(namespace)}`,
          undefined,
          { cache: false },
        );
      } catch (error) {
        throw this.handleError(error);
      }
    }

    /**
     * Declare what following a kind of thing MEANS: the verb clients render,
     * whether reverse lookups are public, whether it federates.
     *
     * Declared once by the application that owns the concept, rather than
     * passed per call site — otherwise two screens of one app can disagree
     * about whether a store is followed or subscribed to.
     */
    async registerFollowKind(input: {
      kind: string;
      label?: string;
      capabilities?: {
        // Matches `FollowVerb` in @oxyhq/services, which is what renders it. A
        // kind that can display a verb it cannot record is a kind whose button
        // and registration disagree.
        verb?: 'follow' | 'subscribe' | 'join' | 'watch';
        reverse?: 'public' | 'private' | 'aggregate' | 'unavailable';
        federated?: boolean;
      };
    }): Promise<{ kind: string; created: boolean }> {
      try {
        return await this.makeRequest('POST', '/v2/follow-targets/kinds', input, {
          cache: false,
        });
      } catch (error) {
        throw this.handleError(error);
      }
    }

    /**
     * Everything the signed-in user follows, newest first.
     *
     * Owner-only by construction server-side — there is no parameter naming a
     * user, so this cannot be pointed at somebody else's graph.
     *
     * Paginate by passing back `nextCursor`, never an offset: the list changes
     * while it is being read, and an offset silently skips or repeats rows
     * exactly when it does.
     */
    async listFollows(params?: {
      kind?: string;
      cursor?: string;
      limit?: number;
    }): Promise<FollowListPage> {
      try {
        const path = buildUrl('/v2/me/follows', {
          ...(params?.kind ? { kind: params.kind } : {}),
          ...(params?.cursor ? { cursor: params.cursor } : {}),
          ...(params?.limit ? { limit: params.limit } : {}),
        });
        return await this.makeRequest<FollowListPage>('GET', path, undefined, { cache: false });
      } catch (error) {
        throw this.handleError(error);
      }
    }
  };
}
