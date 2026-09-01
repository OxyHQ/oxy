/**
 * The customer-visible record of a route switch, written by the edge (issue #972
 * workstream 6, "Emit a customer-visible event/receipt when an allowed route
 * switch occurs").
 *
 * ## The test this file exists for
 *
 * `inference_route_switch_events` had a complete, thoroughly-constrained schema
 * and a writer (`recordRouteSwitch`) that nothing ever called: a switch reported
 * by the data plane reached the customer in-stream and then vanished. So the cases
 * here are about the CALLER — that the edge records a reported switch on BOTH
 * transports, that recording it twice is a no-op, that the writer's structural
 * refusal of an unauthorised substitution is not bypassed by the new call site,
 * and that the one configuration which cannot be recorded says so rather than
 * inventing an authority.
 *
 * ## What a row here does NOT mean
 *
 * That the switch respected the customer's routing policy. The envelope carries a
 * policy REFERENCE, not a snapshot, so the data plane holds no provider allowlist,
 * region residency requirement or price ceiling to check a replacement against —
 * only the ADMITTED route was ever checked against those. A model-scope row is
 * additionally checked against the customer's own authorisation ROWS, which is why
 * the unauthorised case below writes nothing; a deployment-scope row carries no
 * such claim at all. Both assertions here are about what was REPORTED and
 * RECORDED, deliberately, and must not be upgraded into compliance assertions
 * until the envelope carries the pre-authorized route list.
 *
 * ## Fixtures are scoped to ids this file owns
 *
 * Every account, application, credential, publisher, model, price version and
 * routing policy is created per test with a random suffix, and every assertion is
 * scoped to them, so a sibling suite seeding the shared database cannot change an
 * answer here.
 */

import express from "express";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";

jest.mock("../../utils/logger", () => ({
  logger: {
    warn: jest.fn(),
    error: jest.fn(),
    info: jest.fn(),
    debug: jest.fn(),
  },
}));

import { eq } from "drizzle-orm";
import type {
  InferenceRequest,
  InferenceStreamEvent,
  InferenceStreamRouteSwitchEvent,
} from "@oxyhq/contracts";
import { closePostgres, connectPostgres, getDb } from "../../config/postgres";
import { applicationCredentials } from "../../db/schema/applicationCredentials";
import { applications } from "../../db/schema/applications";
import {
  inferenceDeployments,
  inferenceModelRevisions,
  inferenceModels,
  inferenceProviders,
  inferencePublishers,
  inferenceRoutingProfileCandidates,
  inferenceRoutingProfiles,
} from "../../db/schema";
import { inferenceRouteSwitchEvents } from "../../db/schema/inferenceRouteSwitchEvents";
import {
  priceVersions,
  priceVersionUnitPrices,
} from "../../db/schema/priceVersions";
import { usageReceipts } from "../../db/schema/usageReceipts";
import { users } from "../../db/schema/users";
import {
  provisionBillingProfile,
  recordTopUp,
} from "../../services/inferenceLedger.service";
import {
  createRoutingPolicy,
  resolveEffectiveRoutingPolicy,
  type RoutingPolicyControls,
} from "../../services/inferenceRoutingPolicy.service";
import type {
  KaanaClient,
  KaanaCompletion,
  KaanaStreamFrame,
} from "../../services/kaanaClient";
import { generateMachineCredentialToken } from "../../utils/machineCredentialToken";
import { logger } from "../../utils/logger";
import { createInferenceEdgeRouter } from "../inferenceEdge";

const mockedLogger = logger as jest.Mocked<typeof logger>;

jest.setTimeout(60_000);

/* -------------------------------------------------------------------------- */
/*  Harness                                                                   */
/* -------------------------------------------------------------------------- */

interface RawResponse {
  readonly status: number;
  readonly headers: http.IncomingHttpHeaders;
  readonly body: string;
}

function json(response: RawResponse): Record<string, unknown> {
  return JSON.parse(response.body) as Record<string, unknown>;
}

async function withServer(
  kaanaClient: KaanaClient,
  run: (
    request: (
      path: string,
      body: unknown,
      headers: Record<string, string>,
    ) => Promise<RawResponse>,
  ) => Promise<void>,
): Promise<void> {
  const app = express();
  app.use(express.json({ limit: "1mb" }));
  app.use("/v1", createInferenceEdgeRouter({ kaanaClient }));

  const server = await new Promise<http.Server>((resolve) => {
    const created = app.listen(0, "127.0.0.1", () => resolve(created));
  });

  const request = (
    path: string,
    body: unknown,
    headers: Record<string, string>,
  ): Promise<RawResponse> => {
    const { port } = server.address() as AddressInfo;
    const payload = JSON.stringify(body);

    return new Promise<RawResponse>((resolve, reject) => {
      const req = http.request(
        {
          hostname: "127.0.0.1",
          port,
          path,
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(payload),
            ...headers,
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk: Buffer) => chunks.push(chunk));
          res.on("end", () =>
            resolve({
              status: res.statusCode ?? 0,
              headers: res.headers,
              body: Buffer.concat(chunks).toString("utf8"),
            }),
          );
        },
      );
      req.on("error", reject);
      req.write(payload);
      req.end();
    });
  };

  try {
    await run(request);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

/* -------------------------------------------------------------------------- */
/*  Fixtures                                                                  */
/* -------------------------------------------------------------------------- */

const REVISION = "2026-01-01";

interface Fixture {
  readonly accountId: string;
  readonly applicationId: string;
  readonly token: string;
  readonly modelReference: string;
  readonly pinnedModelReference: string;
  readonly provider: string;
  /**
   * A SECOND model in the catalogue, so a cross-model switch has a real
   * destination. Its presence is what makes the authorised and unauthorised
   * substitution cases differ in the AUTHORISATION rather than in whether the
   * destination resolves at all.
   */
  readonly otherModelReference: string;
  readonly otherPinnedModelReference: string;
}

const suffix = (): string => randomUUID().replace(/-/g, "").slice(0, 10);

/** One publisher, two providers, and two models with priced failover routes. */
async function makeFixture(): Promise<Fixture> {
  const db = getDb();
  const tag = suffix();
  const scopes = ["inference:invoke", "inference:usage:read"];

  const [account] = await db
    .insert(users)
    .values({ username: `rsw-${tag}`, email: `rsw-${tag}@example.test` })
    .returning({ id: users.id });

  const [application] = await db
    .insert(applications)
    .values({ name: `Switch ${tag}`, ownerAccountId: account.id, scopes })
    .returning({ id: applications.id });

  const minted = generateMachineCredentialToken();
  await db.insert(applicationCredentials).values({
    applicationId: application.id,
    name: `key-${tag}`,
    publicKey: `oxy_dk_${tag}`,
    tokenPrefix: minted.tokenPrefix,
    tokenHash: minted.tokenHash,
    type: "machine",
    environment: "development",
    scopes,
    status: "active",
  });

  const publisherSlug = `pub${tag}`;
  const providerSlug = `prov${tag}`;

  await db
    .insert(inferencePublishers)
    .values({ slug: publisherSlug, displayName: `Publisher ${tag}` });

  await db.insert(inferenceProviders).values({
    slug: providerSlug,
    displayName: `Provider ${tag}`,
    kind: "third_party",
    retainsPayloads: false,
    retentionDays: 0,
    trainsOnCustomerData: false,
    zeroDataRetentionAvailable: true,
  });

  await db
    .insert(inferenceProviders)
    .values({
      slug: FAILOVER_PROVIDER,
      displayName: "Failover provider",
      kind: "third_party",
      retainsPayloads: false,
      retentionDays: 0,
      trainsOnCustomerData: false,
      zeroDataRetentionAvailable: true,
    })
    .onConflictDoNothing();

  const publishModel = async (slug: string): Promise<void> => {
    const [model] = await db
      .insert(inferenceModels)
      .values({
        publisherSlug,
        slug,
        displayName: `Model ${slug}`,
        inputModalities: ["text"],
        outputModalities: ["text"],
        supportsTools: true,
        supportsParallelToolCalls: false,
        supportsStructuredOutput: true,
        supportsJsonMode: true,
        supportsReasoning: false,
        supportsStreaming: true,
        supportsPromptCaching: false,
        maxContextTokens: 200_000,
        maxOutputTokens: 8192,
        licenseId: "apache-2.0",
        licenseDisplayName: "Apache 2.0",
        commercialUseAllowed: true,
        requiresAttribution: false,
        releaseKind: "open_weight",
      })
      .returning({ id: inferenceModels.id });

    const [revision] = await db
      .insert(inferenceModelRevisions)
      .values({
        modelId: model.id,
        revision: REVISION,
        releasedAt: new Date(),
        isCurrent: true,
      })
      .returning({ id: inferenceModelRevisions.id });

    for (const deploymentProvider of [providerSlug, FAILOVER_PROVIDER]) {
      const [priceVersion] = await db
        .insert(priceVersions)
        .values({
          modelReference: `${publisherSlug}/${slug}@${REVISION}`,
          provider: deploymentProvider,
          status: "active",
          effectiveFrom: new Date(Date.now() - 60_000),
        })
        .returning({ id: priceVersions.id });

      await db.insert(priceVersionUnitPrices).values([
        {
          priceVersionId: priceVersion.id,
          unit: "input_tokens",
          amount: "3.000000000000",
          per: 1_000_000,
        },
        {
          priceVersionId: priceVersion.id,
          unit: "output_tokens",
          amount: "15.000000000000",
          per: 1_000_000,
        },
      ]);

      await db.insert(inferenceDeployments).values({
        modelRevisionId: revision.id,
        providerSlug: deploymentProvider,
        regions: ["us-west-2"],
        retainsPayloads: false,
        retentionDays: 0,
        trainsOnCustomerData: false,
        zeroDataRetentionAvailable: true,
        availabilityScope: "public_payg",
        commercialPermission: "public_resale_approved",
        status: "active",
        legalReviewStatus: "approved",
        legalReviewedAt: new Date(),
        legalReviewEvidenceRef: `contract-register/${tag}`,
        permissionState: "approved",
        priceVersionId: priceVersion.id,
      });
    }
  };

  const modelSlug = `model-${tag}`;
  const otherSlug = `other-${tag}`;
  await publishModel(modelSlug);
  await publishModel(otherSlug);

  await provisionBillingProfile({ accountId: account.id });
  await recordTopUp({
    idempotencyKey: `rsw-top-up-${tag}`,
    accountId: account.id,
    currency: "USD",
    amount: "10.000000000000",
    actor: { kind: "machine" },
  });

  return {
    accountId: account.id,
    applicationId: application.id,
    token: minted.token,
    modelReference: `${publisherSlug}/${modelSlug}`,
    pinnedModelReference: `${publisherSlug}/${modelSlug}@${REVISION}`,
    provider: providerSlug,
    otherModelReference: `${publisherSlug}/${otherSlug}`,
    otherPinnedModelReference: `${publisherSlug}/${otherSlug}@${REVISION}`,
  };
}

/**
 * Every routing control at its neutral value, so a case can set exactly the one
 * it is about and nothing else can be the reason it passes.
 */
function policyControls(
  overrides: Partial<RoutingPolicyControls> = {},
): RoutingPolicyControls {
  return {
    providerAllowlist: [],
    providerDenylist: [],
    allowedRegions: [],
    deniedRegions: [],
    requireZeroDataRetention: false,
    prohibitTrainingOnCustomerData: false,
    maxPricePerUnit: [],
    optimiseFor: "balanced",
    oxyHostedOnly: false,
    allowedLicenseIds: [],
    requireCommercialUseRights: false,
    fallback: {
      disabled: false,
      sameModelDeployment: true,
      authorizedCrossModel: [],
    },
    byokPreference: "disabled",
    dedicatedCapacity: "disabled",
    ...overrides,
  };
}

/**
 * Give the application a routing policy and return the VERSION row id.
 *
 * The id comes from the same resolver the edge reads, so an assertion against it
 * is about what the edge pinned rather than about a second lookup that could
 * disagree.
 */
async function givePolicy(
  fixture: Fixture,
  overrides: Partial<RoutingPolicyControls> = {},
): Promise<string> {
  const created = await createRoutingPolicy({
    target: {
      kind: "application",
      accountId: fixture.accountId,
      applicationId: fixture.applicationId,
    },
    controls: policyControls(overrides),
    createdByUserId: fixture.accountId,
  });
  if (created.status !== "written") {
    throw new Error(`the fixture policy was refused: ${created.status}`);
  }

  const effective = await resolveEffectiveRoutingPolicy(fixture.applicationId);
  if (effective.status !== "resolved") {
    throw new Error(`the fixture policy did not resolve: ${effective.status}`);
  }
  return effective.stored.versionId;
}

/* -------------------------------------------------------------------------- */
/*  Data-plane fakes                                                          */
/* -------------------------------------------------------------------------- */

const bearer = (token: string): Record<string, string> => ({
  Authorization: `Bearer ${token}`,
});

const responsesBody = (
  fixture: Fixture,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> => ({
  model: fixture.modelReference,
  input: "Say hello.",
  maxOutputTokens: 100,
  ...overrides,
});

/** A deployment-scope switch: the same weights, served from somewhere else. */
function deploymentSwitch(
  requestId: string,
  modelReference: string,
  toProvider: string,
  sequence = 1,
): InferenceStreamRouteSwitchEvent {
  return {
    schemaVersion: 1,
    type: "route_switch",
    requestId,
    sequence,
    reason: "provider_overloaded",
    detail: { scope: "deployment", modelReference, toProvider },
    occurredAt: new Date().toISOString(),
  };
}

/** A cross-model switch, which the wire shape can only express as authorised. */
function modelSwitch(
  requestId: string,
  detail: {
    readonly requestedModelId: string;
    readonly fromModelReference: string;
    readonly toModelReference: string;
    readonly toProvider: string;
  },
  sequence = 1,
): InferenceStreamRouteSwitchEvent {
  return {
    schemaVersion: 1,
    type: "route_switch",
    requestId,
    sequence,
    reason: "deployment_unavailable",
    detail: { scope: "model", authorizedByPolicy: true, ...detail },
    occurredAt: new Date().toISOString(),
  };
}

const FAILOVER_PROVIDER = "zz-failover-provider";

function servedRouteFor(
  envelope: InferenceRequest,
  events: readonly InferenceStreamRouteSwitchEvent[],
  servingProvider: string,
): InferenceRequest["authorizedRoutes"][number] {
  const lastModelSwitch = [...events]
    .reverse()
    .find((event) => event.detail.scope === "model");
  const switchedModel =
    lastModelSwitch?.detail.scope === "model"
      ? lastModelSwitch.detail.toModelReference
      : undefined;
  const route = envelope.authorizedRoutes.find(
    (candidate) =>
      candidate.provider === servingProvider &&
      (switchedModel === undefined ||
        candidate.modelReference === switchedModel),
  );
  if (route === undefined) {
    throw new Error(
      "the fake tried to serve a route outside the signed authorization list",
    );
  }
  return route;
}

/**
 * A non-streaming fake whose completion carries the switches the fold collected.
 *
 * `stream` throws: a case that streams has its own fake below, and a throw is what
 * makes a case taking the wrong one fail loudly instead of silently.
 */
function foldedKaana(
  switches: (
    envelope: InferenceRequest,
  ) => readonly InferenceStreamRouteSwitchEvent[],
  servingProvider = FAILOVER_PROVIDER,
  reportUnsignedRoute = false,
): KaanaClient {
  return {
    execute: async (envelope): Promise<KaanaCompletion> => {
      const now = new Date().toISOString();
      const routeSwitches = switches(envelope);
      let servedRoute: InferenceRequest["authorizedRoutes"][number] | undefined;
      try {
        servedRoute = servedRouteFor(envelope, routeSwitches, servingProvider);
      } catch (error) {
        if (!reportUnsignedRoute) throw error;
      }
      const lastModelSwitch = [...routeSwitches]
        .reverse()
        .find((event) => event.detail.scope === "model");
      const reportedModelReference =
        servedRoute?.modelReference ??
        (lastModelSwitch?.detail.scope === "model"
          ? lastModelSwitch.detail.toModelReference
          : envelope.authorizedRoutes[0].modelReference);
      return {
        generationId: `gen-${randomUUID()}`,
        output: [
          { role: "assistant", content: [{ type: "text", text: "Hello." }] },
        ],
        finishReason: "stop",
        usage: {
          schemaVersion: 1,
          requestId: envelope.attribution.requestId,
          attribution: envelope.attribution,
          outcome: "completed",
          units: [
            { unit: "input_tokens", quantity: 12 },
            { unit: "output_tokens", quantity: 20 },
          ],
          usageSource: "provider_reported",
          resolvedModelReference: reportedModelReference,
          servingProvider,
          ...(servedRoute === undefined
            ? {}
            : { deploymentId: servedRoute.deploymentId }),
          routeSwitches: routeSwitches.length,
          startedAt: now,
          completedAt: now,
        },
        routeSwitchEvents: routeSwitches,
      };
    },
    stream: () => {
      throw new Error("this fake serves only non-streaming requests");
    },
  };
}

/** A streaming fake: a start, a delta, the switches, a usage event, a done, a report. */
function streamingKaana(
  switches: (
    envelope: InferenceRequest,
  ) => readonly InferenceStreamRouteSwitchEvent[],
): KaanaClient {
  return {
    execute: () => {
      throw new Error("this fake serves only streaming requests");
    },
    stream: async function* (envelope): AsyncGenerator<KaanaStreamFrame> {
      const requestId = envelope.attribution.requestId;
      const now = new Date().toISOString();
      const routeSwitches = switches(envelope);
      const servedRoute = servedRouteFor(
        envelope,
        routeSwitches,
        FAILOVER_PROVIDER,
      );
      const generationId = `gen-${randomUUID()}`;
      const units = [
        { unit: "input_tokens" as const, quantity: 12 },
        { unit: "output_tokens" as const, quantity: 20 },
      ];

      const events: InferenceStreamEvent[] = [
        {
          schemaVersion: 1,
          type: "start",
          requestId,
          sequence: 0,
          generationId,
          resolvedModelReference: servedRoute.modelReference,
          servingProvider: FAILOVER_PROVIDER,
          startedAt: now,
        },
        ...routeSwitches,
        {
          schemaVersion: 1,
          type: "delta",
          requestId,
          sequence: 90,
          outputIndex: 0,
          channel: "output_text",
          text: "Hello.",
        },
        {
          schemaVersion: 1,
          type: "usage",
          requestId,
          sequence: 91,
          units,
          usageSource: "provider_reported",
        },
        {
          schemaVersion: 1,
          type: "done",
          requestId,
          sequence: 92,
          generationId,
          finishReason: "stop",
          completedAt: now,
        },
      ];

      for (const event of events) yield { kind: "event", event };

      yield {
        kind: "usage",
        usage: {
          schemaVersion: 1,
          requestId,
          generationId,
          attribution: envelope.attribution,
          outcome: "completed",
          units,
          usageSource: "provider_reported",
          resolvedModelReference: servedRoute.modelReference,
          servingProvider: FAILOVER_PROVIDER,
          deploymentId: servedRoute.deploymentId,
          routeSwitches: routeSwitches.length,
          startedAt: now,
          completedAt: now,
        },
      };
    },
  };
}

/* -------------------------------------------------------------------------- */
/*  Environment                                                               */
/* -------------------------------------------------------------------------- */

/**
 * All four flags default to serving and charging nobody, so every assertion here
 * would otherwise pass for the wrong reason. The two dated attestations are
 * comfortably in the past because the flags refuse a FUTURE date, and midnight UTC
 * on a runner an hour behind local time is one.
 *
 * `public` requires BOTH the charging authorization and the privacy review; with
 * either missing the audience resolves closed and every case here would refuse at
 * the gate with `permission_denied` instead of reaching the data plane.
 */
const ROLLOUT_ENVIRONMENT = {
  INFERENCE_EDGE_AUDIENCE: "public",
  INFERENCE_MACHINE_CREDENTIAL_AUTH: "enabled",
  INFERENCE_CHARGING_AUTHORIZED: "route-switch-suite-fixture:2026-08-01",
  INFERENCE_PRIVACY_REVIEW: "route-switch-suite-fixture:2026-08-01",
} as const;

const ORIGINAL_ROLLOUT_ENVIRONMENT = Object.fromEntries(
  Object.keys(ROLLOUT_ENVIRONMENT).map((key) => [key, process.env[key]]),
);

beforeAll(async () => {
  Object.assign(process.env, ROLLOUT_ENVIRONMENT);
  await connectPostgres();
});

afterAll(async () => {
  for (const [key, value] of Object.entries(ORIGINAL_ROLLOUT_ENVIRONMENT)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await closePostgres();
});

beforeEach(() => {
  jest.clearAllMocks();
});

/** Every recorded switch for one application, oldest first. */
async function switchesOf(applicationId: string) {
  return getDb()
    .select({
      requestId: inferenceRouteSwitchEvents.requestId,
      sequence: inferenceRouteSwitchEvents.sequence,
      accountId: inferenceRouteSwitchEvents.accountId,
      environment: inferenceRouteSwitchEvents.environment,
      routingPolicyVersionId: inferenceRouteSwitchEvents.routingPolicyVersionId,
      scope: inferenceRouteSwitchEvents.scope,
      reason: inferenceRouteSwitchEvents.reason,
      fromModelReference: inferenceRouteSwitchEvents.fromModelReference,
      toModelReference: inferenceRouteSwitchEvents.toModelReference,
      toProvider: inferenceRouteSwitchEvents.toProvider,
      requestedModelId: inferenceRouteSwitchEvents.requestedModelId,
      authorizationId: inferenceRouteSwitchEvents.authorizationId,
      routingProfileCandidateId:
        inferenceRouteSwitchEvents.routingProfileCandidateId,
    })
    .from(inferenceRouteSwitchEvents)
    .where(eq(inferenceRouteSwitchEvents.applicationId, applicationId))
    .orderBy(inferenceRouteSwitchEvents.sequence);
}

/* -------------------------------------------------------------------------- */
/*  A deployment switch, on both transports                                   */
/* -------------------------------------------------------------------------- */

describe("a same-model deployment failover", () => {
  it("is recorded from a NON-streaming request, with the reported destination", async () => {
    const fixture = await makeFixture();
    const versionId = await givePolicy(fixture);

    await withServer(
      foldedKaana((envelope) => [
        deploymentSwitch(
          envelope.attribution.requestId,
          fixture.pinnedModelReference,
          FAILOVER_PROVIDER,
        ),
      ]),
      async (request) => {
        const response = await request(
          "/v1/responses",
          responsesBody(fixture),
          bearer(fixture.token),
        );
        expect(response.status).toBe(200);
        // The same request id the notice is keyed on, so a customer can join the
        // two without a second lookup.
        expect(json(response).requestId).toEqual(expect.any(String));
      },
    );

    const rows = await switchesOf(fixture.applicationId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      sequence: 1,
      accountId: fixture.accountId,
      environment: "development",
      routingPolicyVersionId: versionId,
      scope: "deployment",
      reason: "provider_overloaded",
      // Same weights on both sides — that is what makes this a failover rather
      // than the substitution the epic forbids, and the table's own CHECK agrees.
      fromModelReference: fixture.pinnedModelReference,
      toModelReference: fixture.pinnedModelReference,
      toProvider: FAILOVER_PROVIDER,
      // A deployment switch is an availability decision the customer already made
      // with `sameModelDeployment`; there is no per-destination authorisation to
      // name and none is invented.
      requestedModelId: null,
      authorizationId: null,
      routingProfileCandidateId: null,
    });
    // The destination is the REPORTED provider, not the admitted one — without
    // this the row would say the request never left the route it started on.
    expect(rows[0].toProvider).not.toBe(fixture.provider);
  });

  it("is recorded from a STREAMING request too, on the same one writer", async () => {
    const fixture = await makeFixture();
    const versionId = await givePolicy(fixture);

    await withServer(
      streamingKaana((envelope) => [
        deploymentSwitch(
          envelope.attribution.requestId,
          fixture.pinnedModelReference,
          FAILOVER_PROVIDER,
          3,
        ),
      ]),
      async (request) => {
        const response = await request(
          "/v1/responses",
          responsesBody(fixture, { stream: true }),
          bearer(fixture.token),
        );
        expect(response.status).toBe(200);
        expect(response.headers["content-type"]).toContain("text/event-stream");
        // Forwarded in-band as well as persisted: the customer comparing two
        // answers needs it while they are reading, and afterwards.
        expect(response.body).toContain("event: route_switch");
      },
    );

    const rows = await switchesOf(fixture.applicationId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      sequence: 3,
      scope: "deployment",
      routingPolicyVersionId: versionId,
      toProvider: FAILOVER_PROVIDER,
    });
  });

  it("records one row when the same switch arrives twice", async () => {
    const fixture = await makeFixture();
    await givePolicy(fixture);

    // The same `(requestId, sequence)` twice in one response — a redelivery, which
    // is what a retried hop looks like from here. The unique key makes it a no-op;
    // no second idempotency mechanism is introduced for it.
    await withServer(
      foldedKaana((envelope) => [
        deploymentSwitch(
          envelope.attribution.requestId,
          fixture.pinnedModelReference,
          FAILOVER_PROVIDER,
          2,
        ),
        deploymentSwitch(
          envelope.attribution.requestId,
          fixture.pinnedModelReference,
          FAILOVER_PROVIDER,
          2,
        ),
      ]),
      async (request) => {
        const response = await request(
          "/v1/responses",
          responsesBody(fixture),
          bearer(fixture.token),
        );
        expect(response.status).toBe(200);
      },
    );

    const rows = await switchesOf(fixture.applicationId);
    expect(rows).toHaveLength(1);
    expect(rows[0].sequence).toBe(2);
  });

  it("records two rows for two switches in one request", async () => {
    // The control for the case above: an edge that wrote only the first switch
    // whatever arrived would satisfy it, and this is what tells the two apart.
    const fixture = await makeFixture();
    await givePolicy(fixture);

    await withServer(
      foldedKaana((envelope) => [
        deploymentSwitch(
          envelope.attribution.requestId,
          fixture.pinnedModelReference,
          FAILOVER_PROVIDER,
          1,
        ),
        deploymentSwitch(
          envelope.attribution.requestId,
          fixture.pinnedModelReference,
          "second-failover",
          2,
        ),
      ]),
      async (request) => {
        const response = await request(
          "/v1/responses",
          responsesBody(fixture),
          bearer(fixture.token),
        );
        expect(response.status).toBe(200);
      },
    );

    const rows = await switchesOf(fixture.applicationId);
    expect(rows.map((row) => [row.sequence, row.toProvider])).toEqual([
      [1, FAILOVER_PROVIDER],
      [2, "second-failover"],
    ]);
  });
});

/* -------------------------------------------------------------------------- */
/*  A cross-model switch, and the authorisation it must name                  */
/* -------------------------------------------------------------------------- */

describe("a cross-model substitution", () => {
  it("is recorded, naming the customer’s own authorisation row", async () => {
    const fixture = await makeFixture();
    const versionId = await givePolicy(fixture, {
      fallback: {
        disabled: false,
        sameModelDeployment: true,
        // The customer authorised THIS destination by name. Being allowed to
        // substitute IS having this row.
        authorizedCrossModel: [fixture.otherModelReference],
      },
    });

    await withServer(
      foldedKaana((envelope) => [
        modelSwitch(envelope.attribution.requestId, {
          requestedModelId: fixture.modelReference,
          fromModelReference: fixture.pinnedModelReference,
          toModelReference: fixture.otherPinnedModelReference,
          toProvider: FAILOVER_PROVIDER,
        }),
      ]),
      async (request) => {
        const response = await request(
          "/v1/responses",
          responsesBody(fixture),
          bearer(fixture.token),
        );
        expect(response.status).toBe(200);
      },
    );

    const rows = await switchesOf(fixture.applicationId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      scope: "model",
      reason: "deployment_unavailable",
      requestedModelId: fixture.modelReference,
      fromModelReference: fixture.pinnedModelReference,
      toModelReference: fixture.otherPinnedModelReference,
      toProvider: FAILOVER_PROVIDER,
      routingPolicyVersionId: versionId,
    });
    // The authorisation is a ROW, looked up rather than asserted by the reporter —
    // the wire's `authorizedByPolicy: true` is deliberately not forwarded.
    expect(rows[0].authorizationId).toEqual(expect.any(String));
    expect(rows[0].routingProfileCandidateId).toBeNull();
  });

  it("records a routing-profile substitution against the selected candidate row", async () => {
    const fixture = await makeFixture();
    const versionId = await givePolicy(fixture);
    const slug = `profile-${suffix()}`;
    const [profile] = await getDb()
      .insert(inferenceRoutingProfiles)
      .values({
        slug,
        displayName: "Route switch profile fixture",
        optimiseFor: "balanced",
        isProductPreset: false,
      })
      .returning({ id: inferenceRoutingProfiles.id });
    const [primaryModel] = await getDb()
      .select({ id: inferenceModels.id })
      .from(inferenceModels)
      .where(eq(inferenceModels.modelId, fixture.modelReference))
      .limit(1);
    const [alternateModel] = await getDb()
      .select({ id: inferenceModels.id })
      .from(inferenceModels)
      .where(eq(inferenceModels.modelId, fixture.otherModelReference))
      .limit(1);
    await getDb().insert(inferenceRoutingProfileCandidates).values({
      routingProfileId: profile.id,
      modelId: primaryModel.id,
      priority: 0,
    });
    const [alternateCandidate] = await getDb()
      .insert(inferenceRoutingProfileCandidates)
      .values({
        routingProfileId: profile.id,
        modelId: alternateModel.id,
        priority: 1,
      })
      .returning({ id: inferenceRoutingProfileCandidates.id });

    await withServer(
      foldedKaana((envelope) => [
        modelSwitch(envelope.attribution.requestId, {
          requestedModelId: fixture.modelReference,
          fromModelReference: fixture.pinnedModelReference,
          toModelReference: fixture.otherPinnedModelReference,
          toProvider: FAILOVER_PROVIDER,
        }),
      ]),
      async (request) => {
        const response = await request(
          "/v1/responses",
          responsesBody(fixture, { model: undefined, routingProfile: slug }),
          bearer(fixture.token),
        );
        expect(response.status).toBe(200);
      },
    );

    const rows = await switchesOf(fixture.applicationId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      scope: "model",
      routingPolicyVersionId: versionId,
      authorizationId: null,
      routingProfileCandidateId: alternateCandidate.id,
    });
  });

  it("is NOT recorded when the customer authorised no such destination", async () => {
    const fixture = await makeFixture();
    // A policy with fallback enabled and an EMPTY authorisation list: same-model
    // failover is permitted, cross-model substitution is not.
    await givePolicy(fixture);

    await withServer(
      foldedKaana(
        (envelope) => [
          modelSwitch(envelope.attribution.requestId, {
            requestedModelId: fixture.modelReference,
            fromModelReference: fixture.pinnedModelReference,
            toModelReference: fixture.otherPinnedModelReference,
            toProvider: FAILOVER_PROVIDER,
          }),
        ],
        FAILOVER_PROVIDER,
        true,
      ),
      async (request) => {
        // A malicious or stale data plane that reports a route outside the
        // signed list is refused before settlement or notice persistence.
        const response = await request(
          "/v1/responses",
          responsesBody(fixture),
          bearer(fixture.token),
        );
        expect(response.status).toBe(403);
        expect(json(response)).toMatchObject({ code: "policy_violation" });
      },
    );

    await expect(switchesOf(fixture.applicationId)).resolves.toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/*  The one configuration that cannot be recorded                             */
/* -------------------------------------------------------------------------- */

describe("an application served under the platform default", () => {
  it("refuses an unsigned failover and records no notice", async () => {
    // No routing policy at all, so `resolveEffectiveRoutingPolicy` answers `none`
    // and the request runs under `PLATFORM_DEFAULT_ROUTING_POLICY` — which has no
    // version ROW, deliberately, because that absence is how a reader tells the
    // platform default from a configured policy.
    const fixture = await makeFixture();

    await withServer(
      foldedKaana(
        (envelope) => [
          deploymentSwitch(
            envelope.attribution.requestId,
            fixture.pinnedModelReference,
            FAILOVER_PROVIDER,
          ),
        ],
        FAILOVER_PROVIDER,
        true,
      ),
      async (request) => {
        const response = await request(
          "/v1/responses",
          responsesBody(fixture),
          bearer(fixture.token),
        );
        expect(response.status).toBe(403);
        expect(json(response)).toMatchObject({ code: "policy_violation" });
      },
    );

    await expect(switchesOf(fixture.applicationId)).resolves.toEqual([]);
    expect(mockedLogger.warn).toHaveBeenCalledWith(
      "inference.edge.refused",
      expect.objectContaining({ reason: "route_not_authorized" }),
    );
  });
});

/* -------------------------------------------------------------------------- */
/*  A notice that answers a different request                                 */
/* -------------------------------------------------------------------------- */

describe("a switch reported for another request", () => {
  it("is discarded rather than stored under this request’s id", async () => {
    const fixture = await makeFixture();
    await givePolicy(fixture);

    await withServer(
      foldedKaana(() => [
        // A well-formed event naming somebody else's request. Storing it under
        // this one's id would attach a stranger's notice to this customer's
        // receipt — the same reasoning `validateUsageReport` applies to units.
        deploymentSwitch(
          randomUUID(),
          fixture.pinnedModelReference,
          FAILOVER_PROVIDER,
        ),
      ]),
      async (request) => {
        const response = await request(
          "/v1/responses",
          responsesBody(fixture),
          bearer(fixture.token),
        );
        expect(response.status).toBe(200);
      },
    );

    await expect(switchesOf(fixture.applicationId)).resolves.toEqual([]);
    expect(
      mockedLogger.error.mock.calls.filter(
        (call) => call[0] === "inference.edge.route_switch_request_mismatch",
      ),
    ).toHaveLength(1);
  });
});

/* -------------------------------------------------------------------------- */
/*  A client that reports no switches at all                                  */
/* -------------------------------------------------------------------------- */

describe("a completion carrying no routeSwitchEvents field", () => {
  it("is served and settled normally, recording no notices", async () => {
    // THE regression this case exists for. `routeSwitchEvents` was briefly a
    // REQUIRED field, and the edge iterated it unguarded — so a completion built
    // without it threw `is not iterable` at a line that runs AFTER the hold is
    // settled, turning a charged request into a 500 with the money already taken.
    //
    // It reached `main` because nothing could catch it: `packages/api/tsconfig.json`
    // excludes `src/**\/__tests__/**`, so a hand-built completion omitting a
    // required field is not a type error, and the only two suites that constructed
    // one were both updated by the same commit that added the field. A third
    // arrived from a PR written in parallel and `main` went red.
    //
    // So the object below deliberately does NOT set the field, and is typed
    // `KaanaCompletion` so this stays a statement about the published shape rather
    // than about an untyped literal.
    const fixture = await makeFixture();
    await givePolicy(fixture);

    const withoutTheField: KaanaClient = {
      execute: async (envelope): Promise<KaanaCompletion> => {
        const now = new Date().toISOString();
        const modelReference =
          envelope.target.kind === "model"
            ? envelope.target.modelReference
            : "unknown/unknown";
        return {
          generationId: `gen-${randomUUID()}`,
          output: [
            { role: "assistant", content: [{ type: "text", text: "Hello." }] },
          ],
          finishReason: "stop",
          usage: {
            schemaVersion: 1,
            requestId: envelope.attribution.requestId,
            attribution: envelope.attribution,
            outcome: "completed",
            units: [
              { unit: "input_tokens", quantity: 12 },
              { unit: "output_tokens", quantity: 20 },
            ],
            usageSource: "provider_reported",
            resolvedModelReference: modelReference,
            servingProvider: fixture.provider,
            routeSwitches: 0,
            startedAt: now,
            completedAt: now,
          },
        };
      },
      stream: () => {
        throw new Error("this fake serves only non-streaming requests");
      },
    };

    await withServer(withoutTheField, async (request) => {
      const response = await request(
        "/v1/responses",
        responsesBody(fixture),
        bearer(fixture.token),
      );
      // 200, not 500. Before the guard this was a 500 with the hold already
      // settled — the failure mode that makes this worth a case of its own.
      expect(response.status).toBe(200);
      expect(json(response).servingProvider).toBe(fixture.provider);
    });

    // Absent means the same as empty: no notices, and no error logged about it.
    await expect(switchesOf(fixture.applicationId)).resolves.toEqual([]);
    expect(
      mockedLogger.error.mock.calls.filter((call) =>
        String(call[0]).startsWith("inference.edge.route_switch"),
      ),
    ).toEqual([]);

    // And the request was CHARGED, which is what makes the 200 above meaningful:
    // a response that never reached settlement would also be a non-500.
    const receipts = await getDb()
      .select({ id: usageReceipts.id, outcome: usageReceipts.outcome })
      .from(usageReceipts)
      .where(eq(usageReceipts.accountId, fixture.accountId));
    expect(receipts).toHaveLength(1);
    expect(receipts[0].outcome).toBe("completed");
  });
});
