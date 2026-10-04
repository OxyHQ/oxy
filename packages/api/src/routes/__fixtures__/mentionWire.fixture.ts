/** Run only through the owned local cross-repository operator. Only the provider adapter is fake. */
jest.mock("jsonwebtoken", () => jest.requireActual("jsonwebtoken"));
jest.mock("../../utils/logger", () => ({
	logger: {
		warn: jest.fn(),
		error: jest.fn(),
		info: jest.fn(),
		debug: jest.fn(),
	},
}));
import { randomUUID } from "node:crypto";
import type http from "node:http";
import type { AddressInfo } from "node:net";
import {
	type InferenceRequest,
	type ScopedExecutionAudience,
	scopedExecutionAudienceSchema,
} from "@oxy.so/contracts";
import { eq } from "drizzle-orm";
import express from "express";
import * as approvalConfig from "../../config/mentionClassifierEconomics";
import { MENTION_CLASSIFIER_IDENTITY as identity } from "../../config/mentionClassifierEconomics";
import { closePostgres, connectPostgres, getDb } from "../../config/postgres";
import * as rollout from "../../config/rolloutFlags";
import { signServiceTokenEd25519 } from "../../config/serviceTokenSigning";
import {
	applicationCredentials,
	applicationWorkloadIdentities,
	applications,
	inferenceDeploymentRoutingScores,
	inferenceDeployments,
	inferenceMeteredUsage,
	inferenceModelRevisions,
	inferenceModels,
	inferenceProviders,
	inferencePublishers,
	priceVersionUnitPrices,
	priceVersions,
	usageReceipts,
	usageReservations,
	users,
} from "../../db/schema";
import { createTestDatabase, dropTestDatabase } from "../../db/testDatabase";
import {
	TEXT_COMPLETION_MODALITY,
	UNCONSTRAINED_EDGE_CAPACITY,
	UNCONSTRAINED_ROUTING,
	resolveCatalogueViewer,
	resolveEdgeRoute,
} from "../../services/inferenceCatalogue.service";
import { resolveEffectiveRoutingPolicy } from "../../services/inferenceRoutingPolicy.service";
import type { KaanaClient } from "../../services/kaanaClient";
import * as scoped from "../../services/scopedExecution.service";
import * as credentialEnvironment from "../../utils/credentialEnvironment";
import { EDGE_ROLLOUT_ENVIRONMENT } from "../__fixtures__/kaanaAudioFixtures";
import { createNeutralRoutingPolicy } from "../__fixtures__/kaanaRuntimeFixtures";
import { createInferenceEdgeRouter } from "../inferenceEdge";

import { type ChildProcess, spawn } from "node:child_process";
import { createHash, generateKeyPairSync } from "node:crypto";
import {
	closeSync,
	existsSync,
	mkdtempSync,
	openSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as kaanaConfig from "../../config/kaanaDataPlane";
import { createHttpKaanaClient } from "../../services/httpKaanaClient";
function requiredEnvironment(name: string): string {
	const value = process.env[name];
	if (!value) throw new Error(`Owned fixture input ${name} is required`);
	return value;
}
const mentionRoot = requiredEnvironment("MENTION_SOURCE_WORKTREE");
const kaanaRoot = requiredEnvironment("KAANA_SOURCE_WORKTREE");
const builderPath = join(
	mentionRoot,
	"packages/backend/src/services/contentClassification/jevRequest.ts",
);
const { buildJevDecisionRequest, jevInputSha256 } =
	jest.requireActual(builderPath);
const { OxyInferenceClient } = createRequire(__filename)(
	requiredEnvironment("MENTION_WIRE_SDK_MODULE"),
);
const viewer = resolveCatalogueViewer({
	type: "first_party",
	isInternal: false,
});
const scopes = ["inference:invoke", "inference:usage:read"];
const previous = Object.fromEntries(
	Object.keys(EDGE_ROLLOUT_ENVIRONMENT).map((k) => [k, process.env[k]]),
);
const oldUrl = process.env.DATABASE_URL;
const own = mkdtempSync(join(tmpdir(), "mention-wire-"));
const configuration = join(own, "fixture.json");
let ownUrl: string;
let server: http.Server;
let child: ChildProcess;
let childDone: Promise<number | null>;
let goLog: number;
let audience: ScopedExecutionAudience;
let lastEnvelope: InferenceRequest | undefined;
let sdk: InstanceType<typeof OxyInferenceClient>;
let realClient: KaanaClient;
const request = buildJevDecisionRequest(
	{
		model: "typesafe/jev-1.13@2026-09-17",
		policyRef: "synthetic-not-admission",
		policyVersion: 1,
		evaluationVersion: "local-only-v1",
		supportedLanguages: ["en"],
	},
	[{ topic: "science", question: "Does the text discuss science?" }],
	"SYNTHETIC: A telescope observed a distant star.",
	["en"],
);
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
jest.setTimeout(100000);
beforeAll(async () => {
	if (
		!mentionRoot ||
		!kaanaRoot ||
		!process.env.KAANA_WIRE_DATABASE_URL ||
		!process.env.MENTION_WIRE_SDK_MODULE
	)
		throw new Error(
			"Run the owned integration operator; fixture inputs are mandatory",
		);
	expect(
		createHash("sha256").update(readFileSync(builderPath)).digest("hex"),
	).toBe(process.env.MENTION_BUILDER_SHA256);
	Object.assign(process.env, EDGE_ROLLOUT_ENVIRONMENT);
	ownUrl = await createTestDatabase();
	await connectPostgres();
	await getDb().insert(users).values({
		id: identity.ownerAccountId,
		username: "synthetic-mention-wire",
	});
	await getDb().insert(applications).values({
		id: identity.applicationId,
		ownerAccountId: identity.ownerAccountId,
		createdByUserId: identity.ownerAccountId,
		name: "Synthetic Mention",
		type: "first_party",
		isOfficial: true,
		isInternal: false,
		status: "active",
		scopes,
	});
	await getDb().insert(applicationWorkloadIdentities).values({
		id: identity.bindingId,
		applicationId: identity.applicationId,
		provider: "aws-iam",
		subject: identity.subject,
		scopes,
	});
	await getDb().insert(applicationCredentials).values({
		id: identity.credentialId,
		applicationId: identity.applicationId,
		type: "workload",
		name: "Synthetic own workload",
		environment: "production",
		workloadIdentityId: identity.bindingId,
		status: "active",
		scopes: [],
	});
	await createNeutralRoutingPolicy({
		accountId: identity.ownerAccountId,
		applicationId: identity.applicationId,
		overrides: {
			optimiseFor: "price",
			requireZeroDataRetention: true,
			prohibitTrainingOnCustomerData: true,
		},
	});
	const f = await fixture();
	audience = f.audience;
	f.authorizeFixture();
	jest
		.spyOn(credentialEnvironment, "workloadTokenEnvironment")
		.mockReturnValue("production");
	jest.spyOn(rollout, "isChargingAuthorized").mockReturnValue(false);
	jest.spyOn(approvalConfig, "mentionClassifierApproval").mockReturnValue({
		economicPolicyVersion: "mention/synthetic-wire-v1",
		evidenceRef: "synthetic-only-source-review",
		expiresAt: audience.expiresAt,
		deploymentId: audience.deploymentId,
		modelReference: audience.modelReference,
		provider: "openrouter",
		priceVersionId: audience.priceVersionId,
		routingPolicyId: audience.policy.routingPolicyId,
		routingPolicyVersion: audience.policy.policyVersion,
	});
	const keys = generateKeyPairSync("ed25519");
	const der = keys.publicKey.export({ type: "spki", format: "der" }) as Buffer;
	writeFileSync(
		configuration,
		JSON.stringify({
			audience,
			publicKey: der.subarray(-32).toString("base64"),
			databaseUrl: process.env.KAANA_WIRE_DATABASE_URL,
		}),
		{ mode: 0o600 },
	);
	goLog = openSync(join(own, "go.log"), "wx", 0o600);
	child = spawn(
		"go",
		[
			"test",
			"-race",
			"-count=1",
			"-timeout=110s",
			"-run",
			"^TestMentionOxySignedWireFixture$",
			"-v",
			"./internal/kaana",
		],
		{
			cwd: kaanaRoot,
			env: {
				PATH: process.env.PATH,
				HOME: process.env.HOME,
				MENTION_WIRE_FIXTURE: configuration,
			},
			stdio: ["ignore", goLog, goLog],
		},
	);
	childDone = new Promise((resolve, reject) => {
		child.once("exit", resolve);
		child.once("error", reject);
	});
	const deadline = Date.now() + 65000;
	while (!existsSync(`${configuration}.ready`)) {
		if (child.exitCode !== null || Date.now() > deadline)
			throw new Error(
				`Real Go fixture failed to start: ${readFileSync(join(own, "go.log"), "utf8")}`,
			);
		await wait(50);
	}
	const { url } = JSON.parse(readFileSync(`${configuration}.ready`, "utf8"));
	jest.spyOn(kaanaConfig, "resolveKaanaDataPlane").mockReturnValue({
		status: "configured",
		config: {
			baseUrl: url,
			keyId: "synthetic-oxy-wire",
			privateKey: keys.privateKey,
		},
	});
	const configuredClient = createHttpKaanaClient();
	if (!configuredClient?.execute)
		throw new Error("Real signed decisions client is unavailable");
	realClient = configuredClient;
	const execute = configuredClient.execute.bind(configuredClient);
	jest
		.spyOn(realClient, "execute")
		.mockImplementation(async (envelope, options) => {
			lastEnvelope = structuredClone(envelope);
			return execute(envelope, options);
		});
	const app = express();
	app.use(express.json());
	app.use("/v1", createInferenceEdgeRouter({ kaanaClient: realClient }));
	await new Promise<void>((r) => {
		server = app.listen(0, "127.0.0.1", r);
	});
	const at = Math.floor(Date.now() / 1000);
	const token = signServiceTokenEd25519({
		type: "service",
		appId: identity.applicationId,
		appName: "Mention",
		credentialId: identity.credentialId,
		ownerAccountId: identity.ownerAccountId,
		environment: "production",
		scopes,
		iss: "oxy-auth",
		aud: "oxy-api",
		iat: at,
		exp: at + 300,
	});
	sdk = new OxyInferenceClient({
		baseURL: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
		credential: token,
	});
});
afterAll(async () => {
	if (server) await new Promise<void>((r) => server.close(() => r()));
	if (child) {
		writeFileSync(`${configuration}.stop`, "done", { mode: 0o600 });
		const code = await childDone;
		process.stdout.write(readFileSync(join(own, "go.log"), "utf8"));
		closeSync(goLog);
		process.env.MENTION_WIRE_GO_EXIT = String(code);
	}
	jest.restoreAllMocks();
	await closePostgres();
	if (ownUrl) await dropTestDatabase(ownUrl);
	if (oldUrl === undefined) process.env.DATABASE_URL = undefined;
	else process.env.DATABASE_URL = oldUrl;
	for (const [k, v] of Object.entries(previous))
		if (v === undefined) delete process.env[k];
		else process.env[k] = v;
	if (child) expect(process.env.MENTION_WIRE_GO_EXIT).toBe("0");
});
it("actual Mention builder + packaged SDK + Oxy SQL + signed Go executor isolates audience and permanently denies replay", async () => {
	const bind = jest.spyOn(scoped, "scopedPermitForContext");
	const foreign = {
		...audience,
		principal: {
			accountId: "synthetic-Alia-account",
			applicationId: "synthetic-Alia-app",
			credentialId: "synthetic-Alia-credential",
			environment: "production" as const,
		},
	};
	bind.mockImplementation((c) => scoped.bindScopedPermit(foreign, c));
	await expect(
		sdk.decide(request, { idempotencyKey: audience.idempotencyKey }),
	).rejects.toThrow();
	expect(lastEnvelope).toBeUndefined();
	expect(
		await getDb()
			.select()
			.from(inferenceMeteredUsage)
			.where(eq(inferenceMeteredUsage.applicationId, identity.applicationId)),
	).toHaveLength(0);
	bind.mockImplementation((c) => scoped.bindScopedPermit(audience, c));
	const result = await sdk.decide(request, {
		idempotencyKey: audience.idempotencyKey,
	});
	expect(result.model).toBe(audience.modelReference);
	expect(result.data.map((q: { id: string }) => q.id)).toEqual(
		request.questions.map((q: { id: string }) => q.id),
	);
	expect(
		result.data.find((q: { id: string }) => q.id === "feedScore"),
	).toMatchObject({ kind: "score", mean: 2, distribution: [0, 0, 1, 0, 0] });
	const rows = await getDb()
		.select()
		.from(inferenceMeteredUsage)
		.where(eq(inferenceMeteredUsage.applicationId, identity.applicationId));
	expect(rows).toHaveLength(1);
	expect(rows[0]).toMatchObject({
		economicTreatment: "internal_metered",
		economicRelationshipId: "mention-jev-kaana",
		applicationCredentialId: identity.credentialId,
	});
	expect(
		await getDb()
			.select()
			.from(usageReservations)
			.where(eq(usageReservations.applicationId, identity.applicationId)),
	).toHaveLength(0);
	expect(
		await getDb()
			.select()
			.from(usageReceipts)
			.where(eq(usageReceipts.applicationId, identity.applicationId)),
	).toHaveLength(0);
	expect(lastEnvelope?.input).toMatchObject({ format: "decisions" });
	expect(lastEnvelope?.scopedExecution?.fixtureSha256).toBe(
		jevInputSha256(request),
	);
	if (!lastEnvelope?.scopedExecution)
		throw new Error("Actual scoped envelope was not observed");
	const captured = structuredClone(lastEnvelope);
	// Fresh signed HTTP, same permanent permit, altered edge request ID: reaches
	// actual Kaana SQL claim rather than relying on Oxy's daily quota refusal.
	captured.attribution.requestId = randomUUID();
	if (!captured.scopedExecution)
		throw new Error("Captured scoped binding unavailable");
	captured.scopedExecution.requestId = captured.attribution.requestId;
	await expect(
		realClient.execute?.(captured, { signal: new AbortController().signal }),
	).rejects.toThrow();
	const wrongPrincipal = structuredClone(captured);
	wrongPrincipal.attribution.principal.applicationId =
		foreign.principal.applicationId;
	wrongPrincipal.attribution.principal.credentialId =
		foreign.principal.credentialId;
	wrongPrincipal.attribution.principal.billing.accountId =
		foreign.principal.accountId;
	await expect(
		realClient.execute?.(wrongPrincipal, {
			signal: new AbortController().signal,
		}),
	).rejects.toThrow();
	await expect(
		sdk.decide(request, { idempotencyKey: audience.idempotencyKey }),
	).rejects.toThrow();
	expect(
		await getDb()
			.select()
			.from(inferenceMeteredUsage)
			.where(eq(inferenceMeteredUsage.applicationId, identity.applicationId)),
	).toHaveLength(1);
	process.stdout.write(
		`${JSON.stringify({
			mentionBuilderSha256: process.env.MENTION_BUILDER_SHA256,
			realSignedKaana: true,
			realSQLClaims: true,
			questionCount: request.questions.length,
			providerOnlyFake: true,
			ordinaryGettersUnchanged: true,
			fixtureDirectory: own,
		})}\n`,
	);
});

async function fixture() {
	const key = randomUUID().replaceAll("-", "");
	const publisher = "typesafe";
	const provider = "openrouter";
	const deploymentId = `deployment-${key}`;
	await getDb().insert(inferencePublishers).values({
		slug: publisher,
		displayName: "Synthetic commissioning publisher",
	});
	const [model] = await getDb()
		.insert(inferenceModels)
		.values({
			publisherSlug: publisher,
			slug: "jev-1.13",
			displayName: "Synthetic commissioning model",
			supportsTools: false,
			supportsParallelToolCalls: false,
			supportsStructuredOutput: true,
			supportsJsonMode: true,
			supportsReasoning: false,
			supportsStreaming: false,
			supportsPromptCaching: false,
			apiFormats: ["decisions"],
			inputModalities: ["text"],
			outputModalities: ["text"],
			maxContextTokens: 32000,
			maxOutputTokens: 8192,
			licenseId: "synthetic-reviewed",
			licenseDisplayName: "Fixture",
			commercialUseAllowed: true,
			requiresAttribution: false,
			releaseKind: "open_weight",
		})
		.returning();
	const [revision] = await getDb()
		.insert(inferenceModelRevisions)
		.values({
			modelId: model.id,
			revision: "2026-09-17",
			releasedAt: new Date(),
			isCurrent: true,
		})
		.returning();
	await getDb()
		.insert(inferenceProviders)
		.values({
			slug: provider,
			displayName: "Synthetic commissioning provider",
			kind: "third_party",
			retainsPayloads: false,
			retentionDays: 0,
			trainsOnCustomerData: false,
			zeroDataRetentionAvailable: true,
		})
		.onConflictDoNothing();
	const modelReference = `${model.modelId}@2026-09-17`;
	const [price] = await getDb()
		.insert(priceVersions)
		.values({
			provider,
			modelReference,
			currency: "USD",
			status: "active",
			effectiveFrom: new Date(Date.now() - 60000),
		})
		.returning();
	await getDb()
		.insert(priceVersionUnitPrices)
		.values(
			[
				"input_tokens",
				"cached_input_tokens",
				"output_tokens",
				"reasoning_tokens",
				"requests",
			].map((unit) => ({
				priceVersionId: price.id,
				unit: unit as "input_tokens",
				amount: unit === "input_tokens" ? "0.042" : "0",
				per: 1000000,
			})),
		);
	const policy = await resolveEffectiveRoutingPolicy(identity.applicationId);
	if (policy.status !== "resolved") throw new Error("Synthetic policy missing");
	const audience = scopedExecutionAudienceSchema.parse({
		permitId: `permit-${key}`,
		idempotencyKey: `key-${key}`,
		fixtureSha256: jevInputSha256(request),
		expiresAt: new Date(Date.now() + 3600000).toISOString(),
		principal: {
			accountId: identity.ownerAccountId,
			applicationId: identity.applicationId,
			credentialId: identity.credentialId,
			environment: "production",
		},
		policy: {
			routingPolicyId: policy.stored.policy.routingPolicyId,
			policyVersion: policy.stored.policy.policyVersion,
		},
		deploymentId,
		provider,
		keyId: `provider-key-${key}`,
		modelReference,
		upstreamModelId: "typesafe/jev-1.13-20260917",
		priceVersionId: price.id,
		providerRateCardVersionId: `card-${key}`,
		providerSourceVersion: `source-${key}`,
		maxCostUsd: "0.01",
	});
	const [deployment] = await getDb()
		.insert(inferenceDeployments)
		.values({
			modelRevisionId: revision.id,
			providerSlug: provider,
			internalRouteId: deploymentId,
			priceVersionId: price.id,
			scopedExecution: audience,
			regions: [],
			availabilityScope: "platform_internal",
			commercialPermission: "standard_application_use",
			permissionState: "pending_review",
			status: "disabled",
			legalReviewStatus: "approved",
			legalReviewEvidenceRef: "synthetic-legal-review",
			legalReviewedAt: new Date(),
			retainsPayloads: false,
			retentionDays: 0,
			trainsOnCustomerData: false,
			zeroDataRetentionAvailable: true,
		})
		.returning();
	await getDb()
		.insert(inferenceDeploymentRoutingScores)
		.values({
			deploymentId,
			priceVersionId: price.id,
			priceScore: 42,
			priceSource: "reviewed_scorecard",
			priceEvidenceRef: "synthetic-real-price",
			latencySource: "reviewed_scorecard",
			latencyEvidenceRef: "synthetic-not-measured",
			latencyMeasurementWindowStart: new Date(0),
			latencyMeasurementWindowEnd: new Date(1),
			latencyValidUntil: new Date(2),
			throughputSource: "reviewed_scorecard",
			throughputEvidenceRef: "synthetic-not-measured",
			throughputMeasurementWindowStart: new Date(0),
			throughputMeasurementWindowEnd: new Date(1),
			throughputValidUntil: new Date(2),
			balancedSource: "reviewed_scorecard",
			balancedEvidenceRef: "synthetic-not-measured",
			balancedFormulaRef: "synthetic-unmeasured",
			balancedValidUntil: new Date(2),
			changedAt: new Date(),
			fundingClass: "standard_payg",
			fundingState: "available",
			fundingEvidenceRef: "synthetic-provider-price",
			reason: "Private commissioning fixture; no measured benchmark",
			changedByUserId: "fixture",
		});
	const resolve = (
		optimiseFor: "price" | "latency" | "throughput" | "balanced" = "price",
		scope = audience,
	) =>
		resolveEdgeRoute(
			viewer,
			modelReference,
			UNCONSTRAINED_ROUTING,
			TEXT_COMPLETION_MODALITY,
			optimiseFor,
			UNCONSTRAINED_EDGE_CAPACITY,
			{
				applicationId: audience.principal.applicationId,
				environment: "production",
				scopedExecution: scope,
			},
		);
	const authorizeFixture = () =>
		jest
			.spyOn(scoped, "privateCommissioningAudience")
			.mockImplementation((input, now = Date.now()) =>
				input !== undefined &&
				JSON.stringify(input) === JSON.stringify(audience) &&
				Date.parse(audience.expiresAt) > now
					? audience
					: undefined,
			);
	return {
		audience,
		deployment,
		resolve,
		authorizeFixture,
		modelReference,
		price,
	};
}
