import { z } from 'zod';
import {
  safetyRequesterSchema,
  profileAccessInputSchema,
  profileAccessBatchInputSchema,
  messageAccessInputSchema,
  contactAccessInputSchema,
  contentAccessInputSchema,
  contentAccessBatchInputSchema,
  purchaseEffectsSchema,
} from '@oxy.so/contracts';
const request = <T extends z.ZodTypeAny>(input: T) =>
  z.object({ input, requester: safetyRequesterSchema }).strict();
export const safetyProfileRequestSchema = request(profileAccessInputSchema);
export const safetyProfileBatchRequestSchema = request(profileAccessBatchInputSchema);
export const safetyMessageRequestSchema = request(messageAccessInputSchema);
export const safetyContactRequestSchema = request(contactAccessInputSchema);
export const safetyContentRequestSchema = request(contentAccessInputSchema);
export const safetyContentBatchRequestSchema = request(contentAccessBatchInputSchema);
export const safetyPublicationRequestSchema = request(z.object({}).strict());
export const safetyPurchaseRequestSchema = z
  .object({
    input: purchaseEffectsSchema,
    requester: z.object({ accessToken: z.string().min(1).max(16384) }).strict(),
  })
  .strict();
export const safetyPurchaseListQuerySchema = z
  .object({ cursor: z.string().min(1).max(128).optional() })
  .strict();
