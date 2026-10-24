import { utf16MaxLength, utf16MinLength } from '@oxy.so/contracts';
import { z } from '@oxy.so/zod4';
import {
  safetyRequesterSchema,
  profileAccessInputSchema,
  profileAccessBatchInputSchema,
  messageAccessInputSchema,
  messageAccessBatchInputSchema,
  contactAccessInputSchema,
  contentAccessInputSchema,
  contentAccessBatchInputSchema,
  purchaseEffectsSchema,
} from '@oxy.so/contracts';
const request = <T extends z.ZodTypeAny>(input: T) =>
  z.object({ input, requester: safetyRequesterSchema }).strict();
export const safetyProfileRequestSchema = request(profileAccessInputSchema);
export const safetyProfileBatchRequestSchema = request(profileAccessBatchInputSchema);
export const safetyMessageBatchRequestSchema = request(messageAccessBatchInputSchema);
export const safetyMessageRequestSchema = request(messageAccessInputSchema);
export const safetyContactRequestSchema = request(contactAccessInputSchema);
export const safetyContentRequestSchema = request(contentAccessInputSchema);
export const safetyContentBatchRequestSchema = request(contentAccessBatchInputSchema);
export const safetyPublicationRequestSchema = request(z.object({}).strict());
export const safetyPurchaseRequestSchema = z
  .object({
    input: purchaseEffectsSchema,
    requester: z
      .object({ accessToken: z.string().check(utf16MinLength(1)).check(utf16MaxLength(16384)) })
      .strict(),
  })
  .strict();
export const safetyPurchaseListQuerySchema = z
  .object({ cursor: z.string().check(utf16MinLength(1)).check(utf16MaxLength(128)).optional() })
  .strict();
