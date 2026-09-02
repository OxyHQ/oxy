import { describe, expect, it } from 'vitest';
import { modelCatalogueEntrySchema } from '@oxyhq/contracts';
import {
  EMPTY_CATALOGUE_FILTERS,
  catalogueFacets,
  filterCatalogue,
  isEmptyFilterSet,
} from '../model-catalogue-filters';
import type { ModelCatalogueEntry } from '@oxyhq/contracts';

/**
 * Fixtures are built through `modelCatalogueEntrySchema.parse`, the SAME schema
 * the API validates its output with, so a fixture can never describe a response
 * the server could not produce. That matters more than usual here: the real
 * catalogue is empty today, so these fixtures are the only shape the filters are
 * ever exercised against, and a hand-rolled object literal would let them agree
 * with a response that will never arrive.
 */
function entry(overrides: {
  modelId: string;
  displayName?: string;
  publisherSlug?: string;
  inputModalities?: Array<'text' | 'image' | 'audio' | 'video'>;
  outputModalities?: Array<'text' | 'image' | 'audio' | 'video' | 'embedding'>;
  tools?: boolean;
  regions?: Array<string>;
  providers?: Array<string>;
  zeroDataRetentionAvailable?: boolean;
  trainsOnCustomerData?: boolean;
  retainsPayloads?: boolean;
  /** Omitted leaves `pricing` ABSENT, which is what an unpriced route serves. */
  pricing?: {
    currency?: string;
    unitPrices: Array<{ unit: string; amount: string; per: number }>;
  };
}): ModelCatalogueEntry {
  const publisherSlug = overrides.publisherSlug ?? overrides.modelId.split('/')[0];
  const retainsPayloads = overrides.retainsPayloads ?? true;
  const dataPolicy = {
    retainsPayloads,
    retentionDays: retainsPayloads ? 30 : 0,
    trainsOnCustomerData: overrides.trainsOnCustomerData ?? false,
    zeroDataRetentionAvailable: overrides.zeroDataRetentionAvailable ?? false,
    subprocessors: [],
  };

  return modelCatalogueEntrySchema.parse({
    schemaVersion: 2,
    modelId: overrides.modelId,
    publisher: {
      slug: publisherSlug,
      displayName: publisherSlug.toUpperCase(),
    },
    displayName: overrides.displayName ?? overrides.modelId,
    currentRevision: '2026-01-01',
    availableRevisions: ['2026-01-01'],
    capabilities: {
      inputModalities: overrides.inputModalities ?? ['text'],
      outputModalities: overrides.outputModalities ?? ['text'],
      tools: overrides.tools ?? false,
      parallelToolCalls: false,
      structuredOutput: false,
      jsonMode: false,
      reasoning: false,
      streaming: true,
      promptCaching: false,
      maxContextTokens: 100_000,
      maxOutputTokens: 4_000,
    },
    license: {
      licenseId: 'proprietary',
      displayName: 'Proprietary',
      commercialUseAllowed: true,
      requiresAttribution: false,
    },
    provenance: { releaseKind: 'third_party_hosted' },
    regions: overrides.regions ?? ['us-west-2'],
    servingProviders: (overrides.providers ?? ['bedrock']).map((slug) => ({
      slug,
      displayName: slug,
      regions: overrides.regions ?? ['us-west-2'],
      dataPolicy,
    })),
    dataPolicy,
    ...(overrides.pricing === undefined
      ? {}
      : {
          pricing: {
            priceVersionId: `pv-${overrides.modelId.replace(/\W/g, '-')}`,
            currency: overrides.pricing.currency ?? 'USD',
            unitPrices: overrides.pricing.unitPrices.map((unitPrice) => ({
              ...unitPrice,
              currency: overrides.pricing?.currency ?? 'USD',
            })),
          },
        }),
    availabilityScope: 'public_payg',
    commercialPermission: 'public_resale_approved',
    deprecation: { status: 'active' },
    evaluations: [],
  });
}

const CATALOGUE: Array<ModelCatalogueEntry> = [
  entry({
    modelId: 'anthropic/claude-sonnet',
    displayName: 'Claude Sonnet',
    inputModalities: ['text', 'image'],
    tools: true,
    regions: ['us-west-2', 'eu-central-1'],
    providers: ['anthropic-first-party', 'bedrock'],
    zeroDataRetentionAvailable: true,
  }),
  entry({
    modelId: 'meta/llama-3',
    displayName: 'Llama 3',
    inputModalities: ['text'],
    tools: false,
    regions: ['us-west-2'],
    providers: ['together'],
    trainsOnCustomerData: true,
  }),
  entry({
    modelId: 'openai/gpt-5',
    displayName: 'GPT-5',
    inputModalities: ['text', 'audio'],
    tools: true,
    regions: ['eu-central-1'],
    providers: ['bedrock'],
    retainsPayloads: false,
  }),
];

/**
 * A catalogue with PRICES, deliberately not tidy.
 *
 * The three rows exist to break a wrong implementation rather than to agree with
 * a right one:
 *
 *  - `cheap-per-million` is quoted per 1,000,000 at `3.00`.
 *  - `dear-per-thousand` is quoted per 1,000 at `0.005` — which is `5.00` per
 *    million, i.e. MORE expensive, while its raw `amount` string is the SMALLER
 *    of the two. Any implementation that compares amounts without normalising the
 *    denominator gets this pair backwards, and a fixture where both rows shared a
 *    `per` would let it pass.
 *  - `embeddings-only` is priced, but not per input token, so there is nothing
 *    for an input-token cap to compare it against.
 *
 * Plus `no-price/at-all`, whose `pricing` is absent — the state most of the real
 * catalogue is in.
 */
const PRICED_CATALOGUE: Array<ModelCatalogueEntry> = [
  entry({
    modelId: 'acme/cheap-per-million',
    pricing: {
      unitPrices: [{ unit: 'input_tokens', amount: '3.000000000000', per: 1_000_000 }],
    },
  }),
  entry({
    modelId: 'acme/dear-per-thousand',
    pricing: {
      unitPrices: [{ unit: 'input_tokens', amount: '0.005000000000', per: 1_000 }],
    },
  }),
  entry({
    modelId: 'acme/embeddings-only',
    outputModalities: ['embedding'],
    pricing: {
      unitPrices: [{ unit: 'embeddings', amount: '0.000100000000', per: 1_000 }],
    },
  }),
  entry({ modelId: 'no-price/at-all' }),
];

describe('the price cap', () => {
  /**
   * The POSITIVE CONTROL and the negative one in a single assertion: one entry
   * that IS under the cap passes and one that is over it fails. Either alone is
   * satisfied by a broken filter — "everything excluded" and "nothing excluded"
   * each look correct from one side.
   */
  it('keeps a model under the cap and drops one over it, normalising the denominator', () => {
    const under = filterCatalogue(PRICED_CATALOGUE, {
      ...EMPTY_CATALOGUE_FILTERS,
      maxPricePerMillionInputTokens: '4.00',
    });
    expect(under.map((e) => e.modelId)).toContain('acme/cheap-per-million');
    // `0.005` per 1,000 is 5.00 per million: over a 4.00 cap, even though the
    // raw amount string is far smaller than the other row's.
    expect(under.map((e) => e.modelId)).not.toContain('acme/dear-per-thousand');

    // And the comparison is not one-directional: raise the cap above both and
    // the row that was excluded comes back.
    const both = filterCatalogue(PRICED_CATALOGUE, {
      ...EMPTY_CATALOGUE_FILTERS,
      maxPricePerMillionInputTokens: '5.00',
    });
    expect(both.map((e) => e.modelId)).toContain('acme/cheap-per-million');
    expect(both.map((e) => e.modelId)).toContain('acme/dear-per-thousand');
  });

  it('includes a price exactly AT the cap', () => {
    // At-most, not below. The boundary is where a float comparison would have
    // reintroduced the error the exact-decimal representation exists to prevent.
    const atCap = filterCatalogue(PRICED_CATALOGUE, {
      ...EMPTY_CATALOGUE_FILTERS,
      maxPricePerMillionInputTokens: '3.00',
    });
    expect(atCap.map((e) => e.modelId)).toContain('acme/cheap-per-million');

    const justUnder = filterCatalogue(PRICED_CATALOGUE, {
      ...EMPTY_CATALOGUE_FILTERS,
      maxPricePerMillionInputTokens: '2.999999999999',
    });
    expect(justUnder.map((e) => e.modelId)).not.toContain('acme/cheap-per-million');
  });

  it('keeps an UNPRICED entry, and one priced in another unit, under any cap', () => {
    // An unpriced route is not an expensive one, and a model priced per embedding
    // is not over an input-token cap — it is outside its units. A filter that
    // dropped either would make "no model is that cheap" and "most models have no
    // published price" the same screen.
    const strict = filterCatalogue(PRICED_CATALOGUE, {
      ...EMPTY_CATALOGUE_FILTERS,
      maxPricePerMillionInputTokens: '0.000000000001',
    });
    expect(strict.map((e) => e.modelId)).toEqual(['acme/embeddings-only', 'no-price/at-all']);
  });

  it('does not narrow anything while the typed value is blank or unparseable', () => {
    // A text input passes through these states on the way to every valid one. A
    // cap read as zero here would empty the list under the customer's hands.
    for (const typed of ['', '  ', '0.', '.5', 'abc', '-1', '1e-6']) {
      expect(
        filterCatalogue(PRICED_CATALOGUE, {
          ...EMPTY_CATALOGUE_FILTERS,
          maxPricePerMillionInputTokens: typed,
        })
      ).toEqual(PRICED_CATALOGUE);
      expect(
        isEmptyFilterSet({ ...EMPTY_CATALOGUE_FILTERS, maxPricePerMillionInputTokens: typed })
      ).toBe(true);
    }

    // CONTROL: a parseable cap IS active, so the loop above is measuring
    // unparseability and not a filter that never engages at all.
    expect(
      isEmptyFilterSet({ ...EMPTY_CATALOGUE_FILTERS, maxPricePerMillionInputTokens: '3.00' })
    ).toBe(false);
  });

  it('survives a 12-digit fractional price without rounding it', () => {
    const catalogue = [
      entry({
        modelId: 'acme/twelve-digits',
        pricing: {
          // A price quoted per SINGLE token, which is where the fractional digits
          // the ledger's scale exists for actually show up.
          unitPrices: [{ unit: 'input_tokens', amount: '0.000003000000', per: 1 }],
        },
      }),
    ];

    // 0.000003 per token is exactly 3.00 per million. A float would land either
    // side of a 3.00 cap unpredictably.
    expect(
      filterCatalogue(catalogue, {
        ...EMPTY_CATALOGUE_FILTERS,
        maxPricePerMillionInputTokens: '3.00',
      })
    ).toHaveLength(1);
    expect(
      filterCatalogue(catalogue, {
        ...EMPTY_CATALOGUE_FILTERS,
        maxPricePerMillionInputTokens: '2.999999999999',
      })
    ).toHaveLength(0);
  });
});

describe('filterCatalogue', () => {
  /**
   * The vacuity floor for every case below: an unfiltered call returns the WHOLE
   * catalogue. Without it, a predicate that rejected everything would satisfy
   * each individual "the wrong model is absent" assertion.
   */
  it('returns every entry when nothing is filtering', () => {
    expect(filterCatalogue(CATALOGUE, EMPTY_CATALOGUE_FILTERS)).toEqual(CATALOGUE);
    expect(isEmptyFilterSet(EMPTY_CATALOGUE_FILTERS)).toBe(true);
  });

  it('matches the query against id, display name and publisher', () => {
    const byId = filterCatalogue(CATALOGUE, { ...EMPTY_CATALOGUE_FILTERS, query: 'llama' });
    expect(byId.map((e) => e.modelId)).toEqual(['meta/llama-3']);

    const byDisplayName = filterCatalogue(CATALOGUE, { ...EMPTY_CATALOGUE_FILTERS, query: 'GPT' });
    expect(byDisplayName.map((e) => e.modelId)).toEqual(['openai/gpt-5']);

    const byPublisher = filterCatalogue(CATALOGUE, {
      ...EMPTY_CATALOGUE_FILTERS,
      query: 'anthropic',
    });
    expect(byPublisher.map((e) => e.modelId)).toEqual(['anthropic/claude-sonnet']);

    // A query nobody matches returns nothing rather than falling back to all.
    expect(filterCatalogue(CATALOGUE, { ...EMPTY_CATALOGUE_FILTERS, query: 'zzz' })).toEqual([]);
  });

  it('filters by input modality, and keeps a model whose modality is one of several', () => {
    const image = filterCatalogue(CATALOGUE, {
      ...EMPTY_CATALOGUE_FILTERS,
      inputModality: 'image',
    });
    expect(image.map((e) => e.modelId)).toEqual(['anthropic/claude-sonnet']);

    const text = filterCatalogue(CATALOGUE, { ...EMPTY_CATALOGUE_FILTERS, inputModality: 'text' });
    expect(text).toHaveLength(3);
  });

  it('filters by output modality independently of input modality', () => {
    // The two are separate fields and a model's input set is not its output set —
    // an embedding model takes text and emits vectors. Collapsing them would make
    // "reads images" and "draws images" the same filter.
    const embedding = filterCatalogue(PRICED_CATALOGUE, {
      ...EMPTY_CATALOGUE_FILTERS,
      outputModality: 'embedding',
    });
    expect(embedding.map((e) => e.modelId)).toEqual(['acme/embeddings-only']);

    // The same entry accepts TEXT input, so filtering on input modality alone
    // must not exclude it — which is what proves the two predicates are distinct.
    const textIn = filterCatalogue(PRICED_CATALOGUE, {
      ...EMPTY_CATALOGUE_FILTERS,
      inputModality: 'text',
    });
    expect(textIn.map((e) => e.modelId)).toContain('acme/embeddings-only');

    const textOut = filterCatalogue(PRICED_CATALOGUE, {
      ...EMPTY_CATALOGUE_FILTERS,
      outputModality: 'text',
    });
    expect(textOut.map((e) => e.modelId)).not.toContain('acme/embeddings-only');
  });

  it('filters by tool support', () => {
    const withTools = filterCatalogue(CATALOGUE, { ...EMPTY_CATALOGUE_FILTERS, toolsOnly: true });
    expect(withTools.map((e) => e.modelId)).toEqual(['anthropic/claude-sonnet', 'openai/gpt-5']);
  });

  it('filters by region and by serving provider independently', () => {
    const euOnly = filterCatalogue(CATALOGUE, {
      ...EMPTY_CATALOGUE_FILTERS,
      region: 'eu-central-1',
    });
    expect(euOnly.map((e) => e.modelId)).toEqual(['anthropic/claude-sonnet', 'openai/gpt-5']);

    const bedrock = filterCatalogue(CATALOGUE, { ...EMPTY_CATALOGUE_FILTERS, provider: 'bedrock' });
    expect(bedrock.map((e) => e.modelId)).toEqual(['anthropic/claude-sonnet', 'openai/gpt-5']);

    // A provider that serves the model in ONE region does not make the model
    // match a region it is not deployed in.
    const together = filterCatalogue(CATALOGUE, {
      ...EMPTY_CATALOGUE_FILTERS,
      provider: 'together',
      region: 'eu-central-1',
    });
    expect(together).toEqual([]);
  });

  it('filters on the two data-policy questions separately', () => {
    const zeroRetention = filterCatalogue(CATALOGUE, {
      ...EMPTY_CATALOGUE_FILTERS,
      zeroRetentionOnly: true,
    });
    expect(zeroRetention.map((e) => e.modelId)).toEqual(['anthropic/claude-sonnet']);

    // `noTrainingOnly` must NOT collapse into `zeroRetentionOnly`: a route can
    // retain payloads and still not train on them, and dropping it here would
    // silently over-narrow a compliance answer.
    const noTraining = filterCatalogue(CATALOGUE, {
      ...EMPTY_CATALOGUE_FILTERS,
      noTrainingOnly: true,
    });
    expect(noTraining.map((e) => e.modelId)).toEqual([
      'anthropic/claude-sonnet',
      'openai/gpt-5',
    ]);
  });

  it('applies several filters conjunctively', () => {
    const narrowed = filterCatalogue(CATALOGUE, {
      ...EMPTY_CATALOGUE_FILTERS,
      toolsOnly: true,
      region: 'eu-central-1',
      provider: 'bedrock',
    });
    expect(narrowed.map((e) => e.modelId)).toEqual(['anthropic/claude-sonnet', 'openai/gpt-5']);
  });
});

describe('catalogueFacets', () => {
  it('derives the options present in the catalogue, deduplicated and sorted', () => {
    expect(catalogueFacets(CATALOGUE)).toEqual({
      inputModalities: ['audio', 'image', 'text'],
      outputModalities: ['text'],
      regions: ['eu-central-1', 'us-west-2'],
      providers: [
        { slug: 'anthropic-first-party', displayName: 'anthropic-first-party' },
        { slug: 'bedrock', displayName: 'bedrock' },
        { slug: 'together', displayName: 'together' },
      ],
      // None of these entries carries a price, so the page must not offer a cap.
      hasInputTokenPricing: false,
    });
  });

  /**
   * The facet that decides whether the price control is offered at all. It reads
   * the same unit the predicate compares, so a catalogue priced only per
   * embedding does NOT switch on an input-token cap — otherwise the control would
   * be back to matching everything for every value.
   */
  it('reports input-token pricing only when some entry publishes it', () => {
    expect(catalogueFacets(PRICED_CATALOGUE).hasInputTokenPricing).toBe(true);

    const embeddingsOnly = PRICED_CATALOGUE.filter(
      (candidate) => candidate.modelId === 'acme/embeddings-only'
    );
    // CONTROL on the fixture: this row IS priced, so a `false` below is about the
    // UNIT and not about a missing `pricing` field.
    expect(embeddingsOnly[0]?.pricing).toBeDefined();
    expect(catalogueFacets(embeddingsOnly).hasInputTokenPricing).toBe(false);
  });

  /**
   * The state the catalogue is in today. Empty facets are what lets the page
   * hide the filter bar rather than render dropdowns that select nothing.
   */
  it('returns empty facets for an empty catalogue', () => {
    expect(catalogueFacets([])).toEqual({
      inputModalities: [],
      outputModalities: [],
      regions: [],
      providers: [],
      hasInputTokenPricing: false,
    });
  });
});
