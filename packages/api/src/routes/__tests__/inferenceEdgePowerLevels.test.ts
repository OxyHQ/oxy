/**
 * Power levels and exact mode through the REAL edge: a signed HTTP hop to a
 * stub data plane, real Postgres, a real machine credential and the ledger.
 *
 * What each case makes falsifiable:
 *
 *  - a power level signs only servable models of its reviewed class, ordered
 *    by the economic hierarchy (funding class) and then price, and authorizes
 *    cross-model failover among them — while an EXACT request never signs a
 *    different model;
 *  - a model switch inside a level is recorded against the PROFILE;
 *  - the level's reasoning effort is clamped to the nearest effort the model
 *    accepts (never left to a reasoning model's default), and failover never
 *    lands on a route that would run the level at another effort;
 *  - `instant` ranks a model that does not reason ahead of one that does,
 *    inside one funding class;
 *  - `auto` chooses the cheapest sufficient level and climbs only upward;
 *  - an application's allowed-profile list refuses a forbidden level before
 *    any Kaana call, and its `defaultTarget` serves a request naming nothing;
 *  - a deployment Kaana does not publish is never signed;
 *  - same-model deployment failover is on by default and a policy can opt out.
 */

import express from 'express';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { generateKeyPairSync, randomUUID } from 'node:crypto';

jest.mock('../../utils/logger', () => ({
  logger: { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

import { eq } from 'drizzle-orm';
import type { InferenceRequest, UsageQuantity } from '@oxy.so/contracts';
import {
  KAANA_BASE_URL_VARIABLE,
  KAANA_SIGNING_KEY_ID_VARIABLE,
  KAANA_SIGNING_PRIVATE_KEY_VARIABLE,
} from '../../config/kaanaDataPlane';
import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { applicationCredentials } from '../../db/schema/applicationCredentials';
import { applications } from '../../db/schema/applications';
import { inferenceDeployments, inferenceRouteSwitchEvents } from '../../db/schema';
import { users } from '../../db/schema/users';
import {
  clearPowerClassesForTest,
  insertCatalogueRoute,
  setPowerClass,
  type CatalogueRouteFixture,
} from '../../db/testServableEvidence';
import {
  createHttpKaanaClient,
  KAANA_DEPLOYMENTS_QUERY_PATH,
  KAANA_INFERENCE_PATH,
} from '../../services/httpKaanaClient';
import { provisionBillingProfile, recordTopUp } from '../../services/inferenceLedger.service';
import type { RoutingPolicyControls } from '../../services/inferenceRoutingPolicy.service';
import { overrideDeploymentPublicationSource } from '../../services/kaanaDeploymentPublication.service';
import { generateMachineCredentialToken } from '../../utils/machineCredentialToken';
import { createInferenceEdgeRouter } from '../inferenceEdge';
import {
  attestFixtureDeployments,
  createNeutralRoutingPolicy,
} from '../__fixtures__/kaanaRuntimeFixtures';
import { EDGE_ROLLOUT_ENVIRONMENT, verifyEdgeSignature } from '../__fixtures__/kaanaAudioFixtures';

jest.setTimeout(60_000);

const EDGE_KEY_ID = 'oxy-edge-power-test';
const edgeKeys = generateKeyPairSync('ed25519');
const EDGE_PRIVATE_PEM = edgeKeys.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();

/* -------------------------------------------------------------------------- */
/*  The stub data plane                                                       */
/* -------------------------------------------------------------------------- */

interface Stub {
  readonly baseUrl: string;
  readonly received: InferenceRequest[];
  /** Which authorized route serves; a non-zero index emits a route switch first. */
  servedIndex: number;
  close(): Promise<void>;
}

async function startStub(): Promise<Stub> {
  const stub: Stub = { baseUrl: '', received: [], servedIndex: 0, close: async () => undefined };
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      void (async () => {
        const body = Buffer.concat(chunks);
        if (!verifyEdgeSignature(EDGE_KEY_ID, edgeKeys.publicKey, req.headers, body)) {
          res.writeHead(401).end();
          return;
        }
        if (req.url === KAANA_DEPLOYMENTS_QUERY_PATH) {
          const query = JSON.parse(body.toString('utf8')) as { deploymentIds: string[] };
          res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
          res.end(JSON.stringify(await attestFixtureDeployments(query.deploymentIds)));
          return;
        }
        if (req.url !== KAANA_INFERENCE_PATH) {
          res.writeHead(404).end();
          return;
        }
        const envelope = JSON.parse(body.toString('utf8')) as InferenceRequest;
        stub.received.push(envelope);
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        const requestId = envelope.attribution.requestId;
        const first = envelope.authorizedRoutes[0];
        const served = envelope.authorizedRoutes[stub.servedIndex];
        let sequence = 0;
        const frame = (name: string, payload: unknown): void => {
          res.write(`event: ${name}\ndata: ${JSON.stringify(payload)}\n\n`);
        };
        const event = (payload: Record<string, unknown>): void =>
          frame('stream_event', { schemaVersion: 1, requestId, sequence: sequence++, ...payload });
        if (stub.servedIndex > 0) {
          const line = (reference: string) => reference.split('@')[0];
          event({
            type: 'route_switch',
            reason: 'provider_error',
            occurredAt: new Date().toISOString(),
            detail:
              line(served.modelReference) === line(first.modelReference)
                ? {
                    scope: 'deployment',
                    modelReference: served.modelReference,
                    toProvider: served.provider,
                  }
                : {
                    scope: 'model',
                    requestedModelId: line(first.modelReference),
                    fromModelReference: first.modelReference,
                    toModelReference: served.modelReference,
                    toProvider: served.provider,
                    authorizedByPolicy: true,
                  },
          });
        }
        event({ type: 'delta', outputIndex: 0, channel: 'output_text', text: 'Hi.' });
        event({ type: 'done', finishReason: 'stop', completedAt: new Date().toISOString() });
        const units: UsageQuantity[] = [
          { unit: 'requests', quantity: 1 },
          { unit: 'input_tokens', quantity: 12 },
          { unit: 'output_tokens', quantity: 3 },
        ];
        const now = new Date().toISOString();
        frame('usage_report', {
          schemaVersion: 2,
          requestId,
          generationId: `gen-${requestId}`,
          attribution: envelope.attribution,
          outcome: 'completed',
          units,
          usageSource: 'provider_reported',
          resolvedModelReference: served.modelReference,
          servingProvider: served.provider,
          deploymentId: served.deploymentId,
          routeSwitches: stub.servedIndex > 0 ? 1 : 0,
          startedAt: now,
          completedAt: now,
        });
        res.end();
      })();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const { port } = server.address() as AddressInfo;
  (stub as { baseUrl: string }).baseUrl = `http://127.0.0.1:${port}`;
  stub.close = () =>
    new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    });
  return stub;
}

/* -------------------------------------------------------------------------- */
/*  The edge                                                                  */
/* -------------------------------------------------------------------------- */

interface Answer {
  readonly status: number;
  readonly body: Record<string, unknown>;
}

type Post = (
  path: '/v1/chat/completions' | '/v1/responses',
  body: unknown,
  token: string,
) => Promise<Answer>;

async function withEdge(run: (stub: Stub, post: Post) => Promise<void>): Promise<void> {
  const stub = await startStub();
  process.env[KAANA_BASE_URL_VARIABLE] = 'https://kaana.ai';
  process.env[KAANA_SIGNING_KEY_ID_VARIABLE] = EDGE_KEY_ID;
  process.env[KAANA_SIGNING_PRIVATE_KEY_VARIABLE] = EDGE_PRIVATE_PEM;
  const systemFetch = globalThis.fetch;
  globalThis.fetch = (async (input, init) => {
    const requested = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input : input.url,
    );
    expect(requested.origin).toBe('https://kaana.ai');
    return systemFetch(`${stub.baseUrl}${requested.pathname}`, init);
  }) as typeof fetch;

  const kaanaClient = createHttpKaanaClient();
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use('/v1', createInferenceEdgeRouter(kaanaClient === undefined ? {} : { kaanaClient }));
  const server = await new Promise<http.Server>((resolve) => {
    const created = app.listen(0, '127.0.0.1', () => resolve(created));
  });
  const { port } = server.address() as AddressInfo;

  const post: Post = (path, body, token) =>
    new Promise((resolve, reject) => {
      const payload = JSON.stringify(body);
      const request = http.request(
        {
          hostname: '127.0.0.1',
          port,
          path,
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(payload),
            Authorization: `Bearer ${token}`,
          },
        },
        (res) => {
          let text = '';
          res.on('data', (chunk: Buffer) => {
            text += chunk.toString('utf8');
          });
          res.on('end', () =>
            resolve({
              status: res.statusCode ?? 0,
              body: JSON.parse(text) as Record<string, unknown>,
            }),
          );
        },
      );
      request.on('error', reject);
      request.end(payload);
    });

  try {
    await run(stub, post);
  } finally {
    await new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    });
    await stub.close();
    globalThis.fetch = systemFetch;
    delete process.env[KAANA_BASE_URL_VARIABLE];
    delete process.env[KAANA_SIGNING_KEY_ID_VARIABLE];
    delete process.env[KAANA_SIGNING_PRIVATE_KEY_VARIABLE];
  }
}

const ORIGINAL_ENVIRONMENT = Object.fromEntries(
  Object.keys(EDGE_ROLLOUT_ENVIRONMENT).map((key) => [key, process.env[key]]),
);

beforeAll(async () => {
  Object.assign(process.env, EDGE_ROLLOUT_ENVIRONMENT);
  await connectPostgres();
});

afterAll(async () => {
  for (const [key, value] of Object.entries(ORIGINAL_ENVIRONMENT)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await closePostgres();
});

beforeEach(async () => {
  await clearPowerClassesForTest();
});

/* -------------------------------------------------------------------------- */
/*  Fixtures                                                                  */
/* -------------------------------------------------------------------------- */

interface Caller {
  readonly accountId: string;
  readonly applicationId: string;
  readonly token: string;
}

/** A third-party application with a machine credential, a balance and a policy. */
async function makeCaller(policy: Partial<RoutingPolicyControls> | 'none' = {}): Promise<Caller> {
  const db = getDb();
  const tag = randomUUID().replace(/-/g, '').slice(0, 10);
  const [account] = await db
    .insert(users)
    .values({ username: `power-${tag}`, email: `power-${tag}@example.test` })
    .returning({ id: users.id });
  const scopes = ['inference:invoke', 'inference:usage:read'];
  const [application] = await db
    .insert(applications)
    .values({ name: `Power ${tag}`, ownerAccountId: account.id, scopes })
    .returning({ id: applications.id });
  const minted = generateMachineCredentialToken();
  await db.insert(applicationCredentials).values({
    applicationId: application.id,
    name: `key-${tag}`,
    publicKey: `oxy_dk_${tag}`,
    tokenPrefix: minted.tokenPrefix,
    tokenHash: minted.tokenHash,
    type: 'machine',
    environment: 'development',
    scopes,
    status: 'active',
  });
  if (policy !== 'none') {
    await createNeutralRoutingPolicy({
      accountId: account.id,
      applicationId: application.id,
      overrides: { optimiseFor: 'price', ...policy },
    });
  }
  await provisionBillingProfile({ accountId: account.id });
  await recordTopUp({
    idempotencyKey: `power-top-up-${tag}`,
    accountId: account.id,
    currency: 'USD',
    amount: '100.000000000000',
    actor: { kind: 'machine' },
  });
  return { accountId: account.id, applicationId: application.id, token: minted.token };
}

type RouteOptions = Parameters<typeof insertCatalogueRoute>[0];

async function publicRoute(options: RouteOptions = {}): Promise<CatalogueRouteFixture> {
  return insertCatalogueRoute({ availabilityScope: 'public_payg', ...options });
}

const chat = (model: string | undefined, extra: Record<string, unknown> = {}) => ({
  ...(model === undefined ? {} : { model }),
  messages: [{ role: 'user', content: 'Hi' }],
  max_tokens: 100,
  ...extra,
});

const lines = (envelope: InferenceRequest) =>
  envelope.authorizedRoutes.map((route) => route.modelReference.split('@')[0]);

/* -------------------------------------------------------------------------- */
/*  Power levels                                                              */
/* -------------------------------------------------------------------------- */

describe('a power level', () => {
  it('signs the servable models of its class, cheapest funding first, and reports the model that ran', async () => {
    const cheap = await publicRoute({ tag: 'cheap', evidence: { priceScore: 900 } });
    const free = await publicRoute({
      tag: 'free',
      evidence: { priceScore: 10, fundingClass: 'free_entitlement' },
    });
    const dear = await publicRoute({ tag: 'dear', evidence: { priceScore: 100 } });
    const exhausted = await publicRoute({
      tag: 'exh',
      evidence: { priceScore: 999, fundingState: 'exhausted' },
    });
    const otherClass = await publicRoute({ tag: 'mid' });
    for (const model of [cheap, free, dear, exhausted])
      await setPowerClass(model.modelId, 'instant');
    await setPowerClass(otherClass.modelId, 'medium');
    const caller = await makeCaller();

    await withEdge(async (stub, post) => {
      const answer = await post('/v1/chat/completions', chat('instant'), caller.token);
      expect(answer.status).toBe(200);
      const envelope = stub.received[0];
      expect(envelope.target).toEqual({
        kind: 'routing_profile_id',
        routingProfileId: 'power-instant',
      });
      // Free allowance first, then standard paid by price score; exhausted
      // funding is not eligible; a medium-class model is never signed.
      expect(lines(envelope)).toEqual([free.modelId, cheap.modelId, dear.modelId]);
      expect(envelope.authorizedRoutes[1]).toMatchObject({
        substitution: 'cross_model',
        authorizedByPolicy: true,
      });
      expect(answer.body.model).toBe(`${free.modelId}@${free.revision}`);
      // `instant` requests no reasoning effort.
      expect(envelope.reasoning).toBeUndefined();
    });
  });

  it('records a cross-model switch inside the level against the profile', async () => {
    const first = await publicRoute({ tag: 'sw1', evidence: { priceScore: 900 } });
    const second = await publicRoute({ tag: 'sw2', evidence: { priceScore: 100 } });
    await setPowerClass(first.modelId, 'instant');
    await setPowerClass(second.modelId, 'instant');
    const caller = await makeCaller();

    await withEdge(async (stub, post) => {
      stub.servedIndex = 1;
      const answer = await post('/v1/chat/completions', chat('instant'), caller.token);
      expect(answer.status).toBe(200);
      expect(answer.body.model).toBe(`${second.modelId}@${second.revision}`);
      const [row] = await getDb()
        .select()
        .from(inferenceRouteSwitchEvents)
        .where(eq(inferenceRouteSwitchEvents.applicationId, caller.applicationId));
      expect(row).toMatchObject({
        scope: 'model',
        routingProfileId: 'power-instant',
        requestedModelId: first.modelId,
        toModelReference: `${second.modelId}@${second.revision}`,
        authorizationId: null,
      });
    });
  });

  it('applies the level effort where the model advertises it, and never fails over to a route that cannot', async () => {
    const reasons = await publicRoute({
      tag: 'rsn',
      reasoningEfforts: ['low', 'medium', 'high'],
      evidence: { priceScore: 900 },
    });
    const plain = await publicRoute({ tag: 'pln', evidence: { priceScore: 100 } });
    await setPowerClass(reasons.modelId, 'medium');
    await setPowerClass(plain.modelId, 'medium');
    const caller = await makeCaller();

    await withEdge(async (stub, post) => {
      const answer = await post('/v1/chat/completions', chat('medium'), caller.token);
      expect(answer.status).toBe(200);
      const envelope = stub.received[0];
      expect(envelope.reasoning).toEqual({ effort: 'low' });
      expect(lines(envelope)).toEqual([reasons.modelId]);
    });
  });

  it('injects no effort on a deployment whose accepted parameters exclude it, and signs no failover that would refuse it', async () => {
    const refuses = await publicRoute({
      tag: 'nre',
      reasoningEfforts: ['low'],
      evidence: { priceScore: 900 },
    });
    await setPowerClass(refuses.modelId, 'medium');
    // Known accepted set without `reasoning.effort`: Kaana's Translate would
    // refuse an effort on this exact deployment.
    await getDb()
      .update(inferenceDeployments)
      .set({ acceptedParameters: ['maxOutputTokens'] })
      .where(eq(inferenceDeployments.internalRouteId, refuses.internalRouteId));
    const caller = await makeCaller();

    await withEdge(async (stub, post) => {
      expect((await post('/v1/chat/completions', chat('medium'), caller.token)).status).toBe(200);
      expect(stub.received[0].reasoning).toBeUndefined();
      expect(lines(stub.received[0])).toEqual([refuses.modelId]);
    });

    // Now a primary that accepts the effort: the refusing deployment must not
    // be signed as its failover, because the envelope carries `effort: low`.
    const accepts = await publicRoute({
      tag: 'are',
      reasoningEfforts: ['low'],
      evidence: { priceScore: 950 },
    });
    await setPowerClass(accepts.modelId, 'medium');
    await withEdge(async (stub, post) => {
      expect((await post('/v1/chat/completions', chat('medium'), caller.token)).status).toBe(200);
      expect(stub.received[0].reasoning).toEqual({ effort: 'low' });
      expect(lines(stub.received[0])).toEqual([accepts.modelId]);
    });
  });

  it('sends no effort when the chosen model takes none, and signs no failover that would reason at its default', async () => {
    const plain = await publicRoute({ tag: 'pl1', evidence: { priceScore: 900 } });
    const plainToo = await publicRoute({ tag: 'pl2', evidence: { priceScore: 500 } });
    const reasons = await publicRoute({
      tag: 'rs1',
      reasoningEfforts: ['low'],
      evidence: { priceScore: 100 },
    });
    for (const model of [plain, plainToo, reasons]) await setPowerClass(model.modelId, 'medium');
    const caller = await makeCaller();

    await withEdge(async (stub, post) => {
      expect((await post('/v1/chat/completions', chat('medium'), caller.token)).status).toBe(200);
      expect(stub.received[0].reasoning).toBeUndefined();
      // The envelope carries no effort, so the reasoning model — which the
      // level would run at `low` — is not a failover: it would run at its
      // provider's default instead. Another model without effort control is.
      expect(lines(stub.received[0])).toEqual([plain.modelId, plainToo.modelId]);
    });
  });

  it('asks a reasoning model at instant for the least effort it accepts, not its default', async () => {
    const oss = await publicRoute({
      tag: 'oss',
      reasoningEfforts: ['low', 'medium', 'high'],
      evidence: { priceScore: 900 },
    });
    await setPowerClass(oss.modelId, 'instant');
    const caller = await makeCaller();

    await withEdge(async (stub, post) => {
      expect((await post('/v1/chat/completions', chat('instant'), caller.token)).status).toBe(200);
      expect(stub.received[0].reasoning).toEqual({ effort: 'low' });
    });
  });

  it('clamps a level effort the model lacks to the nearest one it accepts', async () => {
    const upOnly = await publicRoute({
      tag: 'upo',
      reasoningEfforts: ['medium', 'high'],
      evidence: { priceScore: 900 },
    });
    await setPowerClass(upOnly.modelId, 'medium');
    const lowOnly = await publicRoute({
      tag: 'lwo',
      reasoningEfforts: ['low'],
      evidence: { priceScore: 900 },
    });
    await setPowerClass(lowOnly.modelId, 'high');
    const caller = await makeCaller();

    await withEdge(async (stub, post) => {
      // `medium` targets `low`: the lowest accepted effort above it.
      expect((await post('/v1/chat/completions', chat('medium'), caller.token)).status).toBe(200);
      expect(stub.received[0].reasoning).toEqual({ effort: 'medium' });
      // `high` targets `medium`: nothing that high is accepted, so the highest
      // accepted rather than the provider's unstated default.
      expect((await post('/v1/chat/completions', chat('high'), caller.token)).status).toBe(200);
      expect(stub.received[1].reasoning).toEqual({ effort: 'low' });
    });
  });

  it('keeps the caller’s own effort over the level’s', async () => {
    const oss = await publicRoute({
      tag: 'own',
      reasoningEfforts: ['low', 'medium', 'high'],
      evidence: { priceScore: 900 },
    });
    await setPowerClass(oss.modelId, 'instant');
    const caller = await makeCaller();

    await withEdge(async (stub, post) => {
      const answer = await post(
        '/v1/chat/completions',
        chat('instant', { reasoning_effort: 'high' }),
        caller.token,
      );
      expect(answer.status).toBe(200);
      expect(stub.received[0].reasoning).toEqual({ effort: 'high' });
    });
  });

  it('ranks a model that does not reason first at instant, within its funding class', async () => {
    const reasonsCheap = await publicRoute({
      tag: 'rcp',
      reasoningEfforts: ['low', 'medium', 'high'],
      evidence: { priceScore: 900 },
    });
    const plainDearer = await publicRoute({ tag: 'pdr', evidence: { priceScore: 500 } });
    const plainDearest = await publicRoute({ tag: 'pdt', evidence: { priceScore: 100 } });
    const reasonsFree = await publicRoute({
      tag: 'rfr',
      reasoningEfforts: ['low'],
      evidence: { priceScore: 10, fundingClass: 'free_entitlement' },
    });
    for (const model of [reasonsCheap, plainDearer, plainDearest]) {
      await setPowerClass(model.modelId, 'instant');
    }
    const caller = await makeCaller();

    await withEdge(async (stub, post) => {
      const answer = await post('/v1/chat/completions', chat('instant'), caller.token);
      expect(answer.status).toBe(200);
      // Non-reasoning first, then price; the reasoning model would run at
      // `low`, which the no-effort envelope cannot carry, so it is not signed.
      expect(lines(stub.received[0])).toEqual([plainDearer.modelId, plainDearest.modelId]);
      expect(stub.received[0].reasoning).toBeUndefined();
      expect(answer.body.model).toBe(`${plainDearer.modelId}@${plainDearer.revision}`);
    });

    // Funding still comes first: a free allowance outranks the preference.
    await setPowerClass(reasonsFree.modelId, 'instant');
    await withEdge(async (stub, post) => {
      expect((await post('/v1/chat/completions', chat('instant'), caller.token)).status).toBe(200);
      expect(lines(stub.received[0])[0]).toBe(reasonsFree.modelId);
      expect(stub.received[0].reasoning).toEqual({ effort: 'low' });
    });
  });

  it('ranks by price alone at a level that asks for reasoning (control)', async () => {
    const reasonsCheap = await publicRoute({
      tag: 'mrc',
      reasoningEfforts: ['low', 'medium', 'high'],
      evidence: { priceScore: 900 },
    });
    const plainDearer = await publicRoute({ tag: 'mpd', evidence: { priceScore: 500 } });
    await setPowerClass(reasonsCheap.modelId, 'medium');
    await setPowerClass(plainDearer.modelId, 'medium');
    const caller = await makeCaller();

    await withEdge(async (stub, post) => {
      expect((await post('/v1/chat/completions', chat('medium'), caller.token)).status).toBe(200);
      expect(lines(stub.received[0])).toEqual([reasonsCheap.modelId]);
      expect(stub.received[0].reasoning).toEqual({ effort: 'low' });
    });
  });

  it('never signs a deployment Kaana does not publish', async () => {
    const live = await publicRoute({ tag: 'live', evidence: { priceScore: 100 } });
    const withheld = await publicRoute({ tag: 'hold', evidence: { priceScore: 900 } });
    await setPowerClass(live.modelId, 'instant');
    await setPowerClass(withheld.modelId, 'instant');
    const caller = await makeCaller();
    const restore = overrideDeploymentPublicationSource({
      current: async () => ({
        status: 'observed',
        snapshotId: 'snap',
        deploymentIds: new Set([live.internalRouteId]),
        observedAt: Date.now(),
      }),
    });
    try {
      await withEdge(async (stub, post) => {
        expect((await post('/v1/chat/completions', chat('instant'), caller.token)).status).toBe(
          200,
        );
        expect(lines(stub.received[0])).toEqual([live.modelId]);
      });
    } finally {
      restore();
    }
  });

  it('answers no_route_available when the level has no servable model', async () => {
    const caller = await makeCaller();
    await withEdge(async (stub, post) => {
      const answer = await post('/v1/chat/completions', chat('ultra'), caller.token);
      expect(answer.status).toBe(503);
      expect(stub.received).toHaveLength(0);
    });
  });

  it('refuses an unknown slug in `model` without guessing a publisher', async () => {
    const caller = await makeCaller();
    await withEdge(async (stub, post) => {
      const answer = await post('/v1/chat/completions', chat('gpt-4o'), caller.token);
      expect(answer.status).toBe(503);
      expect(answer.body.error).toMatchObject({
        code: 'no_route_available',
        param: 'routingProfile',
      });
      expect(stub.received).toHaveLength(0);
    });
  });
});

describe('auto', () => {
  it('picks instant for a plain request and climbs only upward', async () => {
    const instant = await publicRoute({ tag: 'ain' });
    const medium = await publicRoute({ tag: 'ame' });
    const pro = await publicRoute({ tag: 'apr' });
    await setPowerClass(instant.modelId, 'instant');
    await setPowerClass(medium.modelId, 'medium');
    await setPowerClass(pro.modelId, 'pro');
    const caller = await makeCaller();

    await withEdge(async (stub, post) => {
      expect((await post('/v1/chat/completions', chat('auto'), caller.token)).status).toBe(200);
      expect(stub.received[0].target).toEqual({
        kind: 'routing_profile_id',
        routingProfileId: 'power-auto',
      });
      expect(lines(stub.received[0])).toEqual([instant.modelId, medium.modelId]);
    });
  });

  it('starts at medium for a request with tools, never offering instant', async () => {
    const instant = await publicRoute({ tag: 'tin' });
    const medium = await publicRoute({ tag: 'tme' });
    await setPowerClass(instant.modelId, 'instant');
    await setPowerClass(medium.modelId, 'medium');
    const caller = await makeCaller();
    const tools = [
      {
        type: 'function',
        function: { name: 'lookup', parameters: { type: 'object', properties: {} } },
      },
    ];

    await withEdge(async (stub, post) => {
      const answer = await post('/v1/chat/completions', chat('auto', { tools }), caller.token);
      expect(answer.status).toBe(200);
      expect(lines(stub.received[0])).toEqual([medium.modelId]);
    });
  });
});

/* -------------------------------------------------------------------------- */
/*  Per-application defaults and restrictions                                 */
/* -------------------------------------------------------------------------- */

describe('an application’s routing policy', () => {
  it('refuses a level outside its allowed list before any Kaana call', async () => {
    const high = await publicRoute({ tag: 'hi' });
    await setPowerClass(high.modelId, 'high');
    const caller = await makeCaller({ allowedRoutingProfileIds: ['power-instant'] });

    await withEdge(async (stub, post) => {
      const answer = await post('/v1/chat/completions', chat('high'), caller.token);
      expect(answer.status).toBe(403);
      expect(answer.body.error).toMatchObject({
        code: 'policy_violation',
        message: 'This application’s routing policy does not allow the routing profile "high".',
      });
      expect(stub.received).toHaveLength(0);
    });
  });

  it('serves an allowed level (positive control for the refusal above)', async () => {
    const instant = await publicRoute({ tag: 'ok' });
    await setPowerClass(instant.modelId, 'instant');
    const caller = await makeCaller({ allowedRoutingProfileIds: ['power-instant'] });
    await withEdge(async (stub, post) => {
      expect((await post('/v1/chat/completions', chat('instant'), caller.token)).status).toBe(200);
      expect(lines(stub.received[0])).toEqual([instant.modelId]);
    });
  });

  it('keeps auto inside the allowed levels', async () => {
    const instant = await publicRoute({ tag: 'ali' });
    const medium = await publicRoute({ tag: 'alm' });
    await setPowerClass(instant.modelId, 'instant');
    await setPowerClass(medium.modelId, 'medium');
    const caller = await makeCaller({ allowedRoutingProfileIds: ['power-auto', 'power-medium'] });
    await withEdge(async (stub, post) => {
      expect((await post('/v1/chat/completions', chat('auto'), caller.token)).status).toBe(200);
      expect(lines(stub.received[0])).toEqual([medium.modelId]);
    });
  });

  it('serves its default level when the request names no model', async () => {
    const instant = await publicRoute({ tag: 'dft' });
    await setPowerClass(instant.modelId, 'instant');
    const caller = await makeCaller({
      defaultTarget: { kind: 'routing_profile_id', routingProfileId: 'power-instant' },
      allowedRoutingProfileIds: ['power-instant'],
    });
    await withEdge(async (stub, post) => {
      const answer = await post(
        '/v1/responses',
        { input: 'Summarise this.', maxOutputTokens: 100 },
        caller.token,
      );
      expect(answer.status).toBe(200);
      expect(stub.received[0].target).toEqual({
        kind: 'routing_profile_id',
        routingProfileId: 'power-instant',
      });
      expect(lines(stub.received[0])).toEqual([instant.modelId]);
    });
  });
});

/* -------------------------------------------------------------------------- */
/*  Exact mode                                                                */
/* -------------------------------------------------------------------------- */

describe('an exact model request', () => {
  it('never signs another model, and fails over across its own deployments by default', async () => {
    const model = await publicRoute({ tag: 'exa', evidence: { priceScore: 900 } });
    const sibling = await publicRoute({
      tag: 'exb',
      sameModelAs: model,
      evidence: { priceScore: 100 },
    });
    const other = await publicRoute({ tag: 'exo' });
    await setPowerClass(model.modelId, 'instant');
    await setPowerClass(other.modelId, 'instant');
    // `sameModelDeployment` omitted: on by default since contract set 3.4.0.
    const caller = await makeCaller({
      fallback: { disabled: false, authorizedCrossModel: [] },
    });

    await withEdge(async (stub, post) => {
      expect((await post('/v1/chat/completions', chat(model.modelId), caller.token)).status).toBe(
        200,
      );
      const envelope = stub.received[0];
      expect(envelope.target).toEqual({
        kind: 'model',
        modelReference: `${model.modelId}@${model.revision}`,
      });
      expect(envelope.authorizedRoutes.map((route) => route.deploymentId)).toEqual([
        model.internalRouteId,
        sibling.internalRouteId,
      ]);
      expect(envelope.authorizedRoutes.every((route) => route.substitution === 'same_model')).toBe(
        true,
      );
    });
  });

  it('keeps one route when the policy opts out of same-model failover', async () => {
    const model = await publicRoute({ tag: 'opa', evidence: { priceScore: 900 } });
    await publicRoute({ tag: 'opb', sameModelAs: model, evidence: { priceScore: 100 } });
    const caller = await makeCaller({
      fallback: { disabled: false, sameModelDeployment: false, authorizedCrossModel: [] },
    });
    await withEdge(async (stub, post) => {
      expect((await post('/v1/chat/completions', chat(model.modelId), caller.token)).status).toBe(
        200,
      );
      expect(stub.received[0].authorizedRoutes.map((route) => route.deploymentId)).toEqual([
        model.internalRouteId,
      ]);
    });
  });
});
