/**
 * `inference_publishers` — who released a model's weights.
 *
 * The first of the six concepts ADR 0008 separates. A publisher is NOT a
 * provider: Meta publishes Llama and serves nothing, Bedrock serves Llama and
 * publishes nothing. Conflating them is what makes a catalogue unable to answer
 * "whose licence applies?" and "who ran my request?" with different answers.
 *
 * ## The primary key is the slug, and that is the decision
 *
 * `CONVENTIONS.md` says a primary key is `text` from `generatedId()`. This table
 * is one of two deliberate exceptions (the other is `inference_providers`), for
 * a reason `link_previews.id` already established: an id that is CONTENT rather
 * than a surrogate says so by having no generator.
 *
 * A publisher slug is the left half of every canonical model id — `openai` in
 * `openai/gpt-5` — so it is a string customers have written into their own code
 * and pinned in their own configuration. It can never be renamed without
 * breaking every one of them, which makes it immutable by contract rather than
 * by convention. Two things follow, and both are why the exception earns itself:
 *
 *  1. `inference_models` can carry `publisher_slug` as a real FOREIGN KEY, so
 *     the `alia/*` reservation below is expressible as a CHECK on one row
 *     instead of a rule some service has to remember.
 *  2. `inference_models.model_id` can be a GENERATED column composed from
 *     columns of its own row, so the canonical id cannot drift from its parts.
 *
 * `ON UPDATE` is still never declared, exactly as the conventions say — not
 * because ids happen to be immutable here, but because this one is immutable by
 * the public contract it participates in.
 */

import { sql } from 'drizzle-orm';
import { check, pgTable, text } from 'drizzle-orm/pg-core';
import { createdAt, updatedAt } from '@oxyhq/db';
import { SLUG_CHECK_PATTERN } from './inferenceSlug';

export const inferencePublishers = pgTable(
  'inference_publishers',
  {
    /**
     * The publisher's namespace, e.g. `openai`, `anthropic`, `meta`, `alia`.
     * Lowercase and URL-safe, matching `publisherSlugSchema` in
     * `@oxyhq/contracts` — the grammar is part of the PUBLIC contract, since it
     * is half of a string customers type.
     */
    slug: text().primaryKey(),

    displayName: text().notNull(),
    /** Absent is NULL, never `''` — see `CONVENTIONS.md`. */
    description: text(),
    /** Absolute https, matching `inferenceHttpsUrlSchema`. */
    websiteUrl: text(),

    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    /**
     * The slug grammar, in the database rather than only in zod.
     *
     * A route handler validating the shape is bypassable by a seed script, a
     * backfill or a `psql` session; this is not. It matters more here than for
     * an ordinary column because a slug containing `/` would make
     * `inference_models.model_id` ambiguous — `a/b/c` has two readings — and
     * the ambiguity would only surface when somebody's pinned model id stopped
     * resolving.
     */
    check('inference_publishers_slug_format', sql`${t.slug} ~ ${sql.raw(SLUG_CHECK_PATTERN)}`),
  ]
);

export type InferencePublisherRow = typeof inferencePublishers.$inferSelect;
