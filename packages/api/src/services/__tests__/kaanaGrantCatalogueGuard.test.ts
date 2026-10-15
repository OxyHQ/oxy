/**
 * The grant and settlement path never reads Oxy's own model catalogue for
 * price or identity (Kaana ADR 0002, amendment 2026-10-15: «el catálogo es de
 * Kaana»).
 *
 * Oxy's catalogue tables — models, publishers, revisions, price versions,
 * routing scorecards, power classes — and the services over them
 * (`inferenceCatalogue.service.ts` and its route resolver) serve ONLY the old
 * edge, `api.oxy.so/v1` and its `/v1/models`, until phase 5 deletes them. A
 * grant is rated from the `declaredCatalogue` Kaana relays
 * (`kaanaDeclaredCatalogue.service.ts`); a settlement is rated from the list
 * copied onto its grant. If a future change makes either of them import a
 * catalogue table or a catalogue resolver, this fails — before the bug is a
 * price that two catalogues disagree about.
 *
 * The check is textual on purpose: it needs no database, it runs in the
 * lint-sized unit suite, and it fails on the import line, naming it.
 *
 * To put a new file on the grant or settlement path, add it to
 * {@link NEW_PATH}. The one table the path may touch besides its own is
 * `inference_deployments`, from `kaanaGrantRoutes.service.ts` only, by Kaana's
 * deployment id, for the commercial permission to sell a route (see that file).
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC = join(__dirname, '..', '..');

/** The files that decide a grant's, or a settlement's, price, audience or capabilities. */
const NEW_PATH = [
  'services/kaanaGrant.service.ts',
  'services/kaanaGrantReads.service.ts',
  'services/kaanaGrantRoutes.service.ts',
  'services/kaanaGrantSigning.ts',
  'services/kaanaSettlement.service.ts',
  'services/kaanaDeclaredCatalogue.service.ts',
  'routes/internalKaana.ts',
] as const;

/** Oxy catalogue tables (identity, revisions, prices, scorecards, power classes). */
const CATALOGUE_TABLES = [
  'inferenceModels',
  'inferenceModelRevisions',
  'inferencePublishers',
  'inferenceProviders',
  'priceVersions',
  'priceVersionUnitPrices',
  'inferenceDeploymentRoutingScores',
  'inferenceModelPowerClasses',
  'inferenceModelEvaluations',
  'inferenceModelProvenance',
  'inferenceModelReleases',
  'inferenceModelReleaseArtifacts',
  'inferenceModelReleaseSignatures',
  'inferenceModelGpaiDocumentation',
  'inferenceRoutingProfileCandidates',
] as const;

/** Resolvers that read those tables (the old edge's route resolution and quoting by id). */
const CATALOGUE_READERS = [
  'resolveEdgeRoute',
  'selectRouteForViewer',
  'powerLevelCandidates',
  'listCatalogueForViewer',
  'getCatalogueEntryForViewer',
  'servableDeploymentRowIds',
  'listRoutingProfiles',
  'quoteUnits',
  'loadCandidatePrices',
] as const;

/**
 * What the path may import from the catalogue service: the application's
 * POLICY (routing constraints), request-shape types and pure helpers — nothing
 * that reads a model, revision, price or score.
 */
const CATALOGUE_SERVICE_ALLOWED = new Set([
  'CandidatePrice',
  'CatalogueViewer',
  'EdgeCapacityRequirement',
  'EdgeModalityRequirement',
  'RoutingConstraint',
  'RoutingConstraints',
  'TEXT_COMPLETION_MODALITY',
  'UNCONSTRAINED_ROUTING',
  'capabilityAdmits',
  'exceedsAmount',
  'routingConstraintsOf',
  'selectableDeploymentWhere',
  'violatedConstraints',
]);

/** The deployments table: route-level commercial permission, `kaanaGrantRoutes.service.ts` only. */
const DEPLOYMENT_TABLE_FILES = new Set(['services/kaanaGrantRoutes.service.ts']);

function code(file: string): string {
  return readFileSync(join(SRC, file), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

function importsFrom(source: string, modulePattern: RegExp): string[] {
  const names: string[] = [];
  for (const match of source.matchAll(/import\s+(?:type\s+)?\{([\s\S]*?)\}\s*from\s*'([^']+)'/g)) {
    if (!modulePattern.test(match[2] ?? '')) continue;
    for (const part of (match[1] ?? '').split(',')) {
      const name = part
        .trim()
        .replace(/^type\s+/, '')
        .split(/\s+as\s+/)[0]
        ?.trim();
      if (name) names.push(name);
    }
  }
  return names;
}

describe('the grant and settlement path does not read Oxy’s catalogue tables for price or identity', () => {
  it.each(NEW_PATH)('%s exists, so a rename cannot disarm the guard', (file) => {
    expect(existsSync(join(SRC, file))).toBe(true);
  });

  it.each(NEW_PATH)('%s names no Oxy catalogue table', (file) => {
    const source = code(file);
    const found = CATALOGUE_TABLES.filter((table) => new RegExp(`\\b${table}\\b`).test(source));
    expect(found).toEqual([]);
  });

  it.each(NEW_PATH)('%s calls no catalogue resolver', (file) => {
    const source = code(file);
    const found = CATALOGUE_READERS.filter((reader) => new RegExp(`\\b${reader}\\b`).test(source));
    expect(found).toEqual([]);
  });

  it.each(NEW_PATH)('%s imports only policy helpers from the catalogue service', (file) => {
    const imported = importsFrom(code(file), /inferenceCatalogue\.service$/);
    expect(imported.filter((name) => !CATALOGUE_SERVICE_ALLOWED.has(name))).toEqual([]);
  });

  it.each(NEW_PATH)('%s touches the deployments table only where it is allowed to', (file) => {
    const touches = /\binferenceDeployments\b/.test(code(file));
    expect(touches).toBe(DEPLOYMENT_TABLE_FILES.has(file));
  });

  it('the settlement rates from a price list handed by value, never a price version id', () => {
    const source = code('services/kaanaSettlement.service.ts');
    expect(source).toMatch(/priceSnapshot:\s*pricing\.price/);
  });

  it('keeps the guard honest: it does flag a catalogue read when one is present', () => {
    // The old edge's own service is the positive control for every pattern above.
    const edge = code('services/inferenceEdge.service.ts');
    expect(CATALOGUE_READERS.some((reader) => new RegExp(`\\b${reader}\\b`).test(edge))).toBe(true);
    const catalogue = code('services/inferenceCatalogue.service.ts');
    expect(CATALOGUE_TABLES.some((table) => new RegExp(`\\b${table}\\b`).test(catalogue))).toBe(
      true,
    );
  });
});
