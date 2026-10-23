import { z } from '@oxy.so/zod3';

// Params for :userId
export const subscriptionUserIdParams = z.object({
  userId: z.string().trim().min(1),
});
