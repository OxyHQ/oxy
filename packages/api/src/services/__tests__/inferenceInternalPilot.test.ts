import type { ScopedExecutionAudience } from '@oxy.so/contracts';
import { hashScopedInput } from '../scopedExecution.service';
import {
  controlledInputBudget,
  fundedByPromotionalCredit,
  pilotAllowsDeployment,
  pilotTermsFor,
  promotionalLaneLevels,
} from '../inferenceInternalPilot';
import { INTERNAL_METERED_RELATIONSHIPS } from '../../config/inferenceEconomicPolicy';
import {
  KAANA_SPEECH_CATALOGUE,
  KAANA_SPEECH_DEPLOYMENT_ID,
  KAANA_SPEECH_MAX_INPUT_CHARACTERS,
  KAANA_SPEECH_MODEL_REFERENCE,
  KAANA_SPEECH_PROVIDER_SLUG,
} from '../../config/kaanaInitialCatalogue';
import {
  type EdgeOperation,
  type NormalizedEdgeRequest,
  normalizeSpeechRequest,
  speechRequestSchema,
} from '../../schemas/inferenceEdge.schemas';

const COMPLETION: EdgeOperation = { kind: 'completion' };

const request = (text: string): NormalizedEdgeRequest => ({
  operation: { kind: 'completion' },
  input: { format: 'text', text },
  stream: false,
  tools: [],
  sampling: {},
});

it('counts Unicode UTF-8 and every controlled schema or tool-call field', () => {
  const plain = controlledInputBudget(request('abc'));
  expect(controlledInputBudget(request('\u0800\u0800\u0800'))).toBe((plain ?? 0) + 6);
  expect(
    controlledInputBudget({
      ...request('abc'),
      responseFormat: {
        type: 'json_schema',
        name: 'result',
        schema: { description: 'x'.repeat(9000) },
        strict: true,
      },
    }),
  ).toBeGreaterThan(8192);
  expect(
    controlledInputBudget({
      ...request('abc'),
      tools: [{ type: 'function', name: 'lookup', parameters: { description: 'x'.repeat(9000) } }],
    }),
  ).toBeGreaterThan(8192);
  expect(
    controlledInputBudget({
      ...request(''),
      input: {
        format: 'messages',
        messages: [
          {
            role: 'assistant',
            content: [],
            toolCalls: [{ id: 'call', name: 'lookup', arguments: 'x'.repeat(9000) }],
          },
        ],
      },
    }),
  ).toBeGreaterThan(8192);
});

it('accounts for explicit overhead at the 8192 boundary', () => {
  const empty = controlledInputBudget(request(''));
  if (empty === undefined) throw new Error('Text budget missing');
  expect(empty).toBeGreaterThanOrEqual(288);
  expect(controlledInputBudget(request('x'.repeat(8192 - empty)))).toBe(8192);
  expect(controlledInputBudget(request('x'.repeat(8193 - empty)))).toBe(8193);
});

it('refuses modalities and operations whose pilot input is not supported', () => {
  expect(
    controlledInputBudget({ ...request(''), operation: { kind: 'embeddings', embeddings: 1 } }),
  ).toBeUndefined();
  expect(
    controlledInputBudget({
      ...request(''),
      input: {
        format: 'messages',
        messages: [
          {
            role: 'user',
            content: [
              { type: 'image', source: { kind: 'url', url: 'https://example.test/image.png' } },
            ],
          },
        ],
      },
    }),
  ).toBeUndefined();
});

it('requires the exact deployment, model revision and provider tuple', () => {
  const pilot = INTERNAL_METERED_RELATIONSHIPS[0].pilot;
  if (pilot === undefined) throw new Error('Production pilot missing');
  for (const route of pilot.deployments) {
    expect(pilotAllowsDeployment(pilot, COMPLETION, route)).toBe(true);
    expect(pilotAllowsDeployment(pilot, COMPLETION, { ...route, deploymentId: 'other' })).toBe(
      false,
    );
    expect(
      pilotAllowsDeployment(pilot, COMPLETION, {
        ...route,
        modelReference: 'openai/gpt-oss-120b@other',
      }),
    ).toBe(false);
    expect(pilotAllowsDeployment(pilot, COMPLETION, { ...route, provider: 'other' })).toBe(false);
  }
});

describe('promotional-credit lane (ADR 0037)', () => {
  const pilot = INTERNAL_METERED_RELATIONSHIPS[0].pilot;
  if (pilot === undefined) throw new Error('Production pilot missing');
  const everyLevel = () => true;

  it('covers only the named Pro and Ultra levels, each with the XHigh fallback', () => {
    expect(promotionalLaneLevels(pilot, 'pro', everyLevel)).toEqual(['pro', 'xhigh']);
    expect(promotionalLaneLevels(pilot, 'ultra', everyLevel)).toEqual(['ultra', 'xhigh']);
    for (const level of ['instant', 'medium', 'high', 'xhigh'] as const) {
      expect(promotionalLaneLevels(pilot, level, everyLevel)).toBeUndefined();
    }
  });

  it('drops a fallback level the application policy does not allow', () => {
    expect(promotionalLaneLevels(pilot, 'pro', (level) => level !== 'xhigh')).toEqual(['pro']);
  });

  it('is absent without a lane, including for a caller with no pilot', () => {
    const { promotionalCredit: _lane, ...withoutLane } = pilot;
    expect(promotionalLaneLevels(withoutLane, 'pro', everyLevel)).toBeUndefined();
    expect(promotionalLaneLevels(undefined, 'ultra', everyLevel)).toBeUndefined();
  });

  it('admits by available promotional funding only, never by standard, discounted or free funding', () => {
    expect(fundedByPromotionalCredit({ fundingPriority: 3 })).toBe(true);
    expect(fundedByPromotionalCredit({ fundingPriority: 4 })).toBe(false);
    expect(fundedByPromotionalCredit({ fundingPriority: 2 })).toBe(false);
    expect(fundedByPromotionalCredit({ fundingPriority: 1 })).toBe(false);
  });

  it('keeps the promotional quote ceiling an exact USD decimal', () => {
    expect(pilot.promotionalCredit?.maxPricePerRequestUsd).toMatch(/^\d+\.\d+$/);
  });
});

describe('scoped decisions pilot budget', () => {
  const input = {
    format: 'decisions' as const,
    decisions: {
      effort: 'instant' as const,
      state: 'Synthetic red square',
      questions: [{ id: 'color', kind: 'noul' as const, question: 'Is it red?' }],
    },
  };
  const scopedRequest: NormalizedEdgeRequest = {
    operation: { kind: 'decisions' },
    input,
    stream: false,
    tools: [],
    sampling: {},
    target: { kind: 'model', modelReference: 'typesafe/jev@fixture' },
  };
  const permit: ScopedExecutionAudience = {
    permitId: 'fixture',
    idempotencyKey: 'fixture',
    fixtureSha256: hashScopedInput(input),
    expiresAt: '2099-01-01T00:00:00.000Z',
    principal: {
      accountId: 'fixture',
      applicationId: 'fixture',
      credentialId: 'fixture',
      environment: 'production',
    },
    policy: { routingPolicyId: 'fixture', policyVersion: 1 },
    deploymentId: 'fixture',
    provider: 'openrouter',
    keyId: 'fixture',
    modelReference: 'typesafe/jev@fixture',
    upstreamModelId: 'fixture',
    priceVersionId: 'fixture',
    providerRateCardVersionId: 'fixture',
    providerSourceVersion: 'fixture',
    maxCostUsd: '0.01',
  };
  it('refuses unpermitted decisions, expired permits and input/model changes', () => {
    expect(controlledInputBudget(scopedRequest)).toBeUndefined();
    expect(
      controlledInputBudget(scopedRequest, { ...permit, expiresAt: '2020-01-01T00:00:00.000Z' }),
    ).toBeUndefined();
    expect(
      controlledInputBudget(scopedRequest, { ...permit, modelReference: 'typesafe/jev@other' }),
    ).toBeUndefined();
    expect(
      controlledInputBudget(
        {
          ...scopedRequest,
          input: { ...input, decisions: { ...input.decisions, state: 'changed' } },
        },
        permit,
      ),
    ).toBeUndefined();
    expect(controlledInputBudget({ ...scopedRequest, stream: true }, permit)).toBeUndefined();
  });
  it('counts the complete questions and state in UTF-8 against the existing input ceiling', () => {
    const budget = controlledInputBudget(scopedRequest, permit);
    expect(budget).toBe(Buffer.byteLength(JSON.stringify({ input, tools: [] }), 'utf8') + 256);
    const large = {
      ...input,
      decisions: {
        ...input.decisions,
        questions: [{ ...input.decisions.questions[0], question: '字'.repeat(3000) }],
      },
    };
    expect(
      controlledInputBudget(
        { ...scopedRequest, input: large },
        { ...permit, fixtureSha256: hashScopedInput(large) },
      ),
    ).toBeGreaterThan(8192);
  });
  it('matches wire JSON when normalized optional properties are undefined', () => {
    const withoutEffort = { ...input, decisions: { ...input.decisions, effort: undefined } };
    const wirePermit = {
      ...permit,
      fixtureSha256: hashScopedInput(JSON.parse(JSON.stringify(withoutEffort))),
    };
    expect(
      controlledInputBudget({ ...scopedRequest, input: withoutEffort }, wirePermit),
    ).toBeGreaterThan(256);
  });
  it('restricts an authenticated scoped request to its exact route instead of the other pilot routes', () => {
    const pilot = INTERNAL_METERED_RELATIONSHIPS[0].pilot;
    if (pilot === undefined) throw new Error('Missing pilot');
    const route = {
      deploymentId: permit.deploymentId,
      modelReference: permit.modelReference,
      provider: permit.provider,
    };
    const decisions: EdgeOperation = { kind: 'decisions' };
    expect(pilotAllowsDeployment(pilot, decisions, route)).toBe(false);
    expect(pilotAllowsDeployment(pilot, decisions, route, permit)).toBe(true);
    expect(
      pilotAllowsDeployment(pilot, decisions, { ...route, deploymentId: 'other' }, permit),
    ).toBe(false);
    expect(pilotAllowsDeployment(pilot, decisions, pilot.deployments[0], permit)).toBe(false);
    expect(
      pilotAllowsDeployment(pilot, decisions, route, {
        ...permit,
        expiresAt: '2020-01-01T00:00:00.000Z',
      }),
    ).toBe(false);
  });
});

describe('speech terms (approved 2026-10-15)', () => {
  const pilot = INTERNAL_METERED_RELATIONSHIPS[0].pilot;
  if (pilot === undefined) throw new Error('Production pilot missing');
  const speechRoute = {
    deploymentId: KAANA_SPEECH_DEPLOYMENT_ID,
    modelReference: KAANA_SPEECH_MODEL_REFERENCE,
    provider: KAANA_SPEECH_PROVIDER_SLUG,
  };
  const speech = (input: string): NormalizedEdgeRequest =>
    normalizeSpeechRequest(
      speechRequestSchema.parse({ model: KAANA_SPEECH_MODEL_REFERENCE, input, voice: 'female' }),
    );

  it('admits only the reviewed xAI speech route, at 15,000 characters and USD 0.25', () => {
    expect(pilot.speech).toEqual({
      maxInputCharacters: 15_000,
      maxPricePerRequestUsd: '0.25',
      deployments: [speechRoute],
    });
    expect(KAANA_SPEECH_MAX_INPUT_CHARACTERS).toBe(15_000);
    // The deployment tuple is the reviewed catalogue's own, not a copy of it.
    expect(KAANA_SPEECH_CATALOGUE.providers.map((provider) => provider.deploymentId)).toEqual([
      KAANA_SPEECH_DEPLOYMENT_ID,
    ]);
  });

  it('quotes the full 15,000 characters at the list price under the speech ceiling', () => {
    const [provider] = KAANA_SPEECH_CATALOGUE.providers;
    const perCharacter = provider?.unitPrices.find((price) => price.unit === 'characters');
    if (perCharacter === undefined) throw new Error('Speech character price missing');
    // Integer micro-dollars: $15.00 per 1M characters is 15 micro-dollars each.
    const microUsd =
      (KAANA_SPEECH_MAX_INPUT_CHARACTERS * Number(perCharacter.amount) * 1_000_000) /
      perCharacter.per;
    expect(microUsd).toBe(225_000);
    expect(microUsd).toBeLessThanOrEqual(Number(pilot.speech?.maxPricePerRequestUsd) * 1_000_000);
  });

  it('binds speech to its own terms and every other operation to the unchanged text terms', () => {
    expect(pilotTermsFor(pilot, { kind: 'speech', characters: 1 })).toEqual({
      maxInput: 15_000,
      maxOutputTokens: undefined,
      maxPricePerRequestUsd: '0.25',
      deployments: [speechRoute],
    });
    expect(pilotTermsFor(pilot, COMPLETION)).toEqual({
      maxInput: pilot.maxControlledCompletionInputBudget,
      maxOutputTokens: 2048,
      maxPricePerRequestUsd: '0.05',
      deployments: pilot.deployments,
    });
    expect(pilotTermsFor(pilot, { kind: 'decisions' })).toMatchObject({
      maxInput: pilot.maxControlledInputBudget,
      maxPricePerRequestUsd: '0.05',
    });
  });

  it('leaves speech outside a pilot without speech terms', () => {
    const { speech: _speech, ...withoutSpeech } = pilot;
    expect(pilotTermsFor(withoutSpeech, { kind: 'speech', characters: 1 })).toBeUndefined();
    expect(
      pilotAllowsDeployment(withoutSpeech, { kind: 'speech', characters: 1 }, speechRoute),
    ).toBe(false);
  });

  it('never admits a speech route for a completion, nor a completion route for speech', () => {
    const speechOperation: EdgeOperation = { kind: 'speech', characters: 1 };
    expect(pilotAllowsDeployment(pilot, speechOperation, speechRoute)).toBe(true);
    expect(pilotAllowsDeployment(pilot, COMPLETION, speechRoute)).toBe(false);
    expect(pilotAllowsDeployment(pilot, { kind: 'decisions' }, speechRoute)).toBe(false);
    for (const route of pilot.deployments) {
      expect(pilotAllowsDeployment(pilot, speechOperation, route)).toBe(false);
    }
    expect(
      pilotAllowsDeployment(pilot, speechOperation, { ...speechRoute, deploymentId: 'other' }),
    ).toBe(false);
    expect(
      pilotAllowsDeployment(pilot, speechOperation, { ...speechRoute, provider: 'other' }),
    ).toBe(false);
    expect(
      pilotAllowsDeployment(pilot, speechOperation, {
        ...speechRoute,
        modelReference: 'x-ai/text-to-speech@other',
      }),
    ).toBe(false);
  });

  it('measures speech in exact characters, the unit it is quoted and billed in', () => {
    expect(controlledInputBudget(speech('Hola 👋'))).toBe('Hola 👋'.length);
    expect(controlledInputBudget(speech('a'.repeat(15_000)))).toBe(15_000);
    expect(controlledInputBudget(speech('a'.repeat(15_001)))).toBe(15_001);
    // A count that does not describe the text sent is not a measurement.
    const request = speech('abc');
    expect(
      controlledInputBudget({ ...request, operation: { kind: 'speech', characters: 2 } }),
    ).toBeUndefined();
    expect(controlledInputBudget({ ...request, stream: true })).toBeUndefined();
  });
});
