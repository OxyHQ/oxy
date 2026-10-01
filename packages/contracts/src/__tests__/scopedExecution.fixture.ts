export const scopedAudienceFixture = {
	permitId: "permit_synthetic_once",
	idempotencyKey: "idem_synthetic_once",
	fixtureSha256: "a".repeat(64),
	expiresAt: "2026-10-02T00:05:00.000Z",
	principal: {
		accountId: "acc_synthetic",
		applicationId: "app_synthetic",
		credentialId: "cred_synthetic",
		environment: "development",
	},
	policy: { routingPolicyId: "rp_synthetic", policyVersion: 1 },
	deploymentId: "dep_synthetic",
	provider: "openrouter",
	keyId: "key_synthetic_existing",
	modelReference: "typesafe/jev-1.13@2026-09-17",
	upstreamModelId: "typesafe/jev-1.13-20260917",
	priceVersionId: "pv_synthetic",
	providerRateCardVersionId: "card_synthetic",
	providerSourceVersion: "source_synthetic",
	maxCostUsd: "0.01",
};
export const scopedEnvelopeFixture = {
	schemaVersion: 3,
	attribution: {
		requestId: "req_actual_independent",
		principal: {
			billing: { accountId: "acc_synthetic" },
			applicationId: "app_synthetic",
			credentialId: "cred_synthetic",
			environment: "development",
			inferenceScopes: ["inference:invoke"],
		},
	},
	target: {
		kind: "model",
		modelReference: scopedAudienceFixture.modelReference,
	},
	modality: "text",
	input: {
		format: "decisions",
		decisions: {
			state: "Synthetic state",
			questions: [
				{ id: "q", kind: "noul", question: "Synthetic proposition?" },
			],
		},
	},
	stream: false,
	sampling: {},
	tools: [],
	client: {
		apiFormat: "decisions",
		endpoint: "/v1/decisions",
		receivedAt: "2026-10-02T00:00:00.000Z",
	},
	idempotencyKey: scopedAudienceFixture.idempotencyKey,
	routingPolicy: scopedAudienceFixture.policy,
	authorizedRoutes: [
		{
			substitution: "same_model",
			deploymentId: scopedAudienceFixture.deploymentId,
			modelReference: scopedAudienceFixture.modelReference,
			provider: scopedAudienceFixture.provider,
			regions: [],
		},
	],
	scopedExecution: {
		...scopedAudienceFixture,
		requestId: "req_actual_independent",
		snapshotId: "snap_synthetic",
		catalogueEvidenceHash: "b".repeat(64),
	},
};
