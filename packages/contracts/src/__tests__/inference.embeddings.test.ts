import { embeddingResponseSchema, embeddingSuccessSchema } from '../inference/embeddings';

const success = { schemaVersion: 1 as const, requestId: 'req_1', model: 'Qwen/Qwen3-Embedding-0.6B', dimension: 3, data: [{ index: 0, embedding: [0.1, 0.2, 0.3] }], usage: { inputTokens: 4, totalTokens: 4 } };

describe('embeddingResponseSchema', () => {
  it('accepts a dimension-consistent non-streaming response', () => {
    expect(embeddingResponseSchema.parse(success)).toEqual(success);
  });

  it('refuses vectors whose length differs from the declared dimension', () => {
    expect(embeddingSuccessSchema.safeParse({ ...success, data: [{ index: 0, embedding: [0.1, 0.2] }] }).success).toBe(false);
  });
});
