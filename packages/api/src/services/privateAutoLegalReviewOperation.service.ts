/** Independent root/operator legal review; this never approves a public route. */
import { z } from 'zod';
import { eq, sql } from 'drizzle-orm';
import { privateAutoSourceApprovalSchema } from '@oxy.so/contracts';
import { getDb } from '../config/postgres';
import { users, accountClosureFences, inferenceDeployments, inferenceModelRevisions, inferenceModels, securityActivities } from '../db/schema';
import { recordLegalReview } from './inferenceCatalogueAdmin.service';
import { privateAutoCatalogueApproval, privateAutoHash } from './privateAutoExecution.service';

const pointer = z.string().trim().min(1).max(2000);
export const privateAutoLegalReviewPlanSchema = z.object({
  kind: z.literal('private-auto-legal-review-v1'),
  reviewerUserId: z.string().min(1).max(128), deploymentRowId: z.string().min(1).max(128),
  approval: privateAutoSourceApprovalSchema,
  expectedLegalStatus: z.enum(['not_started', 'in_review', 'approved', 'rejected']),
  expectedEvidenceRef: z.string().nullable(), evidenceRef: pointer,
  reason: z.string().trim().min(1).max(500), operator: z.string().trim().min(1).max(200), sessionApprovalRef: pointer,
}).strict();

/** Existing staff authority, exact row CAS and source approval are independently required. */
export async function executePrivateAutoLegalReview(input: unknown,
  options: { apply?: boolean; expectedPlanSha256?: string } = {}) {
  const plan = privateAutoLegalReviewPlanSchema.parse(input);
  const planSha256 = privateAutoHash(plan);
  if (options.apply && options.expectedPlanSha256 !== planSha256) throw new Error('private_auto_legal_plan_hash_mismatch');
  return getDb().transaction(async tx => {
    await tx.execute(sql`SELECT set_config('statement_timeout', '25000', true),
      set_config('lock_timeout', '1000', true), set_config('idle_in_transaction_session_timeout', '30000', true)`);
    const [reviewer] = await tx.select({ id: users.id, type: users.type, status: users.accountStatus,
      isStaff: users.isStaff, capabilities: users.staffCapabilities }).from(users).where(eq(users.id, plan.reviewerUserId)).for('update');
    const [fence] = await tx.select({ id: accountClosureFences.accountId }).from(accountClosureFences).where(eq(accountClosureFences.accountId, plan.reviewerUserId));
    if (!reviewer || reviewer.type !== 'local' || reviewer.status !== 'active' || !reviewer.isStaff ||
      !reviewer.capabilities.includes('inference:catalogue:publish') || fence) throw new Error('private_auto_legal_reviewer_not_authorized');
    const [row] = await tx.select({ id: inferenceDeployments.id, route: inferenceDeployments.internalRouteId,
      provider: inferenceDeployments.providerSlug, price: inferenceDeployments.priceVersionId,
      source: inferenceDeployments.privateAutoSourceApproval, scoped: inferenceDeployments.scopedExecution,
      permission: inferenceDeployments.permissionState, status: inferenceDeployments.status,
      availability: inferenceDeployments.availabilityScope, autoPolicy: inferenceDeployments.autoApprovalPolicyId,
      legal: inferenceDeployments.legalReviewStatus, evidence: inferenceDeployments.legalReviewEvidenceRef,
      retains: inferenceDeployments.retainsPayloads, retention: inferenceDeployments.retentionDays,
      trains: inferenceDeployments.trainsOnCustomerData, zdr: inferenceDeployments.zeroDataRetentionAvailable,
      revisionId: inferenceDeployments.modelRevisionId }).from(inferenceDeployments).where(eq(inferenceDeployments.id, plan.deploymentRowId)).for('update');
    const source = privateAutoCatalogueApproval({ approval: plan.approval, principal: plan.approval.principal });
    if (!row || !source || !row.source || privateAutoHash(row.source) !== privateAutoHash(source) || row.scoped !== null ||
      row.route !== source.deploymentId || row.provider !== source.provider || row.price !== source.priceVersionId ||
      row.permission !== 'pending_review' || row.status !== 'disabled' || row.availability !== 'platform_internal' || row.autoPolicy !== null ||
      row.legal !== plan.expectedLegalStatus || row.evidence !== plan.expectedEvidenceRef ||
      plan.evidenceRef !== source.review.legalReviewEvidenceRef ||
      row.retains !== source.review.retainsPayloads || row.retention !== source.review.retentionDays ||
      row.trains !== source.review.trainsOnCustomerData || row.zdr !== source.review.zeroDataRetentionAvailable) throw new Error('private_auto_legal_deployment_precondition_failed');
    const [model] = await tx.select({ modelId: inferenceModels.modelId, revision: inferenceModelRevisions.revision,
      commercial: inferenceModels.commercialUseAllowed }).from(inferenceModelRevisions)
      .innerJoin(inferenceModels, eq(inferenceModelRevisions.modelId, inferenceModels.id)).where(eq(inferenceModelRevisions.id, row.revisionId)).for('share');
    if (!model || `${model.modelId}@${model.revision}` !== source.modelReference ||
      model.commercial !== source.review.commercialUseAllowed) throw new Error('private_auto_legal_model_precondition_failed');
    const receipt = { kind: 'private-auto-legal-review-v1' as const, planSha256, applied: options.apply === true,
      deploymentRowId: row.id, permissionState: row.permission, deploymentStatus: row.status,
      publicServingApproved: false, inferenceAuthorized: false };
    if (!privateAutoCatalogueApproval({ approval: source, principal: source.principal })) throw new Error('private_auto_legal_source_withdrawn');
    if (!options.apply) return receipt;
    await recordLegalReview({ deploymentId: row.id, status: 'approved', evidenceRef: plan.evidenceRef, reviewerUserId: reviewer.id }, tx);
    await tx.insert(securityActivities).values({ userId: reviewer.id, eventType: 'security_settings_changed', severity: 'high',
      eventDescription: 'Private Auto internal-use legal review recorded', metadata: {
        operation: 'private_auto_internal_use_legal_review', planSha256, deploymentRowId: row.id,
        previousStatus: row.legal, previousEvidenceRef: row.evidence, evidenceRef: plan.evidenceRef,
        operator: plan.operator, reason: plan.reason, sessionApprovalRef: plan.sessionApprovalRef,
        authorityTransport: 'root_operator_cli', publicServingApproved: false,
      } });
    return receipt;
  });
}
