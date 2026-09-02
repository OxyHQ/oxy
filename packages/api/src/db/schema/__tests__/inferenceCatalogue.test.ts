/**
 * The inference catalogue's schema, against a REAL Postgres.
 *
 * One `describe` per decision the schema files argue for, because each of them
 * is the kind a comment cannot keep true: that a published revision's identity
 * cannot be edited, that the `alia/*` namespace cannot be re-badged, that a
 * route is unselectable until somebody approves it, and that the two halves of
 * the customer-safe boundary cover the table between them.
 *
 * Every row carries a per-test random identifier, so no assertion depends on a
 * table being empty and no aggregate reads a sibling file's rows.
 */

import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { eq, sql } from 'drizzle-orm';
import { getTableColumns } from 'drizzle-orm';
import {
  modelRevisionLabelSchema,
  modelSlugSchema,
  publisherSlugSchema,
} from '@oxyhq/contracts';
import { closePostgres, connectPostgres, getDb } from '../../../config/postgres';
import { inferenceDeployments } from '../inferenceDeployments';
import { inferenceModelRevisions, INFERENCE_REVISION_IMMUTABLE_COLUMNS, INFERENCE_REVISION_IMMUTABILITY_TRIGGER_NAME } from '../inferenceModelRevisions';
import { inferenceModels } from '../inferenceModels';
import {
  INFERENCE_MODEL_PROVENANCE_DDL,
  INFERENCE_MODEL_PROVENANCE_TRIGGER_DDL,
  INFERENCE_MODEL_PROVENANCE_TRIGGER_NAME,
  INFERENCE_REVISION_PROVENANCE_DDL,
  INFERENCE_REVISION_PROVENANCE_TRIGGER_DDL,
  INFERENCE_REVISION_PROVENANCE_TRIGGER_NAME,
} from '../inferenceModelProvenance';
import { inferenceProviders } from '../inferenceProviders';
import { inferencePublishers } from '../inferencePublishers';
import { inferenceRoutingProfileCandidates } from '../inferenceRoutingProfileCandidates';
import { inferenceRoutingProfiles } from '../inferenceRoutingProfiles';
import { INFERENCE_DEPLOYMENTS_PROTECTED_COLUMNS } from '../protectedColumns';
import {
  CUSTOMER_SAFE_DEPLOYMENT_COLUMNS,
  INTERNAL_DEPLOYMENT_COLUMNS,
} from '../../../services/inferenceCatalogue.service';

/** Postgres `check_violation` — also what the immutability trigger raises. */
const CHECK_VIOLATION = '23514';
/** Postgres `unique_violation`. */
const UNIQUE_VIOLATION = '23505';
/** Postgres `generated_always` — writing a GENERATED column. */
const GENERATED_ALWAYS = '428C9';

/** The migration that installs the provenance triggers, read back as text. */
const PROVENANCE_MIGRATION = '0050_inference_model_provenance_marking.sql';

beforeAll(async () => {
  await connectPostgres();
});

afterAll(async () => {
  await closePostgres();
});

/** A short, slug-safe suffix so every fixture owns its own identifiers. */
function suffix(): string {
  return randomUUID().replace(/-/g, '').slice(0, 10);
}

function pgErrorCode(error: unknown): string | undefined {
  for (let current = error; current instanceof Error; current = current.cause) {
    const code: unknown = Reflect.get(current, 'code');
    if (typeof code === 'string') return code;
  }
  return undefined;
}

async function rejection(query: Promise<unknown>): Promise<unknown> {
  try {
    await query;
  } catch (error) {
    return error;
  }
  throw new Error('Expected the query to be rejected by a constraint, but it succeeded.');
}

async function insertPublisher(slug = `pub${suffix()}`): Promise<string> {
  await getDb().insert(inferencePublishers).values({ slug, displayName: 'Fixture Publisher' });
  return slug;
}

/** The NOT NULL capability/licence columns every model fixture needs. */
function modelDefaults() {
  return {
    displayName: 'Fixture Model',
    inputModalities: ['text'],
    outputModalities: ['text'],
    supportsTools: false,
    supportsParallelToolCalls: false,
    supportsStructuredOutput: false,
    supportsJsonMode: false,
    supportsReasoning: false,
    supportsStreaming: true,
    supportsPromptCaching: false,
    maxContextTokens: 128_000,
    maxOutputTokens: 4096,
    licenseId: 'fixture-1.0',
    licenseDisplayName: 'Fixture Licence',
    commercialUseAllowed: true,
    requiresAttribution: false,
    releaseKind: 'open_weight' as const,
  };
}

async function insertModel(publisherSlug: string, slug = `mdl${suffix()}`): Promise<string> {
  const [row] = await getDb()
    .insert(inferenceModels)
    .values({ publisherSlug, slug, ...modelDefaults() })
    .returning({ id: inferenceModels.id });
  return row.id;
}

async function insertRevision(modelId: string, revision = `rev${suffix()}`): Promise<string> {
  const [row] = await getDb()
    .insert(inferenceModelRevisions)
    .values({ modelId, revision, releasedAt: new Date(), isCurrent: true })
    .returning({ id: inferenceModelRevisions.id });
  return row.id;
}

async function insertProvider(slug = `prv${suffix()}`): Promise<string> {
  await getDb().insert(inferenceProviders).values({
    slug,
    displayName: 'Fixture Provider',
    kind: 'third_party',
    retainsPayloads: false,
    retentionDays: 0,
    trainsOnCustomerData: false,
    zeroDataRetentionAvailable: true,
  });
  return slug;
}

/* -------------------------------------------------------------------------- */

describe('the identifier grammars agree with the wire contract, in both directions', () => {
  // A restatement in POSIX ARE of a pattern zod expresses as a JS RegExp. Held
  // here against real rows, because the two are different languages and a
  // divergence is silent: a slug the API accepts but the database refuses is a
  // 500, and one the database accepts but the API refuses is unreachable data.
  const acceptedSlugs = ['openai', 'gpt-5', 'llama-3.1-70b', 'a', 'x.y_no', 'a-b.c'];
  const refusedSlugs = ['OpenAI', '-leading', 'trailing-', 'has space', 'has/slash', ''];

  it.each(acceptedSlugs)('accepts the slug %p that the contract accepts', async (slug) => {
    // Positive control on the contract side: if the contract stopped accepting
    // these, this case would be asserting agreement about the wrong set.
    expect(publisherSlugSchema.safeParse(slug).success).toBe(true);
    expect(modelSlugSchema.safeParse(slug).success).toBe(true);

    const scoped = `${slug}${suffix()}`.toLowerCase();
    await expect(insertPublisher(scoped)).resolves.toBe(scoped);
  });

  it.each(refusedSlugs)('refuses the slug %p that the contract refuses', async (slug) => {
    expect(publisherSlugSchema.safeParse(slug).success).toBe(false);
    expect(pgErrorCode(await rejection(insertPublisher(slug)))).toBe(CHECK_VIOLATION);
  });

  it('preserves revision case, as the contract does, and refuses what it refuses', async () => {
    const publisher = await insertPublisher();
    const modelId = await insertModel(publisher);

    // `v1.2-Instruct` is upper-case and legal: upstream revision labels
    // routinely are, which is why the revision pattern is not the slug pattern.
    expect(modelRevisionLabelSchema.safeParse('v1.2-Instruct').success).toBe(true);
    await expect(insertRevision(modelId, 'v1.2-Instruct')).resolves.toEqual(expect.any(String));

    expect(modelRevisionLabelSchema.safeParse('has space').success).toBe(false);
    expect(
      pgErrorCode(
        await rejection(
          getDb()
            .insert(inferenceModelRevisions)
            .values({ modelId, revision: 'has space', releasedAt: new Date() })
        )
      )
    ).toBe(CHECK_VIOLATION);
  });
});

describe('the canonical model id is composed by the database', () => {
  it('is <publisher>/<model>, and cannot be written', async () => {
    const publisher = await insertPublisher();
    const modelId = await insertModel(publisher, `gpt${suffix()}`);

    const [row] = await getDb()
      .select({ modelId: inferenceModels.modelId, slug: inferenceModels.slug })
      .from(inferenceModels)
      .where(eq(inferenceModels.id, modelId));

    expect(row.modelId).toBe(`${publisher}/${row.slug}`);

    // A serializer composing this string would be bypassable; a GENERATED
    // column is not. `428C9` is Postgres refusing the write outright.
    const forced = getDb().execute(
      sql`update inference_models set model_id = 'someone/else' where id = ${modelId}`
    );
    expect(pgErrorCode(await rejection(forced))).toBe(GENERATED_ALWAYS);
  });
});

describe('the alia/* namespace is reserved for first-party releases', () => {
  beforeAll(async () => {
    // The reservation names the literal slug `alia`, so the row has to exist for
    // the constraint to have anything to fire on. Insert-if-absent: the seed
    // script creates it in a real deployment.
    await getDb()
      .insert(inferencePublishers)
      .values({ slug: 'alia', displayName: 'Alia' })
      .onConflictDoNothing({ target: inferencePublishers.slug });
  });

  it.each(['open_weight', 'third_party_hosted'] as const)(
    'refuses a %s model under alia/*',
    async (releaseKind) => {
      const rejected = getDb()
        .insert(inferenceModels)
        .values({
          publisherSlug: 'alia',
          slug: `rebadged${suffix()}`,
          ...modelDefaults(),
          releaseKind,
        });
      expect(pgErrorCode(await rejection(rejected))).toBe(CHECK_VIOLATION);
    }
  );

  it.each(['first_party_original', 'first_party_derived'] as const)(
    'accepts a %s model under alia/*',
    async (releaseKind) => {
      await expect(
        getDb()
          .insert(inferenceModels)
          .values({
            publisherSlug: 'alia',
            slug: `real${suffix()}`,
            ...modelDefaults(),
            releaseKind,
          })
      ).resolves.toBeDefined();
    }
  );

  it('leaves the same release kinds legal under another publisher', async () => {
    // The constraint is an IMPLICATION, not a biconditional: a first-party
    // release published under a partner's namespace is legitimate. Without this
    // case, tightening it to a biconditional would go unnoticed.
    const publisher = await insertPublisher();
    await expect(
      getDb()
        .insert(inferenceModels)
        .values({
          publisherSlug: publisher,
          slug: `derived${suffix()}`,
          ...modelDefaults(),
          releaseKind: 'first_party_derived',
        })
    ).resolves.toBeDefined();
  });
});

describe('a published revision is immutable', () => {
  it('has its trigger installed', async () => {
    const rows = await getDb().execute<{ tgname: string }>(
      sql`select tgname from pg_trigger where tgname = ${INFERENCE_REVISION_IMMUTABILITY_TRIGGER_NAME}`
    );
    // Vacuity floor: a trigger absent and a query that read nothing both return
    // an empty set, so the count is asserted rather than the emptiness.
    expect(rows).toHaveLength(1);
  });

  it.each([...INFERENCE_REVISION_IMMUTABLE_COLUMNS])('refuses to change %s', async (column) => {
    const publisher = await insertPublisher();
    const modelId = await insertModel(publisher);
    const otherModelId = await insertModel(publisher);
    const revisionId = await insertRevision(modelId);

    // Driven from the exported list, so adding a column there without adding it
    // to the trigger's DDL fails here, and removing it from the DDL without
    // removing it from the list fails here too. Neither half drifts alone.
    const value =
      column === 'model_id'
        ? sql`${otherModelId}`
        : column === 'revision'
          ? sql`'moved'`
          : column === 'released_at'
            ? sql`now() - interval '1 day'`
            : sql`'sha256:' || repeat('a', 64)`;

    const update = getDb().execute(
      sql`update inference_model_revisions set ${sql.raw(`"${column}"`)} = ${value} where id = ${revisionId}`
    );
    expect(pgErrorCode(await rejection(update))).toBe(CHECK_VIOLATION);
  });

  it.each(['is_current', 'retired_at', 'model_card_url'])(
    'still allows %s to change',
    async (column) => {
      const publisher = await insertPublisher();
      const modelId = await insertModel(publisher);
      const revisionId = await insertRevision(modelId);

      // The negative control for the case above: if the trigger froze the whole
      // row, every one of those assertions would pass for the wrong reason.
      const value =
        column === 'is_current'
          ? sql`false`
          : column === 'retired_at'
            ? sql`now() + interval '1 day'`
            : sql`'https://example.test/card'`;

      await expect(
        getDb().execute(
          sql`update inference_model_revisions set ${sql.raw(`"${column}"`)} = ${value} where id = ${revisionId}`
        )
      ).resolves.toBeDefined();
    }
  );
});

describe('at most one current revision per model', () => {
  it('refuses a second', async () => {
    const publisher = await insertPublisher();
    const modelId = await insertModel(publisher);
    await insertRevision(modelId);

    expect(pgErrorCode(await rejection(insertRevision(modelId)))).toBe(UNIQUE_VIOLATION);
  });

  it('allows many non-current revisions', async () => {
    // The partial index's own control: without the `WHERE is_current` predicate
    // this would collide, and the case above would still pass.
    const publisher = await insertPublisher();
    const modelId = await insertModel(publisher);
    await getDb()
      .insert(inferenceModelRevisions)
      .values([
        { modelId, revision: 'a1', releasedAt: new Date(), isCurrent: false },
        { modelId, revision: 'a2', releasedAt: new Date(), isCurrent: false },
      ]);

    const rows = await getDb()
      .select({ id: inferenceModelRevisions.id })
      .from(inferenceModelRevisions)
      .where(eq(inferenceModelRevisions.modelId, modelId));
    expect(rows).toHaveLength(2);
  });
});

describe('a route is unselectable until somebody approves it', () => {
  async function deploymentDefaults() {
    const publisher = await insertPublisher();
    const modelId = await insertModel(publisher);
    const revisionId = await insertRevision(modelId);
    const providerSlug = await insertProvider();
    return {
      modelRevisionId: revisionId,
      providerSlug,
      regions: ['us-west-2'],
      retainsPayloads: false,
      retentionDays: 0,
      trainsOnCustomerData: false,
      zeroDataRetentionAvailable: true,
      availabilityScope: 'public_payg' as const,
      commercialPermission: 'public_resale_approved' as const,
    };
  }

  it('defaults to pending_review and disabled', async () => {
    const [row] = await getDb()
      .insert(inferenceDeployments)
      .values(await deploymentDefaults())
      .returning({
        permissionState: inferenceDeployments.permissionState,
        status: inferenceDeployments.status,
      });

    // Default DENY, in the DDL. A route inserted by any path at all — a future
    // import, a psql session — arrives unselectable.
    expect(row.permissionState).toBe('pending_review');
    expect(row.status).toBe('disabled');
  });

  it('refuses an approval with no approved legal review', async () => {
    const rejected = getDb()
      .insert(inferenceDeployments)
      .values({ ...(await deploymentDefaults()), permissionState: 'approved' });
    expect(pgErrorCode(await rejection(rejected))).toBe(CHECK_VIOLATION);
  });

  it('refuses a legal approval with a blank evidence reference', async () => {
    // `''` rather than NULL: an empty string is a VALUE and would satisfy a bare
    // `is not null`, so it is the cheapest way to green a weaker constraint.
    const rejected = getDb()
      .insert(inferenceDeployments)
      .values({
        ...(await deploymentDefaults()),
        legalReviewStatus: 'approved',
        legalReviewedAt: new Date(),
        legalReviewEvidenceRef: '   ',
      });
    expect(pgErrorCode(await rejection(rejected))).toBe(CHECK_VIOLATION);
  });

  it('accepts an approval whose review is approved and evidenced', async () => {
    await expect(
      getDb()
        .insert(inferenceDeployments)
        .values({
          ...(await deploymentDefaults()),
          legalReviewStatus: 'approved',
          legalReviewedAt: new Date(),
          legalReviewEvidenceRef: 'contract-register/2026-000123',
          permissionState: 'approved',
          status: 'active',
        })
    ).resolves.toBeDefined();
  });

  it('refuses a public pay-as-you-go route with no resale permission', async () => {
    const rejected = getDb()
      .insert(inferenceDeployments)
      .values({
        ...(await deploymentDefaults()),
        availabilityScope: 'public_payg',
        commercialPermission: 'standard_application_use',
      });
    expect(pgErrorCode(await rejection(rejected))).toBe(CHECK_VIOLATION);
  });

  it('allows that same permission on an internal route', async () => {
    // The control for the case above: `standard_application_use` is a valid
    // permission, just not a resale one, so a constraint that rejected it
    // everywhere would pass the previous case for the wrong reason.
    await expect(
      getDb()
        .insert(inferenceDeployments)
        .values({
          ...(await deploymentDefaults()),
          availabilityScope: 'internal_alia',
          commercialPermission: 'standard_application_use',
        })
    ).resolves.toBeDefined();
  });

  it('refuses a BYOK route that carries a customer price version', async () => {
    const rejected = getDb()
      .insert(inferenceDeployments)
      .values({
        ...(await deploymentDefaults()),
        availabilityScope: 'byok_only',
        commercialPermission: 'customer_byok',
        priceVersionId: 'pv-fixture',
      });
    expect(pgErrorCode(await rejection(rejected))).toBe(CHECK_VIOLATION);
  });

  it('refuses a partially-filled upstream cost', async () => {
    const rejected = getDb()
      .insert(inferenceDeployments)
      .values({
        ...(await deploymentDefaults()),
        upstreamWholesaleCostAmount: '3.000000000000',
        upstreamWholesaleCostCurrency: 'USD',
        // unit and per omitted — an amount with no unit prices nothing.
      });
    expect(pgErrorCode(await rejection(rejected))).toBe(CHECK_VIOLATION);
  });

  it('stores an empty region set as explicitly unattested, never as global', async () => {
    const [row] = await getDb()
      .insert(inferenceDeployments)
      .values({ ...(await deploymentDefaults()), regions: [] })
      .returning({ regions: inferenceDeployments.regions });
    expect(row.regions).toEqual([]);
  });
});

describe('a routing-profile candidate names a model or a revision, never both or neither', () => {
  async function insertProfile(): Promise<string> {
    const [row] = await getDb()
      .insert(inferenceRoutingProfiles)
      .values({
        slug: `prof${suffix()}`,
        displayName: 'Fixture Profile',
        optimiseFor: 'balanced',
        isProductPreset: true,
      })
      .returning({ id: inferenceRoutingProfiles.id });
    return row.id;
  }

  it('refuses a candidate naming neither', async () => {
    const routingProfileId = await insertProfile();
    const rejected = getDb()
      .insert(inferenceRoutingProfileCandidates)
      .values({ routingProfileId, priority: 0 });
    expect(pgErrorCode(await rejection(rejected))).toBe(CHECK_VIOLATION);
  });

  it('refuses a candidate naming both', async () => {
    const routingProfileId = await insertProfile();
    const publisher = await insertPublisher();
    const modelId = await insertModel(publisher);
    const modelRevisionId = await insertRevision(modelId);

    const rejected = getDb()
      .insert(inferenceRoutingProfileCandidates)
      .values({ routingProfileId, modelId, modelRevisionId, priority: 0 });
    expect(pgErrorCode(await rejection(rejected))).toBe(CHECK_VIOLATION);
  });

  it('refuses the same model twice in one profile', async () => {
    // Postgres treats NULLs as DISTINCT, so a plain three-column unique over the
    // two nullable columns would allow this. The partial indexes are what stop it.
    const routingProfileId = await insertProfile();
    const publisher = await insertPublisher();
    const modelId = await insertModel(publisher);

    await getDb()
      .insert(inferenceRoutingProfileCandidates)
      .values({ routingProfileId, modelId, priority: 0 });

    const rejected = getDb()
      .insert(inferenceRoutingProfileCandidates)
      .values({ routingProfileId, modelId, priority: 1 });
    expect(pgErrorCode(await rejection(rejected))).toBe(UNIQUE_VIOLATION);
  });

  it('refuses a profile slug shaped like a model id', async () => {
    // The structural half of "a request for a concrete model is never silently
    // replaced": the two identifier spaces cannot overlap.
    const rejected = getDb()
      .insert(inferenceRoutingProfiles)
      .values({
        slug: 'alia/fast',
        displayName: 'Looks like a model',
        optimiseFor: 'latency',
        isProductPreset: true,
      });
    expect(pgErrorCode(await rejection(rejected))).toBe(CHECK_VIOLATION);
  });
});

describe('every deployment column is classified as customer-safe or internal', () => {
  it('leaves none unclassified, and none in both', () => {
    // A gate that SKIPS what is missing from a hand-maintained map is not a
    // gate: a column in neither list FAILS here, so a new one cannot default
    // into the customer view or out of anybody's attention.
    const declared = Object.keys(getTableColumns(inferenceDeployments));
    const safe = new Set(Object.keys(CUSTOMER_SAFE_DEPLOYMENT_COLUMNS));
    const internal = new Set(Object.keys(INTERNAL_DEPLOYMENT_COLUMNS));

    // Vacuity floor: a broken `getTableColumns` would report zero columns and
    // every set operation below would agree with itself about nothing.
    expect(declared.length).toBeGreaterThan(20);

    expect(declared.filter((column) => !safe.has(column) && !internal.has(column))).toEqual([]);
    expect(declared.filter((column) => safe.has(column) && internal.has(column))).toEqual([]);
    // And neither list may name a column that no longer exists.
    expect([...safe, ...internal].filter((column) => !declared.includes(column))).toEqual([]);
  });

  it('classifies every PROTECTED column as internal', () => {
    // The two mechanisms are independent — the allow-list is default-deny, the
    // protected registry drives the whole-row-read scanner — so this asserts
    // they agree rather than assuming one implies the other.
    const internal = new Set(Object.keys(INTERNAL_DEPLOYMENT_COLUMNS));
    expect(INFERENCE_DEPLOYMENTS_PROTECTED_COLUMNS.length).toBeGreaterThan(0);
    expect(
      INFERENCE_DEPLOYMENTS_PROTECTED_COLUMNS.filter((column) => !internal.has(column))
    ).toEqual([]);
  });
});

describe('the indexes the catalogue reads depend on exist', () => {
  // An index is the one thing a functional test can never detect the absence
  // of: every assertion above passes at any table size with none of these, and
  // the only symptom would be a sequential scan that grows with the number of
  // REJECTED routes — the set that grows fastest.
  const REQUIRED_INDEXES = [
    'inference_deployments_scope_permission_status_idx',
    'inference_deployments_model_revision_id_idx',
    'inference_deployments_provider_slug_idx',
    'inference_model_revisions_one_current_per_model',
    'inference_model_revisions_model_id_released_at_idx',
    'inference_models_publisher_slug_idx',
    'inference_models_model_id_idx',
    'inference_routing_profile_candidates_profile_priority_idx',
  ] as const;

  it('has every one of them, by name', async () => {
    const rows = await getDb().execute<{ indexname: string }>(
      sql`select indexname from pg_indexes where schemaname = 'public' and indexname like 'inference_%'`
    );
    const present = new Set(rows.map((row) => row.indexname));

    // Vacuity floor: an empty read and a schema with no indexes look identical.
    expect(present.size).toBeGreaterThan(REQUIRED_INDEXES.length);

    expect(REQUIRED_INDEXES.filter((name) => !present.has(name))).toEqual([]);
  });
});

describe('a non-text model must declare its content-provenance marking', () => {
  /** The two required members of the safety object, as a marked revision states them. */
  const MARKED = { contentFilteringDefault: 'provider_default', provenanceMarking: 'c2pa' } as const;

  /** A model with the given OUTPUT modalities; inputs stay text. */
  async function insertModelWithOutputs(
    publisherSlug: string,
    outputModalities: string[]
  ): Promise<string> {
    const [row] = await getDb()
      .insert(inferenceModels)
      .values({ publisherSlug, slug: `mdl${suffix()}`, ...modelDefaults(), outputModalities })
      .returning({ id: inferenceModels.id });
    return row.id;
  }

  it('has both triggers installed', async () => {
    const rows = await getDb().execute<{ tgname: string }>(
      sql`select tgname from pg_trigger where tgname in (
        ${INFERENCE_REVISION_PROVENANCE_TRIGGER_NAME},
        ${INFERENCE_MODEL_PROVENANCE_TRIGGER_NAME}
      )`
    );
    // Vacuity floor: a trigger absent and a query that read nothing both return
    // an empty set, so the COUNT is what is asserted.
    expect(rows).toHaveLength(2);
  });

  it.each(['image', 'audio', 'video', 'embedding'])(
    'refuses a revision with no marking under a %s-output model',
    async (modality) => {
      const publisher = await insertPublisher();
      const modelId = await insertModelWithOutputs(publisher, [modality]);

      const insert = getDb()
        .insert(inferenceModelRevisions)
        .values({ modelId, revision: `rev${suffix()}`, releasedAt: new Date(), isCurrent: true });
      expect(pgErrorCode(await rejection(insert))).toBe(CHECK_VIOLATION);
    }
  );

  it('admits a TEXT-only model’s revision with no marking', async () => {
    /*
     * The control for every refusal above. A constraint that refused every
     * revision would pass all of them and be indistinguishable from one that
     * works — and this is also the shape every existing catalogue fixture uses,
     * so it is what says the rule did not narrow the catalogue.
     */
    const publisher = await insertPublisher();
    const modelId = await insertModelWithOutputs(publisher, ['text']);

    await expect(
      getDb()
        .insert(inferenceModelRevisions)
        .values({ modelId, revision: `rev${suffix()}`, releasedAt: new Date(), isCurrent: true })
    ).resolves.toBeDefined();
  });

  it('admits a non-text model’s revision once it declares one', async () => {
    const publisher = await insertPublisher();
    const modelId = await insertModelWithOutputs(publisher, ['text', 'image']);

    await expect(
      getDb()
        .insert(inferenceModelRevisions)
        .values({
          modelId,
          revision: `rev${suffix()}`,
          releasedAt: new Date(),
          isCurrent: true,
          ...MARKED,
        })
    ).resolves.toBeDefined();
  });

  it('refuses UN-declaring a marking, which the immutability trigger does not cover', async () => {
    const publisher = await insertPublisher();
    const modelId = await insertModelWithOutputs(publisher, ['image']);
    const [revision] = await getDb()
      .insert(inferenceModelRevisions)
      .values({
        modelId,
        revision: `rev${suffix()}`,
        releasedAt: new Date(),
        isCurrent: true,
        ...MARKED,
      })
      .returning({ id: inferenceModelRevisions.id });

    // The safety columns are deliberately NOT in
    // `INFERENCE_REVISION_IMMUTABLE_COLUMNS` — a republished safety card changes
    // nothing about the weights — so without the UPDATE arm a marking that had to
    // be set could simply be removed afterwards. Both columns at once, because
    // `inference_model_revisions_safety_is_whole` refuses half the object.
    const update = getDb().execute(
      sql`update inference_model_revisions
          set provenance_marking = null, content_filtering_default = null
          where id = ${revision.id}`
    );
    expect(pgErrorCode(await rejection(update))).toBe(CHECK_VIOLATION);
  });

  it('refuses widening a model past text while a revision declares nothing', async () => {
    const publisher = await insertPublisher();
    const modelId = await insertModelWithOutputs(publisher, ['text']);
    // Legal today: the model is text-only.
    await getDb()
      .insert(inferenceModelRevisions)
      .values({ modelId, revision: `rev${suffix()}`, releasedAt: new Date(), isCurrent: true });

    // …and this is the walk-around the second trigger closes: make the model an
    // image model afterwards, and the revision that declared nothing is suddenly
    // an undeclared image model's revision.
    const widen = getDb().execute(
      sql`update inference_models
          set output_modalities = array['text','image']::text[]
          where id = ${modelId}`
    );
    expect(pgErrorCode(await rejection(widen))).toBe(CHECK_VIOLATION);
  });

  it('permits widening once every revision declares, and permits unrelated edits regardless', async () => {
    const publisher = await insertPublisher();
    const modelId = await insertModelWithOutputs(publisher, ['text']);
    const [revision] = await getDb()
      .insert(inferenceModelRevisions)
      .values({ modelId, revision: `rev${suffix()}`, releasedAt: new Date(), isCurrent: true })
      .returning({ id: inferenceModelRevisions.id });

    // The POSITIVE side of the case above: declare on the revision, then the same
    // widening is accepted. Without this the refusal could be a trigger that
    // rejects every modality change.
    await getDb()
      .update(inferenceModelRevisions)
      .set(MARKED)
      .where(eq(inferenceModelRevisions.id, revision.id));
    await expect(
      getDb().execute(
        sql`update inference_models
            set output_modalities = array['text','image']::text[]
            where id = ${modelId}`
      )
    ).resolves.toBeDefined();

    // And an edit that does not touch the modalities is never re-validated, so a
    // deprecation or a description change on a non-text model stays a one-row
    // write rather than a scan of its revisions.
    await expect(
      getDb()
        .update(inferenceModels)
        .set({ deprecationStatus: 'deprecated' })
        .where(eq(inferenceModels.id, modelId))
    ).resolves.toBeDefined();
  });
});

describe('the provenance migration and the schema agree on the DDL', () => {
  /*
   * `inferenceModelProvenance.ts` claims to be the authoritative copy "so a
   * regeneration of the table migrations has something to restore this file
   * from". That claim rots the moment the two drift, and only a comparison keeps
   * it — the same check `applicationCredentialAudit.test.ts` makes for 0043.
   */
  const migration = readFileSync(
    join(__dirname, '..', '..', '..', '..', 'drizzle', PROVENANCE_MIGRATION),
    'utf8'
  );

  it('carries both function texts the schema declares authoritative', () => {
    expect(migration).toContain(INFERENCE_REVISION_PROVENANCE_DDL);
    expect(migration).toContain(INFERENCE_MODEL_PROVENANCE_DDL);
  });

  it('carries both trigger texts the schema declares authoritative', () => {
    expect(migration).toContain(INFERENCE_REVISION_PROVENANCE_TRIGGER_DDL);
    expect(migration).toContain(INFERENCE_MODEL_PROVENANCE_TRIGGER_DDL);
  });

  it('declares a deploy phase, so the deploy knows which side it belongs on', () => {
    expect(migration).toContain('-- oxy:deploy-phase=pre');
  });

  it('fires the revision trigger on INSERT as well as UPDATE', () => {
    // Stated against the migration text because the two arms answer different
    // attacks (a row that never declared, and a row that stopped declaring), and
    // dropping either would leave the other's test green.
    expect(migration).toContain('BEFORE INSERT OR UPDATE ON inference_model_revisions');
    expect(migration).toContain('BEFORE UPDATE ON inference_models');
  });
});
