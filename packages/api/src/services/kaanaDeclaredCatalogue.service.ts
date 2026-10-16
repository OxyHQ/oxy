/**
 * Kaana's declared catalogue, as Oxy reads it to rate a grant.
 *
 * Kaana ADR 0002, amendment 2026-10-15 («el catálogo es de Kaana»): the model
 * catalogue — identity, licence, provenance, data policy, capabilities, voices,
 * audience and the LIST PRICE per unit — is `configs/public-catalogue.json` in
 * Kaana, and nobody else's. Kaana relays it, whole, as the `declaredCatalogue`
 * member of its signed `GET /internal/v1/models` (`declaredCatalogueSchema`,
 * `@kaana.ai/contracts/internal` 4.3.0). The grant API (`kaanaGrant.service.ts`)
 * and the settlement (`kaanaSettlement.service.ts`) take a model's price,
 * audience and capabilities from here and from nowhere else: they never read
 * the model, revision, price or scorecard tables of Oxy's own catalogue, which
 * serve only the old edge (`api.oxy.so/v1`) until phase 5 deletes them
 * (`docs/inference/kaana-grants.md`, «Where the price comes from»). A guard
 * test (`kaanaGrantCatalogueGuard.test.ts`) fails on the first import that
 * crosses that line.
 *
 * ## Cached in memory, not persisted
 *
 * The ADR: Oxy «lo cachea en memoria con la versión de contrato, no lo
 * persiste». One signed read is kept for {@link DECLARED_CATALOGUE_TTL_MS},
 * single-flight; if a refresh fails the last good read keeps being served until
 * it is {@link DECLARED_CATALOGUE_MAX_STALE_MS} old, after which the answer is
 * `unavailable` and a grant is refused (`service_unavailable`) — «we cannot
 * read what Kaana declares» is never «every model is free».
 *
 * ## Versioned by `priceVersionId`
 *
 * A model's `pricing.priceVersionId` identifies its list. A new price is a new
 * id; a published id never changes. The cache enforces the second half: if an
 * id Oxy has already seen reappears with different entries, that model is
 * `price_version_changed` and prices nothing until Kaana publishes a new id,
 * rather than rating a grant at a list that two readers could disagree about.
 *
 * What a grant keeps is not this cache but a COPY of the entries it was rated
 * at (`kaana_grant_line_unit_prices`), so its settlement is rated at exactly
 * that version even after Kaana has moved on or this process has restarted.
 *
 * ## Typed refusals, never zero
 *
 * No declared model, no `pricing`, a unit the list does not price: each is a
 * {@link DeclaredPriceError} with a code. A model without `pricing` is the
 * BYOK-only case (the contract: «absent for a model a customer cannot buy per
 * unit»); an unlisted unit is a unit Oxy will not guess a price for.
 */

import {
  type DeclaredCatalogue,
  type DeclaredModel,
  declaredCatalogueSchema,
} from '@kaana.ai/contracts/internal';
import type { UsageUnit } from '@oxy.so/contracts';
import { type KaanaDataPlaneConfig, resolveKaanaDataPlane } from '../config/kaanaDataPlane';
import { logger } from '../utils/logger';
import {
  createHttpKaanaDeclaredCatalogueReader,
  type KaanaDeclaredCatalogueReader,
} from './httpKaanaClient';
import type { PriceSnapshotInput } from './inferenceLedger.service';

export const DECLARED_CATALOGUE_TTL_MS = 60_000;
export const DECLARED_CATALOGUE_MAX_STALE_MS = 5 * 60_000;
const DECLARED_CATALOGUE_READ_TIMEOUT_MS = 10_000;
/** Versions remembered across refreshes; far above the lists of a catalogue of hundreds. */
const MAX_REMEMBERED_PRICE_VERSIONS = 20_000;

/* -------------------------------------------------------------------------- */
/*  The view                                                                   */
/* -------------------------------------------------------------------------- */

/** One observation of Kaana's declared catalogue. */
export interface DeclaredCatalogueObservation {
  readonly status: 'observed';
  /** Every declared model by `modelId` (`publisher/model`). */
  readonly models: ReadonlyMap<string, DeclaredModel>;
  /**
   * Models whose `priceVersionId` was seen before with different entries. A
   * published version never changes, so these price nothing.
   */
  readonly changedPriceVersions: ReadonlySet<string>;
  readonly observedAt: number;
}

export type DeclaredCatalogueView =
  | DeclaredCatalogueObservation
  | { readonly status: 'unavailable' }
  /** This process has no Kaana binding: there is nothing to read the catalogue from. */
  | { readonly status: 'not-configured' };

export interface DeclaredCatalogueSource {
  current(): Promise<DeclaredCatalogueObservation | { readonly status: 'unavailable' }>;
  /** A list this process has observed, by Kaana's `priceVersionId`. */
  priceVersion(priceVersionId: string): PriceSnapshotInput | undefined;
}

/* -------------------------------------------------------------------------- */
/*  Typed pricing refusals                                                     */
/* -------------------------------------------------------------------------- */

export type DeclaredPriceErrorCode =
  | 'model_not_declared'
  | 'model_retired'
  | 'model_not_priced'
  | 'price_version_changed'
  | 'unit_not_priced';

/**
 * A model or a unit Oxy cannot rate. Thrown by the pricing helpers and mapped
 * by the grant (`no_route_available` / `model_not_found`) and by the settlement
 * (a permanent rejection). Never a zero price.
 */
export class DeclaredPriceError extends Error {
  constructor(
    readonly code: DeclaredPriceErrorCode,
    message: string,
    readonly detail: { readonly modelId?: string; readonly units?: readonly UsageUnit[] } = {},
  ) {
    super(message);
    this.name = 'DeclaredPriceError';
  }
}

/** A declared model's list as a price snapshot; `undefined` when the model declares none. */
export function priceSnapshotOf(model: DeclaredModel): PriceSnapshotInput | undefined {
  const pricing = model.pricing;
  if (pricing === undefined) return undefined;
  return {
    priceVersionId: pricing.priceVersionId,
    currency: pricing.currency,
    unitPrices: pricing.unitPrices.map((entry) => ({
      unit: entry.unit,
      amount: entry.amount,
      per: entry.per,
    })),
  };
}

/**
 * The list a grant rates `model` at, or the typed reason there is none. The
 * single place «can this model be priced» is decided for the grant.
 */
export function requirePriceSnapshot(
  observation: DeclaredCatalogueObservation,
  model: DeclaredModel,
): PriceSnapshotInput {
  const snapshot = priceSnapshotOf(model);
  if (snapshot === undefined) {
    throw new DeclaredPriceError(
      'model_not_priced',
      `${model.modelId} declares no price per unit.`,
      { modelId: model.modelId },
    );
  }
  if (observation.changedPriceVersions.has(snapshot.priceVersionId)) {
    throw new DeclaredPriceError(
      'price_version_changed',
      `${model.modelId} republished priceVersionId ${snapshot.priceVersionId} with different prices.`,
      { modelId: model.modelId },
    );
  }
  return snapshot;
}

/** The units of `quantities` (with a positive quantity) that `snapshot` has no price for. */
export function unpricedUnits(
  snapshot: Pick<PriceSnapshotInput, 'unitPrices'>,
  quantities: Partial<Record<UsageUnit, number>>,
): UsageUnit[] {
  const priced = new Set(snapshot.unitPrices.map((entry) => entry.unit));
  return (Object.entries(quantities) as [UsageUnit, number | undefined][])
    .filter(([unit, quantity]) => typeof quantity === 'number' && quantity > 0 && !priced.has(unit))
    .map(([unit]) => unit);
}

/**
 * Whether a viewer may be offered a model by its declared AUDIENCE. `public`
 * models are everyone's; `platform_internal` ones are for official Oxy products
 * only (the viewer's scopes already encode that: `resolveCatalogueViewer`).
 */
export function audienceAdmits(
  viewerScopes: readonly string[],
  model: Pick<DeclaredModel, 'audience'>,
): boolean {
  return model.audience === 'public' || viewerScopes.includes('platform_internal');
}

/** A declared model that may still be called; `retired` models are not. */
export function isCallable(model: Pick<DeclaredModel, 'deprecation'>): boolean {
  return model.deprecation.status !== 'retired';
}

/* -------------------------------------------------------------------------- */
/*  The cache                                                                  */
/* -------------------------------------------------------------------------- */

/** `3.0` and `3.000000000000` are one amount; compare them as exact decimal text. */
function normalizedAmount(amount: string): string {
  return amount.includes('.') ? amount.replace(/0+$/, '').replace(/\.$/, '') : amount;
}

function samePrices(left: PriceSnapshotInput, right: PriceSnapshotInput): boolean {
  if (left.currency !== right.currency || left.unitPrices.length !== right.unitPrices.length) {
    return false;
  }
  const byUnit = new Map(right.unitPrices.map((entry) => [entry.unit, entry] as const));
  return left.unitPrices.every((entry) => {
    const other = byUnit.get(entry.unit);
    return (
      other !== undefined &&
      other.per === entry.per &&
      normalizedAmount(other.amount) === normalizedAmount(entry.amount)
    );
  });
}

export function createDeclaredCatalogueCache(
  reader: Pick<KaanaDeclaredCatalogueReader, 'readDeclaredCatalogue'>,
  options: {
    readonly ttlMs?: number;
    readonly maxStaleMs?: number;
    readonly now?: () => number;
  } = {},
): DeclaredCatalogueSource {
  const ttlMs = options.ttlMs ?? DECLARED_CATALOGUE_TTL_MS;
  const maxStaleMs = options.maxStaleMs ?? DECLARED_CATALOGUE_MAX_STALE_MS;
  const now = options.now ?? Date.now;
  const versions = new Map<string, PriceSnapshotInput>();
  let last: DeclaredCatalogueObservation | undefined;
  let inFlight:
    | Promise<DeclaredCatalogueObservation | { readonly status: 'unavailable' }>
    | undefined;

  const observe = (catalogue: DeclaredCatalogue): DeclaredCatalogueObservation => {
    const models = new Map<string, DeclaredModel>();
    const changed = new Set<string>();
    for (const model of catalogue.models) {
      if (models.has(model.modelId)) {
        // Two declarations of one model: which is true is not Oxy's to guess.
        throw new Error(`the declared catalogue declares ${model.modelId} twice`);
      }
      models.set(model.modelId, model);
      const snapshot = priceSnapshotOf(model);
      if (snapshot === undefined) continue;
      const known = versions.get(snapshot.priceVersionId);
      if (known === undefined) {
        if (versions.size >= MAX_REMEMBERED_PRICE_VERSIONS) {
          const oldest = versions.keys().next().value;
          if (oldest !== undefined) versions.delete(oldest);
        }
        versions.set(snapshot.priceVersionId, snapshot);
      } else if (!samePrices(known, snapshot)) {
        changed.add(snapshot.priceVersionId);
        logger.error(
          'inference.declared_catalogue.price_version_changed',
          new Error('a published priceVersionId was republished with different prices'),
          {
            component: 'inference-kaana',
            modelId: model.modelId,
            priceVersionId: snapshot.priceVersionId,
          },
        );
      }
    }
    return { status: 'observed', models, changedPriceVersions: changed, observedAt: now() };
  };

  const refresh = async (): Promise<
    DeclaredCatalogueObservation | { readonly status: 'unavailable' }
  > => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DECLARED_CATALOGUE_READ_TIMEOUT_MS);
    try {
      const raw = await reader.readDeclaredCatalogue(controller.signal);
      const parsed = declaredCatalogueSchema.safeParse(raw);
      if (!parsed.success) {
        throw new Error(
          `the declared catalogue does not match @kaana.ai/contracts: ${parsed.error.issues[0]?.path.join('.') ?? ''} ${parsed.error.issues[0]?.message ?? ''}`,
        );
      }
      last = observe(parsed.data);
      return last;
    } catch (error) {
      logger.warn('inference.declared_catalogue.read_failed', {
        component: 'inference-kaana',
        error: error instanceof Error ? error.message : String(error),
        lastObservedAt: last?.observedAt,
      });
      if (last !== undefined && now() - last.observedAt <= maxStaleMs) return last;
      return { status: 'unavailable' };
    } finally {
      clearTimeout(timer);
    }
  };

  return {
    current() {
      if (last !== undefined && now() - last.observedAt < ttlMs) return Promise.resolve(last);
      inFlight ??= refresh().finally(() => {
        inFlight = undefined;
      });
      return inFlight;
    },
    priceVersion(priceVersionId) {
      return versions.get(priceVersionId);
    },
  };
}

function configuredSource(): DeclaredCatalogueSource | undefined {
  const resolution = resolveKaanaDataPlane();
  if (resolution.status !== 'configured') return undefined;
  const config: KaanaDataPlaneConfig = resolution.config;
  return createDeclaredCatalogueCache(createHttpKaanaDeclaredCatalogueReader(config));
}

let source: DeclaredCatalogueSource | undefined = configuredSource();

/** Read Kaana's declared catalogue, naming the case where this process has no binding. */
export async function currentDeclaredCatalogue(): Promise<DeclaredCatalogueView> {
  const configured = source;
  return configured === undefined ? { status: 'not-configured' } : configured.current();
}

/** A list this process has observed for `priceVersionId`, if any. */
export function observedPriceVersion(priceVersionId: string): PriceSnapshotInput | undefined {
  return source?.priceVersion(priceVersionId);
}

/**
 * Replace the process-wide source (tests, and nothing else). Returns the
 * function that restores the previous one.
 */
export function overrideDeclaredCatalogueSource(
  replacement: DeclaredCatalogueSource | undefined,
): () => void {
  const previous = source;
  source = replacement;
  return () => {
    source = previous;
  };
}
