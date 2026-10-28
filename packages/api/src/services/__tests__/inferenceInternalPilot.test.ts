import {
  controlledInputBudget,
  fundedByPromotionalCredit,
  pilotAllowsDeployment,
  pilotTermsFor,
  promotionalLaneLevels,
} from '../inferenceInternalPilot';
import {
  CLARITY_EMBEDDINGS_DEPLOYMENT,
  INTERNAL_METERED_RELATIONSHIPS,
} from '../../config/inferenceEconomicPolicy';
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
              {
                type: 'audio',
                source: { kind: 'inline', mediaType: 'audio/wav', data: 'UklGRg==' },
              },
            ],
          },
        ],
      },
    }),
  ).toBeUndefined();
});

describe('a completion carrying images (Oxy ADR 0051)', () => {
  const withImage = (data: string): NormalizedEdgeRequest => ({
    ...request(''),
    input: {
      format: 'messages',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'what does this page say?' },
            { type: 'image', source: { kind: 'inline', mediaType: 'image/png', data } },
          ],
        },
      ],
    },
  });

  it('counts the part’s framing and never its bytes in the controlled input', () => {
    const small = controlledInputBudget(withImage('AAAA'));
    const large = controlledInputBudget(withImage('A'.repeat(400_000)));
    expect(small).toBeDefined();
    expect(large).toBe(small);
    expect(small ?? 0).toBeLessThan(1_000);
  });

  const alia = INTERNAL_METERED_RELATIONSHIPS.find(
    (relationship) => relationship.relationshipId === 'alia-kaana',
  )?.pilot;
  if (alia === undefined) throw new Error('Alia pilot missing');
  const images = alia.imageInput;
  if (images === undefined) throw new Error('Alia image terms missing');

  it('answers to the image terms: their routes, count and quote ceiling, the text ceilings', () => {
    const terms = pilotTermsFor(alia, COMPLETION, 2);
    expect(terms).toEqual({
      maxInput: alia.maxControlledInputBudget,
      maxOutputTokens: alia.maxOutputTokens,
      maxPricePerRequestUsd: images.maxPricePerRequestUsd,
      deployments: images.deployments,
      maxImages: images.maxImages,
    });
    expect(pilotTermsFor(alia, COMPLETION)?.maxImages).toBeUndefined();
  });

  it('signs only the image routes for a request with images, and none of them without', () => {
    for (const route of images.deployments) {
      expect(pilotAllowsDeployment(alia, COMPLETION, route, 1)).toBe(true);
      expect(pilotAllowsDeployment(alia, COMPLETION, route)).toBe(false);
    }
    for (const route of alia.deployments ?? []) {
      expect(pilotAllowsDeployment(alia, COMPLETION, route, 1)).toBe(false);
    }
  });

  it('leaves images outside a pilot without image terms', () => {
    const { imageInput: _images, ...textOnly } = alia;
    expect(pilotTermsFor(textOnly, COMPLETION, 1)).toBeUndefined();
  });
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
      maxInput: pilot.maxControlledInputBudget,
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

describe('an embeddings-only pilot on the old edge (clarity-kaana)', () => {
  const pilot = INTERNAL_METERED_RELATIONSHIPS.find(
    (relationship) => relationship.relationshipId === 'clarity-kaana',
  )?.pilot;
  if (pilot === undefined) throw new Error('clarity-kaana pilot missing');

  it('binds no operation: its embeddings terms are read by the grant API only', () => {
    const operations: EdgeOperation[] = [
      COMPLETION,
      { kind: 'decisions' },
      { kind: 'speech', characters: 1 },
      { kind: 'embeddings', embeddings: 1 },
    ];
    for (const operation of operations) {
      expect(pilotTermsFor(pilot, operation)).toBeUndefined();
      expect(pilotAllowsDeployment(pilot, operation, CLARITY_EMBEDDINGS_DEPLOYMENT)).toBe(false);
    }
  });
});
