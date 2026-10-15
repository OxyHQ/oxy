/**
 * `POST /v1/embeddings` — OpenAI-compatible, so a stock OpenAI client works
 * against `https://kaana.ai/v1`.
 *
 * New in contract set 4.0.0 (Kaana ADR 0002, decision 7). The signed-lane
 * result Kaana already produced (`embeddingSuccessSchema` in `/internal`)
 * bounds what this surface can promise: at most 2048 inputs per request and
 * vectors of at most 1024 dimensions.
 */

import { z } from 'zod';
import { modelReferenceSchema } from './identifiers.js';

/** The most inputs one request may embed. */
export const MAX_EMBEDDING_INPUTS = 2048;

export const embeddingsRequestSchema = z
  .object({
    /** A concrete model: an embedding space is a property of exact weights. */
    model: modelReferenceSchema,
    input: z.union([
      z.string().min(1),
      z.array(z.string().min(1)).min(1).max(MAX_EMBEDDING_INPUTS),
    ]),
    /** Only `float`: base64 vectors are an encoding the contract does not carry. */
    encoding_format: z.literal('float').optional(),
    /** Requested output dimension, for models that can shorten their vectors. */
    dimensions: z.number().int().positive().max(1024).optional(),
    /** OpenAI's end-user attribution field: the delegated user id, attribution only. */
    user: z.string().min(1).max(64).optional(),
  })
  .strict();

export const embeddingsResponseSchema = z
  .object({
    object: z.literal('list'),
    data: z
      .array(
        z
          .object({
            object: z.literal('embedding'),
            index: z.number().int().nonnegative(),
            embedding: z.array(z.number()).min(1).max(1024),
          })
          .strict(),
      )
      .min(1)
      .max(MAX_EMBEDDING_INPUTS),
    /** The revision that produced the vectors. */
    model: modelReferenceSchema,
    usage: z
      .object({
        prompt_tokens: z.number().int().nonnegative(),
        total_tokens: z.number().int().nonnegative(),
      })
      .strict(),
  })
  .strict()
  .superRefine((response, ctx) => {
    const indexes = response.data.map((vector) => vector.index);
    if (new Set(indexes).size !== indexes.length) {
      ctx.addIssue({ code: 'custom', path: ['data'], message: 'embedding indexes must be unique' });
    }
    const dimensions = new Set(response.data.map((vector) => vector.embedding.length));
    if (dimensions.size > 1) {
      ctx.addIssue({
        code: 'custom',
        path: ['data'],
        message: 'every vector of one response has the same dimension',
      });
    }
  });

export type EmbeddingsRequest = z.infer<typeof embeddingsRequestSchema>;
export type EmbeddingsResponse = z.infer<typeof embeddingsResponseSchema>;
