import { utf16MinLength } from '@oxy.so/contracts';
import { z } from 'zod';

// Params for :userId
export const subscriptionUserIdParams = z.object({
  userId: z.string().trim().check(utf16MinLength(1)),
});
