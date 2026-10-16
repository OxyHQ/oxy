/**
 * The first-party login result check, without Zod. Schemas: `../deviceBoot.ts`.
 *
 * Part of `@oxy.so/contracts/client`: never import `zod` here (see `./check.ts`).
 */

import type { LoginResult } from '../deviceBoot';
import { array, exact, object, optional, string } from './check';

const securityAlert = object({
  message: string(),
  anomalies: array(object({ type: string(), reason: string(), details: optional(string()) })),
});

export const loginResultCheck = exact<LoginResult>()(
  object({
    sessionId: string(),
    deviceId: string(),
    expiresAt: string(),
    accessToken: optional(string()),
    deviceSecret: optional(string()),
    securityAlert: optional(securityAlert),
    user: object({ id: string(), username: optional(string()), avatar: optional(string()) }),
  }),
);
