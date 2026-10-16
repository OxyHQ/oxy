/**
 * The public-application check, without Zod. Schemas: `../sessionStatus.ts`.
 *
 * Part of `@oxy.so/contracts/client`: never import `zod` here (see `./check.ts`).
 */

import type { PublicApplicationResponse } from '../sessionStatus';
import { array, boolean, exact, object, oneOf, optional, string } from './check';

export const publicApplicationCheck = exact<PublicApplicationResponse>()(
  object({
    id: string(),
    name: string(),
    description: optional(string()),
    icon: optional(string()),
    websiteUrl: optional(string()),
    privacyPolicyUrl: optional(string()),
    termsUrl: optional(string()),
    type: oneOf(['first_party', 'third_party', 'internal', 'system']),
    isOfficial: boolean,
    isInternal: boolean,
    scopes: array(string()),
    developerName: optional(string()),
  }),
);
