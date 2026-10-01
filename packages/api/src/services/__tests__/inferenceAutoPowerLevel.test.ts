import {
  AUTO_CLASSIFIER_LIMITS,
  createAutoPowerLevelResolver,
  type AutoClassificationChild,
  type JevAutoClassifier,
} from '../inferenceAutoPowerLevel.service';
import { autoClassifierApproval } from '../../config/autoClassification';
import {
  AUTO_POWER_LEVELS,
  autoLadder,
  classifyAutoPowerLevel,
  type AutoPowerLevelContext,
  type AutoRoutingFeatures,
} from '../inferencePowerLevels.service';

const features: AutoRoutingFeatures = {
  toolCount: 0, estimatedInputTokens: 10, nonTextInput: false, structuredOutput: false,
};
const approved = { commercial: true, internalEligibility: true, privacy: true, zdr: true };
const modelReference = 'synthetic/jev@revision-1';

function fixture(overrides: Partial<JevAutoClassifier> = {}) {
  const parent = new AbortController();
  const state = jest.fn(() => 'Synthetic task: compare two puzzle solutions.');
  const context: AutoPowerLevelContext = { requestId: 'parent-id', signal: parent.signal, state };
  const execute = jest.fn(async (_child: AutoClassificationChild): Promise<unknown> => ({ level: 'high', confidence: 0.7 }));
  const resolver = createAutoPowerLevelResolver({
    modelReference, review: approved, admitAndExecute: execute, ...overrides,
  });
  return { parent, state, context, execute, resolver };
}

describe('bounded Jev Auto resolver', () => {
  afterEach(() => jest.useRealTimers());

  it('is dormant without an executor and does not even read the input', async () => {
    const f = fixture();
    const decision = await createAutoPowerLevelResolver()(features, f.context);
    expect(decision).toMatchObject({ level: 'instant', classification: { reason: 'disabled' } });
    expect(f.state).not.toHaveBeenCalled();
    expect(f.execute).not.toHaveBeenCalled();
    expect(autoClassifierApproval()).toBeUndefined();
  });

  it.each(['commercial', 'internalEligibility', 'privacy', 'zdr'] as const)(
    'requires affirmative %s review before exposing state', async (gate) => {
      const f = fixture({ review: { ...approved, [gate]: false } });
      expect(await f.resolver(features, f.context)).toMatchObject({ classification: { reason: 'disabled' } });
      expect(f.state).not.toHaveBeenCalled();
      expect(f.execute).not.toHaveBeenCalled();
    }
  );

  it.each(['auto', 'pro', 'synthetic/jev', 'synthetic/jev@', 'https://provider.test/jev@r1'])(
    'refuses unpinned or non-model child target %s', async (model) => {
      const f = fixture({ modelReference: model });
      expect(await f.resolver(features, f.context)).toMatchObject({ classification: { reason: 'invalid_model' } });
      expect(f.execute).not.toHaveBeenCalled();
      expect(f.state).not.toHaveBeenCalled();
    }
  );

  it('makes one separately identified pinned child with its own bounded budget', async () => {
    const f = fixture();
    const decision = await f.resolver(features, f.context);
    expect(decision).toEqual({
      level: 'high', reasons: [],
      classification: { source: 'jev', version: 'jev-auto-v1', modelReference, recommendedLevel: 'high', providerConfidence: 0.7 },
    });
    expect(f.execute).toHaveBeenCalledTimes(1);
    const child = f.execute.mock.calls[0][0];
    expect(child.requestId).not.toBe(f.context.requestId);
    expect(child).toMatchObject({
      parentRequestId: f.context.requestId,
      target: { kind: 'model', modelReference },
      levels: ['instant', 'medium', 'high', 'xhigh'],
      maxPricePerRequest: { currency: 'USD', amount: '0.001000000000' },
    });
    expect(child.signal).not.toBe(f.context.signal);
    expect(Object.isFrozen(child)).toBe(true);
    expect(Object.isFrozen(child.target)).toBe(true);
    expect(Object.isFrozen(child.levels)).toBe(true);
  });

  it('snapshots classifier model and review rather than observing later mutations', async () => {
    const config = { modelReference, review: { ...approved }, admitAndExecute: jest.fn(async () => ({ level: 'medium', confidence: 0.7 })) };
    const resolver = createAutoPowerLevelResolver(config);
    config.modelReference = 'auto';
    config.review.commercial = false;
    await resolver(features, fixture().context);
    expect(config.admitAndExecute).toHaveBeenCalledWith(expect.objectContaining({
      target: { kind: 'model', modelReference },
    }));
  });

  it('retains deterministic capability and explicit effort floors as separate signals', async () => {
    const f = fixture({ admitAndExecute: async () => ({ level: 'instant', confidence: 0.7 }) });
    const decision = await f.resolver({ ...features, requestedEffort: 'high', toolCount: 1 }, f.context);
    expect(decision).toMatchObject({
      level: 'xhigh', reasons: ['reasoning_effort_high->xhigh', 'tools->medium'],
      classification: { source: 'jev', recommendedLevel: 'instant' },
    });
  });

  it.each([undefined, null, 'high', { level: 'auto' }, { level: 'pro' }, { level: 'ultra' },
    { level: 'low' }, { level: 'HIGH' }, { level: ' high ' }, { level: 2 }, {},
    { level: 'high', reason: 'PRIVATE_PROVIDER_OUTPUT' }, { level: 'high' }, { level: 'high', confidence: 1.5 },
    { level: 'high', confidence: '0.7' }, { level: 'high', confidence: -0.1 }])('falls back on invalid result %j', async (value) => {
    const f = fixture({ admitAndExecute: async () => value });
    const decision = await f.resolver({ ...features, toolCount: 1 }, f.context);
    expect(decision).toMatchObject({ level: 'medium', classification: { reason: 'invalid_result' } });
    expect(JSON.stringify(decision)).not.toContain('PRIVATE_PROVIDER_OUTPUT');
  });

  it.each(AUTO_POWER_LEVELS)('accepts only the exact bounded level %s', async (level) => {
    const f = fixture({ admitAndExecute: async () => ({ level, confidence: 0.7 }) });
    expect((await f.resolver(features, f.context)).level).toBe(level);
  });

  it('uses the deterministic answer on a provider failure and never retries uncertain cost', async () => {
    const execute = jest.fn(async () => { throw new Error('PRIVATE_UPSTREAM_BODY'); });
    const f = fixture({ admitAndExecute: execute });
    const decision = await f.resolver(features, f.context);
    expect(decision).toMatchObject({ ...classifyAutoPowerLevel(features), classification: { reason: 'provider_error' } });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(decision)).not.toContain('PRIVATE_UPSTREAM_BODY');
  });

  it('also contains synchronous provider throws', async () => {
    const f = fixture({ admitAndExecute: () => { throw new Error('synthetic'); } });
    expect(await f.resolver(features, f.context)).toMatchObject({ classification: { reason: 'provider_error' } });
  });

  it('bounds UTF-8 bytes without sending a truncated task', async () => {
    const f = fixture();
    f.state.mockReturnValue('😀'.repeat(AUTO_CLASSIFIER_LIMITS.maxStateBytes / 4 + 1));
    expect(await f.resolver(features, f.context)).toMatchObject({ classification: { reason: 'input_limit' } });
    expect(f.execute).not.toHaveBeenCalled();
    f.state.mockReturnValue('x'.repeat(AUTO_CLASSIFIER_LIMITS.maxStateBytes));
    expect((await f.resolver(features, f.context)).level).toBe('high');
    expect(f.execute).toHaveBeenCalledTimes(1);
  });

  it('times out even when the child ignores abort and ignores its late answer', async () => {
    jest.useFakeTimers();
    let resolve!: (value: unknown) => void;
    const execute = jest.fn((_child: AutoClassificationChild) => new Promise((done) => { resolve = done; }));
    const f = fixture({ admitAndExecute: execute });
    const pending = f.resolver(features, f.context);
    await jest.advanceTimersByTimeAsync(AUTO_CLASSIFIER_LIMITS.timeoutMs);
    const decision = await pending;
    expect(decision).toMatchObject({ level: 'instant', classification: { reason: 'timeout' } });
    expect(execute.mock.calls[0][0].signal.aborted).toBe(true);
    expect(f.parent.signal.aborted).toBe(false);
    resolve({ level: 'xhigh', confidence: 0.7 });
    await Promise.resolve();
    expect(decision.level).toBe('instant');
    expect(execute).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('consumes a rejection arriving after timeout without retrying', async () => {
    jest.useFakeTimers();
    let reject!: (error: Error) => void;
    const execute = jest.fn(() => new Promise((_done, fail) => { reject = fail; }));
    const f = fixture({ admitAndExecute: execute });
    const pending = f.resolver(features, f.context);
    await jest.advanceTimersByTimeAsync(AUTO_CLASSIFIER_LIMITS.timeoutMs);
    await pending;
    reject(new Error('late private body'));
    await jest.advanceTimersByTimeAsync(1);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('propagates parent cancellation and cleans up its timer and listener', async () => {
    jest.useFakeTimers();
    const execute = jest.fn((_child: AutoClassificationChild) => new Promise(() => {}));
    const f = fixture({ admitAndExecute: execute });
    const remove = jest.spyOn(f.parent.signal, 'removeEventListener');
    const pending = f.resolver(features, f.context);
    await Promise.resolve();
    f.parent.abort();
    expect(await pending).toMatchObject({ classification: { reason: 'cancelled' } });
    expect(execute.mock.calls[0][0].signal.aborted).toBe(true);
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
    expect(jest.getTimerCount()).toBe(0);
  });

  it('does not launch a child after cancellation, including before its execution microtask', async () => {
    const f = fixture();
    const pending = f.resolver(features, f.context);
    f.parent.abort();
    await pending;
    await f.resolver(features, f.context);
    expect(f.execute).not.toHaveBeenCalled();
  });

  it('always applies application restrictions to semantic and fallback ladders', async () => {
    const f = fixture();
    const semantic = await f.resolver(features, f.context);
    expect(autoLadder(semantic.level, (level) => level === 'medium')).toEqual([]);
    const fallback = await createAutoPowerLevelResolver()(features, f.context);
    expect(autoLadder(fallback.level, (level) => level === 'medium')).toEqual(['medium']);
    expect(autoLadder(fallback.level, () => false)).toEqual([]);
  });

  it.each(['auto', 'pro', 'ultra', 'low', 'HIGH', '', undefined, null, {}, 3])(
    'rejects %j at the ladder boundary without consulting application permissions', (value) => {
      const allowed = jest.fn(() => true);
      expect(autoLadder(value, allowed)).toEqual([]);
      expect(allowed).not.toHaveBeenCalled();
    }
  );
});
