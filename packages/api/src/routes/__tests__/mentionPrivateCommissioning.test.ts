/** Synthetic source approvals + signed own-role HTTP + real SQL catalogue/authority/metering. No provider network. */
jest.mock("jsonwebtoken", () => jest.requireActual("jsonwebtoken"));
jest.mock("../../utils/logger", () => ({
  logger: {
    warn: jest.fn(),
    error: jest.fn(),
    info: jest.fn(),
    debug: jest.fn(),
  },
}));
import express from "express";
import http from "http";
import type { AddressInfo } from "net";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import {
  scopedExecutionAudienceSchema,
  type ScopedExecutionAudience,
  type InferenceRequest,
} from "@oxy.so/contracts";
import { connectPostgres, closePostgres, getDb } from "../../config/postgres";
import { createTestDatabase, dropTestDatabase } from "../../db/testDatabase";
import {
  applications,
  applicationCredentials,
  applicationWorkloadIdentities,
  users,
  inferenceDeployments,
  inferenceDeploymentRoutingScores,
  inferenceModels,
  inferenceModelRevisions,
  inferencePublishers,
  inferenceProviders,
  priceVersions,
  priceVersionUnitPrices,
  inferenceMeteredUsage,
  usageReservations,
  usageReceipts,
} from "../../db/schema";
import * as approvalConfig from "../../config/mentionClassifierEconomics";
import { MENTION_CLASSIFIER_IDENTITY as identity } from "../../config/mentionClassifierEconomics";
import * as scoped from "../../services/scopedExecution.service";
import * as rollout from "../../config/rolloutFlags";
import * as credentialEnvironment from "../../utils/credentialEnvironment";
import { createNeutralRoutingPolicy } from "../__fixtures__/kaanaRuntimeFixtures";
import { resolveEffectiveRoutingPolicy } from "../../services/inferenceRoutingPolicy.service";
import {
  resolveEdgeRoute,
  resolveCatalogueViewer,
  UNCONSTRAINED_ROUTING,
  TEXT_COMPLETION_MODALITY,
  UNCONSTRAINED_EDGE_CAPACITY,
  selectRouteForViewer,
} from "../../services/inferenceCatalogue.service";
import { signServiceTokenEd25519 } from "../../config/serviceTokenSigning";
import { createInferenceEdgeRouter } from "../inferenceEdge";
import type { KaanaClient } from "../../services/kaanaClient";
import { EDGE_ROLLOUT_ENVIRONMENT } from "../__fixtures__/kaanaAudioFixtures";
const viewer = resolveCatalogueViewer({
  type: "first_party",
  isInternal: false,
});
const scopes = ["inference:invoke", "inference:usage:read"];
const previous = Object.fromEntries(
  Object.keys(EDGE_ROLLOUT_ENVIRONMENT).map((k) => [k, process.env[k]]),
);
const oldUrl = process.env.DATABASE_URL;
let ownUrl: string;
let server: http.Server;
let audience: ScopedExecutionAudience;
let executions = 0;
const client: KaanaClient = {
  stream: async function* () {
    throw new Error("Synthetic decisions never stream");
  },
  attestDeployments: async () => ({
    snapshotId: "synthetic-reviewed",
    scopedExecutionContractVersion: "3.6.0",
    deployments: [{ ...audience, regions: [], scopedExecution: audience }],
  }),
  execute: async (envelope: InferenceRequest) => {
    executions++;
    const route = envelope.authorizedRoutes?.[0];
    if (!route) throw new Error("Synthetic route missing");
    const now = new Date().toISOString();
    return {
      generationId: randomUUID(),
      output: [],
      finishReason: "stop",
      decisions: [{ id: "q", kind: "noul", probability: 1 }],
      usage: {
        schemaVersion: 2,
        requestId: envelope.attribution.requestId,
        attribution: envelope.attribution,
        outcome: "completed",
        units: [
          { unit: "requests", quantity: 1 },
          { unit: "input_tokens", quantity: 10 },
          { unit: "output_tokens", quantity: 0 },
        ],
        usageSource: "provider_reported",
        resolvedModelReference: route.modelReference,
        servingProvider: route.provider,
        deploymentId: route.deploymentId,
        routeSwitches: 0,
        startedAt: now,
        completedAt: now,
      },
    };
  },
};
jest.setTimeout(60000);
beforeAll(async () => {
  Object.assign(process.env, EDGE_ROLLOUT_ENVIRONMENT);
  ownUrl = await createTestDatabase();
  await connectPostgres();
  await getDb()
    .insert(users)
    .values({ id: identity.ownerAccountId, username: "synthetic-mention" });
  await getDb()
    .insert(applications)
    .values({
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
  await getDb()
    .insert(applicationWorkloadIdentities)
    .values({
      id: identity.bindingId,
      applicationId: identity.applicationId,
      provider: "aws-iam",
      subject: identity.subject,
      scopes,
    });
  await getDb()
    .insert(applicationCredentials)
    .values({
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
  const app = express();
  app.use(express.json());
  app.use("/v1", createInferenceEdgeRouter({ kaanaClient: client }));
  await new Promise<void>((r) => {
    server = app.listen(0, "127.0.0.1", r);
  });
});
afterAll(async () => {
  if (server) await new Promise<void>((r) => server.close(() => r()));
  await closePostgres();
  if (ownUrl) await dropTestDatabase(ownUrl);
  if (oldUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = oldUrl;
  for (const [k, v] of Object.entries(previous)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});
afterEach(() => jest.restoreAllMocks());
beforeEach(async () => {
  jest
    .spyOn(credentialEnvironment, "workloadTokenEnvironment")
    .mockReturnValue("production");
  executions = 0;
  await getDb()
    .delete(inferenceMeteredUsage)
    .where(eq(inferenceMeteredUsage.applicationId, identity.applicationId));
  await getDb()
    .update(applicationWorkloadIdentities)
    .set({ scopes, subject: identity.subject })
    .where(eq(applicationWorkloadIdentities.id, identity.bindingId));
  await getDb()
    .update(applications)
    .set({ status: "active" })
    .where(eq(applications.id, identity.applicationId));
});
async function post(f: Awaited<ReturnType<typeof fixture>>) {
  const issuedAt = Math.floor(Date.now() / 1000);
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
    iat: issuedAt,
    exp: issuedAt + 300,
  });
  const data = JSON.stringify({
    model: f.modelReference,
    state: "SYNTHETIC",
    questions: [{ id: "q", kind: "noul", question: "Synthetic?" }],
  });
  return new Promise<{
    status: number;
    body: unknown;
  }>((resolve, reject) => {
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port: (server.address() as AddressInfo).port,
        path: "/v1/decisions",
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          "content-length": Buffer.byteLength(data),
          "idempotency-key": f.audience.idempotencyKey,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (x) => chunks.push(x));
        res.on("end", () =>
          resolve({
            status: res.statusCode!,
            body: JSON.parse(Buffer.concat(chunks).toString()),
          }),
        );
      },
    );
    req.setTimeout(10000, () =>
      req.destroy(new Error("synthetic HTTP timeout")),
    );
    req.on("error", reject);
    req.end(data);
  });
}
async function authorizedFixture() {
  const f = await fixture();
  audience = f.audience;
  expect(scopedExecutionAudienceSchema.safeParse(audience)).toMatchObject({
    success: true,
  });
  f.authorizeFixture();
  jest
    .spyOn(scoped, "scopedPermitForContext")
    .mockImplementation((c) => scoped.bindScopedPermit(f.audience, c));
  jest
    .spyOn(approvalConfig, "mentionClassifierApproval")
    .mockReturnValue({
      economicPolicyVersion: "mention/synthetic-composition-v1",
      evidenceRef: "synthetic-explicit-review",
      expiresAt: f.audience.expiresAt,
      deploymentId: f.audience.deploymentId,
      modelReference: f.modelReference,
      provider: "openrouter",
      priceVersionId: f.price.id,
      routingPolicyId: f.audience.policy.routingPolicyId,
      routingPolicyVersion: f.audience.policy.policyVersion,
    });
  return f;
}
async function fixture() {
  const key = randomUUID().replaceAll("-", "");
  const publisher = `private${key}`;
  const provider = `openrouter`;
  const deploymentId = `deployment-${key}`;
  await getDb()
    .insert(inferencePublishers)
    .values({
      slug: publisher,
      displayName: "Synthetic commissioning publisher",
    });
  const [model] = await getDb()
    .insert(inferenceModels)
    .values({
      publisherSlug: publisher,
      slug: "fixture",
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
      outputModalities: ["decisions"],
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
      revision: "fixture-v1",
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
  const modelReference = `${model.modelId}@fixture-v1`;
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
        amount: unit === "input_tokens" ? "0.04" : "0",
        per: 1000000,
      })),
    );
  const policy = await resolveEffectiveRoutingPolicy(identity.applicationId);
  if (policy.status !== "resolved") throw new Error("Synthetic policy missing");
  const audience = scopedExecutionAudienceSchema.parse({
    permitId: `permit-${key}`,
    idempotencyKey: `key-${key}`,
    fixtureSha256: scoped.hashScopedInput({
      format: "decisions",
      decisions: {
        state: "SYNTHETIC",
        questions: [{ id: "q", kind: "noul", question: "Synthetic?" }],
      },
    }),
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
    upstreamModelId: "fixture-v1",
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
it.each([false, true])("admits own-role private classifier without funds or hold, commercial charging=%s", async (charging) => {
  const f = await authorizedFixture();
  jest.spyOn(rollout, "isChargingAuthorized").mockReturnValue(charging);
  const result = await post(f);
  if (result.status !== 200) throw new Error(JSON.stringify(result));
  expect(result).toMatchObject({ status: 200 });
  expect(executions).toBe(1);
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
  expect(await post(f)).toMatchObject({
    status: 429,
    body: { code: "quota_exceeded" },
  });
  expect(executions).toBe(1);
});
it.each([
  "binding-scope",
  "app-suspended",
  "foreign-role",
  "expired-approval",
  "missing-approval",
  "wrong-price",
  "legal-withdrawn",
  "privacy-drift",
  "expensive-quote",
] as const)(
  "refuses %s without usage, reservation or provider execution",
  async (kind) => {
    const f = await authorizedFixture();
    jest.spyOn(rollout, "isChargingAuthorized").mockReturnValue(false);
    if (kind === "binding-scope")
      await getDb()
        .update(applicationWorkloadIdentities)
        .set({ scopes: ["inference:usage:read"] })
        .where(eq(applicationWorkloadIdentities.id, identity.bindingId));
    if (kind === "app-suspended")
      await getDb()
        .update(applications)
        .set({ status: "suspended" })
        .where(eq(applications.id, identity.applicationId));
    if (kind === "foreign-role")
      await getDb()
        .update(applicationWorkloadIdentities)
        .set({ subject: "arn:aws:iam::237343248947:role/foreign-fixture" })
        .where(eq(applicationWorkloadIdentities.id, identity.bindingId));
    if (kind === "expired-approval")
      jest
        .mocked(approvalConfig.mentionClassifierApproval)
        .mockReturnValue({
          ...approvalConfig.mentionClassifierApproval()!,
          expiresAt: new Date(0).toISOString(),
        });
    if (kind === "missing-approval")
      jest
        .mocked(approvalConfig.mentionClassifierApproval)
        .mockReturnValue(undefined);
    if (kind === "wrong-price")
      jest
        .mocked(approvalConfig.mentionClassifierApproval)
        .mockReturnValue({
          ...approvalConfig.mentionClassifierApproval()!,
          priceVersionId: "foreign",
        });
    if (kind === "legal-withdrawn")
      await getDb()
        .update(inferenceDeployments)
        .set({ legalReviewStatus: "not_started", legalReviewEvidenceRef: null })
        .where(eq(inferenceDeployments.id, f.deployment.id));
    if (kind === "privacy-drift")
      await getDb()
        .update(inferenceDeployments)
        .set({ retainsPayloads: true, retentionDays: 30 })
        .where(eq(inferenceDeployments.id, f.deployment.id));
    if (kind === "expensive-quote")
      await getDb()
        .update(priceVersionUnitPrices)
        .set({ amount: "100000" })
        .where(eq(priceVersionUnitPrices.priceVersionId, f.price.id));
    const r = await post(f);
    expect(r.status).toBeGreaterThanOrEqual(400);
    expect(executions).toBe(0);
    expect(
      await getDb()
        .select()
        .from(inferenceMeteredUsage)
        .where(eq(inferenceMeteredUsage.applicationId, identity.applicationId)),
    ).toHaveLength(0);
    expect(
      await getDb()
        .select()
        .from(usageReservations)
        .where(eq(usageReservations.applicationId, identity.applicationId)),
    ).toHaveLength(0);
  },
);
it("keeps the ordinary catalogue and unrelated Mention approval closed", async () => {
  expect(approvalConfig.mentionClassifierApproval()).toBeUndefined();
  expect(scoped.sourceReviewedScopedAudience(Number.POSITIVE_INFINITY)).toBeUndefined();
  const f = await fixture();
  expect(
    await selectRouteForViewer(viewer, f.modelReference, UNCONSTRAINED_ROUTING),
  ).toBeUndefined();
});
it("rechecks exact binding after attestation before durable admission", async () => {
  const f = await authorizedFixture();
  const original = client.attestDeployments!;
  jest
    .spyOn(client, "attestDeployments")
    .mockImplementation(async (...args) => {
      const result = await original(...args);
      await getDb()
        .update(applicationWorkloadIdentities)
        .set({ scopes: ["inference:usage:read"] })
        .where(eq(applicationWorkloadIdentities.id, identity.bindingId));
      return result;
    });
  expect((await post(f)).status).toBeGreaterThanOrEqual(400);
  expect(executions).toBe(0);
  expect(
    await getDb()
      .select()
      .from(inferenceMeteredUsage)
      .where(eq(inferenceMeteredUsage.applicationId, identity.applicationId)),
  ).toHaveLength(0);
});
it("preserves relationship concurrency while the first synthetic execution is in flight", async () => {
  const f = await authorizedFixture();
  jest.spyOn(rollout, "isChargingAuthorized").mockReturnValue(false);
  let started!: () => void;
  let release!: () => void;
  const entered = new Promise<void>((r) => {
    started = r;
  });
  const wait = new Promise<void>((r) => {
    release = r;
  });
  const original = client.execute;
  jest.spyOn(client, "execute").mockImplementation(async (...args) => {
    started();
    await wait;
    return original(...args);
  });
  const first = post(f);
  await Promise.race([
    entered,
    first.then((result) => {
      if (result.status !== 200) throw new Error(JSON.stringify(result));
    }),
  ]);
  try {
    expect(await post(f)).toMatchObject({
      status: 429,
      body: { code: "rate_limited" },
    });
  } finally {
    release();
  }
  expect((await first).status).toBe(200);
  expect(executions).toBe(1);
  expect(
    await getDb()
      .select()
      .from(inferenceMeteredUsage)
      .where(eq(inferenceMeteredUsage.applicationId, identity.applicationId)),
  ).toHaveLength(1);
});
