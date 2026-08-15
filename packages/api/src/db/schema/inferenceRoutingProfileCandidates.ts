/**
 * `inference_routing_profile_candidates` — what a profile may resolve to, and
 * how strongly each is preferred.
 *
 * ## A candidate names a MODEL or a REVISION, never both and never neither
 *
 * `routingProfileCandidateSchema` carries a `modelReference`, and that grammar
 * admits two forms with genuinely different meanings:
 *
 *  - `<publisher>/<model>` — "whatever revision is current", so the profile
 *    follows the model line as it ships new revisions.
 *  - `<publisher>/<model>@<revision>` — those exact weights, pinned, so the
 *    profile's behaviour is reproducible and does not move under it.
 *
 * Both are legitimate and a profile author must choose deliberately, so the
 * distinction is two nullable foreign keys with an exclusive-or CHECK rather
 * than one text column. Storing the reference as a string instead would make
 * "this profile points at a model that no longer exists" undetectable — the
 * foreign keys are what make a retired model surface as a constraint rather
 * than as a request that quietly resolves to nothing.
 *
 * The exclusive-or is written `(a is null) <> (b is null)`, which is FALSE when
 * both are null and FALSE when both are set. A CHECK rejects only FALSE, so both
 * degenerate rows are refused — including the empty one, which a naive
 * `a is not null or b is not null` would admit in the other direction.
 */

import { sql } from 'drizzle-orm';
import { check, index, integer, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';
import { createdAt, generatedId, updatedAt } from '@oxyhq/db';
import { inferenceModelRevisions } from './inferenceModelRevisions';
import { inferenceModels } from './inferenceModels';
import { inferenceRoutingProfiles } from './inferenceRoutingProfiles';

export const inferenceRoutingProfileCandidates = pgTable(
  'inference_routing_profile_candidates',
  {
    id: generatedId(),

    /** `CASCADE`: a candidate of a deleted profile has nothing to belong to. */
    routingProfileId: text()
      .notNull()
      .references(() => inferenceRoutingProfiles.id, { onDelete: 'cascade' }),

    /**
     * The unpinned form: follow this model's current revision.
     *
     * `RESTRICT`, not `CASCADE`: silently dropping a candidate when its model is
     * removed would leave the profile still resolvable but choosing from a
     * SMALLER set than its author configured, with no error. A profile losing a
     * candidate is an editorial decision, so removing the model has to be
     * refused until somebody makes it.
     */
    modelId: text().references(() => inferenceModels.id, { onDelete: 'restrict' }),

    /** The pinned form: exactly these weights. `RESTRICT` for the same reason. */
    modelRevisionId: text().references(() => inferenceModelRevisions.id, {
      onDelete: 'restrict',
    }),

    /**
     * Lower sorts first; ties are broken by the profile's optimisation target.
     * Bounded to match `routingProfileCandidateSchema`, so a value the wire
     * would refuse cannot be stored.
     */
    priority: integer().notNull(),

    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check(
      'inference_routing_profile_candidates_names_exactly_one',
      sql`(${t.modelId} is null) <> (${t.modelRevisionId} is null)`
    ),
    check(
      'inference_routing_profile_candidates_priority_range',
      sql`${t.priority} between 0 and 1000`
    ),

    /**
     * A profile lists each candidate once.
     *
     * Two PARTIAL unique indexes rather than one `unique(profile, model,
     * revision)`: Postgres treats NULLs as DISTINCT, so a three-column unique
     * over two nullable columns would allow the same model twice — every row
     * would differ in the NULL column and collide with nothing. The partial
     * form asks the question that is actually meant, once per form.
     */
    uniqueIndex('inference_routing_profile_candidates_profile_model_key')
      .on(t.routingProfileId, t.modelId)
      .where(sql`${t.modelId} is not null`),
    uniqueIndex('inference_routing_profile_candidates_profile_revision_key')
      .on(t.routingProfileId, t.modelRevisionId)
      .where(sql`${t.modelRevisionId} is not null`),

    /** The profile's own read: its candidates in preference order. */
    index('inference_routing_profile_candidates_profile_priority_idx').on(
      t.routingProfileId,
      t.priority
    ),
  ]
);

export type InferenceRoutingProfileCandidateRow =
  typeof inferenceRoutingProfileCandidates.$inferSelect;
