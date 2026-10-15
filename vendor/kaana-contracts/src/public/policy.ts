/**
 * The routing-policy reference a response and a receipt record.
 *
 * The policy itself is a Console resource and stays in `@oxy.so/contracts`; what
 * a client reads back is only which of its own policy revisions served it.
 *
 * Moved from `@oxy.so/contracts` 4.12.0 (`src/inference/routingPolicy.ts`) by Kaana ADR 0002.
 */

import { z } from 'zod';

/**
 * The reference a request records: which policy, at which of the customer's own
 * revisions. Embedded in the request envelope and in the settled receipt, so a
 * charge can be explained against the exact configuration that produced it.
 */
export const routingPolicyReferenceSchema = z
  .object({
    routingPolicyId: z.string().min(1).max(128),
    policyVersion: z.number().int().positive().safe(),
  })
  .strict();

export type RoutingPolicyReference = z.infer<typeof routingPolicyReferenceSchema>;
