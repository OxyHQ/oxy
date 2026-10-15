/**
 * `POST /v1/images/generations` — text to image, in OpenAI's shapes.
 *
 * Moved from the Oxy edge (`packages/api/src/schemas/inferenceEdge.schemas.ts`)
 * by Kaana ADR 0002, unchanged. `size` and `quality` are forwarded and do not
 * widen the hold: each size/quality class is its own model reference in the
 * catalogue, because a price prices a unit, not a `(unit, size, quality)` tuple.
 */

import { z } from 'zod';
import { modelReferenceSchema } from './identifiers.js';

export const imageGenerationsRequestSchema = z
  .object({
    model: modelReferenceSchema,
    prompt: z.string().min(1).max(32_000),
    /** OpenAI caps this at 10. Exact, declared, and the whole ceiling. */
    n: z.number().int().min(1).max(10).optional(),
    size: z.string().min(1).max(32).optional(),
    quality: z.string().min(1).max(32).optional(),
    style: z.string().min(1).max(32).optional(),
    response_format: z.enum(['url', 'b64_json']).optional(),
    user: z.string().min(1).max(64).optional(),
  })
  .strict();

/**
 * A union per element rather than two optional fields: the endpoint returns a
 * URL or inline base64 and never both.
 */
export const imageGenerationsSchema = z
  .object({
    created: z.number().int().nonnegative(),
    data: z.array(
      z.union([
        z.object({ url: z.string().min(1) }).strict(),
        z.object({ b64_json: z.string().min(1) }).strict(),
      ]),
    ),
  })
  .strict();

export type ImageGenerationsRequest = z.infer<typeof imageGenerationsRequestSchema>;
export type ImageGenerations = z.infer<typeof imageGenerationsSchema>;
