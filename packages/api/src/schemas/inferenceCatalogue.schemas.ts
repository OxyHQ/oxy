/**
 * The request and RESPONSE shapes of the public model catalogue, mounted at both
 * `/v1/models` and `/models`.
 *
 * ## Why the response envelopes are written down here
 *
 * `@oxyhq/contracts` already owns what a catalogue entry, a routing profile and a
 * model card ARE — those are the Oxy↔data-plane shapes and they are not restated.
 * What it does not own is the ENVELOPE this HTTP surface wraps them in: `{ data,
 * count }` on the collection reads, `{ models, count, timestamp }` on the one
 * Console still calls, `{ data }` on the single-entry reads. That envelope is a
 * fact about these five endpoints, and until this file it was written nowhere at
 * all — so the published contract described every one of them as returning an
 * undescribed 200, and a generated client returned `Any`.
 *
 * Each schema is bound to the handler that sends it by TYPE, not by comment: the
 * routes annotate the body they pass to `res.json` with the schema's own
 * `z.infer`, so a handler that stops matching its published response fails `tsc`.
 * The generator reads the same identifier from the route's `@response` tag.
 */

import { z } from 'zod';
import {
  modelCatalogueEntrySchema,
  modelDocumentationSchema,
  modelRevisionLabelSchema,
  routingProfileSchema,
} from '@oxyhq/contracts';

/**
 * The revision a documentation read may name.
 *
 * `modelRevisionLabelSchema` and nothing looser: the label is interpolated into
 * an equality predicate, and the contract's own grammar is what says which
 * strings can be one.
 */
export const documentationQuery = z
  .object({ revision: modelRevisionLabelSchema.optional() })
  .strict();

/** `GET /models` — the customer-safe catalogue. */
export const catalogueListResponse = z
  .object({
    data: z.array(modelCatalogueEntrySchema),
    count: z.number().int().nonnegative(),
  })
  .strict();

/**
 * `GET /models/stats` — the same catalogue in the envelope Console already parses.
 *
 * `models` rather than `data`, and a `timestamp`: this endpoint predates the
 * envelope above and its shape is what an existing consumer reads. Documented as
 * it is rather than corrected, because correcting it here would publish a promise
 * the server does not keep.
 */
export const catalogueStatsResponse = z
  .object({
    models: z.array(modelCatalogueEntrySchema),
    count: z.number().int().nonnegative(),
    timestamp: z.string().datetime(),
  })
  .strict();

/** `GET /models/routing-profiles` — the profiles a caller may target by slug. */
export const routingProfileListResponse = z
  .object({
    data: z.array(routingProfileSchema),
    count: z.number().int().nonnegative(),
  })
  .strict();

/** `GET /models/{publisher}/{model}` — one entry by canonical id. */
export const catalogueEntryResponse = z.object({ data: modelCatalogueEntrySchema }).strict();

/** `GET /models/{publisher}/{model}/documentation` — one revision's model card. */
export const modelDocumentationResponse = z.object({ data: modelDocumentationSchema }).strict();
