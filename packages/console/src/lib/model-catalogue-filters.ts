import type { InferenceModality, ModelCatalogueEntry } from '@oxyhq/contracts';
import { isUnitPriceAtMost } from '@/lib/money';

/**
 * Catalogue filtering, as pure functions over `ModelCatalogueEntry[]`.
 *
 * Split out of the page so the predicates are testable without rendering, and
 * so each one sits next to the reason it is expressible at all: every filter
 * here reads a field the catalogue contract actually carries.
 *
 * The PRICE filter was deliberately absent while the API never populated
 * `pricing` — a filter that matched nothing for every value is indistinguishable
 * from "no model is that cheap". The catalogue serializer now publishes the
 * primary route's price snapshot, so the filter exists; `catalogueFacets`
 * reports whether any entry actually carries an input-token price, and the page
 * offers the control only when one does. That is the same guard the other
 * selects have, and it is what keeps this from becoming the vacuous control the
 * old comment warned about.
 */

/** How a price cap typed by a customer is denominated: per million tokens. */
export const PRICE_CAP_PER = 1_000_000;

/** The unit a price cap is compared against. */
const PRICE_CAP_UNIT = 'input_tokens';

export interface CatalogueFilters {
  /** Free text over model id, display name and publisher. */
  query: string;
  /** An input modality the model must accept. */
  inputModality: InferenceModality | null;
  /** An output modality the model must produce. */
  outputModality: InferenceModality | null;
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
  /**
   * The most a customer will pay per {@link PRICE_CAP_PER} input tokens, as an
   * exact decimal STRING in the catalogue's own currency.
   *
   * A string rather than a number for the reason `money.ts` exists: the values
   * being compared are exact decimals, and parsing the cap into a float would
   * reintroduce at the boundary precisely the error the ledger's representation
   * prevents everywhere else. It is also what a text input holds, so there is no
   * lossy hop in either direction.
   */
  maxPricePerMillionInputTokens: string | null;
}

export const EMPTY_CATALOGUE_FILTERS: CatalogueFilters = {
  query: '',
  inputModality: null,
  outputModality: null,
  toolsOnly: false,
  region: null,
  provider: null,
  zeroRetentionOnly: false,
  noTrainingOnly: false,
  maxPricePerMillionInputTokens: null,
};

/** True when no filter is narrowing the list. */
export function isEmptyFilterSet(filters: CatalogueFilters): boolean {
  return (
    filters.query.trim() === '' &&
    filters.inputModality === null &&
    filters.outputModality === null &&
    !filters.toolsOnly &&
    filters.region === null &&
    filters.provider === null &&
    !filters.zeroRetentionOnly &&
    !filters.noTrainingOnly &&
    !isPriceCapActive(filters.maxPricePerMillionInputTokens)
  );
}

/**
 * Whether a typed price cap is narrowing anything yet.
 *
 * Blank and half-typed values (`''`, `'0.'`, `'abc'`) are NOT active. A text
 * input passes through unparseable states on the way to every valid one, and
 * treating those as a cap of zero would empty the list under the customer's
 * hands as they type. `isUnitPriceAtMost` is the authority on what parses, so
 * this asks it rather than restating its regex.
 */
function isPriceCapActive(cap: string | null): boolean {
  if (cap === null || cap.trim() === '') {
    return false;
  }
  return isUnitPriceAtMost({ amount: cap, per: PRICE_CAP_PER }, { amount: cap, per: PRICE_CAP_PER }) !== undefined;
}

/**
 * Does an entry's published input-token price fall at or under the cap?
 *
 * Two absences are deliberately NOT exclusions:
 *
 *  - **No `pricing` at all.** An unpriced route is not an expensive one; it is a
 *    route Oxy has not published a price for (and one the edge refuses to serve).
 *    Excluding it would answer a question the customer did not ask.
 *  - **Priced, but not per input token.** An embedding or image model priced only
 *    per `embeddings` or `images` has no input-token price to compare. Same
 *    reasoning: it is not over the cap, it is outside the cap's units.
 *
 * Both are stated here rather than left to fall out of the code, because
 * "silently doing one of them" is the actual bug — a filter that quietly drops
 * every unpriced model looks exactly like a catalogue where nothing is cheap.
 */
function matchesPriceCap(entry: ModelCatalogueEntry, cap: string): boolean {
  const pricing = entry.pricing;
  if (pricing === undefined) {
    return true;
  }
  const inputPrice = pricing.unitPrices.find((unitPrice) => unitPrice.unit === PRICE_CAP_UNIT);
  if (inputPrice === undefined) {
    return true;
  }
  // `undefined` here would mean the SERVER sent an amount that is not an exact
  // decimal, which the contract's branded schema forbids. Keeping the row is the
  // conservative answer: a filter must not hide a model because a price could
  // not be read.
  return isUnitPriceAtMost(inputPrice, { amount: cap, per: PRICE_CAP_PER }) !== false;
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
    if (
      filters.outputModality !== null &&
      !entry.capabilities.outputModalities.includes(filters.outputModality)
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
    if (
      isPriceCapActive(filters.maxPricePerMillionInputTokens) &&
      filters.maxPricePerMillionInputTokens !== null &&
      !matchesPriceCap(entry, filters.maxPricePerMillionInputTokens)
    ) {
      return false;
    }
    return true;
  });
}

export interface CatalogueFacets {
  inputModalities: Array<InferenceModality>;
  outputModalities: Array<InferenceModality>;
  regions: Array<string>;
  providers: Array<{ slug: string; displayName: string }>;
  /**
   * Whether any entry publishes a price per input token.
   *
   * The price control's own facet. `false` means the cap could only ever match
   * everything, so the page hides the input rather than offering a filter whose
   * every value returns the whole list — the same property the selects have, for
   * the same reason.
   */
  hasInputTokenPricing: boolean;
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
  const inputModalities = new Set<InferenceModality>();
  const outputModalities = new Set<InferenceModality>();
  const regions = new Set<string>();
  const providers = new Map<string, string>();
  let hasInputTokenPricing = false;

  for (const entry of entries) {
    for (const modality of entry.capabilities.inputModalities) {
      inputModalities.add(modality);
    }
    for (const modality of entry.capabilities.outputModalities) {
      outputModalities.add(modality);
    }
    for (const region of entry.regions) {
      regions.add(region);
    }
    for (const provider of entry.servingProviders) {
      providers.set(provider.slug, provider.displayName);
    }
    // The facet reads the same field the predicate reads — a published price in
    // some OTHER unit cannot enable a control that compares input-token prices.
    if (entry.pricing?.unitPrices.some((unitPrice) => unitPrice.unit === PRICE_CAP_UNIT) === true) {
      hasInputTokenPricing = true;
    }
  }

  return {
    inputModalities: [...inputModalities].sort(),
    outputModalities: [...outputModalities].sort(),
    regions: [...regions].sort(),
    providers: [...providers.entries()]
      .map(([slug, displayName]) => ({ slug, displayName }))
      .sort((left, right) => left.slug.localeCompare(right.slug)),
    hasInputTokenPricing,
  };
}
