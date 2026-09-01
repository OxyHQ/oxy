import { z } from 'zod';

// Params for :userId
export const subscriptionUserIdParams = z.object({
  userId: z.string().trim().min(1),
});
