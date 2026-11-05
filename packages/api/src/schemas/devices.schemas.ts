import { utf16MinLength } from '@oxy.so/contracts';
import { z } from 'zod';

// DELETE /devices/:deviceId
export const deviceIdParams = z.object({
  deviceId: z.string().trim().check(utf16MinLength(1)),
});
