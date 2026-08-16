/**
 * `inference_routing_policy_fallbacks` — the models a customer has EXPLICITLY
 * authorised as substitutes, for one immutable policy version.
 *
 * This table is the storage half of the epic's hardest invariant: **a request
 * for a concrete model is never silently replaced with a different model.**
 *
 * ## Authorisation is a set of ROWS, never a boolean
 *
 * There is deliberately no "cross-model fallback allowed" flag anywhere. Being
 * allowed to substitute IS having rows here, and each row names its destination.
 * A boolean would mean "you may serve something else, we did not say what",
 * which is exactly the silent substitution the invariant forbids — and once the
 * flag exists, "flag set, list empty" is a state somebody has to decide what to
 * do with. Deriving the permission from the rows removes the state instead of
 * handling it.
 *
 * ## Fallback disabled and a fallback destination cannot coexist
 *
 * `fallback_disabled` is a COPY of the parent version's column, CHECKed to be
 * false and joined to the parent by a composite foreign key
 * `(version_id, fallback_disabled) → versions(id, fallback_disabled)`. So a row
 * here can only attach to a version whose fallback is not disabled, and it
 * cannot drift from it — the version is immutable, so the value it was matched
 * against is the value it keeps. The contract expresses this as a refinement
 * because a flat wire object has no other option; storage can make it
 * unrepresentable.
 *
 * ## A destination names a MODEL or a REVISION, never both and never neither
 *
 * The same two forms `inference_routing_profile_candidates` distinguishes, for
 * the same reason: `<publisher>/<model>` follows the model line, and
 * `<publisher>/<model>@<revision>` pins exact weights. Two nullable foreign keys
 * with an exclusive-or CHECK rather than one text column, so "this policy
 * authorises fallback to a model that is not in the catalogue" is a constraint
 * failure at write time instead of a request that quietly resolves to nothing.
 *
 * The exclusive-or is written `(a is null) <> (b is null)`, which is FALSE when
 * both are null and FALSE when both are set; a CHECK rejects only FALSE, so both
 * degenerate rows are refused — including the empty one, which a naive
 * `a is not null or b is not null` would admit in the other direction.
 *
 * ## `position` records the customer's own order
 *
 * `authorizedCrossModel` is an ARRAY on the wire, so it has an order, and a read
 * that returned the destinations in whatever order the planner chose would not
 * round-trip the policy the customer wrote. `position` preserves the array index
 * and nothing more — it is deliberately not a PREFERENCE, which the contract
 * does not define and this table must not invent.
 */

import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  foreignKey,
  integer,
  pgTable,
  text,
  unique,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { createdAt, generatedId } from '@oxyhq/db';
import { inferenceModelRevisions } from './inferenceModelRevisions';
import { inferenceModels } from './inferenceModels';
import { inferenceRoutingPolicyVersions } from './inferenceRoutingPolicyVersions';

export const inferenceRoutingPolicyFallbacks = pgTable(
  'inference_routing_policy_fallbacks',
  {
    /**
     * A real id, because `inference_route_switch_events` points AT this row: a
     * recorded cross-model switch names the authorisation that permitted it, so
     * an unauthorised substitution has nothing to reference and cannot be
     * written down.
     */
    id: generatedId(),

    versionId: text().notNull(),

    /**
     * Always false, and constrained twice — by the CHECK below, and by the
     * composite foreign key that forces it to equal the parent version's value.
     * Together those say "this row exists only under a version whose fallback is
     * not disabled".
     */
    fallbackDisabled: boolean().notNull().default(false),

    /**
     * The unpinned form: substitute this model's current revision.
     *
     * `RESTRICT`, not `CASCADE`: silently dropping an authorisation when its
     * model leaves the catalogue would leave the policy still resolvable but
     * choosing from a SMALLER authorised set than the customer wrote, with no
     * error anywhere. Withdrawing an authorisation is the customer's decision,
     * so removing the model has to be refused until somebody makes it.
     */
    modelId: text().references(() => inferenceModels.id, { onDelete: 'restrict' }),

    /** The pinned form: exactly these weights. `RESTRICT` for the same reason. */
    modelRevisionId: text().references(() => inferenceModelRevisions.id, {
      onDelete: 'restrict',
    }),

    /** The customer's own array index. Not a preference — see the header. */
    position: integer().notNull(),

    createdAt: createdAt(),
  },
  (t) => [
    foreignKey({
      name: 'inference_routing_policy_fallbacks_version_fk',
      columns: [t.versionId, t.fallbackDisabled],
      foreignColumns: [
        inferenceRoutingPolicyVersions.id,
        inferenceRoutingPolicyVersions.fallbackDisabled,
      ],
    }).onDelete('cascade'),

    /**
     * The target a route-switch event points at. `id` alone is already unique as
     * the primary key; this pair exists so an event's `authorization_id` and its
     * `routing_policy_version_id` cannot name two different versions.
     */
    unique('inference_routing_policy_fallbacks_id_version_key').on(t.id, t.versionId),

    unique('inference_routing_policy_fallbacks_position_key').on(t.versionId, t.position),

    check('inference_routing_policy_fallbacks_not_disabled', sql`not ${t.fallbackDisabled}`),
    check(
      'inference_routing_policy_fallbacks_names_one',
      sql`(${t.modelId} is null) <> (${t.modelRevisionId} is null)`
    ),
    check('inference_routing_policy_fallbacks_position_range', sql`${t.position} >= 0`),

    /**
     * A version authorises each destination once.
     *
     * Two PARTIAL unique indexes rather than one three-column unique: Postgres
     * treats NULLs as DISTINCT, so a unique over two nullable columns would allow
     * the same model twice — every row would differ in the NULL column and
     * collide with nothing.
     */
    uniqueIndex('inference_routing_policy_fallbacks_model_key')
      .on(t.versionId, t.modelId)
      .where(sql`${t.modelId} is not null`),
    uniqueIndex('inference_routing_policy_fallbacks_revision_key')
      .on(t.versionId, t.modelRevisionId)
      .where(sql`${t.modelRevisionId} is not null`),
  ]
);

export type InferenceRoutingPolicyFallbackRow =
  typeof inferenceRoutingPolicyFallbacks.$inferSelect;
