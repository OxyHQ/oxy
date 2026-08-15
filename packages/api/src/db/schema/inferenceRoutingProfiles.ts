/**
 * `inference_routing_profiles` — a named strategy for CHOOSING among routes.
 *
 * The sixth of ADR 0008's six concepts, and the one the other five exist to keep
 * it apart from. `auto`, `fast` and `quality` are profiles or product presets;
 * they are never model objects. A profile has no publisher, no revision, no
 * licence and no weights, and the response to a request that named one always
 * reports the concrete model revision and serving deployment that actually ran
 * — that report is what makes a profile honest rather than a tier name in
 * disguise.
 *
 * ## The slug cannot be written in the shape of a model id
 *
 * `routingProfileSlugSchema` refuses `/` on the wire; the CHECK below refuses it
 * in the database. That is the structural half of "a request for a concrete
 * model is never silently replaced with a different model": a caller can always
 * tell which kind of thing they asked for, because the two identifier spaces
 * cannot overlap. A profile called `alia/fast` would make that undecidable, and
 * it is exactly the shape the retired tier names had.
 *
 * ## Candidates are a child table
 *
 * `inference_routing_profile_candidates`. An array of ENTITIES becomes a real
 * table with real foreign keys — a `jsonb` array of model references could not
 * be joined against the catalogue, so nothing would notice a profile pointing at
 * a model that had been retired.
 */

import { sql } from 'drizzle-orm';
import { boolean, check, pgTable, text } from 'drizzle-orm/pg-core';
import { createdAt, generatedId, inList, updatedAt } from '@oxyhq/db';
import { SLUG_CHECK_PATTERN } from './inferenceSlug';

/** What a profile optimises for when several candidates qualify. */
export const ROUTING_PROFILE_OPTIMISATIONS = [
  'price',
  'latency',
  'throughput',
  'quality',
  'balanced',
] as const;

export type RoutingProfileOptimisation = (typeof ROUTING_PROFILE_OPTIMISATIONS)[number];

export const inferenceRoutingProfiles = pgTable(
  'inference_routing_profiles',
  {
    id: generatedId(),

    /**
     * `auto`, `fast`, `quality`, or a customer-defined name. UNIQUE across the
     * whole profile space, which is a separate identifier space from model ids
     * — see the format CHECK.
     */
    slug: text().notNull().unique(),

    displayName: text().notNull(),
    description: text(),

    optimiseFor: text({ enum: ROUTING_PROFILE_OPTIMISATIONS }).notNull(),

    /**
     * A product preset (Alia's "fast" toggle) rather than a customer's own
     * profile. Kept as a flag rather than two tables because the selection
     * mechanism is identical and only the AUTHORSHIP differs; Console renders
     * the two in different places by reading it.
     */
    isProductPreset: boolean().notNull(),

    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    /**
     * The slug grammar, which refuses `/` because the pattern has no alternative
     * for it. This is the constraint that keeps the profile namespace and the
     * model namespace disjoint, so no caller and no log line has to guess which
     * one a string came from.
     */
    check(
      'inference_routing_profiles_slug_format',
      sql`${t.slug} ~ ${sql.raw(SLUG_CHECK_PATTERN)}`
    ),
    check(
      'inference_routing_profiles_optimise_for_check',
      sql`${t.optimiseFor} in (${sql.raw(inList(ROUTING_PROFILE_OPTIMISATIONS))})`
    ),
  ]
);

export type InferenceRoutingProfileRow = typeof inferenceRoutingProfiles.$inferSelect;
