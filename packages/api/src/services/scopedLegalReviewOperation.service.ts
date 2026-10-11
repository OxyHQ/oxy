/** Root/operator CLI seam. An existing reviewer ID is audit attribution, never HTTP authentication. */
import { z } from 'zod';
import { eq, sql } from 'drizzle-orm';
import { scopedExecutionAudienceSchema, canonicalScopedExecutionJson } from '@oxy.so/contracts';
import { getDb } from '../config/postgres';
import {
  users,
  accountClosureFences,
  inferenceDeployments,
  securityActivities,
} from '../db/schema';
import { recordLegalReview } from './inferenceCatalogueAdmin.service';
import { hashScopedInput } from './scopedExecution.service';

const pointer = z.string().trim().min(1).max(2000);
export const scopedLegalReviewPlanSchema = z
  .object({
    kind: z.literal('scoped-legal-review-v1'),
    reviewerUserId: z.string().min(1).max(128),
    deploymentRowId: z.string().min(1).max(128),
    audience: scopedExecutionAudienceSchema,
    expectedLegalStatus: z.enum(['not_started', 'in_review', 'approved', 'rejected']),
    expectedEvidenceRef: z.string().nullable(),
    evidenceRef: pointer,
    reason: z.string().trim().min(1).max(500),
    operator: z.string().trim().min(1).max(200),
    sessionApprovalRef: pointer,
  })
  .strict();
export type ScopedLegalReviewPlan = z.infer<typeof scopedLegalReviewPlanSchema>;

/** Legal review and its audit commit together. This never approves public serving permission. */
export async function executeScopedLegalReview(
  input: unknown,
  options: { apply?: boolean; expectedPlanSha256?: string } = {},
) {
  const plan = scopedLegalReviewPlanSchema.parse(input);
  const planSha256 = hashScopedInput(plan);
  if (options.apply && options.expectedPlanSha256 !== planSha256)
    throw new Error('scoped_legal_plan_hash_mismatch');
  return getDb().transaction(async (tx) => {
    await tx.execute(sql`SELECT set_config('statement_timeout', '25000', true),
      set_config('lock_timeout', '1000', true), set_config('idle_in_transaction_session_timeout', '30000', true)`);
    const [reviewer] = await tx
      .select({
        id: users.id,
        type: users.type,
        status: users.accountStatus,
        isStaff: users.isStaff,
        capabilities: users.staffCapabilities,
      })
      .from(users)
      .where(eq(users.id, plan.reviewerUserId))
      .for('update');
    const [fence] = await tx
      .select({ id: accountClosureFences.accountId })
      .from(accountClosureFences)
      .where(eq(accountClosureFences.accountId, plan.reviewerUserId));
    if (
      !reviewer ||
      reviewer.type !== 'local' ||
      reviewer.status !== 'active' ||
      !reviewer.isStaff ||
      !reviewer.capabilities.includes('inference:catalogue:publish') ||
      fence
    )
      throw new Error('scoped_legal_reviewer_not_authorized');
    const [deployment] = await tx
      .select({
        id: inferenceDeployments.id,
        provider: inferenceDeployments.providerSlug,
        route: inferenceDeployments.internalRouteId,
        audience: inferenceDeployments.scopedExecution,
        price: inferenceDeployments.priceVersionId,
        status: inferenceDeployments.status,
        permission: inferenceDeployments.permissionState,
        availability: inferenceDeployments.availabilityScope,
        legal: inferenceDeployments.legalReviewStatus,
        evidence: inferenceDeployments.legalReviewEvidenceRef,
        autoPolicy: inferenceDeployments.autoApprovalPolicyId,
      })
      .from(inferenceDeployments)
      .where(eq(inferenceDeployments.id, plan.deploymentRowId))
      .for('update');
    if (
      !deployment ||
      deployment.route !== plan.audience.deploymentId ||
      deployment.provider !== plan.audience.provider ||
      deployment.price !== plan.audience.priceVersionId ||
      deployment.audience === null ||
      canonicalScopedExecutionJson(deployment.audience) !==
        canonicalScopedExecutionJson(plan.audience) ||
      deployment.permission !== 'pending_review' ||
      deployment.status !== 'disabled' ||
      deployment.availability !== 'platform_internal' ||
      deployment.autoPolicy !== null ||
      deployment.legal !== plan.expectedLegalStatus ||
      deployment.evidence !== plan.expectedEvidenceRef ||
      Date.parse(plan.audience.expiresAt) <= Date.now()
    )
      throw new Error('scoped_legal_deployment_precondition_failed');
    const receipt = {
      kind: 'scoped-legal-review-v1' as const,
      planSha256,
      applied: options.apply === true,
      deploymentRowId: deployment.id,
      permissionState: deployment.permission,
      deploymentStatus: deployment.status,
      publicServingApproved: false,
      inferenceAuthorized: false,
    };
    if (!options.apply) return receipt;
    await recordLegalReview(
      {
        deploymentId: deployment.id,
        status: 'approved',
        evidenceRef: plan.evidenceRef,
        reviewerUserId: reviewer.id,
      },
      tx,
    );
    await tx.insert(securityActivities).values({
      userId: reviewer.id,
      eventType: 'security_settings_changed',
      severity: 'high',
      eventDescription: 'Scoped private commissioning legal review recorded',
      metadata: {
        operation: 'scoped_private_commissioning_legal_review',
        planSha256,
        deploymentRowId: deployment.id,
        previousStatus: deployment.legal,
        previousEvidenceRef: deployment.evidence,
        evidenceRef: plan.evidenceRef,
        operator: plan.operator,
        reason: plan.reason,
        sessionApprovalRef: plan.sessionApprovalRef,
        authorityTransport: 'root_operator_cli',
        publicServingApproved: false,
      },
    });
    return receipt;
  });
}
