import { z } from '@oxy.so/zod3';

/** Opt in without changing the body accepted by existing Inbox clients. */
export const inboxDailyBriefQuerySchema = z
  .object({
    includeActions: z.enum(['true', 'false']).optional(),
  })
  .strict();
