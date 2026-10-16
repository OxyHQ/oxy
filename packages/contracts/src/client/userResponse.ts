/**
 * User-response checks, without Zod. Schemas: `../userResponse.ts`.
 *
 * Part of `@oxy.so/contracts/client`: never import `zod` here (see `./check.ts`).
 */

import type { UserNameResponse } from '../userResponse';
import { exact, looseObject, optional, string } from './check';

export const userNameCheck = exact<UserNameResponse>()(
  looseObject({
    first: optional(string()),
    last: optional(string()),
    full: optional(string()),
    displayName: optional(string()),
  }),
);
