/**
 * `follow_targets` — the canonical registry of anything a user can follow.
 *
 * One row per followable thing, identified by a URI that outlives whoever
 * resolved it:
 *
 *   https://oxy.so/users/<id>
 *   https://mention.earth/tags/design
 *   https://syra.music/artists/<id>
 *   https://mercaria.shop/stores/<id>
 *   https://mastodon.example/users/alice
 *
 * ## The provider does not own the relationship
 *
 * `provider_application_id` records which application knows how to resolve this
 * target's metadata — a display name, an icon, a deep link. That is provenance,
 * not authority. The relationship belongs to the user, so an application being
 * deleted must not erase what the user chose to follow: the canonical URI and
 * the last safe metadata snapshot stay, and the row simply stops being
 * refreshable. `SET NULL`, never `CASCADE`.
 *
 * ## Why a snapshot at all
 *
 * A central "everything you follow" list has to render a row for a target whose
 * provider is offline, suspended, or gone. Resolving live would make that list
 * as available as the least available application in it. The snapshot is
 * bounded and display-only for the same reason: it is a cache of how to show
 * the thing, never a source of truth about it.
 */

import { index, jsonb, pgTable, text, unique } from 'drizzle-orm/pg-core';
import { applications } from './applications';
import { followTargetKinds } from './followTargetKinds';
import { createdAt, generatedId, updatedAt } from '@oxyhq/db';
import type { FollowKindCapabilities } from './followTargetKinds';
import { users } from './users';

export const followTargets = pgTable(
  'follow_targets',
  {
    id: generatedId(),
    /**
     * The stable address of the thing. UNIQUE, and the identity every client
     * caches on — a bare id is ambiguous across kinds and applications.
     */
    canonicalUri: text().notNull(),
    /**
     * The registered kind, `<namespace>.<thing>`.
     *
     * A REFERENCE, not an enum. The platform does not know what kinds exist —
     * an application registers its own in its own namespace — so a hardcoded
     * list here would put a central migration between every new app and its
     * first follow button. `RESTRICT`: a kind with targets cannot be pulled out
     * from under them.
     */
    kind: text()
      .notNull()
      .references(() => followTargetKinds.kind, { onDelete: 'restrict' }),
    /**
     * Who resolves this target's metadata. `SET NULL`: the user's relationship
     * survives the application that introduced it.
     */
    providerApplicationId: text().references(() => applications.id, { onDelete: 'set null' }),
    /** The provider's own id for the thing, when it has one. Opaque here. */
    providerReference: text(),
    /**
     * Set only for `oxy.user` targets, and UNIQUE when set.
     *
     * This is what lets the optimized account graph stay authoritative for
     * user-to-user queries while the generic model carries everything else — a
     * relationship to a user can be joined straight back to `users` without
     * parsing a URI.
     *
     * `CASCADE`: a deleted account's target is not followable, and leaving a
     * dangling row would let the central list render a person who no longer
     * exists.
     */
    localUserId: text().references(() => users.id, { onDelete: 'cascade' }),
    /**
     * Bounded, display-safe metadata: name, handle, icon, deep link. Never
     * authoritative, and never large — see the header.
     */
    metadataSnapshot: jsonb().$type<Record<string, unknown>>(),
    /**
     * What can be done with this target, as structured data rather than as
     * knowledge spread across clients: the verb to render (`follow`,
     * `subscribe`, `join`), whether reverse counts are public, whether a
     * federation adapter applies.
     */
    /**
     * Per-target overrides of the kind's capabilities. Almost always NULL — the
     * kind is where this is normally decided, so one target cannot quietly
     * disagree with the rest of its kind about what the verb is.
     */
    capabilities: jsonb().$type<FollowKindCapabilities>(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique('follow_targets_canonical_uri_key').on(t.canonicalUri),
    // At most one target per local account. Without it, two rows could describe
    // the same person and the follower counts would disagree depending on which
    // one a caller found.
    unique('follow_targets_local_user_id_key').on(t.localUserId),
    // "Everything of this kind" — the central list's kind filter, and the sweep
    // a provider runs when refreshing its own snapshots.
    index('follow_targets_kind_idx').on(t.kind),
    index('follow_targets_provider_application_id_idx').on(t.providerApplicationId),
  ]
);
