import { z } from 'zod';
import {
  deploymentIdSchema,
  modelReferenceSchema,
  routingPolicyReferenceSchema,
  inferenceProviderSlugSchema,
  inferenceRegionSchema,
} from '@oxy.so/contracts';

/** All reviews cover one exact deployment under one immutable Oxy policy version. */
export interface AutoClassifierReview {
  readonly commercial: boolean;
  readonly internalEligibility: boolean;
  readonly privacy: boolean;
  readonly zdr: boolean;
}

const approvalSchema = z
  .object({
    reviewId: z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/),
    reviewVersion: z.number().int().positive(),
    deploymentId: deploymentIdSchema,
    modelReference: modelReferenceSchema.refine((value) => value.includes('@')),
    provider: inferenceProviderSlugSchema,
    regions: z.array(inferenceRegionSchema),
    routingPolicy: routingPolicyReferenceSchema,
    commercial: z.literal(true),
    internalEligibility: z.literal(true),
    privacy: z.literal(true),
    zdr: z.literal(true),
  })
  .strict();
export type AutoClassifierApproval = Readonly<
  Omit<z.infer<typeof approvalSchema>, 'regions'> & { readonly regions: readonly string[] }
>;

/** No reviewed deployment exists. Neither credentials nor environment flags grant approval. */
export function autoClassifierApproval(): AutoClassifierApproval | undefined {
  return undefined;
}

/** Validate and snapshot before exposing request text; no approval transfers to another route. */
export function approvedAutoClassifier(
  approval: unknown,
  policy: AutoClassifierApproval['routingPolicy'],
): AutoClassifierApproval | undefined {
  const parsed = approvalSchema.safeParse(approval);
  if (
    !parsed.success ||
    parsed.data.routingPolicy.routingPolicyId !== policy.routingPolicyId ||
    parsed.data.routingPolicy.policyVersion !== policy.policyVersion
  )
    return undefined;
  return Object.freeze({
    ...parsed.data,
    regions: Object.freeze([...parsed.data.regions]),
    routingPolicy: Object.freeze(parsed.data.routingPolicy),
  });
}

export function sameAutoClassifierApproval(
  left: AutoClassifierApproval,
  right: AutoClassifierApproval,
): boolean {
  return (
    left.reviewId === right.reviewId &&
    left.reviewVersion === right.reviewVersion &&
    left.deploymentId === right.deploymentId &&
    left.modelReference === right.modelReference &&
    left.provider === right.provider &&
    left.routingPolicy.routingPolicyId === right.routingPolicy.routingPolicyId &&
    left.routingPolicy.policyVersion === right.routingPolicy.policyVersion &&
    left.regions.length === right.regions.length &&
    left.regions.every((region) => right.regions.includes(region))
  );
}
