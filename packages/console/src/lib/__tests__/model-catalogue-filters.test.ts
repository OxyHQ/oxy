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
  tools?: boolean;
  regions?: Array<string>;
  providers?: Array<string>;
  zeroDataRetentionAvailable?: boolean;
  trainsOnCustomerData?: boolean;
  retainsPayloads?: boolean;
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
    schemaVersion: 1,
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
      outputModalities: ['text'],
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
      regions: ['eu-central-1', 'us-west-2'],
      providers: [
        { slug: 'anthropic-first-party', displayName: 'anthropic-first-party' },
        { slug: 'bedrock', displayName: 'bedrock' },
        { slug: 'together', displayName: 'together' },
      ],
    });
  });

  /**
   * The state the catalogue is in today. Empty facets are what lets the page
   * hide the filter bar rather than render dropdowns that select nothing.
   */
  it('returns empty facets for an empty catalogue', () => {
    expect(catalogueFacets([])).toEqual({ inputModalities: [], regions: [], providers: [] });
  });
});
