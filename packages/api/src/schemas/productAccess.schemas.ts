import { z } from '@oxy.so/zod3';
import { subjectProductAccessSchema, subjectProductAccessQuerySchema } from '@oxy.so/contracts';

export const productAccessParamsSchema = subjectProductAccessQuerySchema.omit({
  schemaVersion: true,
});
export const productAccessResponseSchema = z.object({ data: subjectProductAccessSchema }).strict();
