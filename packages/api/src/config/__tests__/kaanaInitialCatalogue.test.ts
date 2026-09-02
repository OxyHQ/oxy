import {
  KAANA_INITIAL_MODEL,
  KAANA_INITIAL_PROVIDERS,
  KAANA_INITIAL_ROUTING_PROFILES,
} from '../kaanaInitialCatalogue';

describe('the reviewed initial Kaana catalogue', () => {
  it('uses unique permanent deployment identities instead of names as route keys', () => {
    const ids = KAANA_INITIAL_PROVIDERS.map((provider) => provider.deploymentId);

    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual([
      'dep_cerebras_gpt_oss_120b_observed_2026_09_01',
      'dep_groq_openai_gpt_oss_120b_observed_2026_09_01',
    ]);
    for (const provider of KAANA_INITIAL_PROVIDERS) {
      expect(provider.deploymentId).not.toBe(provider.displayName);
      expect(provider.deploymentId).not.toBe(provider.upstreamModelId);
    }
  });

  it('prices every possible text usage unit and every request explicitly', () => {
    const required = new Set([
      'input_tokens',
      'cached_input_tokens',
      'output_tokens',
      'reasoning_tokens',
      'requests',
    ]);

    for (const provider of KAANA_INITIAL_PROVIDERS) {
      expect(new Set(provider.unitPrices.map((price) => price.unit))).toEqual(required);
      expect(provider.unitPrices.find((price) => price.unit === 'requests')).toEqual({
        unit: 'requests',
        amount: '0',
        per: 1,
      });
    }
  });

  it('uses the conservative common capability ceiling', () => {
    expect(KAANA_INITIAL_MODEL.inputModalities).toEqual(['text']);
    expect(KAANA_INITIAL_MODEL.outputModalities).toEqual(['text']);
    expect(KAANA_INITIAL_MODEL.supportsParallelToolCalls).toBe(false);
    expect(KAANA_INITIAL_MODEL.maxContextTokens).toBe(131_072);
    expect(KAANA_INITIAL_MODEL.maxOutputTokens).toBe(40_960);
  });

  it('keeps unsupported modality profiles absent instead of claiming capability', () => {
    const profiles = KAANA_INITIAL_ROUTING_PROFILES.map((profile) => profile.slug);

    expect(profiles).toContain('kaana-lite');
    expect(profiles).toContain('kaana-v1');
    expect(profiles).not.toContain('kaana-v1-vision');
    expect(profiles).not.toContain('kaana-v1-audio');
    expect(profiles).not.toContain('kaana-v1-voice');
    expect(profiles).not.toContain('kaana-v1-multimodal');
  });

  it('does not publish the unsupported quality optimisation dimension', () => {
    expect(KAANA_INITIAL_ROUTING_PROFILES.map((profile) => profile.optimiseFor)).not.toContain(
      'quality'
    );
  });

  it('does not let unmeasured latency introduce a provider preference', () => {
    expect(KAANA_INITIAL_PROVIDERS.map((provider) => provider.scores.latency)).toEqual([500, 500]);
    expect(KAANA_INITIAL_ROUTING_PROFILES.map((profile) => profile.optimiseFor)).not.toContain(
      'latency'
    );
  });

  it('stores reviewed score dimensions rather than deriving priority from provider names', () => {
    for (const provider of KAANA_INITIAL_PROVIDERS) {
      const expectedBalanced = Math.round((provider.scores.price + provider.scores.throughput) / 2);
      expect(provider.scores.balanced).toBe(expectedBalanced);
    }
  });
});
