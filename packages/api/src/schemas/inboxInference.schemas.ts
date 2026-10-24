import { z } from '@oxy.so/zod4';

/** Opt in without changing the body accepted by existing Inbox clients. */
export const inboxDailyBriefQuerySchema = z
  .object({
    includeActions: z.enum(['true', 'false']).optional(),
  })
  .strict();
