/**
 * The economic treatment decision (#1526, I09) is a pure function of the
 * AUTHENTICATED principal. These cases pin what selects `internal_metered` and,
 * more importantly, everything that does not.
 */

import {
  ALIA_INFERENCE_CONSUMER_APPLICATION_ID,
  ASTRO_INFERENCE_CONSUMER_APPLICATION_ID,
  CLARITY_EMBEDDINGS_DEPLOYMENT,
  CLARITY_INFERENCE_CONSUMER_APPLICATION_ID,
  INFERENCE_ECONOMIC_POLICY_VERSION,
  INTERNAL_METERED_RELATIONSHIPS,
  MENTION_INFERENCE_CONSUMER_APPLICATION_ID,
  pilotTextTerms,
  resolveEconomicTreatment,
  type EconomicTreatmentPrincipal,
} from '../inferenceEconomicPolicy';
import { CLARITY_BACKEND_APPLICATION_ID } from '../firstPartyApplications';
import {
  ALIA_APPLICATION_ID,
  MENTION_APPLICATION_ID,
} from '../../scripts/seedOxyApplicationsSpecs';

const alia: EconomicTreatmentPrincipal = {
  lane: 'service_token',
  applicationId: ALIA_INFERENCE_CONSUMER_APPLICATION_ID,
  environment: 'production',
  applicationIsInternal: true,
};

describe('resolveEconomicTreatment', () => {
  it('pins the same Alia application id the seed provisions', () => {
    expect(ALIA_INFERENCE_CONSUMER_APPLICATION_ID).toBe(ALIA_APPLICATION_ID);
  });

  it('treats the configured Alia → Kaana relationship as internal_metered, stamped with the policy version', () => {
    const decision = resolveEconomicTreatment(alia);
    expect(decision).toMatchObject({
      treatment: 'internal_metered',
      policyVersion: INFERENCE_ECONOMIC_POLICY_VERSION,
      relationship: {
        relationshipId: 'alia-kaana',
        consumerProduct: 'alia',
        providerProduct: 'kaana',
      },
    });
  });

  it('is commercial for every principal the policy does not name', () => {
    expect(
      resolveEconomicTreatment({ ...alia, applicationId: 'some-customer-app' }).treatment,
    ).toBe('commercial');
  });

  it('is commercial on any lane other than the service-token lane, for the same application', () => {
    expect(resolveEconomicTreatment({ ...alia, lane: 'machine_credential' }).treatment).toBe(
      'commercial',
    );
    expect(resolveEconomicTreatment({ ...alia, lane: 'product_session' }).treatment).toBe(
      'commercial',
    );
  });

  it('is commercial in an environment the relationship does not list', () => {
    expect(resolveEconomicTreatment({ ...alia, environment: 'development' }).treatment).toBe(
      'commercial',
    );
    expect(resolveEconomicTreatment({ ...alia, environment: 'staging' }).treatment).toBe(
      'commercial',
    );
  });

  it('is commercial the moment the application stops being internal, whatever the file says', () => {
    expect(resolveEconomicTreatment({ ...alia, applicationIsInternal: false }).treatment).toBe(
      'commercial',
    );
    expect(resolveEconomicTreatment({ ...alia, applicationIsInternal: null }).treatment).toBe(
      'commercial',
    );
  });

  it('ignores request-borne facts even when a caller smuggles them onto the principal object', () => {
    const customer = { ...alia, applicationId: 'some-customer-app' };
    const forged = {
      ...customer,
      economicTreatment: 'internal_metered',
      accountKind: 'bot',
      agentId: 'agent-1',
      delegatedUserId: 'alia-owner',
      applicationType: 'internal',
    } as EconomicTreatmentPrincipal;
    expect(resolveEconomicTreatment(forged).treatment).toBe('commercial');
  });

  it('declares technical capacity for every internal relationship', () => {
    for (const relationship of INTERNAL_METERED_RELATIONSHIPS) {
      expect(relationship.capacity.maxConcurrentRequests).toBeGreaterThan(0);
      expect(relationship.capacity.maxRequestsPerUtcDay).toBeGreaterThan(0);
    }
  });
});

describe('alia-kaana grant terms for voice (Alia ADR 0017, Kaana ADR 0002)', () => {
  const relationship = INTERNAL_METERED_RELATIONSHIPS.find(
    (candidate) => candidate.relationshipId === 'alia-kaana',
  );

  it('admits realtime conversation sessions under a per-minute price ceiling, and nothing else', () => {
    expect(relationship?.pilot?.realtime).toEqual({
      sessionKinds: ['conversation'],
      maxPricePerMinuteUsd: '0.25',
    });
  });

  it('admits transcriptions of at most Alia’s 5-minute clip under a per-request ceiling', () => {
    expect(relationship?.pilot?.transcription).toEqual({
      maxInputAudioMilliseconds: 300_000,
      maxPricePerRequestUsd: '0.05',
    });
  });

  it('carries no concurrency or spend of its own for voice: those are Console configuration', () => {
    const realtime = relationship?.pilot?.realtime ?? {};
    const transcription = relationship?.pilot?.transcription ?? {};
    for (const terms of [realtime, transcription]) {
      expect(Object.keys(terms).some((key) => /concurren|session.*limit|spend/i.test(key))).toBe(
        false,
      );
    }
  });
});

describe('clarity-kaana: Clarity search embeddings, and nothing else', () => {
  const relationship = INTERNAL_METERED_RELATIONSHIPS.find(
    (candidate) => candidate.relationshipId === 'clarity-kaana',
  );
  const clarity: EconomicTreatmentPrincipal = {
    lane: 'service_token',
    applicationId: CLARITY_INFERENCE_CONSUMER_APPLICATION_ID,
    environment: 'production',
    applicationIsInternal: true,
  };

  it('pins the backend application Clarity calls kaana.ai with', () => {
    expect(CLARITY_INFERENCE_CONSUMER_APPLICATION_ID).toBe(CLARITY_BACKEND_APPLICATION_ID);
  });

  it('treats Clarity’s production service token as internal_metered under it, and nothing else', () => {
    expect(resolveEconomicTreatment(clarity)).toMatchObject({
      treatment: 'internal_metered',
      relationship: { relationshipId: 'clarity-kaana', consumerProduct: 'clarity' },
    });
    expect(resolveEconomicTreatment({ ...clarity, lane: 'machine_credential' }).treatment).toBe(
      'commercial',
    );
    expect(resolveEconomicTreatment({ ...clarity, environment: 'development' }).treatment).toBe(
      'commercial',
    );
    expect(resolveEconomicTreatment({ ...clarity, applicationIsInternal: false }).treatment).toBe(
      'commercial',
    );
  });

  it('carries embeddings terms only: no text, speech, realtime, transcription or promotional lane', () => {
    const pilot = relationship?.pilot;
    expect(pilot).toBeDefined();
    if (pilot === undefined) return;
    expect(pilotTextTerms(pilot)).toBeUndefined();
    expect(Object.keys(pilot)).toEqual(['embeddings']);
    expect(pilot.embeddings).toEqual({
      maxInputTokens: 65_536,
      maxPricePerRequestUsd: '0.001',
      deployments: [CLARITY_EMBEDDINGS_DEPLOYMENT],
    });
  });

  it('names the one route Kaana published for qwen/qwen3-embedding-8b', () => {
    expect(CLARITY_EMBEDDINGS_DEPLOYMENT).toEqual({
      deploymentId: 'dep_openrouter_qwen_qwen3_embedding_8b_observed_2026_10_15',
      modelReference: 'qwen/qwen3-embedding-8b@observed-2026-10-15',
      provider: 'openrouter',
    });
  });

  it('admits Clarity’s largest request and quotes it under the ceiling at the line’s list price', () => {
    // 128 chunks of 2,000 characters, as Kaana estimates them (length / 4 + 1).
    const largest = 128 * (2000 / 4 + 1);
    expect(largest).toBeLessThanOrEqual(relationship?.pilot?.embeddings?.maxInputTokens ?? 0);
    // $0.01 per 1M input tokens, in micro-dollars to stay exact.
    const quoteMicroUsd =
      ((relationship?.pilot?.embeddings?.maxInputTokens ?? 0) * 10_000) / 1_000_000;
    expect(quoteMicroUsd).toBeLessThanOrEqual(1_000);
  });

  it('bounds the day and the concurrency', () => {
    expect(relationship?.capacity).toEqual({
      maxConcurrentRequests: 16,
      maxRequestsPerUtcDay: 60_000,
    });
  });
});

describe('Mention: decisions and level text, each its own relationship; nothing else', () => {
  const mention: EconomicTreatmentPrincipal = {
    lane: 'service_token',
    applicationId: MENTION_INFERENCE_CONSUMER_APPLICATION_ID,
    environment: 'production',
    applicationIsInternal: false,
    applicationType: 'first_party',
  };

  it('applies to the seeded first-party Mention application for its named operations only', () => {
    expect(MENTION_INFERENCE_CONSUMER_APPLICATION_ID).toBe(MENTION_APPLICATION_ID);
    expect(resolveEconomicTreatment(mention, 'decisions')).toMatchObject({
      treatment: 'internal_metered',
      relationship: { relationshipId: 'mention-kaana-decisions' },
    });
    expect(resolveEconomicTreatment(mention, 'responses')).toMatchObject({
      treatment: 'internal_metered',
      relationship: { relationshipId: 'mention-kaana-text' },
    });
    expect(resolveEconomicTreatment(mention, 'embeddings').treatment).toBe('commercial');
    expect(resolveEconomicTreatment(mention).treatment).toBe('commercial');
    expect(
      resolveEconomicTreatment({ ...mention, applicationType: 'third_party' }, 'decisions')
        .treatment,
    ).toBe('commercial');
  });
});

describe('astro-kaana-session: Astro’s one-shot features on a person’s session (ADR 0050)', () => {
  const relationship = INTERNAL_METERED_RELATIONSHIPS.find(
    (candidate) => candidate.relationshipId === 'astro-kaana-session',
  );
  const astro: EconomicTreatmentPrincipal = {
    lane: 'product_session',
    applicationId: ASTRO_INFERENCE_CONSUMER_APPLICATION_ID,
    environment: 'production',
    applicationIsInternal: false,
    applicationType: 'first_party',
  };

  it('pins Astro’s registered application', () => {
    expect(ASTRO_INFERENCE_CONSUMER_APPLICATION_ID).toBe('c08f19e22ae6e86eb1d50361');
  });

  it('applies to Astro’s product session for responses only, and to no other lane or class', () => {
    expect(resolveEconomicTreatment(astro, 'responses')).toMatchObject({
      treatment: 'internal_metered',
      relationship: { relationshipId: 'astro-kaana-session', lane: 'product_session' },
    });
    for (const operation of ['chat_completions', 'embeddings', 'audio_speech'] as const) {
      expect(resolveEconomicTreatment(astro, operation).treatment).toBe('commercial');
    }
    expect(resolveEconomicTreatment(astro).treatment).toBe('commercial');
    expect(
      resolveEconomicTreatment({ ...astro, lane: 'service_token' }, 'responses').treatment,
    ).toBe('commercial');
    expect(
      resolveEconomicTreatment({ ...astro, lane: 'machine_credential' }, 'responses').treatment,
    ).toBe('commercial');
    expect(
      resolveEconomicTreatment({ ...astro, applicationType: 'third_party' }, 'responses').treatment,
    ).toBe('commercial');
    expect(
      resolveEconomicTreatment({ ...astro, environment: 'development' }, 'responses').treatment,
    ).toBe('commercial');
  });

  it('serves the instant level only, at 8,000 input and 512 output tokens, under USD 0.004', () => {
    const pilot = relationship?.pilot;
    expect(pilot).toBeDefined();
    if (pilot === undefined) return;
    expect(pilotTextTerms(pilot)).toBeUndefined();
    expect(Object.keys(pilot)).toEqual(['levelText']);
    expect(pilot.levelText).toEqual({
      levels: ['instant'],
      maxInputTokens: 8_000,
      maxOutputTokens: 512,
      maxPricePerRequestUsd: '0.004',
    });
    // The dearest instant line (USD 0.30 in, 2.50 out per 1M) at full size, in micro-dollars.
    const quoteMicroUsd = (8_000 * 0.3 + 512 * 2.5) * 1;
    expect(quoteMicroUsd).toBeLessThanOrEqual(4_000);
  });

  it('bounds each person’s day, the application’s day and its requests in flight', () => {
    expect(relationship?.capacity).toEqual({
      maxConcurrentRequests: 16,
      maxRequestsPerUtcDay: 10_000,
      maxRequestsPerUserPerUtcDay: 200,
      scope: 'relationship',
    });
  });

  it('is the only relationship on the product_session lane, and every such one bounds a person', () => {
    const sessions = INTERNAL_METERED_RELATIONSHIPS.filter(
      (candidate) => candidate.lane === 'product_session',
    );
    expect(sessions.map((candidate) => candidate.relationshipId)).toEqual(['astro-kaana-session']);
    for (const candidate of sessions) {
      expect(candidate.capacity.maxRequestsPerUserPerUtcDay).toBeGreaterThan(0);
      expect(candidate.operations).toBeDefined();
      expect(candidate.consumerApplicationClass).toBe('first_party');
    }
  });

  it('accepts a shared session by public client id for Astro only, and only with a per-person bound', () => {
    expect(relationship?.sharedSessionAttribution).toBe('public_client_id');
    const accepting = INTERNAL_METERED_RELATIONSHIPS.filter(
      (candidate) => candidate.sharedSessionAttribution !== undefined,
    );
    expect(accepting.map((candidate) => candidate.relationshipId)).toEqual(['astro-kaana-session']);
    for (const candidate of accepting) {
      expect(candidate.lane).toBe('product_session');
      expect(candidate.capacity.maxRequestsPerUserPerUtcDay).toBeGreaterThan(0);
    }
  });

  it('stamps the version that introduced it', () => {
    expect(INFERENCE_ECONOMIC_POLICY_VERSION).toBe('oxy-inference-economics/2026-10-27.2');
  });
});
