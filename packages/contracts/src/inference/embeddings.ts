import { z } from 'zod';
import { inferenceErrorSchema } from './errors';

export const embeddingVectorSchema = z.object({ index: z.number().int().nonnegative(), embedding: z.array(z.number().finite()).min(1).max(1024) }).strict();
export const embeddingUsageSchema = z.object({ inputTokens: z.number().int().nonnegative(), totalTokens: z.number().int().nonnegative() }).strict().refine((usage) => usage.totalTokens >= usage.inputTokens, { message: 'totalTokens must be greater than or equal to inputTokens', path: ['totalTokens'] });
export const embeddingSuccessSchema = z.object({ schemaVersion: z.literal(1), requestId: z.string().min(1).max(128), model: z.string().min(1).max(255), dimension: z.number().int().positive().max(1024), data: z.array(embeddingVectorSchema).min(1).max(2048), usage: embeddingUsageSchema }).strict().superRefine((result, context) => {
  const indexes = new Set<number>();
  for (const [position, vector] of result.data.entries()) {
    if (vector.embedding.length !== result.dimension) context.addIssue({ code: z.ZodIssueCode.custom, path: ['data', position, 'embedding'], message: 'embedding length must equal dimension' });
    if (indexes.has(vector.index)) context.addIssue({ code: z.ZodIssueCode.custom, path: ['data', position, 'index'], message: 'embedding indexes must be unique' });
    indexes.add(vector.index);
  }
});
export const embeddingFailureSchema = z.object({ schemaVersion: z.literal(1), requestId: z.string().min(1).max(128), error: inferenceErrorSchema }).strict();
export const embeddingResponseSchema = z.union([embeddingSuccessSchema, embeddingFailureSchema]);

export type EmbeddingVector = z.infer<typeof embeddingVectorSchema>;
export type EmbeddingUsage = z.infer<typeof embeddingUsageSchema>;
export type EmbeddingSuccess = z.infer<typeof embeddingSuccessSchema>;
export type EmbeddingFailure = z.infer<typeof embeddingFailureSchema>;
export type EmbeddingResponse = z.infer<typeof embeddingResponseSchema>;
