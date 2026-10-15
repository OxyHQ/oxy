import { z } from 'zod';
/** The requester is authenticated by the bearer; applications cannot submit viewer IDs. */
export const profileAccessInputSchema = z
  .object({ subjectAccountId: z.string().min(1).max(128) })
  .strict();
export const profileAccessDecisionSchema = z
  .object({
    allowed: z.boolean(),
    reason: z.enum(['public', 'owner', 'private', 'blocked', 'unavailable']),
    policyVersion: z.literal('1'),
  })
  .strict();
export type ProfileAccessInput = z.infer<typeof profileAccessInputSchema>;
export type ProfileAccessDecision = z.infer<typeof profileAccessDecisionSchema>;
