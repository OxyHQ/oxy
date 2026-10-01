/** Real PostgreSQL policy/ledger and signed Kaana client; all model replies are synthetic. */
import { createHash, generateKeyPairSync, randomUUID, verify } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { inferenceRequestSchema, type InferenceRequest } from '@oxy.so/contracts';
import { connectPostgres, closePostgres, getDb } from '../../config/postgres';
import * as autoConfig from '../../config/autoClassification';
import * as decisionsConfig from '../../config/decisionAvailability';
import { KAANA_BASE_URL_VARIABLE, KAANA_SIGNING_KEY_ID_VARIABLE, KAANA_SIGNING_PRIVATE_KEY_VARIABLE } from '../../config/kaanaDataPlane';
import { applications, applicationCredentials, users, inferenceModels, inferenceDeployments,
  usageReservations, usageReceipts, accountBalances, spendingLimits, inferenceUsageEvents } from '../../db/schema';
import { clearPowerClassesForTest, insertCatalogueRoute, setPowerClass } from '../../db/testServableEvidence';
import { createNeutralRoutingPolicy, attestFixtureDeployments } from '../../routes/__fixtures__/kaanaRuntimeFixtures';
import { EDGE_ROLLOUT_ENVIRONMENT } from '../../routes/__fixtures__/kaanaAudioFixtures';
import { generateMachineCredentialToken } from '../../utils/machineCredentialToken';
import { createHttpKaanaClient, KAANA_DEPLOYMENTS_QUERY_PATH } from '../httpKaanaClient';
import { authenticateEdgeCaller, executeInferenceRequest, type EdgeExecutionContext } from '../inferenceEdge.service';
import * as ledger from '../inferenceLedger.service';
import { provisionBillingProfile, recordTopUp } from '../inferenceLedger.service';
import { resolveEffectiveRoutingPolicy, type RoutingPolicyControls } from '../inferenceRoutingPolicy.service';
import * as childAdapter from '../inferenceAutoClassifierChild.service';
import { logger } from '../../utils/logger';

jest.mock('../../utils/logger', () => ({ logger: { info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() } }));
jest.setTimeout(30_000);
const keys = generateKeyPairSync('ed25519');
const env = { ...EDGE_ROLLOUT_ENVIRONMENT,
  [KAANA_BASE_URL_VARIABLE]: 'https://kaana.ai', [KAANA_SIGNING_KEY_ID_VARIABLE]: 'synthetic-auto',
  [KAANA_SIGNING_PRIVATE_KEY_VARIABLE]: keys.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
};
const previous = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
beforeAll(async () => { Object.assign(process.env, env); await connectPostgres(); });
afterAll(async () => {
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  await closePostgres();
});
beforeEach(async () => { await clearPowerClassesForTest(); jest.clearAllMocks(); });
afterEach(() => jest.restoreAllMocks());

async function fixture(controls: Partial<RoutingPolicyControls> = {}, options: { higher?: boolean; childOutputPerMillion?: string } = {}) {
  const db = getDb();
  const tag = randomUUID().slice(0, 8);
  const [owner] = await db.insert(users).values({ username: `autoj-${tag}`, email: `${tag}@example.test` }).returning();
  const scopes = ['inference:invoke', 'inference:usage:read'];
  const [app] = await db.insert(applications).values({ name: `Auto ${tag}`, ownerAccountId: owner.id, scopes }).returning();
  const key = generateMachineCredentialToken();
  await db.insert(applicationCredentials).values({ applicationId: app.id, name: 'synthetic',
    publicKey: `oxy_dk_${tag}`, tokenPrefix: key.tokenPrefix, tokenHash: key.tokenHash,
    type: 'machine', environment: 'development', scopes, status: 'active' });
  await createNeutralRoutingPolicy({ accountId: owner.id, applicationId: app.id, overrides: { optimiseFor: 'price', ...controls } });
  await provisionBillingProfile({ accountId: owner.id });
  await recordTopUp({ idempotencyKey: `synthetic-topup-${tag}`, accountId: owner.id, currency: 'USD', amount: '1.000000000000', actor: { kind: 'machine' } });
  const parent = await insertCatalogueRoute({ tag: 'auto-parent', availabilityScope: 'public_payg' });
  await setPowerClass(parent.modelId, 'instant');
  // A strictly higher viable level is what makes a semantic child worth running.
  const higher = options.higher === false ? undefined : await insertCatalogueRoute({ tag: 'auto-high', availabilityScope: 'public_payg' });
  if (higher !== undefined) await setPowerClass(higher.modelId, 'high');
  const child = await insertCatalogueRoute({ tag: 'auto-child', availabilityScope: 'public_payg', evidence: { inputPerMillion: '0.01', outputPerMillion: options.childOutputPerMillion ?? '0' } });
  await db.update(inferenceModels).set({ apiFormats: ['decisions'] }).where(eq(inferenceModels.id, child.modelRowId));
  const policy = await resolveEffectiveRoutingPolicy(app.id);
  if (policy.status !== 'resolved') throw new Error('Missing synthetic policy');
  const approval: autoConfig.AutoClassifierApproval = {
    reviewId: `synthetic-${tag}`, reviewVersion: 1, deploymentId: child.internalRouteId,
    modelReference: `${child.modelId}@${child.revision}`, provider: child.providerSlug, regions: [],
    routingPolicy: { routingPolicyId: policy.stored.policy.routingPolicyId, policyVersion: policy.stored.policy.policyVersion },
    commercial: true, internalEligibility: true, privacy: true, zdr: true,
  };
  const review = jest.spyOn(autoConfig, 'autoClassifierApproval').mockReturnValue(approval);
  jest.spyOn(decisionsConfig, 'decisionAvailability').mockReturnValue({ available: true, reason: 'synthetic-only' });
  const authentication = await authenticateEdgeCaller({ headers: { authorization: `Bearer ${key.token}` } });
  if (!authentication.ok) throw new Error('Synthetic authentication failed');
  const kaanaClient = createHttpKaanaClient();
  if (!kaanaClient) throw new Error('Missing synthetic signed client');
  const controller = new AbortController();
  const context: EdgeExecutionContext = {
    requestId: randomUUID(), receivedAt: performance.now(), principal: authentication.principal,
    request: { operation: { kind: 'completion' }, target: { kind: 'routing_profile_id', routingProfileId: 'power-auto' },
      input: { format: 'text', text: 'SYNTHETIC_PRIVATE_TASK_MARKER' }, stream: false, sampling: {}, tools: [], maxOutputTokens: 100 },
    signal: controller.signal, idempotencyKey: `parent-${tag}`, apiFormat: 'responses', endpoint: '/v1/responses', kaanaClient,
  };
  const parents = higher === undefined ? [parent] : [parent, higher];
  return { app, owner, parent, higher, parents, child, approval, review, context, controller };
}

function stub() {
  const state = {
    children: [] as InferenceRequest[], childBodies: [] as Record<string, unknown>[], generations: [] as InferenceRequest[], attested: [] as string[][],
    mode: 'success' as 'success' | 'timeout' | 'error', aborted: 0,
    onChild: undefined as (() => void | Promise<void>) | undefined,
    childReply: 'instant', childProbabilities: [1, 0, 0, 0],
  };
  jest.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    const destination = new URL(String(url));
    expect(destination.origin).toBe('https://kaana.ai');
    if (!init) throw new Error('Missing signed body');
    const bytes = init.body as Buffer;
    const headers = new Headers(init.headers);
    const signed = Buffer.from(`oxy-kaana-envelope:v1\nsynthetic-auto\n${headers.get('X-Oxy-Kaana-Timestamp')}\n${createHash('sha256').update(bytes).digest('hex')}`);
    expect(verify(null, signed, keys.publicKey, Buffer.from((headers.get('X-Oxy-Kaana-Signature') ?? '').slice(3), 'base64'))).toBe(true);
    const body = JSON.parse(bytes.toString());
    if (destination.pathname === KAANA_DEPLOYMENTS_QUERY_PATH) {
      state.attested.push(body.deploymentIds);
      return new Response(JSON.stringify(await attestFixtureDeployments(body.deploymentIds)), { headers: { 'cache-control': 'no-store' } });
    }
    const envelope = body as InferenceRequest;
    const route = envelope.authorizedRoutes[0];
    const requestId = envelope.attribution.requestId;
    const now = new Date().toISOString();
    const usage = { schemaVersion: 2, requestId, attribution: envelope.attribution, outcome: 'completed',
      units: [{ unit: 'requests', quantity: 1 }, { unit: 'input_tokens', quantity: 10 }], usageSource: 'provider_reported',
      resolvedModelReference: route.modelReference, servingProvider: route.provider, deploymentId: route.deploymentId,
      routeSwitches: 0, startedAt: now, completedAt: now };
    if (destination.pathname === '/internal/v1/decisions') {
      state.children.push(envelope);
      state.childBodies.push(body);
      await state.onChild?.();
      if (state.mode === 'error') return new Response(JSON.stringify({ code: 'provider_error' }), { status: 503 });
      if (state.mode === 'timeout') return new Promise((_resolve, reject) => {
        const abort = () => { state.aborted += 1; reject(new DOMException('Synthetic cancellation', 'AbortError')); };
        if (init.signal?.aborted) abort(); else init.signal?.addEventListener('abort', abort, { once: true });
      });
      // Kaana reports the output tokens a classification really emitted (observed: 4);
      // the child's route publishes them at an exact zero price.
      const childUsage = { ...usage, units: [...usage.units, { unit: 'output_tokens', quantity: 4 }] };
      return new Response(JSON.stringify({ schemaVersion: 1, requestId, model: route.modelReference,
        data: [{ id: 'auto-power-level', kind: 'choice', reply: state.childReply, confidence: 0.83, probabilities: state.childProbabilities }], usage: childUsage }));
    }
    expect(destination.pathname).toBe('/internal/v1/inference');
    state.generations.push(envelope);
    const frame = (name: string, value: unknown) => `event: ${name}\ndata: ${JSON.stringify(value)}\n\n`;
    return new Response(frame('stream_event', { schemaVersion: 1, requestId, sequence: 0, type: 'delta', outputIndex: 0, channel: 'output_text', text: 'Synthetic answer' })
      + frame('stream_event', { schemaVersion: 1, requestId, sequence: 1, type: 'done', finishReason: 'stop', completedAt: now })
      + frame('usage_report', { ...usage, units: [...usage.units, { unit: 'output_tokens', quantity: 3 }] }),
    { headers: { 'content-type': 'text/event-stream' } });
  });
  return state;
}

async function receipts(applicationId: string, count: number) {
  const deadline = Date.now() + 3000;
  for (;;) {
    const rows = await getDb().select().from(usageReceipts).where(eq(usageReceipts.applicationId, applicationId));
    if (rows.length === count || Date.now() >= deadline) return rows;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
async function holds(applicationId: string) {
  return getDb().select().from(usageReservations).where(eq(usageReservations.applicationId, applicationId));
}

it('qualifies and attests the parent before one exact child; settles two distinct holds', async () => {
  const f = await fixture(); const s = stub();
  s.onChild = () => { expect(s.attested[0]).toContain(f.parent.internalRouteId); };
  expect((await executeInferenceRequest(f.context)).status).toBe('completed');
  expect(s.children).toHaveLength(1); expect(s.generations).toHaveLength(1);
  expect(s.children[0].authorizedRoutes.map((r) => r.deploymentId)).toEqual([f.child.internalRouteId]);
  expect(s.children[0].routingPolicy).toEqual(f.approval.routingPolicy);
  expect(s.generations[0].routingPolicy).toEqual(f.approval.routingPolicy);
  expect(s.generations[0].authorizedRoutes[0].deploymentId).toBe(f.parent.internalRouteId);
  const rows = await receipts(f.app.id, 2);
  expect(rows).toHaveLength(2);
  expect(new Set(rows.map((row) => row.requestId)).size).toBe(2);
  // The child's 4 reported output tokens are kept on its receipt and price to zero:
  // the exact charge is requests + input only, within the input-only hold.
  const childReceipt = rows.find((row) => row.requestId === s.children[0].attribution.requestId);
  expect(childReceipt).toMatchObject({ outputTokens: 4, inputTokens: 10, requests: 1 });
  const childHold = (await holds(f.app.id)).find((row) => row.requestId === s.children[0].attribution.requestId);
  expect(childHold?.outputTokens).toBe(0);
  expect(Number(childReceipt?.billedAmount)).toBeLessThanOrEqual(Number(childHold?.reservedAmount));
  expect((await holds(f.app.id)).map((row) => row.status)).toEqual(['settled', 'settled']);
  const [balance] = await getDb().select().from(accountBalances).where(eq(accountBalances.accountId, f.owner.id));
  expect(Number(balance.reservedBalance)).toBe(0);
  expect(Number(balance.purchasedBalance)).toBeLessThan(1);
  const logged = JSON.stringify([jest.mocked(logger.info).mock.calls, jest.mocked(logger.error).mock.calls, jest.mocked(logger.warn).mock.calls]);
  expect(logged).toContain(f.context.requestId);
  expect(logged).not.toContain('SYNTHETIC_PRIVATE_TASK_MARKER');
});

it('Auto+instant with a medium tool floor makes zero classifier calls and reservations', async () => {
  const f = await fixture({ allowedRoutingProfileIds: ['power-auto', 'power-instant'] }); const s = stub();
  const factory = jest.spyOn(childAdapter, 'createJevAutoClassifier');
  const context = { ...f.context, request: { ...f.context.request, tools: [{ type: 'function' as const, name: 'lookup', parameters: { type: 'object' as const, properties: {} } }] } };
  expect((await executeInferenceRequest(context)).status).toBe('refused');
  expect(factory).not.toHaveBeenCalled(); expect(s.children).toHaveLength(0);
  expect(await holds(f.app.id)).toHaveLength(0);
});

it.each(['privacy', 'permission', 'capability', 'scope', 'price', 'app-budget', 'account-budget', 'account-funds'])(
  'parent %s denial exposes no task and spends nothing on classification', async (gate) => {
    const f = await fixture(gate === 'privacy' ? { requireZeroDataRetention: true }
      : gate === 'price' ? { maxPricePerRequest: { currency: 'USD', amount: '0.000000000001' } as RoutingPolicyControls['maxPricePerRequest'] } : {});
    const s = stub(); const db = getDb();
    let context = f.context;
    for (const route of f.parents) {
      if (gate === 'privacy') await db.update(inferenceDeployments).set({ zeroDataRetentionAvailable: false }).where(eq(inferenceDeployments.internalRouteId, route.internalRouteId));
      if (gate === 'permission') await db.update(inferenceDeployments).set({ permissionState: 'pending_review' }).where(eq(inferenceDeployments.internalRouteId, route.internalRouteId));
      if (gate === 'capability') await db.update(inferenceModels).set({ apiFormats: ['chat_completions'] }).where(eq(inferenceModels.id, route.modelRowId));
    }
    if (gate === 'scope') context = { ...context, principal: { ...context.principal, scopes: [] } };
    if (gate === 'account-budget') await db.insert(spendingLimits).values({ accountId: f.owner.id, scope: 'account', scopeAccountId: f.owner.id,
      period: 'total', currency: 'USD', limitAmount: '0.000000000001', enforcement: 'hard_stop', alertThresholdBps: [] });
    if (gate === 'account-funds') await db.update(accountBalances).set({ purchasedBalance: '0' }).where(eq(accountBalances.accountId, f.owner.id));
    if (gate === 'app-budget') await db.insert(spendingLimits).values({ accountId: f.owner.id, scope: 'application', scopeApplicationId: f.app.id,
      period: 'total', currency: 'USD', limitAmount: '0.000000000001', enforcement: 'hard_stop', alertThresholdBps: [] });
    expect((await executeInferenceRequest(context)).status).toBe('refused');
    expect(s.children).toHaveLength(0); expect(s.generations).toHaveLength(0); expect(await holds(f.app.id)).toHaveLength(0);
  }
);

it('a higher ranked unreviewed deployment cannot inherit exact approval', async () => {
  const f = await fixture(); const s = stub();
  const replacement = await insertCatalogueRoute({ tag: 'replacement', sameModelAs: f.child, availabilityScope: 'public_payg', evidence: { priceScore: 900, inputPerMillion: '0.01', outputPerMillion: '0' } });
  expect((await executeInferenceRequest(f.context)).status).toBe('completed');
  expect(s.children[0].authorizedRoutes.map((r) => r.deploymentId)).toEqual([f.child.internalRouteId]);
  expect(s.children[0].authorizedRoutes.map((r) => r.deploymentId)).not.toContain(replacement.internalRouteId);
});

it.each(['removed', 'model', 'review-version', 'policy-version'])('fails closed for changed approval binding: %s', async (change) => {
  const f = await fixture(); const s = stub();
  if (change === 'removed') await getDb().update(inferenceDeployments).set({ status: 'retired' }).where(eq(inferenceDeployments.internalRouteId, f.child.internalRouteId));
  if (change === 'model') f.review.mockReturnValue({ ...f.approval, modelReference: `${f.parent.modelId}@${f.parent.revision}` });
  if (change === 'policy-version') f.review.mockReturnValue({ ...f.approval, routingPolicy: { ...f.approval.routingPolicy, policyVersion: 999 } });
  if (change === 'review-version') f.review.mockReturnValueOnce(f.approval).mockReturnValue({ ...f.approval, reviewVersion: 2 });
  expect((await executeInferenceRequest(f.context)).status).toBe('completed');
  expect(s.children).toHaveLength(0); expect(await holds(f.app.id)).toHaveLength(1);
});

it('replayed completed parent cannot charge a child that had no original reservation', async () => {
  const f = await fixture(); const s = stub();
  f.review.mockReturnValue(undefined);
  expect((await executeInferenceRequest(f.context)).status).toBe('completed');
  expect(s.children).toHaveLength(0); expect(await holds(f.app.id)).toHaveLength(1);
  f.review.mockReturnValue(f.approval);
  const factory = jest.spyOn(childAdapter, 'createJevAutoClassifier');
  const replayId = randomUUID();
  const replay = await executeInferenceRequest({ ...f.context, requestId: replayId });
  // The public replay shape is unchanged from before Auto: message and param included.
  expect(replay).toMatchObject({ status: 'refused', error: REPLAY_ERROR });
  expect(factory).not.toHaveBeenCalled(); expect(s.children).toHaveLength(0); expect(await holds(f.app.id)).toHaveLength(1);
  expect(refusalsFor(replayId, 'inference.edge.refused')).toHaveLength(1);
  expect(JSON.stringify(jest.mocked(logger.warn).mock.calls)).not.toContain('SYNTHETIC_PRIVATE_TASK_MARKER');
});

const REPLAY_ERROR = {
  code: 'idempotency_conflict',
  message: 'This Idempotency-Key has already been used. Responses are not retained, so it cannot be replayed.',
  param: 'Idempotency-Key',
};
function refusalsFor(requestId: string, event: string) {
  return jest.mocked(logger.warn).mock.calls.filter((call) =>
    call[0] === event && (call[1] as { requestId?: string } | undefined)?.requestId === requestId);
}
async function usageEventsFor(requestId: string) {
  return getDb().select().from(inferenceUsageEvents).where(eq(inferenceUsageEvents.requestId, requestId));
}

/**
 * A competing request takes the parent's key in the real ledger at the last moment,
 * so the atomic lock-then-lookup decides: before the spending preview (no child may
 * run) or before the final reserve (after the child).
 */
it.each(['preview', 'reserve'] as const)('a key raced before the %s refuses with the unchanged shape, recorded once', async (stage) => {
  const f = await fixture(); const s = stub();
  const realReserve = ledger.reserve;
  const realPreview = ledger.previewReservation;
  let planted = false;
  const plant = async (input: ledger.ReserveInput) => {
    if (planted || !input.idempotencyKey.startsWith('oxy-edge:idem:')) return;
    planted = true;
    const competitor = await realReserve({ ...input, attribution: { ...input.attribution, requestId: randomUUID() } });
    expect(competitor.status).toBe('reserved');
  };
  if (stage === 'preview') {
    jest.spyOn(ledger, 'previewReservation').mockImplementation(async (input) => { await plant(input); return realPreview(input); });
  } else {
    jest.spyOn(ledger, 'reserve').mockImplementation(async (input) => { await plant(input); return realReserve(input); });
  }
  const result = await executeInferenceRequest(f.context);
  expect(planted).toBe(true);
  expect(result).toMatchObject({ status: 'refused', error: REPLAY_ERROR });
  expect(s.generations).toHaveLength(0);
  expect(s.children).toHaveLength(stage === 'preview' ? 0 : 1);
  // Only the competitor's parent hold, plus the child's own settled hold after it ran.
  const rows = await holds(f.app.id);
  expect(rows.filter((row) => row.requestId === f.context.requestId)).toHaveLength(0);
  expect(rows).toHaveLength(stage === 'preview' ? 1 : 2);
  const events = await usageEventsFor(f.context.requestId);
  expect(events).toHaveLength(1);
  expect(events[0].statusCode).toBe(409);
  const warned = refusalsFor(f.context.requestId, 'inference.edge.reservation_refused');
  expect(warned).toHaveLength(1);
  expect(warned[0][1]).toMatchObject({ code: 'idempotency_conflict', reservationStatus: 'already-reserved' });
  expect(JSON.stringify([jest.mocked(logger.warn).mock.calls, jest.mocked(logger.info).mock.calls, events]))
    .not.toContain('SYNTHETIC_PRIVATE_TASK_MARKER');
});

it.each(['inert', 'classified'] as const)('logs the Auto ladder at routing time, classification only when semantic (%s)', async (mode) => {
  const f = await fixture(); const s = stub();
  if (mode === 'inert') f.review.mockReturnValue(undefined); else { s.childReply = 'high'; s.childProbabilities = [0, 0, 1, 0]; }
  expect((await executeInferenceRequest(f.context)).status).toBe('completed');
  const logged = jest.mocked(logger.info).mock.calls
    .filter((call) => call[0] === 'inference.edge.auto_power_level' && (call[1] as { requestId?: string }).requestId === f.context.requestId)
    .map((call) => call[1] as Record<string, unknown>);
  // The pre-Auto event, unchanged when inert; a semantic pass adds one more.
  expect(logged).toHaveLength(mode === 'inert' ? 1 : 2);
  expect(logged[0]).toMatchObject({ decided: 'instant', ladder: ['instant', 'medium', 'high', 'xhigh'] });
  expect(logged[0].classification).toBeUndefined();
  if (mode === 'classified') expect(logged[1]).toMatchObject({ decided: 'high', ladder: ['high', 'xhigh'],
    classification: { source: 'jev', recommendedLevel: 'high', providerConfidence: 0.83 } });
  expect(JSON.stringify(logged)).not.toContain('SYNTHETIC_PRIVATE_TASK_MARKER');
});

it.each(['timeout', 'error'] as const)('child %s settles its own hold, then fallback settles generation once', async (mode) => {
  const f = await fixture(); const s = stub(); s.mode = mode;
  expect((await executeInferenceRequest(f.context)).status).toBe('completed');
  expect(s.children).toHaveLength(1); expect(s.generations).toHaveLength(1);
  const rows = await receipts(f.app.id, 2); expect(rows).toHaveLength(2);
  const childReceipt = rows.find((row) => row.requestId === s.children[0].attribution.requestId);
  expect(Number(childReceipt?.billedAmount)).toBe(0);
  expect((await holds(f.app.id)).every((row) => row.status === 'settled')).toBe(true);
  if (mode === 'timeout') expect(s.aborted).toBe(1);
});

it('parent cancellation aborts the signed child, settles its hold and never reserves generation', async () => {
  const f = await fixture(); const s = stub(); s.mode = 'timeout';
  s.onChild = () => { f.controller.abort(); };
  expect(await executeInferenceRequest(f.context)).toMatchObject({ status: 'refused', error: { code: 'cancelled' } });
  expect(await receipts(f.app.id, 1)).toHaveLength(1);
  expect(s.aborted).toBe(1); expect(s.generations).toHaveLength(0);
  expect((await holds(f.app.id)).map((row) => row.status)).toEqual(['settled']);
});

it('concurrent parent attempts execute at most one child and one generation against atomic holds', async () => {
  const f = await fixture(); const s = stub();
  const results = await Promise.all([executeInferenceRequest(f.context), executeInferenceRequest({ ...f.context, requestId: randomUUID() })]);
  expect(results.filter((result) => result.status === 'completed')).toHaveLength(1);
  expect(s.children).toHaveLength(1); expect(s.generations).toHaveLength(1);
  expect(await receipts(f.app.id, 2)).toHaveLength(2); expect(await holds(f.app.id)).toHaveLength(2);
});

it('does not bypass newly revoked parent permission after a successful child', async () => {
  const f = await fixture(); const s = stub();
  s.onChild = async () => {
    for (const route of f.parents) await getDb().update(inferenceDeployments).set({ permissionState: 'pending_review' }).where(eq(inferenceDeployments.internalRouteId, route.internalRouteId));
  };
  expect((await executeInferenceRequest(f.context)).status).toBe('refused');
  expect(s.children).toHaveLength(1); expect(s.generations).toHaveLength(0); expect(await receipts(f.app.id, 1)).toHaveLength(1);
});

it('runs no child when no strictly higher level is viable for the parent', async () => {
  const f = await fixture({}, { higher: false }); const s = stub();
  const factory = jest.spyOn(childAdapter, 'createJevAutoClassifier');
  expect((await executeInferenceRequest(f.context)).status).toBe('completed');
  expect(factory).not.toHaveBeenCalled(); expect(s.children).toHaveLength(0); expect(s.generations).toHaveLength(1);
  expect(await holds(f.app.id)).toHaveLength(1);
});

it('a tied provider reply of high routes the generation to the high level', async () => {
  const f = await fixture(); const s = stub();
  s.childReply = 'high'; s.childProbabilities = [0, 0.5, 0.5, 0];
  expect((await executeInferenceRequest(f.context)).status).toBe('completed');
  expect(s.children).toHaveLength(1);
  expect(s.generations[0].authorizedRoutes.map((r) => r.deploymentId)).toEqual([f.higher?.internalRouteId]);
  expect(await receipts(f.app.id, 2)).toHaveLength(2);
});

it('a semantic level with no viable route keeps the deterministic floor instead of refusing', async () => {
  const f = await fixture(); const s = stub();
  s.childReply = 'xhigh'; s.childProbabilities = [0, 0, 0, 1];
  expect((await executeInferenceRequest(f.context)).status).toBe('completed');
  expect(s.children).toHaveLength(1);
  expect(s.generations[0].authorizedRoutes[0].deploymentId).toBe(f.parent.internalRouteId);
  expect(JSON.stringify(jest.mocked(logger.info).mock.calls)).toContain('not_viable');
  expect(await receipts(f.app.id, 2)).toHaveLength(2);
});

/**
 * The exact signed bytes, checked against the Oxy contract AND the rules Kaana's
 * Go side enforces before translation (contract.ValidateDecisionsEnvelope and the
 * systemone adapter, whose fixture carries a nil Effort and refuses any effort).
 */
it('signs a child envelope that the Oxy contract and the Kaana decisions guard both accept', async () => {
  const f = await fixture(); const s = stub();
  expect((await executeInferenceRequest(f.context)).status).toBe('completed');
  expect(s.childBodies).toHaveLength(1);
  const body = s.childBodies[0];
  const parsed = inferenceRequestSchema.safeParse(body);
  if (!parsed.success) throw new Error(`Oxy contract refused the child: ${parsed.error.message}`);
  const wire = parsed.data;
  expect(wire.client.apiFormat).toBe('decisions');
  expect(wire.modality).toBe('text');
  expect(wire.stream).toBe(false);
  expect(wire.target).toEqual({ kind: 'model', modelReference: f.approval.modelReference });
  for (const field of ['maxOutputTokens', 'toolChoice', 'responseFormat', 'reasoning', 'speech', 'audioOutput']) {
    expect(body).not.toHaveProperty(field);
  }
  expect(wire.tools).toEqual([]);
  expect(Object.keys(wire.sampling)).toEqual([]);
  if (wire.input.format !== 'decisions') throw new Error('Missing typed decisions');
  const rawDecisions = (body.input as { decisions: Record<string, unknown> }).decisions;
  expect(Object.keys(rawDecisions).sort()).toEqual(['instructions', 'questions', 'state']);
  expect(rawDecisions).not.toHaveProperty('effort');
  expect(wire.input.decisions.questions).toEqual([expect.objectContaining({
    id: 'auto-power-level', kind: 'choice', options: ['instant', 'medium', 'high', 'xhigh'],
  })]);
  expect(wire.authorizedRoutes).toEqual([expect.objectContaining({
    deploymentId: f.child.internalRouteId, modelReference: f.approval.modelReference, substitution: 'same_model',
  })]);
});

it.each(['0.000001', undefined])('a child route publishing output price %s never executes and reserves nothing', async (price) => {
  const f = await fixture({}, { childOutputPerMillion: price ?? '0' }); const s = stub();
  if (price === undefined) {
    // A missing output price is as unquoted as a positive one.
    await getDb().execute(sql`delete from price_version_unit_prices where unit = 'output_tokens'
      and price_version_id in (select price_version_id from inference_deployments where internal_route_id = ${f.child.internalRouteId})`);
  }
  expect((await executeInferenceRequest(f.context)).status).toBe('completed');
  expect(s.children).toHaveLength(0); expect(s.generations).toHaveLength(1);
  expect(await holds(f.app.id)).toHaveLength(1);
});
