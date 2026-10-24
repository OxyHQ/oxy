import { utf16MaxLength, utf16MinLength } from '@oxy.so/contracts';
/**
 * Path-parameter schemas for `routes/linkedAccounts.ts`. Request and response
 * bodies are the shared contracts in `@oxy.so/contracts` (`linkedAccounts.ts`).
 */

import { z } from '@oxy.so/zod4';
import { linkedAccountNetworkSchema } from '@oxy.so/contracts';

export const linkedAccountNetworkParams = z.object({ network: linkedAccountNetworkSchema });

export const linkedAccountIdParams = z.object({
  id: z.string().trim().check(utf16MinLength(1)).check(utf16MaxLength(64)),
});

export const linkedAccountUserIdParams = z.object({
  userId: z.string().trim().check(utf16MinLength(1)).check(utf16MaxLength(64)),
});
