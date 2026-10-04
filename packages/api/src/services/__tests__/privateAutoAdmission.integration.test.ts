/** Real SQL admission and signed HTTP transport; only source authority and provider replies are synthetic. */
import { createHash, generateKeyPairSync, randomUUID, verify } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { privateAutoSourceApprovalSchema, privateAutoInferenceRequestSchema, privateAutoOperationId,
  type PrivateAutoSourceApproval, type PrivateAutoInferenceRequest, type InferenceRequest } from '@oxy.so/contracts';
import { privateAutoApprovalFixture } from '../../../../contracts/src/__tests__/privateAutoExecution.fixture';
import { connectPostgres, closePostgres, getDb } from '../../config/postgres';
import * as privateConfig from '../../config/privateAutoClassification';
import * as economicConfig from '../../config/inferenceEconomicPolicy';
import * as autoConfig from '../../config/autoClassification';
import * as decisionsConfig from '../../config/decisionAvailability';
import { KAANA_BASE_URL_VARIABLE, KAANA_SIGNING_KEY_ID_VARIABLE, KAANA_SIGNING_PRIVATE_KEY_VARIABLE } from '../../config/kaanaDataPlane';
import { applications, applicationCredentials, users, inferenceModels, inferenceDeployments,
  inferenceMeteredUsage, usageReservations, usageReceipts } from '../../db/schema';
import { clearPowerClassesForTest, insertCatalogueRoute, setPowerClass } from '../../db/testServableEvidence';
import { createNeutralRoutingPolicy, attestFixtureDeployments } from '../../routes/__fixtures__/kaanaRuntimeFixtures';
import { EDGE_ROLLOUT_ENVIRONMENT } from '../../routes/__fixtures__/kaanaAudioFixtures';
import { generateMachineCredentialToken } from '../../utils/machineCredentialToken';
import { createHttpKaanaClient, KAANA_DEPLOYMENTS_QUERY_PATH } from '../httpKaanaClient';
import { executeInferenceRequest, type EdgeExecutionContext } from '../inferenceEdge.service';
import { resolveEffectiveRoutingPolicy } from '../inferenceRoutingPolicy.service';
import * as childAdapter from '../inferenceAutoClassifierChild.service';
import { readPrivateAutoChildRecovery } from '../privateAutoExecution.service';

jest.mock('../../utils/logger', () => ({ logger: { info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() } }));
jest.setTimeout(30_000);
const keys = generateKeyPairSync('ed25519');
const env = { ...EDGE_ROLLOUT_ENVIRONMENT,
  [KAANA_BASE_URL_VARIABLE]: 'https://kaana.ai', [KAANA_SIGNING_KEY_ID_VARIABLE]: 'synthetic-auto',
  [KAANA_SIGNING_PRIVATE_KEY_VARIABLE]: keys.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
};
const previous = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
beforeAll(async () => { Object.assign(process.env, env); await connectPostgres(); });
afterAll(async () => {
  for (const [key,value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  await closePostgres();
});
beforeEach(async () => { await clearPowerClassesForTest(); jest.clearAllMocks(); });
afterEach(() => jest.restoreAllMocks());

async function fixture() {
  const db = getDb(); const tag = randomUUID().slice(0,8);
  const [owner] = await db.insert(users).values({ username: `pauto-${tag}`, email: `${tag}@example.test` }).returning();
  const scopes = ['inference:invoke', 'inference:usage:read'];
  const [app] = await db.insert(applications).values({ name: `Synthetic private ${tag}`, ownerAccountId: owner.id, scopes }).returning();
  const key = generateMachineCredentialToken();
  const [credential] = await db.insert(applicationCredentials).values({ applicationId: app.id, name: 'synthetic SQL lineage',
    publicKey: `oxy_dk_${tag}`, tokenPrefix: key.tokenPrefix, tokenHash: key.tokenHash,
    type: 'machine', environment: 'production', scopes, status: 'active' }).returning();
  await createNeutralRoutingPolicy({ accountId: owner.id, applicationId: app.id, overrides: { optimiseFor: 'price' } });
  const parent = await insertCatalogueRoute({ tag: 'private-parent', availabilityScope: 'platform_internal' });
  const higher = await insertCatalogueRoute({ tag: 'private-high', availabilityScope: 'platform_internal' });
  await setPowerClass(parent.modelId, 'instant'); await setPowerClass(higher.modelId, 'high');
  const child = await insertCatalogueRoute({ tag: 'private-child', availabilityScope: 'platform_internal', evidence: { inputPerMillion: '0.01', outputPerMillion: '0' } });
  await db.update(inferenceModels).set({ apiFormats: ['decisions'], outputModalities: ['decisions'], commercialUseAllowed: false }).where(eq(inferenceModels.id,child.modelRowId));
  const [childRow] = await db.select().from(inferenceDeployments).where(eq(inferenceDeployments.internalRouteId,child.internalRouteId));
  if (!childRow?.priceVersionId) throw new Error('Synthetic child price missing');
  const policy = await resolveEffectiveRoutingPolicy(app.id);
  if (policy.status !== 'resolved') throw new Error('Synthetic policy missing');
  const approval = privateAutoSourceApprovalSchema.parse({ ...privateAutoApprovalFixture,
    principal: { accountId: owner.id, applicationId: app.id, credentialId: credential.id, environment: 'production', lane: 'service_token' },
    policy: { routingPolicyId: policy.stored.policy.routingPolicyId, policyVersion: policy.stored.policy.policyVersion },
    deploymentId: child.internalRouteId, modelReference: `${child.modelId}@${child.revision}`, provider: child.providerSlug,
    priceVersionId: childRow.priceVersionId,
  });
  await db.update(inferenceDeployments).set({ privateAutoSourceApproval: approval, permissionState: 'pending_review', status: 'disabled',
    autoApprovalPolicyId: null, legalReviewStatus: 'approved', legalReviewEvidenceRef: approval.review.legalReviewEvidenceRef,
    legalReviewedAt: new Date(), retainsPayloads: false, retentionDays: 0, trainsOnCustomerData: false, zeroDataRetentionAvailable: true,
  }).where(eq(inferenceDeployments.id,childRow.id));
  const review = jest.spyOn(privateConfig, 'privateAutoClassifierSourceApproval').mockReturnValue(approval);
  jest.spyOn(autoConfig,'autoClassifierApproval').mockReturnValue(undefined);
  jest.spyOn(decisionsConfig,'decisionAvailability').mockReturnValue({ available:false, reason:'synthetic public decisions remain unavailable' });
  jest.spyOn(economicConfig,'resolveEconomicTreatment').mockReturnValue({ treatment:'internal_metered', policyVersion:approval.economicPolicyVersion,
    relationship: { relationshipId:approval.economicRelationshipId, consumerApplicationId:app.id, consumerProduct:'synthetic-alia',providerProduct:'kaana',
      environments:['production'],lane:'service_token',capacity:{maxConcurrentRequests:4,maxRequestsPerUtcDay:100},
      pilot:{maxControlledInputBudget:8192,maxOutputTokens:100,maxPricePerRequestUsd:'0.01',deployments:[parent,higher].map(row => ({deploymentId:row.internalRouteId,modelReference:`${row.modelId}@${row.revision}`,provider:row.providerSlug}))} } });
  const kaanaClient = createHttpKaanaClient(); if (!kaanaClient) throw new Error('Synthetic signed client missing');
  const context: EdgeExecutionContext = { requestId:randomUUID(),receivedAt:performance.now(),
    principal:{lane:'service_token',ownerAccountId:owner.id,applicationId:app.id,credentialId:credential.id,environment:'production',scopes,
      applicationType:'internal',applicationIsInternal:true},
    request:{operation:{kind:'completion'},target:{kind:'routing_profile_id',routingProfileId:'power-auto'},
      input:{format:'text',text:'SYNTHETIC_FIRST_TASK'},stream:false,sampling:{},tools:[],maxOutputTokens:100},
    signal:new AbortController().signal,idempotencyKey:`private-parent-${tag}`,apiFormat:'responses',endpoint:'/v1/responses',kaanaClient };
  const childResults: unknown[] = [];
  const childContexts: EdgeExecutionContext[] = [];
  const createChild = childAdapter.createPrivateJevAutoClassifier;
  jest.spyOn(childAdapter, 'createPrivateJevAutoClassifier').mockImplementation((parent, effective, execute, routing, meter) =>
    createChild(parent, effective, async childContext => { childContexts.push(childContext); const result = await execute(childContext); childResults.push(result.status === 'refused' ? result : result.status); return result; }, routing, meter));
  return {app,approval,review,context,childResults,childContexts,parent,higher};
}

function stub(approval: PrivateAutoSourceApproval) {
  const state = {
    children: [] as PrivateAutoInferenceRequest[], childBodies: [] as Record<string, unknown>[], generations: [] as InferenceRequest[], attested: [] as string[][],
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
      const evidence = await attestFixtureDeployments(body.deploymentIds);
      return new Response(JSON.stringify({ ...evidence,
        ...(body.privateAutoExecutionContractVersion === '3.7.0' ? { privateAutoExecutionContractVersion: '3.7.0' } : {}),
        deployments: evidence.deployments.map(row => row.deploymentId !== approval.deploymentId ? row : {
          ...row, privateAutoSourceApproval: approval, keyId: approval.keyId, upstreamModelId: approval.upstreamModelId,
          providerRateCardVersionId: approval.providerRateCardVersionId, providerSourceVersion: approval.providerSourceVersion,
        }),
      }), { headers: { 'cache-control': 'no-store' } });
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
      state.children.push(privateAutoInferenceRequestSchema.parse(body));
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


async function meters(appId:string) {
  return getDb().select().from(inferenceMeteredUsage).where(eq(inferenceMeteredUsage.applicationId,appId));
}

it('uses two distinct real parent admissions for two variable texts with signed schema4 children and no monetary holds', async () => {
  const f = await fixture(); const s = stub(f.approval);
  const contexts = [f.context, { ...f.context,requestId:randomUUID(),idempotencyKey:`${f.context.idempotencyKey}-two`,
    request:{ ...f.context.request,input:{format:'text' as const,text:'SYNTHETIC_SECOND_TASK'} } }];
  for (const context of contexts) expect(await executeInferenceRequest(context)).toMatchObject({status:'completed'});
  expect(f.childResults).toEqual(['completed','completed']);
  expect(s.children).toHaveLength(2); expect(s.generations).toHaveLength(2);
  const rows = await meters(f.app.id); expect(rows).toHaveLength(4);
  const parentRows = rows.filter(row => row.parentRequestId === null); expect(parentRows).toHaveLength(2);
  for (const envelope of s.children) {
    const parent = parentRows.find(row => row.id === envelope.privateAutoExecution.parentMeteredUsageId);
    expect(parent).toBeDefined(); if (!parent) throw new Error('Actual SQL parent missing');
    expect(envelope.schemaVersion).toBe(4);
    expect(envelope.privateAutoExecution.operationId).toBe(privateAutoOperationId(parent.id));
    expect(envelope.attribution.requestId).toBe(privateAutoOperationId(parent.id));
    expect(envelope.privateAutoExecution.parentRequestId).toBe(parent.requestId);
    expect(envelope.attribution.userId).toBeUndefined();
  }
  expect(new Set(s.children.map(row => row.privateAutoExecution.inputSha256)).size).toBe(2);
  expect(await getDb().select().from(usageReservations).where(eq(usageReservations.applicationId,f.app.id))).toEqual([]);
  expect(await getDb().select().from(usageReceipts).where(eq(usageReceipts.applicationId,f.app.id))).toEqual([]);
});

it('recovers only known own child lineage after settlement and source-off; changed input/approval never dispatches again', async () => {
  const f = await fixture(); const s = stub(f.approval);
  expect(await executeInferenceRequest(f.context)).toMatchObject({status:'completed'});
  expect(f.childResults).toEqual(['completed']);
  expect(s.children).toHaveLength(1);
  const envelope = s.children[0]; const operation = envelope.privateAutoExecution;
  const binding = {parentMeteredUsageId:operation.parentMeteredUsageId,parentRequestId:operation.parentRequestId,
    requestId:operation.operationId,principal:f.context.principal,policy:f.approval.policy,input:envelope.input,
    deadlineAt:Date.now()-1,signal:new AbortController().signal};
  f.review.mockReturnValue(undefined);
  expect(await readPrivateAutoChildRecovery(binding)).toMatchObject({requestId:operation.operationId,newAdmissionAuthorized:false});
  expect(await readPrivateAutoChildRecovery({...binding,principal:{...binding.principal,credentialId:'foreign'}})).toBeUndefined();
  expect(await readPrivateAutoChildRecovery({...binding,principal:{...binding.principal,scopes:['inference:invoke']}})).toBeUndefined();
  const before = s.children.length+s.generations.length;
  const childContext = f.childContexts[0];
  if (!childContext?.privateAutoChild || childContext.request.input.format !== 'decisions') throw new Error('Actual private child context missing');
  const replayInput = { ...childContext.request.input, decisions: { ...childContext.request.input.decisions, state:'CHANGED_CHILD_TEXT' } };
  f.review.mockReturnValue(f.approval);
  expect((await executeInferenceRequest({ ...childContext, request:{ ...childContext.request,input:replayInput } })).status).toBe('refused');
  const changedApproval = { ...f.approval, approvalVersion:2 };
  f.review.mockReturnValue(changedApproval);
  expect((await executeInferenceRequest({ ...childContext, privateAutoChild:{ ...childContext.privateAutoChild,approval:changedApproval } })).status).toBe('refused');
  expect((await executeInferenceRequest({...f.context,request:{...f.context.request,input:{format:'text',text:'CHANGED_INPUT'}}})).status).toBe('refused');
  f.review.mockReturnValue({...f.approval,approvalVersion:2});
  expect((await executeInferenceRequest(f.context)).status).toBe('refused');
  expect(s.children.length+s.generations.length).toBe(before);
  expect(await meters(f.app.id)).toHaveLength(2);
});


it('a valid high recommendation requalifies the original parent onto the available exact high route', async () => {
  const f = await fixture(); const s = stub(f.approval);
  s.childReply = 'high'; s.childProbabilities = [0,0,1,0];
  expect(await executeInferenceRequest(f.context)).toMatchObject({status:'completed'});
  expect(f.childResults).toEqual(['completed']);
  expect(s.children).toHaveLength(1); expect(s.generations).toHaveLength(1);
  expect(s.generations[0].authorizedRoutes[0].deploymentId).toBe(f.higher.internalRouteId);
  expect(s.attested.filter(ids => ids.includes(f.higher.internalRouteId)).length).toBeGreaterThanOrEqual(2);
  const rows = await meters(f.app.id); expect(rows).toHaveLength(2);
  expect(rows.every(row => row.status === 'settled')).toBe(true);
});

it('a child timeout keeps the deterministic parent with one child POST and no open capacity or monetary hold', async () => {
  const f = await fixture(); const s = stub(f.approval); s.mode = 'timeout';
  expect(await executeInferenceRequest(f.context)).toMatchObject({status:'completed'});
  expect(s.children).toHaveLength(1); expect(s.generations).toHaveLength(1); expect(s.aborted).toBe(1);
  expect(s.generations[0].authorizedRoutes[0].deploymentId).toBe(f.parent.internalRouteId);
  const deadline = Date.now()+3000;
  let rows = await meters(f.app.id);
  while (rows.some(row => row.status === 'admitted') && Date.now()<deadline) {
    await new Promise(resolve => setTimeout(resolve,10)); rows = await meters(f.app.id);
  }
  expect(rows).toHaveLength(2);
  expect(rows.every(row => row.status === 'settled' || row.status === 'refused')).toBe(true);
  const child = rows.find(row => row.parentRequestId === f.context.requestId);
  expect(child?.outcome).not.toBe('completed');
  expect(await getDb().select().from(usageReservations).where(eq(usageReservations.applicationId,f.app.id))).toEqual([]);
  expect(s.children).toHaveLength(1);
});
