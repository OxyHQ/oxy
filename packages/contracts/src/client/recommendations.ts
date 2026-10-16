/**
 * The recommendation-request check, without Zod. Schemas: `../recommendations.ts`.
 *
 * Part of `@oxy.so/contracts/client`: never import `zod` here (see `./check.ts`).
 */

import type { RecommendationRequest } from '../recommendations';
import {
  array,
  atLeast,
  atMost,
  exact,
  int,
  maxItems,
  maxLength,
  minItems,
  minLength,
  number,
  object,
  oneOf,
  optional,
  string,
  trim,
} from './check';

const id = string(trim, minLength(1));
const weight = optional(number(atLeast(0), atMost(10)));

export const recommendationRequestCheck = exact<RecommendationRequest>()(
  object({
    clientId: optional(string(trim, minLength(1))),
    limit: optional(number(int, atLeast(1), atMost(100))),
    offset: optional(number(int, atLeast(0))),
    excludeTypes: optional(array(oneOf(['federated', 'agent', 'automated']))),
    excludeIds: optional(array(id, maxItems(500))),
    boosts: optional(
      array(
        object({
          userIds: array(id, minItems(1), maxItems(200)),
          weight: number(atLeast(-5), atMost(5)),
          reason: optional(string(trim, maxLength(120))),
        }),
        maxItems(50),
      ),
    ),
    signalWeights: optional(
      object({
        graph: weight,
        completeness: weight,
        verified: weight,
        curation: weight,
        interest: weight,
        appBoost: weight,
        repCandidate: weight,
        affinity: weight,
      }),
    ),
  }),
);
