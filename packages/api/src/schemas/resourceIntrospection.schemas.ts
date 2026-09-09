import { z } from 'zod';

export const resourceIntrospectionRequestSchema = z
  .object({ token: z.string().min(1).max(16_384) })
  .strict();
