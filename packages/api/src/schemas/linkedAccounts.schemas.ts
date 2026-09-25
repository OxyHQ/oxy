/**
 * Path-parameter schemas for `routes/linkedAccounts.ts`. Request and response
 * bodies are the shared contracts in `@oxy.so/contracts` (`linkedAccounts.ts`).
 */

import { z } from 'zod';
import { linkedAccountNetworkSchema } from '@oxy.so/contracts';

export const linkedAccountNetworkParams = z.object({ network: linkedAccountNetworkSchema });

export const linkedAccountIdParams = z.object({ id: z.string().trim().min(1).max(64) });

export const linkedAccountUserIdParams = z.object({ userId: z.string().trim().min(1).max(64) });
