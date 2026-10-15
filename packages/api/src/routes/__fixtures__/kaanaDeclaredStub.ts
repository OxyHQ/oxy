// Keep reusable helpers outside __tests__ so Jest does not collect them as a suite.
//
// A stand-in for KAANA, for the grant and settlement suites: the declared
// catalogue it relays on `GET /internal/v1/models` and the deployments it
// publishes. The grant API reads nothing else for a model's identity, audience,
// capabilities and price (Kaana ADR 0002, amendment 2026-10-15), so a suite
// decides here what Kaana says — and can say something different from what
// Oxy's own (old-edge) catalogue tables hold, which is how a test proves a
// grant is rated from Kaana and not from them.
//
// `exportFixtureRows` is the one-time export of the amendment, in miniature:
// it reads the fixture rows the audio and model-line fixtures insert into Oxy's
// tables and declares them to the stub. Production code never does this.

import { eq, like, or } from 'drizzle-orm';
import { type DeclaredModel, declaredModelSchema } from '@kaana.ai/contracts/internal';
import type { UsageUnit } from '@oxy.so/contracts';
import { getDb } from '../../config/postgres';
import {
  inferenceDeployments,
  inferenceModelPowerClasses,
  inferenceModelRevisions,
  inferenceModels,
} from '../../db/schema';
import { priceVersions, priceVersionUnitPrices } from '../../db/schema/priceVersions';
import {
  createDeclaredCatalogueCache,
  overrideDeclaredCatalogueSource,
} from '../../services/kaanaDeclaredCatalogue.service';
import {
  type DeploymentPublication,
  overrideDeploymentPublicationSource,
  type PublishedRoute,
} from '../../services/kaanaDeploymentPublication.service';

/** Publisher slugs the fixtures use for the models they insert. */
const FIXTURE_PUBLISHER_PREFIXES = ['kgpub', 'apub'] as const;

export interface DeclaredModelInput {
  readonly modelId: string;
  readonly audience?: 'public' | 'platform_internal';
  readonly inputModalities?: readonly string[];
  readonly outputModalities?: readonly string[];
  readonly apiFormats?: readonly string[];
  readonly realtime?: { readonly transports: readonly string[]; readonly sessionKinds: readonly string[] };
  readonly maxContextTokens?: number;
  readonly maxOutputTokens?: number;
  readonly powerClass?: 'instant' | 'medium' | 'high' | 'pro' | 'ultra';
  readonly deprecation?: 'active' | 'deprecated' | 'retired';
  /** Absent: the model declares no price per unit (the BYOK-only case). */
  readonly pricing?: {
    readonly priceVersionId: string;
    readonly currency?: string;
    readonly unitPrices: readonly {
      readonly unit: UsageUnit;
      readonly amount: string;
      readonly per: number;
    }[];
  };
}

/** A model as Kaana's `configs/public-catalogue.json` declares it, parsed by the contract. */
export function declaredModel(input: DeclaredModelInput): DeclaredModel {
  const [publisher = 'fixture'] = input.modelId.split('/');
  const currency = input.pricing?.currency ?? 'USD';
  return declaredModelSchema.parse({
    modelId: input.modelId,
    audience: input.audience ?? 'public',
    publisher: { slug: publisher, displayName: publisher },
    displayName: input.modelId,
    capabilities: {
      inputModalities: [...(input.inputModalities ?? ['text'])],
      outputModalities: [...(input.outputModalities ?? ['text'])],
      tools: true,
      parallelToolCalls: false,
      structuredOutput: false,
      jsonMode: false,
      reasoning: false,
      streaming: true,
      promptCaching: false,
      maxContextTokens: input.maxContextTokens ?? 32_000,
      maxOutputTokens: input.maxOutputTokens ?? 4_096,
      ...(input.apiFormats === undefined ? {} : { apiFormats: [...input.apiFormats] }),
      ...(input.realtime === undefined
        ? {}
        : {
            realtime: {
              transports: [...input.realtime.transports],
              sessionKinds: [...input.realtime.sessionKinds],
            },
          }),
    },
    license: {
      licenseId: 'LicenseRef-Fixture',
      displayName: 'Fixture',
      commercialUseAllowed: true,
      requiresAttribution: false,
    },
    provenance: { releaseKind: 'third_party_hosted' },
    regions: [],
    dataPolicy: {
      retainsPayloads: false,
      retentionDays: 0,
      trainsOnCustomerData: false,
      zeroDataRetentionAvailable: true,
      subprocessors: [],
    },
    ...(input.pricing === undefined
      ? {}
      : {
          pricing: {
            priceVersionId: input.pricing.priceVersionId,
            currency,
            unitPrices: input.pricing.unitPrices.map((entry) => ({ ...entry, currency })),
          },
        }),
    deprecation: { status: input.deprecation ?? 'active' },
    evaluations: [],
    ...(input.powerClass === undefined ? {} : { powerClass: input.powerClass }),
  });
}

export class KaanaStub {
  /** The declared catalogue, by model id. */
  readonly models = new Map<string, DeclaredModel>();
  /** The deployments Kaana publishes, by deployment id. */
  readonly routes = new Map<string, PublishedRoute>();
  /** Reads of the declared catalogue Kaana served; the cache calls this per refresh. */
  reads = 0;
  /** Whether the catalogue read fails, as Kaana being unreachable. */
  failing = false;
  /** Whether the stub re-exports the fixture rows on every read. */
  private exporting = false;
  private exportedModels = new Map<string, DeclaredModel>();
  private exportedRoutes = new Map<string, PublishedRoute>();

  /** Replace what Kaana declares for a model (keep everything else). */
  declare(model: DeclaredModel): void {
    this.models.set(model.modelId, model);
  }

  publish(route: PublishedRoute): void {
    this.routes.set(route.deploymentId, route);
  }

  /** Declare, on every read, the models the fixtures put in Oxy's tables. */
  followFixtures(): void {
    this.exporting = true;
  }

  /** Models a test declared on top of (or instead of) the exported fixtures. */
  private readonly overrides = new Map<string, DeclaredModel | 'drop'>();

  override(modelId: string, model: DeclaredModel | 'drop'): void {
    this.overrides.set(modelId, model);
  }

  clearOverrides(): void {
    this.overrides.clear();
  }

  async snapshot(): Promise<unknown> {
    this.reads += 1;
    if (this.failing) throw new Error('Kaana is unreachable');
    if (this.exporting) await this.exportFixtureRows();
    const models = new Map([...this.exportedModels, ...this.models]);
    for (const [modelId, override] of this.overrides) {
      if (override === 'drop') models.delete(modelId);
      else models.set(modelId, override);
    }
    return { schemaVersion: 1, models: [...models.values()] };
  }

  async publication(): Promise<DeploymentPublication> {
    if (this.exporting) await this.exportFixtureRows();
    const routes = new Map([...this.exportedRoutes, ...this.routes]);
    return {
      status: 'observed',
      snapshotId: 'stub',
      deploymentIds: new Set(routes.keys()),
      routes,
      observedAt: Date.now(),
    };
  }

  /** Install this stub as the process's Kaana. Returns what restores the previous one. */
  install(): () => void {
    const restoreCatalogue = overrideDeclaredCatalogueSource(
      createDeclaredCatalogueCache({ readDeclaredCatalogue: () => this.snapshot() }, { ttlMs: 0 }),
    );
    const restorePublication = overrideDeploymentPublicationSource({
      current: async () => this.publication(),
    });
    return () => {
      restorePublication();
      restoreCatalogue();
    };
  }

  /**
   * The one-time export, in miniature: declare what the fixtures inserted into
   * Oxy's catalogue tables — each model once, at the list of its first
   * deployment — and publish each of their deployments.
   */
  async exportFixtureRows(): Promise<void> {
    const db = getDb();
    const rows = await db
      .select({
        modelId: inferenceModels.modelId,
        inputModalities: inferenceModels.inputModalities,
        outputModalities: inferenceModels.outputModalities,
        apiFormats: inferenceModels.apiFormats,
        realtimeTransports: inferenceModels.realtimeTransports,
        realtimeSessionKinds: inferenceModels.realtimeSessionKinds,
        maxContextTokens: inferenceModels.maxContextTokens,
        maxOutputTokens: inferenceModels.maxOutputTokens,
        revision: inferenceModelRevisions.revision,
        deploymentId: inferenceDeployments.internalRouteId,
        provider: inferenceDeployments.providerSlug,
        regions: inferenceDeployments.regions,
        priceVersionId: inferenceDeployments.priceVersionId,
        currency: priceVersions.currency,
        powerClass: inferenceModelPowerClasses.powerClass,
      })
      .from(inferenceDeployments)
      .innerJoin(
        inferenceModelRevisions,
        eq(inferenceDeployments.modelRevisionId, inferenceModelRevisions.id),
      )
      .innerJoin(inferenceModels, eq(inferenceModelRevisions.modelId, inferenceModels.id))
      .leftJoin(priceVersions, eq(inferenceDeployments.priceVersionId, priceVersions.id))
      .leftJoin(
        inferenceModelPowerClasses,
        eq(inferenceModelPowerClasses.modelId, inferenceModels.modelId),
      )
      .where(
        or(
          ...FIXTURE_PUBLISHER_PREFIXES.map((prefix) =>
            like(inferenceModels.publisherSlug, `${prefix}%`),
          ),
        ),
      );
    const priceRows = await db.select().from(priceVersionUnitPrices);
    const unitPricesOf = new Map<string, { unit: UsageUnit; amount: string; per: number }[]>();
    for (const price of priceRows) {
      const list = unitPricesOf.get(price.priceVersionId) ?? [];
      list.push({ unit: price.unit, amount: price.amount, per: price.per });
      unitPricesOf.set(price.priceVersionId, list);
    }
    const models = new Map<string, DeclaredModel>();
    const routes = new Map<string, PublishedRoute>();
    for (const row of rows) {
      if (row.modelId === null || row.deploymentId === null) continue;
      routes.set(row.deploymentId, {
        deploymentId: row.deploymentId,
        modelReference: `${row.modelId}@${row.revision}`,
        provider: row.provider,
        regions: row.regions,
      });
      if (models.has(row.modelId)) continue;
      const unitPrices =
        row.priceVersionId === null ? undefined : unitPricesOf.get(row.priceVersionId);
      models.set(
        row.modelId,
        declaredModel({
          modelId: row.modelId,
          inputModalities: row.inputModalities,
          outputModalities: row.outputModalities,
          ...(row.apiFormats === null ? {} : { apiFormats: row.apiFormats }),
          ...(row.realtimeTransports === null || row.realtimeSessionKinds === null
            ? {}
            : {
                realtime: {
                  transports: row.realtimeTransports,
                  sessionKinds: row.realtimeSessionKinds,
                },
              }),
          maxContextTokens: row.maxContextTokens,
          maxOutputTokens: row.maxOutputTokens,
          ...(row.powerClass === null ? {} : { powerClass: row.powerClass }),
          ...(row.priceVersionId === null || unitPrices === undefined || unitPrices.length === 0
            ? {}
            : {
                pricing: {
                  priceVersionId: row.priceVersionId,
                  currency: row.currency ?? 'USD',
                  unitPrices,
                },
              }),
        }),
      );
    }
    this.exportedModels = models;
    this.exportedRoutes = routes;
  }
}
