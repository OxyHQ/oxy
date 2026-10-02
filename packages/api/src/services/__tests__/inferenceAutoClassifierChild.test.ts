import * as config from '../../config/autoClassification';
import * as availability from '../../config/decisionAvailability';
import * as rollout from '../../config/rolloutFlags';
import * as catalogue from '../inferenceCatalogue.service';
import * as ledger from '../inferenceLedger.service';
import * as policies from '../inferenceRoutingPolicy.service';
import * as publication from '../kaanaDeploymentPublication.service';
import * as telemetry from '../inferenceTelemetry.service';
import * as metered from '../inferenceMeteredUsage.service';
import * as postgres from '../../config/postgres';
import * as powerLevels from '../inferencePowerLevels.service';
import * as childAdapter from '../inferenceAutoClassifierChild.service';
import { createJevAutoClassifier } from '../inferenceAutoClassifierChild.service';
import { AUTO_CLASSIFIER_LIMITS, createAutoPowerLevelResolver } from '../inferenceAutoPowerLevel.service';
import { admitRequest, PLATFORM_INTERNAL_DEFAULT_ROUTING_POLICY, type EdgeExecution, type EdgeExecutionContext } from '../inferenceEdge.service';

jest.mock('../../utils/logger', () => ({ logger: { info: jest.fn(), error: jest.fn(), warn: jest.fn() } }));

const modelReference = 'synthetic/jev@revision-1';
const policy: policies.EffectiveRoutingPolicyResolution = { status: 'none', applicationId: 'synthetic-app' };
const policyReference = PLATFORM_INTERNAL_DEFAULT_ROUTING_POLICY;
const approval: config.AutoClassifierApproval = {
  reviewId: 'synthetic-review', reviewVersion: 1,
  deploymentId: 'synthetic-deployment', modelReference, provider: 'synthetic', regions: ['test-region'],
  routingPolicy: policyReference,
  commercial: true, internalEligibility: true, privacy: true, zdr: true,
};
const features = { toolCount: 0, estimatedInputTokens: 10, nonTextInput: false, structuredOutput: false };

function parent(): EdgeExecutionContext {
  return {
    requestId: 'parent-1', receivedAt: performance.now(),
    principal: { ownerAccountId: 'synthetic-owner', applicationId: 'synthetic-app', credentialId: 'synthetic-credential',
      scopes: ['inference:invoke'], environment: 'development', applicationIsInternal: true, applicationType: 'internal' },
    request: { operation: { kind: 'completion' }, target: { kind: 'routing_profile_id', routingProfileId: 'power-auto' },
      input: { format: 'text', text: 'Synthetic puzzle' }, tools: [], sampling: {}, stream: false },
    signal: new AbortController().signal,
    endpoint: '/v1/responses', apiFormat: 'responses', delegatedUserId: 'synthetic-user',
    idempotencyKey: 'customer-key',
  } as EdgeExecutionContext;
}

function allowSyntheticChild(): void {
  jest.spyOn(config, 'autoClassifierApproval').mockReturnValue(approval);
  jest.spyOn(availability, 'decisionAvailability').mockReturnValue({ available: true, reason: 'synthetic only' });
}

function completed(context: EdgeExecutionContext, probabilities = [0, 0, 1, 0], reply = 'high'): EdgeExecution {
  return { status: 'completed', completion: {
    requestId: context.requestId, resolvedModelReference: modelReference,
    decisions: [{ id: 'auto-power-level', kind: 'choice', reply, confidence: 0.61, probabilities }],
    output: [], units: {}, servingProvider: 'synthetic', finishReason: 'stop', latencyMs: 1,
    routingPolicy: { routingPolicyId: 'synthetic-policy', policyVersion: 1 },
  } };
}

afterEach(() => { jest.restoreAllMocks(); jest.useRealTimers(); });

it('has no production adapter even with an authenticated parent', () => {
  expect(createJevAutoClassifier(parent(), policy, jest.fn(), policyReference)).toBeUndefined();
});

it('requires both decisions and Auto reviews, and an explicitly pinned model', () => {
  allowSyntheticChild();
  const execute = jest.fn();
  jest.spyOn(availability, 'decisionAvailability').mockReturnValue({ available: false, reason: 'closed' });
  expect(createJevAutoClassifier(parent(), policy, execute, policyReference)).toBeUndefined();
  jest.spyOn(availability, 'decisionAvailability').mockReturnValue({ available: true, reason: 'fixture' });
  jest.spyOn(config, 'autoClassifierApproval').mockReturnValueOnce({ ...approval, internalEligibility: false } as unknown as config.AutoClassifierApproval);
  expect(createJevAutoClassifier(parent(), policy, execute, policyReference)).toBeUndefined();
  jest.spyOn(config, 'autoClassifierApproval').mockReturnValue(undefined);
  expect(createJevAutoClassifier(parent(), policy, execute, policyReference)).toBeUndefined();
  expect(execute).not.toHaveBeenCalled();
});

it('uses one typed child with inherited identity, pinned policy and separate idempotency/budget', async () => {
  allowSyntheticChild();
  const p = parent();
  const execute = jest.fn(async (context: EdgeExecutionContext) => completed(context));
  const resolver = createAutoPowerLevelResolver(createJevAutoClassifier(p, policy, execute, policyReference));
  expect((await resolver(features, { requestId: p.requestId, signal: p.signal, state: () => 'Synthetic puzzle' })).level).toBe('high');
  expect(execute).toHaveBeenCalledTimes(1);
  const child = execute.mock.calls[0][0];
  expect(child.principal).toBe(p.principal);
  expect(child.autoClassificationChild?.policy).toBe(policy);
  expect(child.autoClassificationChild?.maxPricePerRequest).toEqual(AUTO_CLASSIFIER_LIMITS.maxPricePerRequest);
  expect(child.idempotencyKey).toBe(p.idempotencyKey);
  expect(child.delegatedUserId).toBe(p.delegatedUserId);
  expect(child.request.target).toEqual({ kind: 'model', modelReference });
  expect(child.request.input).toMatchObject({ format: 'decisions', decisions: {
    questions: [{ id: 'auto-power-level', kind: 'choice', options: ['instant', 'medium', 'high', 'xhigh'] }],
  } });
  // Kaana's systemone adapter refuses ANY decisions effort; none is ever sent.
  if (child.request.input.format !== 'decisions') throw new Error('Missing typed decisions');
  expect(child.request.input.decisions).not.toHaveProperty('effort');
  expect(child.request.reasoning).toBeUndefined();
  expect(child.request.maxOutputTokens).toBeUndefined();
  expect(child.request.tools).toEqual([]);
  expect(child.request.sampling).toEqual({});
  expect(createJevAutoClassifier(child, policy, execute, policyReference)).toBeUndefined();
});

it.each([
  [[0.5, 0.5, 0, 0], 'medium'], [[0.5, 0.5, 0, 0], 'instant'], [[0.1, 0.4, 0.4, 0.1], 'high'], [[0, 0, 0, 1], 'xhigh'],
] as const)('uses the provider reply, ties included, never a reconstruction: %j -> %s', async (probabilities, reply) => {
  allowSyntheticChild();
  const p = parent();
  const execute = async (context: EdgeExecutionContext) => completed(context, [...probabilities], reply);
  const resolver = createAutoPowerLevelResolver(createJevAutoClassifier(p, policy, execute, policyReference));
  const result = await resolver(features, { requestId: p.requestId, signal: p.signal, state: () => 'fixture' });
  expect(result).toMatchObject({ level: reply,
    classification: { source: 'jev', recommendedLevel: reply, providerConfidence: 0.61 } });
});

it.each(['id', 'cardinality', 'sum', 'model', 'requestId', 'reply-not-max', 'reply-pro', 'reply-auto', 'no-reply', 'no-confidence'])(
  'falls back without retrying malformed child %s', async (fault) => {
    allowSyntheticChild();
    const p = parent();
    const execute = jest.fn(async (context: EdgeExecutionContext) => {
      const result = completed(context);
      if (result.status !== 'completed') throw new Error('fixture');
      const completion = result.completion;
      return { ...result, completion: { ...completion,
        ...(fault === 'model' ? { resolvedModelReference: 'synthetic/other@revision-1' } : {}),
        ...(fault === 'requestId' ? { requestId: 'foreign-request' } : {}),
        decisions: [{ id: fault === 'id' ? 'foreign-question' : 'auto-power-level', kind: 'choice' as const,
          ...(fault === 'no-reply' ? {} : { reply: fault === 'reply-not-max' ? 'instant'
            : fault === 'reply-pro' ? 'pro' : fault === 'reply-auto' ? 'auto' : 'high' }),
          ...(fault === 'no-confidence' ? {} : { confidence: 0.61 }),
          probabilities: fault === 'cardinality' ? [1, 0] : fault === 'sum' ? [1, 1, 0, 0] : [0, 0, 1, 0] }],
      } };
    });
    const result = await createAutoPowerLevelResolver(createJevAutoClassifier(p, policy, execute, policyReference))(
      features, { requestId: p.requestId, signal: p.signal, state: () => 'fixture' }
    );
    expect(result).toMatchObject({ level: 'instant', classification: { reason: 'provider_error' } });
    expect(execute).toHaveBeenCalledTimes(1);
  }
);

/** Real admission with synthetic catalogue/ledger boundaries; no database/provider calls. */
async function admissionFixture() {
  allowSyntheticChild();
  jest.spyOn(rollout, 'isChargingAuthorized').mockReturnValue(true);
  jest.spyOn(ledger, 'previewReservation').mockResolvedValue({ status: 'eligible' });
  jest.spyOn(catalogue, 'resolveCatalogueViewer').mockReturnValue({ scopes: ['platform_internal'] } as catalogue.CatalogueViewer);
  const readPolicy = jest.spyOn(policies, 'resolveEffectiveRoutingPolicy');
  jest.spyOn(telemetry, 'recordInferenceUsage').mockResolvedValue(undefined);
  jest.spyOn(publication, 'currentDeploymentLiveness').mockResolvedValue({ status: 'not-configured' });
  const route = {
    deploymentId: 'synthetic-deployment', modelReference, provider: 'synthetic', regions: ['test-region'],
    priceVersionId: 'synthetic-price', maxContextTokens: 100_000, maxOutputTokens: 10,
    fundingPriority: 4, routingScore: 100, reasoning: false, availabilityScope: 'platform_internal',
    inputModalities: ['text'], outputModalities: ['text'],
    reasoningEfforts: [], acceptedParameters: null, apiFormats: ['decisions'],
  } satisfies catalogue.EdgeRoute;
  const resolve = jest.spyOn(catalogue, 'resolveEdgeRoute').mockResolvedValue({ status: 'resolved', route, alternates: [] });
  // Decisions are admitted only on a route publishing output_tokens at exactly zero.
  const outputPrice = jest.spyOn(ledger, 'publishedUnitPrice').mockResolvedValue('zero');
  const quote = jest.spyOn(ledger, 'quoteUnits').mockResolvedValue({ status: 'quoted', amount: '0.000500000000', currency: 'USD' });
  const reserve = jest.spyOn(ledger, 'reserve').mockResolvedValue({ status: 'reserved', reservation: {} } as Awaited<ReturnType<typeof ledger.reserve>>);
  // The durable usage claim (#1526) is a database boundary like the ledger's.
  jest.spyOn(metered, 'claimMeteredAdmission').mockResolvedValue({ status: 'claimed', meteredUsageId: 'synthetic-metered' });
  jest.spyOn(metered, 'markMeteredAdmissionRefused').mockResolvedValue(undefined);
  const limit = jest.fn(async () => []);
  jest.spyOn(postgres, 'getDb').mockReturnValue({ select: () => ({ from: () => ({ where: () => ({ limit }) }) }) } as unknown as ReturnType<typeof postgres.getDb>);
  const p = parent();
  const attest = jest.fn(async (_ids: readonly string[]): Promise<{ snapshotId: string; deployments: catalogue.EdgeRoute[] }> =>
    ({ snapshotId: 'fixture', deployments: [route] }));
  const execute = jest.fn(async (context: EdgeExecutionContext) => completed(context));
  const withKaana = { ...p, kaanaClient: { attestDeployments: attest } } as unknown as EdgeExecutionContext;
  await createAutoPowerLevelResolver(createJevAutoClassifier(withKaana, policy, execute, policyReference))(
    features, { requestId: p.requestId, signal: p.signal, state: () => 'fixture' }
  );
  return { context: execute.mock.calls[0][0], route, resolve, quote, reserve, readPolicy, attest, limit, outputPrice };
}

it('admits a child once under the pinned policy with an independent capped hold', async () => {
  const f = await admissionFixture();
  // Two eligible deployments still authorize exactly one child attempt.
  f.resolve.mockResolvedValue({ status: 'resolved', route: f.route,
    alternates: [{ ...f.route, deploymentId: 'synthetic-secondary' }],
  });
  const admitted = await admitRequest(f.context);
  expect(admitted.status).toBe('admitted');
  if (admitted.status !== 'admitted') throw new Error('Expected admission');
  expect(admitted.admitted.authorizedRoutes).toHaveLength(1);
  expect(f.readPolicy).not.toHaveBeenCalled();
  expect(f.reserve).toHaveBeenCalledTimes(1);
  expect(f.reserve.mock.calls[0][0]).toMatchObject({ maxAmount: '0.000500000000', attribution: { requestId: f.context.requestId } });
  expect(f.reserve.mock.calls[0][0].idempotencyKey).toMatch(/^oxy-edge:auto:/);
  expect(f.resolve.mock.calls[0][3]).toMatchObject({ requiresDeclaredApiFormat: true, apiFormat: 'decisions' });
});

it('rejects a child over its independent price ceiling before a hold or attestation', async () => {
  const f = await admissionFixture();
  f.quote.mockResolvedValue({ status: 'quoted', amount: '0.002000000000', currency: 'USD' });
  expect(await admitRequest(f.context)).toMatchObject({ status: 'refused', error: { code: 'policy_violation' } });
  expect(f.reserve).not.toHaveBeenCalled();
  expect(f.attest).not.toHaveBeenCalled();
});

it.each(['positive', 'missing'] as const)('refuses a child whose route publishes a %s output price before a hold or attestation', async (price) => {
  const f = await admissionFixture();
  f.outputPrice.mockResolvedValue(price);
  expect(await admitRequest(f.context)).toMatchObject({ status: 'refused' });
  expect(f.outputPrice).toHaveBeenCalledWith(f.route.priceVersionId, 'output_tokens');
  expect(f.reserve).not.toHaveBeenCalled();
  expect(f.attest).not.toHaveBeenCalled();
});

it('refuses an existing or raced child reservation without executing or settling it again', async () => {
  const f = await admissionFixture();
  f.limit.mockResolvedValueOnce([{ id: 'prior' }] as never);
  expect(await admitRequest(f.context)).toMatchObject({ status: 'refused', error: { code: 'idempotency_conflict' } });
  expect(f.reserve).not.toHaveBeenCalled();
  f.reserve.mockResolvedValue({ status: 'already-reserved', reservation: {} } as Awaited<ReturnType<typeof ledger.reserve>>);
  expect(await admitRequest(f.context)).toMatchObject({ status: 'refused', error: { code: 'idempotency_conflict' } });
  expect(f.reserve).toHaveBeenCalledTimes(1);
});

it('still requires invocation scope, exact route attestation and cancellation before reservation', async () => {
  const f = await admissionFixture();
  expect(await admitRequest({ ...f.context, principal: { ...f.context.principal, scopes: [] } })).toMatchObject({
    status: 'refused', error: { code: 'insufficient_scope' },
  });
  expect(f.resolve).not.toHaveBeenCalled();
  f.attest.mockResolvedValueOnce({ snapshotId: 'fixture', deployments: [] });
  expect(await admitRequest(f.context)).toMatchObject({ status: 'refused', error: { code: 'service_unavailable' } });
  const controller = new AbortController();
  controller.abort();
  expect(await admitRequest({ ...f.context, signal: controller.signal })).toMatchObject({ status: 'refused', error: { code: 'cancelled' } });
  expect(f.reserve).not.toHaveBeenCalled();
});

it('rejects Auto-to-Auto recursion at admission even if a malformed internal adapter requests it', async () => {
  const f = await admissionFixture();
  expect(await admitRequest({ ...f.context, request: { ...f.context.request,
    target: { kind: 'routing_profile_id', routingProfileId: 'power-auto' },
  } })).toMatchObject({ status: 'refused', error: { code: 'policy_violation' } });
  expect(f.resolve).not.toHaveBeenCalled();
  expect(f.reserve).not.toHaveBeenCalled();
});

it.each(['lower-app-cap', 'foreign-currency'])('retains application budget controls: %s', async (mode) => {
  const f = await admissionFixture();
  const pinned = { status: 'resolved', source: 'application', stored: {
    versionId: 'immutable-version', policy: { routingPolicyId: 'app-policy', policyVersion: 7,
      optimiseFor: 'price', fallback: { disabled: true }, },
  } } as unknown as policies.EffectiveRoutingPolicyResolution;
  const constraints = { ...catalogue.UNCONSTRAINED_ROUTING,
    requireZeroDataRetention: true, prohibitTrainingOnCustomerData: true,
    providerAllowlist: ['synthetic'], allowedRegions: ['test-region'],
    maxPricePerRequest: { currency: mode === 'foreign-currency' ? 'EUR' : 'USD', amount: '0.000100000000' },
  };
  jest.spyOn(catalogue, 'routingConstraintsOf').mockReturnValue(constraints as ReturnType<typeof catalogue.routingConstraintsOf>);
  if (f.context.autoClassificationChild === undefined) throw new Error('Missing synthetic child');
  const reviewed = { ...approval, routingPolicy: { routingPolicyId: 'app-policy', policyVersion: 7 } };
  jest.spyOn(config, 'autoClassifierApproval').mockReturnValue(reviewed);
  const context = { ...f.context, autoClassificationChild: { ...f.context.autoClassificationChild, policy: pinned, approval: reviewed } };
  expect(await admitRequest(context)).toMatchObject({ status: 'refused', error: { code: 'policy_violation' } });
  if (mode === 'lower-app-cap') expect(f.resolve.mock.calls[0][2]).toMatchObject({
    requireZeroDataRetention: true, prohibitTrainingOnCustomerData: true,
    providerAllowlist: ['synthetic'], allowedRegions: ['test-region'],
  });
  expect(f.reserve).not.toHaveBeenCalled();
  expect(f.readPolicy).not.toHaveBeenCalled();
});

it.each(['timeout', 'provider-error'])('fallback after %s still runs final admission and reserves generation once', async (failure) => {
  const f = await admissionFixture();
  jest.useFakeTimers();
  f.readPolicy.mockResolvedValue(policy);
  jest.spyOn(catalogue, 'resolveRoutingProfileForEdgeById').mockResolvedValue({
    status: 'power-level', routingProfileId: 'power-auto', powerLevel: 'auto', slug: 'auto', optimiseFor: 'price',
  });
  jest.spyOn(powerLevels, 'powerLevelProfileIds').mockResolvedValue(new Map([
    ['instant', 'power-instant'], ['medium', 'power-medium'], ['high', 'power-high'], ['xhigh', 'power-xhigh'],
  ]));
  jest.spyOn(powerLevels, 'powerLevelEfforts').mockResolvedValue(new Map());
  // A strictly higher viable level (high) is what lets the child run at all.
  const high = { ...f.route, deploymentId: 'synthetic-high', modelReference: 'synthetic/high@revision-1' };
  f.resolve.mockImplementation(async (_viewer, reference) =>
    ({ status: 'resolved', route: reference === high.modelReference ? high : f.route, alternates: [] }));
  f.attest.mockImplementation(async (ids: readonly string[]) =>
    ({ snapshotId: 'fixture', deployments: ids.map((id) => id === high.deploymentId ? high : f.route) }));
  const candidates = jest.spyOn(catalogue, 'powerLevelCandidates').mockResolvedValue([
    { modelReference, priority: 0, level: 'instant' }, { modelReference: high.modelReference, priority: 2, level: 'high' },
  ]);
  const execute = jest.fn((): Promise<unknown> => failure === 'timeout'
    ? new Promise(() => {}) : Promise.reject(new Error('Synthetic provider error')));
  jest.spyOn(childAdapter, 'createJevAutoClassifier').mockReturnValue({
    modelReference, review: { commercial: true, internalEligibility: true, privacy: true, zdr: true },
    admitAndExecute: execute,
  });
  const context = { ...parent(), kaanaClient: f.context.kaanaClient };
  const pending = admitRequest(context);
  await jest.advanceTimersByTimeAsync(AUTO_CLASSIFIER_LIMITS.timeoutMs);
  expect((await pending).status).toBe('admitted');
  expect(execute).toHaveBeenCalledTimes(1);
  expect(candidates).toHaveBeenCalledWith(expect.anything(), ['instant', 'medium', 'high', 'xhigh']);
  expect(f.attest).toHaveBeenCalledTimes(2);
  expect(f.reserve).toHaveBeenCalledTimes(1);
  expect(f.reserve.mock.calls[0][0].attribution.requestId).toBe(context.requestId);
  expect(f.reserve.mock.calls[0][0].idempotencyKey).toMatch(/^oxy-edge:idem:/);
});
