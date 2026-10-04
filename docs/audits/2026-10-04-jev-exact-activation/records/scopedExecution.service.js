"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.scopedFundingRestriction = void 0;
exports.sourceReviewedScopedAudience = sourceReviewedScopedAudience;
exports.scopedPermitForContext = scopedPermitForContext;
exports.bindScopedPermit = bindScopedPermit;
exports.hashScopedInput = hashScopedInput;
exports.privateCommissioningAudience = privateCommissioningAudience;
exports.attestScopedPermit = attestScopedPermit;
exports.scopedFundingIntegrationAvailable = scopedFundingIntegrationAvailable;
const node_crypto_1 = require("node:crypto");
const contracts_1 = require("@oxy.so/contracts");
exports.scopedFundingRestriction = 'promotional-only';
/** Source-reviewed authorization only. No environment switch or public setter. */
const preapprovedManifest = contracts_1.scopedExecutionAudienceSchema.parse({
    "permitId": "jev-internal-synthetic-20261004-01",
    "idempotencyKey": "jev-internal-synthetic-20261004-01",
    "fixtureSha256": "023ad0e07ce8ad36de7b6c8b3a3e6817833e606b98a25a898e471fb1537d0125",
    "expiresAt": "2026-10-05T02:30:00.000Z",
    "principal": {
        "accountId": "01a0369b-1222-712f-8df6-f8ffeb78ccc2",
        "applicationId": "6a2f851751b784a86fd0e934",
        "credentialId": "wl_d50a0056191d0448024900b4",
        "environment": "production"
    },
    "policy": {
        "routingPolicyId": "platform-internal-default",
        "policyVersion": 1
    },
    "deploymentId": "dep_openrouter_typesafe_jev_1_13_scoped_2026_10_04",
    "provider": "openrouter",
    "keyId": "b8090dce-82f2-4077-9fc1-fd831a53ca27",
    "modelReference": "typesafe/jev-1.13@2026-09-17",
    "upstreamModelId": "typesafe/jev-1.13-20260917",
    "priceVersionId": "jev_scoped_price_20261004_01",
    "providerRateCardVersionId": "rc_openrouter_jev_2026_10_04",
    "providerSourceVersion": "openrouter-api/2026-10-04/typesafe/jev-1.13-20260917/556fab0c5da201c07d4eeafd32b48250fb3fa297b69ed0f9e62a7225ca8511ba",
    "maxCostUsd": "0.01"
});
/** Used by catalogue import; signed provider metadata cannot authorize itself. */
function sourceReviewedScopedAudience(now = Date.now()) {
    const parsed = contracts_1.scopedExecutionAudienceSchema.safeParse(preapprovedManifest);
    return parsed.success && Number.isFinite(now) && Date.parse(parsed.data.expiresAt) > now
        ? parsed.data : undefined;
}
function scopedPermitForContext(context) {
    return bindScopedPermit(preapprovedManifest, context);
}
/** Pure admission helper: fixtures may inject synthetic source authorization. */
function bindScopedPermit(manifest, context, now = Date.now()) {
    var _a;
    if (manifest === undefined)
        return undefined;
    const parsed = contracts_1.scopedExecutionAudienceSchema.safeParse(manifest);
    if (!parsed.success)
        return undefined;
    const permit = parsed.data;
    const { principal, request } = context;
    if (Date.parse(permit.expiresAt) <= now || !Number.isFinite(now) ||
        principal.ownerAccountId !== permit.principal.accountId ||
        principal.applicationId !== permit.principal.applicationId ||
        principal.credentialId !== permit.principal.credentialId ||
        principal.environment !== permit.principal.environment ||
        !principal.scopes.includes('inference:invoke') ||
        context.idempotencyKey !== permit.idempotencyKey || request.stream ||
        request.operation.kind !== 'decisions' || request.input.format !== 'decisions' ||
        ((_a = request.target) === null || _a === void 0 ? void 0 : _a.kind) !== 'model' || request.target.modelReference !== permit.modelReference)
        return undefined;
    try {
        if (hashScopedInput(JSON.parse(JSON.stringify(request.input))) !== permit.fixtureSha256)
            return undefined;
    }
    catch (_b) {
        return undefined;
    }
    return permit;
}
function hashScopedInput(input) {
    return (0, node_crypto_1.createHash)('sha256').update((0, contracts_1.canonicalScopedExecutionJson)(input), 'utf8').digest('hex');
}
/** Wire-supplied audience data cannot authorize a private catalogue row. */
function privateCommissioningAudience(audience, now = Date.now()) {
    const reviewed = sourceReviewedScopedAudience(now);
    return audience !== undefined && reviewed !== undefined &&
        (0, contracts_1.canonicalScopedExecutionJson)(audience) === (0, contracts_1.canonicalScopedExecutionJson)(reviewed)
        ? reviewed : undefined;
}
/** No snapshot id can substitute for the exact negotiated audience/card proof. */
function attestScopedPermit(permit, attestation, requestId, evidence) {
    if (attestation.scopedExecutionContractVersion !== '3.6.0' || !attestation.snapshotId ||
        attestation.deployments.length !== 1 || !requestId || !evidence.modelRevisionId ||
        !evidence.legalReviewEvidenceRef.trim() || !evidence.commercialPermission ||
        !((evidence.permissionState === 'approved' && (evidence.admission === undefined || evidence.admission === 'approved_catalogue')) ||
            (evidence.permissionState === 'pending_review' && evidence.admission === 'private_commissioning' &&
                evidence.deploymentStatus === 'disabled' && evidence.eligibility.availabilityScope === 'platform_internal')) ||
        !Number.isFinite(Date.parse(permit.expiresAt)) || Date.parse(permit.expiresAt) <= Date.now() || evidence.legalReviewStatus !== 'approved' ||
        evidence.deploymentId !== permit.deploymentId || evidence.priceVersionId !== permit.priceVersionId ||
        (0, contracts_1.canonicalScopedExecutionJson)(evidence.policy) !== (0, contracts_1.canonicalScopedExecutionJson)(permit.policy) ||
        evidence.eligibility.policyAdmitted !== true || evidence.eligibility.capabilityAdmitted !== true ||
        evidence.eligibility.privacyAdmitted !== true)
        return undefined;
    const descriptor = attestation.deployments[0];
    if (descriptor.scopedExecution === undefined ||
        (0, contracts_1.canonicalScopedExecutionJson)(descriptor.scopedExecution) !== (0, contracts_1.canonicalScopedExecutionJson)(permit) ||
        descriptor.deploymentId !== permit.deploymentId || descriptor.provider !== permit.provider ||
        descriptor.modelReference !== permit.modelReference || descriptor.keyId !== permit.keyId ||
        descriptor.upstreamModelId !== permit.upstreamModelId ||
        descriptor.providerRateCardVersionId !== permit.providerRateCardVersionId ||
        descriptor.providerSourceVersion !== permit.providerSourceVersion)
        return undefined;
    const parsed = contracts_1.scopedExecutionSchema.safeParse(Object.assign(Object.assign({}, permit), { requestId, snapshotId: attestation.snapshotId, catalogueEvidenceHash: hashScopedInput(evidence) }));
    return parsed.success ? parsed.data : undefined;
}
/** Typed ordinary ledger support landed; source authorization remains absent. */
function scopedFundingIntegrationAvailable() { return exports.scopedFundingRestriction === 'promotional-only'; }
