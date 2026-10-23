import { z } from '@oxy.so/zod3';

// DELETE /devices/:deviceId
export const deviceIdParams = z.object({
  deviceId: z.string().trim().min(1),
});
