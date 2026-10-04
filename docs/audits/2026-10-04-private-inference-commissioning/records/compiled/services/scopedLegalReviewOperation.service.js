"use strict";
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.scopedLegalReviewPlanSchema = void 0;
exports.executeScopedLegalReview = executeScopedLegalReview;
/** Root/operator CLI seam. An existing reviewer ID is audit attribution, never HTTP authentication. */
const zod_1 = require("zod");
const drizzle_orm_1 = require("drizzle-orm");
const contracts_1 = require("@oxy.so/contracts");
const postgres_1 = require("../config/postgres");
const schema_1 = require("../db/schema");
const inferenceCatalogueAdmin_service_1 = require("./inferenceCatalogueAdmin.service");
const scopedExecution_service_1 = require("./scopedExecution.service");
const pointer = zod_1.z.string().trim().min(1).max(2000);
exports.scopedLegalReviewPlanSchema = zod_1.z.object({
    kind: zod_1.z.literal('scoped-legal-review-v1'),
    reviewerUserId: zod_1.z.string().min(1).max(128),
    deploymentRowId: zod_1.z.string().min(1).max(128),
    audience: contracts_1.scopedExecutionAudienceSchema,
    expectedLegalStatus: zod_1.z.enum(['not_started', 'in_review', 'approved', 'rejected']),
    expectedEvidenceRef: zod_1.z.string().nullable(),
    evidenceRef: pointer,
    reason: zod_1.z.string().trim().min(1).max(500),
    operator: zod_1.z.string().trim().min(1).max(200),
    sessionApprovalRef: pointer,
}).strict();
/** Legal review and its audit commit together. This never approves public serving permission. */
function executeScopedLegalReview(input_1) {
    return __awaiter(this, arguments, void 0, function* (input, options = {}) {
        const plan = exports.scopedLegalReviewPlanSchema.parse(input);
        const planSha256 = (0, scopedExecution_service_1.hashScopedInput)(plan);
        if (options.apply && options.expectedPlanSha256 !== planSha256)
            throw new Error('scoped_legal_plan_hash_mismatch');
        return (0, postgres_1.getDb)().transaction((tx) => __awaiter(this, void 0, void 0, function* () {
            yield tx.execute((0, drizzle_orm_1.sql) `SELECT set_config('statement_timeout', '25000', true),
      set_config('lock_timeout', '1000', true), set_config('idle_in_transaction_session_timeout', '30000', true)`);
            const [reviewer] = yield tx.select({ id: schema_1.users.id, type: schema_1.users.type, status: schema_1.users.accountStatus,
                isStaff: schema_1.users.isStaff, capabilities: schema_1.users.staffCapabilities }).from(schema_1.users)
                .where((0, drizzle_orm_1.eq)(schema_1.users.id, plan.reviewerUserId)).for('update');
            const [fence] = yield tx.select({ id: schema_1.accountClosureFences.accountId }).from(schema_1.accountClosureFences)
                .where((0, drizzle_orm_1.eq)(schema_1.accountClosureFences.accountId, plan.reviewerUserId));
            if (!reviewer || reviewer.type !== 'local' || reviewer.status !== 'active' || !reviewer.isStaff ||
                !reviewer.capabilities.includes('inference:catalogue:publish') || fence)
                throw new Error('scoped_legal_reviewer_not_authorized');
            const [deployment] = yield tx.select({ id: schema_1.inferenceDeployments.id, provider: schema_1.inferenceDeployments.providerSlug,
                route: schema_1.inferenceDeployments.internalRouteId, audience: schema_1.inferenceDeployments.scopedExecution,
                price: schema_1.inferenceDeployments.priceVersionId, status: schema_1.inferenceDeployments.status,
                permission: schema_1.inferenceDeployments.permissionState, availability: schema_1.inferenceDeployments.availabilityScope,
                legal: schema_1.inferenceDeployments.legalReviewStatus, evidence: schema_1.inferenceDeployments.legalReviewEvidenceRef,
                autoPolicy: schema_1.inferenceDeployments.autoApprovalPolicyId }).from(schema_1.inferenceDeployments)
                .where((0, drizzle_orm_1.eq)(schema_1.inferenceDeployments.id, plan.deploymentRowId)).for('update');
            if (!deployment || deployment.route !== plan.audience.deploymentId || deployment.provider !== plan.audience.provider ||
                deployment.price !== plan.audience.priceVersionId || deployment.audience === null ||
                (0, contracts_1.canonicalScopedExecutionJson)(deployment.audience) !== (0, contracts_1.canonicalScopedExecutionJson)(plan.audience) ||
                deployment.permission !== 'pending_review' || deployment.status !== 'disabled' ||
                deployment.availability !== 'platform_internal' || deployment.autoPolicy !== null ||
                deployment.legal !== plan.expectedLegalStatus || deployment.evidence !== plan.expectedEvidenceRef ||
                Date.parse(plan.audience.expiresAt) <= Date.now())
                throw new Error('scoped_legal_deployment_precondition_failed');
            const receipt = { kind: 'scoped-legal-review-v1', planSha256, applied: options.apply === true,
                deploymentRowId: deployment.id, permissionState: deployment.permission, deploymentStatus: deployment.status,
                publicServingApproved: false, inferenceAuthorized: false };
            if (!options.apply)
                return receipt;
            yield (0, inferenceCatalogueAdmin_service_1.recordLegalReview)({ deploymentId: deployment.id, status: 'approved', evidenceRef: plan.evidenceRef,
                reviewerUserId: reviewer.id }, tx);
            yield tx.insert(schema_1.securityActivities).values({ userId: reviewer.id, eventType: 'security_settings_changed',
                severity: 'high', eventDescription: 'Scoped private commissioning legal review recorded', metadata: {
                    operation: 'scoped_private_commissioning_legal_review', planSha256, deploymentRowId: deployment.id,
                    previousStatus: deployment.legal, previousEvidenceRef: deployment.evidence, evidenceRef: plan.evidenceRef,
                    operator: plan.operator, reason: plan.reason, sessionApprovalRef: plan.sessionApprovalRef,
                    authorityTransport: 'root_operator_cli', publicServingApproved: false,
                } });
            return receipt;
        }));
    });
}
