import type { InferenceModality, ModelCatalogueEntry } from '@oxyhq/contracts';

/**
 * Catalogue filtering, as pure functions over `ModelCatalogueEntry[]`.
 *
 * Split out of the page so the predicates are testable without rendering, and
 * so each one sits next to the reason it is expressible at all: every filter
 * here reads a field the catalogue contract actually carries. The epic also
 * lists a PRICE filter; there is deliberately none, because `pricing` is
 * optional on the entry and the serializer never populates it (price versions
 * are workstream 7's table). A price filter today would match nothing for every
 * value, which is indistinguishable from "no model is that cheap" — so the page
 * renders a published price when one exists and offers no filter over it.
 */

export interface CatalogueFilters {
  /** Free text over model id, display name and publisher. */
  query: string;
  /** An input modality the model must accept. */
  inputModality: InferenceModality | null;
  /** Only models that support tool calling. */
  toolsOnly: boolean;
  /** A region at least one serving deployment must cover. */
  region: string | null;
  /** A serving provider slug. */
  provider: string | null;
  /** Only routes offering zero data retention. */
  zeroRetentionOnly: boolean;
  /** Only routes that do not train on customer data. */
  noTrainingOnly: boolean;
}

export const EMPTY_CATALOGUE_FILTERS: CatalogueFilters = {
  query: '',
  inputModality: null,
  toolsOnly: false,
  region: null,
  provider: null,
  zeroRetentionOnly: false,
  noTrainingOnly: false,
};

/** True when no filter is narrowing the list. */
export function isEmptyFilterSet(filters: CatalogueFilters): boolean {
  return (
    filters.query.trim() === '' &&
    filters.inputModality === null &&
    !filters.toolsOnly &&
    filters.region === null &&
    filters.provider === null &&
    !filters.zeroRetentionOnly &&
    !filters.noTrainingOnly
  );
}

function matchesQuery(entry: ModelCatalogueEntry, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (needle === '') {
    return true;
  }
  return (
    entry.modelId.toLowerCase().includes(needle) ||
    entry.displayName.toLowerCase().includes(needle) ||
    entry.publisher.slug.toLowerCase().includes(needle) ||
    entry.publisher.displayName.toLowerCase().includes(needle)
  );
}

/**
 * Data-policy filters read the ENTRY's policy, which the API derives from the
 * primary deployment rather than from the provider organisation's default — a
 * zero-retention endpoint at a provider that retains by default is a real case,
 * and the entry is where that distinction survives.
 */
export function filterCatalogue(
  entries: ReadonlyArray<ModelCatalogueEntry>,
  filters: CatalogueFilters
): Array<ModelCatalogueEntry> {
  return entries.filter((entry) => {
    if (!matchesQuery(entry, filters.query)) {
      return false;
    }
    if (
      filters.inputModality !== null &&
      !entry.capabilities.inputModalities.includes(filters.inputModality)
    ) {
      return false;
    }
    if (filters.toolsOnly && !entry.capabilities.tools) {
      return false;
    }
    if (filters.region !== null && !entry.regions.includes(filters.region)) {
      return false;
    }
    if (
      filters.provider !== null &&
      !entry.servingProviders.some((provider) => provider.slug === filters.provider)
    ) {
      return false;
    }
    if (filters.zeroRetentionOnly && !entry.dataPolicy.zeroDataRetentionAvailable) {
      return false;
    }
    if (filters.noTrainingOnly && entry.dataPolicy.trainsOnCustomerData) {
      return false;
    }
    return true;
  });
}

export interface CatalogueFacets {
  inputModalities: Array<InferenceModality>;
  regions: Array<string>;
  providers: Array<{ slug: string; displayName: string }>;
}

/**
 * The filter options present in THIS catalogue.
 *
 * Derived from the entries rather than from the contract's enums, so the page
 * never offers a region or a provider that would select nothing. With an empty
 * catalogue every facet is empty, which is what lets the page hide the filter
 * bar instead of showing dropdowns that cannot narrow anything.
 */
export function catalogueFacets(entries: ReadonlyArray<ModelCatalogueEntry>): CatalogueFacets {
  const modalities = new Set<InferenceModality>();
  const regions = new Set<string>();
  const providers = new Map<string, string>();

  for (const entry of entries) {
    for (const modality of entry.capabilities.inputModalities) {
      modalities.add(modality);
    }
    for (const region of entry.regions) {
      regions.add(region);
    }
    for (const provider of entry.servingProviders) {
      providers.set(provider.slug, provider.displayName);
    }
  }

  return {
    inputModalities: [...modalities].sort(),
    regions: [...regions].sort(),
    providers: [...providers.entries()]
      .map(([slug, displayName]) => ({ slug, displayName }))
      .sort((left, right) => left.slug.localeCompare(right.slug)),
  };
}
