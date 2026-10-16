/**
 * The external-identity reference check, without Zod. Schemas: `../externalIdentity.ts`.
 *
 * Part of `@oxy.so/contracts/client`: never import `zod` here (see `./check.ts`).
 */

import type { ExternalIdentityReference } from '../externalIdentity';
import { exact, minLength, object, oneOf, string } from './check';

const required = string(minLength(1));

/** One Oxy-proven network alias of a profile — the twin of `externalIdentityReferenceSchema`. */
export const externalIdentityReferenceCheck = exact<ExternalIdentityReference>()(
  object({
    canonicalAcct: required,
    network: required,
    protocol: oneOf(['activitypub', 'atproto', 'instagram-graph']),
    actorUri: required,
    transportAcct: required,
    sourceUserId: required,
  }),
);
