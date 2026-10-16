/**
 * Profile-access checks, without Zod. Schemas: `../safety.ts`.
 *
 * Part of `@oxy.so/contracts/client`: never import `zod` here (see `./check.ts`).
 */

import type { ProfileAccessDecision, ProfileAccessInput } from '../safety';
import {
  boolean,
  exact,
  literal,
  maxLength,
  minLength,
  oneOf,
  strictObject,
  string,
} from './check';

export const profileAccessInputCheck = exact<ProfileAccessInput>()(
  strictObject({ subjectAccountId: string(minLength(1), maxLength(128)) }),
);

export const profileAccessDecisionCheck = exact<ProfileAccessDecision>()(
  strictObject({
    allowed: boolean,
    reason: oneOf(['public', 'owner', 'private', 'blocked', 'unavailable']),
    policyVersion: literal('1'),
  }),
);
