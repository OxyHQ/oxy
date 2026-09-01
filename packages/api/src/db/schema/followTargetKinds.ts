/**
 * `follow_target_kinds` — what an application declares it can make followable.
 *
 * The platform does NOT enumerate the kinds. It cannot: a hardcoded list would
 * mean every application that wants its own followable thing needs a migration
 * in the central API, reviewed and deployed by someone else, before it can ship
 * a button. With a handful of first-party apps that reads as tidy; with a
 * thousand it is a queue, and the queue is owned by the wrong people.
 *
 * So a kind is DATA. An application registers `<namespace>.<thing>` inside its
 * own namespace, and the platform's job is to keep namespaces apart rather than
 * to know what a `store` or an `artist` is.
 *
 * ## Namespacing is the whole safety property
 *
 * `namespace` is the application's, assigned once and never claimable by
 * another. `mercaria.store` can only be registered by whoever owns `mercaria`,
 * so one application can neither define nor silently redefine another's kinds —
 * which is the multi-tenant version of the authority rule this whole feature is
 * built on.
 *
 * `oxy.*` is the platform's own namespace, owned by no application row, which
 * is why `application_id` is nullable.
 *
 * ## Capabilities live here, not on each target
 *
 * The verb a client renders and the privacy of reverse lookups are properties
 * of the KIND. Putting them on every target row would let two stores disagree
 * about whether a store is "subscribed to", and putting them in client code
 * would let two screens in one app disagree. Declared once, by the application
 * that owns the concept.
 */

import { sql } from 'drizzle-orm';
import { check, index, jsonb, pgTable, text, unique } from 'drizzle-orm/pg-core';
import { applications } from './applications';
import { followNamespaces } from './followNamespaces';
import { createdAt, generatedId, updatedAt } from '@oxyhq/db';

/**
 * What clients may do with a kind.
 *
 * `verb` exists because "Follow" is wrong for half of what becomes followable —
 * a store is subscribed to, a channel is joined — and a per-call-site label
 * would drift between surfaces of the same app.
 *
 * `reverse` is the privacy decision #809 requires each kind to make EXPLICITLY.
 * A user's followers are public; a hashtag's are nobody's business. `unavailable`
 * is a real answer, not an omission, and the default is the private one so a
 * kind registered carelessly leaks nothing.
 */
export interface FollowKindCapabilities {
  verb?: 'follow' | 'subscribe' | 'join' | 'watch';
  reverse?: 'public' | 'private' | 'aggregate' | 'unavailable';
  /** Whether following this kind has to be projected onto a remote protocol. */
  federated?: boolean;
}

export const followTargetKinds = pgTable(
  'follow_target_kinds',
  {
    id: generatedId(),
    /**
     * The kind itself, `<namespace>.<thing>` — `oxy.user`, `mercaria.store`.
     * UNIQUE: it is the value `follow_targets.kind` points at.
     */
    kind: text().notNull(),
    /**
     * The namespace half, stored rather than parsed at read time so ownership
     * can be indexed and constrained instead of re-derived by every caller.
     *
     * A REFERENCE into `follow_namespaces`: the prefix check below proves the
     * kind lives in the namespace it claims, and this proves the claimant owns
     * that namespace at all. Without the second, any application holding
     * `follow-targets:register` could register another's kinds.
     */
    namespace: text()
      .notNull()
      .references(() => followNamespaces.namespace, { onDelete: 'restrict' }),
    /**
     * The application that owns the namespace. NULL for the platform's own
     * `oxy.*` kinds.
     *
     * `CASCADE` is deliberately NOT used: see `follow_targets`. A deleted
     * application must not take the user's relationships with it, so the kind
     * outlives it and simply stops being refreshable.
     */
    applicationId: text().references(() => applications.id, { onDelete: 'set null' }),
    /** Display-only label for a management UI listing what a user follows. */
    label: text(),
    capabilities: jsonb().$type<FollowKindCapabilities>(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique('follow_target_kinds_kind_key').on(t.kind),
    index('follow_target_kinds_namespace_idx').on(t.namespace),
    // The kind must actually live in the namespace it claims. Enforced in the
    // database because it is the invariant that keeps one application from
    // defining another's kinds, and an invariant that only application code
    // upholds is one a migration or a script can walk straight past.
    check('follow_target_kinds_namespace_prefix_check', sql`${t.kind} like ${t.namespace} || '.%'`),
    // A namespace is a single dotted segment: `mercaria`, never `mercaria.shop`
    // or an empty string. Without this, `a.b` could claim to be namespace `a.b`
    // and then register `a.b.c`, which reads as nesting and is really a second
    // owner for the `a` namespace.
    check('follow_target_kinds_namespace_shape_check', sql`${t.namespace} ~ '^[a-z][a-z0-9_]*$'`),
  ]
);
