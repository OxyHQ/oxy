/**
 * The routing policy control plane's schema, against a REAL Postgres.
 *
 * One `describe` per claim the schema files make, because every one of them is
 * the kind a comment cannot keep true: that a contradictory policy cannot be
 * STORED (not merely rejected on the wire), that a cross-model substitution
 * cannot be recorded without the customer authorisation that permitted it, that
 * a request naming an exact revision has no representation in the substitution
 * record at all, and that a version a charge names cannot be edited or removed.
 *
 * Every row carries a per-test random identifier, so no assertion depends on a
 * table being empty and no aggregate reads a sibling file's rows.
 */

import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { modelIdSchema, modelReferenceSchema, routingPolicySchema } from '@oxyhq/contracts';
import { closePostgres, connectPostgres, getDb } from '../../../config/postgres';
import { applicationCredentials } from '../applicationCredentials';
import { applications } from '../applications';
import { inferenceModelRevisions } from '../inferenceModelRevisions';
import { inferenceModels } from '../inferenceModels';
import { inferencePublishers } from '../inferencePublishers';
import { inferenceRouteSwitchEvents } from '../inferenceRouteSwitchEvents';
import {
  IMMUTABLE_ROUTING_RECORD_TABLES,
  ROUTING_POLICY_VERSION_IMMUTABILITY_TRIGGER_NAME,
} from '../inferenceRoutingImmutability';
import { inferenceRoutingPolicies } from '../inferenceRoutingPolicies';
import { inferenceRoutingPolicyFallbacks } from '../inferenceRoutingPolicyFallbacks';
import { inferenceRoutingPolicyPriceCaps } from '../inferenceRoutingPolicyPriceCaps';
import {
  inferenceRoutingPolicyVersions,
  ROUTING_POLICY_OPTIMISATIONS,
  ROUTING_POLICY_PREFERENCES,
  ROUTING_POLICY_VERSION_MUTABLE_COLUMN,
} from '../inferenceRoutingPolicyVersions';
import { inferenceRoutingProfiles } from '../inferenceRoutingProfiles';
import { MODEL_ID_CHECK_PATTERN } from '../inferenceSlug';
import { usageReceipts } from '../usageReceipts';
import { zeroUsageUnits } from '../ledgerColumns';
import { priceVersions } from '../priceVersions';
import { users } from '../users';

/** Postgres `check_violation` — also what the immutability triggers raise. */
const CHECK_VIOLATION = '23514';
/** Postgres `unique_violation`. */
const UNIQUE_VIOLATION = '23505';
/** Postgres `foreign_key_violation`. */
const FOREIGN_KEY_VIOLATION = '23503';

beforeAll(async () => {
  await connectPostgres();
});

afterAll(async () => {
  await closePostgres();
});

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

/**
 * What POSTGRES said, which is the innermost message in the cause chain.
 *
 * `String(error)` is drizzle's wrapper, and it quotes the failed statement — so
 * asserting a column name against it is satisfied by the `set "col" = …` in the
 * query itself, whether or not any trigger fired. The trigger's own words are
 * down here.
 */
function pgErrorMessage(error: unknown): string {
  let message = '';
  for (let current = error; current instanceof Error; current = current.cause) {
    message = current.message;
  }
  return message;
}

async function rejection(query: Promise<unknown>): Promise<unknown> {
  try {
    await query;
  } catch (error) {
    return error;
  }
  throw new Error('Expected the statement to be rejected, but it succeeded.');
}

/* -------------------------------------------------------------------------- */
/*  Fixtures                                                                  */
/* -------------------------------------------------------------------------- */

async function insertAccount(): Promise<string> {
  const tag = suffix();
  const [row] = await getDb()
    .insert(users)
    .values({ username: `routing-${tag}`, email: `routing-${tag}@example.test` })
    .returning({ id: users.id });
  return row.id;
}

async function insertApplication(ownerAccountId: string): Promise<string> {
  const [row] = await getDb()
    .insert(applications)
    .values({ name: `Routing ${suffix()}`, ownerAccountId })
    .returning({ id: applications.id });
  return row.id;
}

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

interface CatalogueFixture {
  publisherSlug: string;
  modelRowId: string;
  modelReference: string;
  revisionRowId: string;
  revisionLabel: string;
}

async function insertCatalogueModel(): Promise<CatalogueFixture> {
  const publisherSlug = `pub${suffix()}`;
  await getDb()
    .insert(inferencePublishers)
    .values({ slug: publisherSlug, displayName: 'Fixture Publisher' });

  const slug = `mdl${suffix()}`;
  const [model] = await getDb()
    .insert(inferenceModels)
    .values({ publisherSlug, slug, ...modelDefaults() })
    .returning({ id: inferenceModels.id, modelId: inferenceModels.modelId });

  const revisionLabel = `rev${suffix()}`;
  const [revision] = await getDb()
    .insert(inferenceModelRevisions)
    .values({ modelId: model.id, revision: revisionLabel, releasedAt: new Date(), isCurrent: true })
    .returning({ id: inferenceModelRevisions.id });

  return {
    publisherSlug,
    modelRowId: model.id,
    modelReference: `${publisherSlug}/${slug}`,
    revisionRowId: revision.id,
    revisionLabel,
  };
}

async function insertPolicy(
  accountId: string,
  overrides: Partial<typeof inferenceRoutingPolicies.$inferInsert> = {}
): Promise<string> {
  const [row] = await getDb()
    .insert(inferenceRoutingPolicies)
    .values({
      scopeKind: 'account',
      accountId,
      status: 'active',
      createdByUserId: accountId,
      ...overrides,
    })
    .returning({ id: inferenceRoutingPolicies.id });
  return row.id;
}

/** The NOT NULL columns every version row needs, with the permissive defaults. */
function versionDefaults(routingPolicyId: string, createdByUserId: string) {
  return {
    routingPolicyId,
    version: 1,
    providerAllowlist: [],
    providerDenylist: [],
    allowedRegions: [],
    deniedRegions: [],
    requireZeroDataRetention: false,
    prohibitTrainingOnCustomerData: false,
    optimiseFor: 'balanced' as const,
    oxyHostedOnly: false,
    allowedLicenseIds: [],
    requireCommercialUseRights: false,
    fallbackDisabled: false,
    sameModelDeploymentFallback: true,
    byokPreference: 'disabled' as const,
    dedicatedCapacity: 'disabled' as const,
    createdByUserId,
  };
}

async function insertVersion(
  routingPolicyId: string,
  createdByUserId: string,
  overrides: Partial<typeof inferenceRoutingPolicyVersions.$inferInsert> = {}
): Promise<string> {
  const [row] = await getDb()
    .insert(inferenceRoutingPolicyVersions)
    .values({ ...versionDefaults(routingPolicyId, createdByUserId), ...overrides })
    .returning({ id: inferenceRoutingPolicyVersions.id });
  return row.id;
}

/* -------------------------------------------------------------------------- */

describe('routing policy vocabularies agree with the contract', () => {
  /**
   * The three closed sets are declared as SQL CHECKs here and as zod enums in
   * `@oxyhq/contracts`, which are different languages and therefore cannot share
   * one string. They must nonetheless agree, so each is driven through the
   * CONTRACT and asserted in BOTH directions — every value the database admits
   * must parse, and a value neither admits must be refused by both.
   */
  function policyWith(overrides: Record<string, unknown>): unknown {
    return {
      schemaVersion: 1,
      routingPolicyId: 'policy-1',
      policyVersion: 1,
      scope: { kind: 'account', accountId: 'account-1' },
      providerAllowlist: [],
      providerDenylist: [],
      allowedRegions: [],
      deniedRegions: [],
      requireZeroDataRetention: false,
      prohibitTrainingOnCustomerData: false,
      maxPricePerUnit: [],
      optimiseFor: 'balanced',
      oxyHostedOnly: false,
      allowedLicenseIds: [],
      requireCommercialUseRights: false,
      fallback: { disabled: false, sameModelDeployment: true, authorizedCrossModel: [] },
      byokPreference: 'disabled',
      dedicatedCapacity: 'disabled',
      updatedAt: new Date().toISOString(),
      ...overrides,
    };
  }

  it('accepts every optimisation the column admits, and no more', () => {
    for (const value of ROUTING_POLICY_OPTIMISATIONS) {
      expect(routingPolicySchema.safeParse(policyWith({ optimiseFor: value })).success).toBe(true);
    }
    expect(routingPolicySchema.safeParse(policyWith({ optimiseFor: 'quality' })).success).toBe(
      false
    );
  });

  it('accepts every BYOK and capacity preference the columns admit', () => {
    for (const value of ROUTING_POLICY_PREFERENCES) {
      expect(routingPolicySchema.safeParse(policyWith({ byokPreference: value })).success).toBe(
        true
      );
      expect(routingPolicySchema.safeParse(policyWith({ dedicatedCapacity: value })).success).toBe(
        true
      );
    }
    expect(routingPolicySchema.safeParse(policyWith({ byokPreference: 'always' })).success).toBe(
      false
    );
  });

  /**
   * `MODEL_ID_CHECK_PATTERN` is the structural half of "a pinned revision is
   * never substituted", so its agreement with `modelIdSchema` is asserted
   * against a REAL Postgres rather than by comparing two regex sources: the two
   * are POSIX ARE and JavaScript, and only the server can say what the CHECK
   * accepts.
   */
  it.each([
    ['openai/gpt-5', true],
    ['meta/llama-3.1-70b', true],
    ['openai/gpt-5@2026-05-01', false],
    ['gpt-5', false],
    ['OpenAI/gpt-5', false],
  ])('the model-id CHECK and modelIdSchema agree on %s', async (candidate, accepted) => {
    const [row] = await getDb().execute<{ matches: boolean }>(
      sql`select (${candidate} ~ ${sql.raw(MODEL_ID_CHECK_PATTERN)}) as matches`
    );
    expect(row.matches).toBe(accepted);
    expect(modelIdSchema.safeParse(candidate).success).toBe(accepted);
  });

  it('the reference grammar accepts a pinned revision the id grammar refuses', () => {
    expect(modelReferenceSchema.safeParse('openai/gpt-5@2026-05-01').success).toBe(true);
    expect(modelIdSchema.safeParse('openai/gpt-5@2026-05-01').success).toBe(false);
  });
});

describe('a contradictory policy version cannot be stored', () => {
  let accountId: string;
  let policyId: string;

  beforeAll(async () => {
    accountId = await insertAccount();
    policyId = await insertPolicy(accountId);
  });

  it('refuses a provider that is both required by the allowlist and denied', async () => {
    const error = await rejection(
      insertVersion(policyId, accountId, {
        version: 100,
        providerAllowlist: ['bedrock'],
        providerDenylist: ['bedrock'],
      })
    );
    expect(pgErrorCode(error)).toBe(CHECK_VIOLATION);
  });

  it('admits disjoint allow and deny lists, and two empty ones', async () => {
    await expect(
      insertVersion(policyId, accountId, {
        version: 101,
        providerAllowlist: ['bedrock'],
        providerDenylist: ['openai'],
      })
    ).resolves.toEqual(expect.any(String));
    // The empty case is the vacuity floor for the overlap CHECK: `&&` is FALSE
    // when either side is empty, so "no allowlist" must still insert.
    await expect(insertVersion(policyId, accountId, { version: 102 })).resolves.toEqual(
      expect.any(String)
    );
  });

  it('refuses a region that is both allowed and denied', async () => {
    const error = await rejection(
      insertVersion(policyId, accountId, {
        version: 110,
        allowedRegions: ['eu-central-1'],
        deniedRegions: ['eu-central-1'],
      })
    );
    expect(pgErrorCode(error)).toBe(CHECK_VIOLATION);
  });

  it('refuses fallback disabled together with same-model deployment failover', async () => {
    const error = await rejection(
      insertVersion(policyId, accountId, {
        version: 120,
        fallbackDisabled: true,
        sameModelDeploymentFallback: true,
      })
    );
    expect(pgErrorCode(error)).toBe(CHECK_VIOLATION);
  });

  it('refuses an Oxy-hosted-only policy that also requires a customer credential', async () => {
    const error = await rejection(
      insertVersion(policyId, accountId, {
        version: 130,
        oxyHostedOnly: true,
        byokPreference: 'require',
      })
    );
    expect(pgErrorCode(error)).toBe(CHECK_VIOLATION);

    // Positive control: either half alone is a perfectly ordinary policy.
    await expect(
      insertVersion(policyId, accountId, { version: 131, oxyHostedOnly: true })
    ).resolves.toEqual(expect.any(String));
    await expect(
      insertVersion(policyId, accountId, { version: 132, byokPreference: 'require' })
    ).resolves.toEqual(expect.any(String));
  });

  it('refuses a per-request ceiling with no currency to quote it in', async () => {
    const error = await rejection(
      insertVersion(policyId, accountId, {
        version: 140,
        maxPricePerRequestAmount: '1.000000000000',
      })
    );
    expect(pgErrorCode(error)).toBe(CHECK_VIOLATION);
  });
});

describe('a default target names exactly one thing, or nothing', () => {
  let accountId: string;
  let policyId: string;
  let catalogue: CatalogueFixture;
  let profileId: string;

  beforeAll(async () => {
    accountId = await insertAccount();
    policyId = await insertPolicy(accountId);
    catalogue = await insertCatalogueModel();
    const [profile] = await getDb()
      .insert(inferenceRoutingProfiles)
      .values({
        slug: `prof${suffix()}`,
        displayName: 'Fixture Profile',
        optimiseFor: 'balanced',
        isProductPreset: false,
      })
      .returning({ id: inferenceRoutingProfiles.id });
    profileId = profile.id;
  });

  it('admits no target at all — every request names its own model', async () => {
    await expect(insertVersion(policyId, accountId, { version: 200 })).resolves.toEqual(
      expect.any(String)
    );
  });

  it('admits a model, a pinned revision, or a routing profile', async () => {
    await expect(
      insertVersion(policyId, accountId, {
        version: 201,
        defaultTargetKind: 'model',
        defaultModelId: catalogue.modelRowId,
      })
    ).resolves.toEqual(expect.any(String));
    await expect(
      insertVersion(policyId, accountId, {
        version: 202,
        defaultTargetKind: 'model',
        defaultModelRevisionId: catalogue.revisionRowId,
      })
    ).resolves.toEqual(expect.any(String));
    await expect(
      insertVersion(policyId, accountId, {
        version: 203,
        defaultTargetKind: 'routing_profile',
        defaultRoutingProfileId: profileId,
      })
    ).resolves.toEqual(expect.any(String));
  });

  it('refuses a kind that names nothing', async () => {
    const error = await rejection(
      insertVersion(policyId, accountId, { version: 210, defaultTargetKind: 'model' })
    );
    expect(pgErrorCode(error)).toBe(CHECK_VIOLATION);
  });

  it('refuses a model target that names both a model and a pinned revision', async () => {
    const error = await rejection(
      insertVersion(policyId, accountId, {
        version: 211,
        defaultTargetKind: 'model',
        defaultModelId: catalogue.modelRowId,
        defaultModelRevisionId: catalogue.revisionRowId,
      })
    );
    expect(pgErrorCode(error)).toBe(CHECK_VIOLATION);
  });

  /**
   * The NULL-kind case, driven for all three target columns.
   *
   * This is the three-valued-logic trap: with `=` instead of
   * `is not distinct from`, every arm of the CHECK evaluates to FALSE or NULL,
   * the disjunction is NULL, and a CHECK rejects only FALSE — so the row is
   * ADMITTED and the policy silently carries a target nothing reads. The first
   * draft of the constraint did exactly that.
   */
  it.each([
    ['a model', () => ({ defaultModelId: catalogue.modelRowId })],
    ['a pinned revision', () => ({ defaultModelRevisionId: catalogue.revisionRowId })],
    ['a routing profile', () => ({ defaultRoutingProfileId: profileId })],
  ])('refuses %s with no kind declared', async (_label, target) => {
    // The same version number in all three cases: none of them may insert, so a
    // collision here would itself be a failure worth seeing.
    const error = await rejection(
      insertVersion(policyId, accountId, { version: 212, ...target() })
    );
    expect(pgErrorCode(error)).toBe(CHECK_VIOLATION);
  });
});

describe('price ceilings share one currency, structurally', () => {
  let accountId: string;
  let withCurrency: string;
  let withoutCurrency: string;

  beforeAll(async () => {
    accountId = await insertAccount();
    const policyId = await insertPolicy(accountId);
    withCurrency = await insertVersion(policyId, accountId, {
      version: 300,
      priceCeilingCurrency: 'USD',
    });
    withoutCurrency = await insertVersion(policyId, accountId, { version: 301 });
  });

  function cap(versionId: string, unit: 'input_tokens' | 'output_tokens', currency: string) {
    return getDb()
      .insert(inferenceRoutingPolicyPriceCaps)
      .values({ versionId, unit, currency, amount: '0.000003000000', per: 1_000_000 });
  }

  it('admits a ceiling in the version’s own currency', async () => {
    await expect(cap(withCurrency, 'input_tokens', 'USD')).resolves.toBeDefined();
  });

  it('refuses a ceiling in any other currency', async () => {
    const error = await rejection(cap(withCurrency, 'output_tokens', 'EUR'));
    expect(pgErrorCode(error)).toBe(FOREIGN_KEY_VIOLATION);
  });

  it('refuses a ceiling on a version that declares no currency', async () => {
    // NULL matches no foreign key, so a version with no `price_ceiling_currency`
    // is not a valid parent for any cap at all.
    const error = await rejection(cap(withoutCurrency, 'input_tokens', 'USD'));
    expect(pgErrorCode(error)).toBe(FOREIGN_KEY_VIOLATION);
  });

  it('refuses a second ceiling for the same unit', async () => {
    const error = await rejection(cap(withCurrency, 'input_tokens', 'USD'));
    expect(pgErrorCode(error)).toBe(UNIQUE_VIOLATION);
  });
});

describe('cross-model fallback is a set of authorisations, never a flag', () => {
  let accountId: string;
  let catalogue: CatalogueFixture;
  let enabledVersion: string;
  let disabledVersion: string;

  beforeAll(async () => {
    accountId = await insertAccount();
    catalogue = await insertCatalogueModel();
    const policyId = await insertPolicy(accountId);
    enabledVersion = await insertVersion(policyId, accountId, { version: 400 });
    disabledVersion = await insertVersion(policyId, accountId, {
      version: 401,
      fallbackDisabled: true,
      sameModelDeploymentFallback: false,
    });
  });

  it('admits an authorisation under a version whose fallback is not disabled', async () => {
    await expect(
      getDb().insert(inferenceRoutingPolicyFallbacks).values({
        versionId: enabledVersion,
        modelId: catalogue.modelRowId,
        position: 0,
      })
    ).resolves.toBeDefined();
  });

  it('refuses an authorisation under a fallback-disabled version', async () => {
    // The composite key `(version_id, fallback_disabled)` has nothing to match:
    // the child's own CHECK forces `false`, and the parent holds `true`.
    const error = await rejection(
      getDb().insert(inferenceRoutingPolicyFallbacks).values({
        versionId: disabledVersion,
        modelId: catalogue.modelRowId,
        position: 0,
      })
    );
    expect(pgErrorCode(error)).toBe(FOREIGN_KEY_VIOLATION);
  });

  it('refuses an authorisation that claims a different fallback state than its version', async () => {
    const error = await rejection(
      getDb().insert(inferenceRoutingPolicyFallbacks).values({
        versionId: enabledVersion,
        fallbackDisabled: true,
        modelId: catalogue.modelRowId,
        position: 9,
      })
    );
    expect(pgErrorCode(error)).toBe(CHECK_VIOLATION);
  });

  it('refuses an authorisation naming both a model and a revision, and one naming neither', async () => {
    const both = await rejection(
      getDb().insert(inferenceRoutingPolicyFallbacks).values({
        versionId: enabledVersion,
        modelId: catalogue.modelRowId,
        modelRevisionId: catalogue.revisionRowId,
        position: 1,
      })
    );
    expect(pgErrorCode(both)).toBe(CHECK_VIOLATION);

    const neither = await rejection(
      getDb()
        .insert(inferenceRoutingPolicyFallbacks)
        .values({ versionId: enabledVersion, position: 2 })
    );
    expect(pgErrorCode(neither)).toBe(CHECK_VIOLATION);
  });

  it('refuses the same destination twice in one version', async () => {
    const error = await rejection(
      getDb().insert(inferenceRoutingPolicyFallbacks).values({
        versionId: enabledVersion,
        modelId: catalogue.modelRowId,
        position: 3,
      })
    );
    expect(pgErrorCode(error)).toBe(UNIQUE_VIOLATION);
  });
});

describe('a recorded route switch cannot be an unauthorised substitution', () => {
  let accountId: string;
  let applicationId: string;
  let catalogue: CatalogueFixture;
  let otherCatalogue: CatalogueFixture;
  let versionId: string;
  let otherVersionId: string;
  let authorizationId: string;

  beforeAll(async () => {
    accountId = await insertAccount();
    applicationId = await insertApplication(accountId);
    catalogue = await insertCatalogueModel();
    otherCatalogue = await insertCatalogueModel();
    const policyId = await insertPolicy(accountId);
    versionId = await insertVersion(policyId, accountId, { version: 500 });
    otherVersionId = await insertVersion(policyId, accountId, { version: 501 });

    const [row] = await getDb()
      .insert(inferenceRoutingPolicyFallbacks)
      .values({ versionId, modelId: otherCatalogue.modelRowId, position: 0 })
      .returning({ id: inferenceRoutingPolicyFallbacks.id });
    authorizationId = row.id;
  });

  function event(overrides: Partial<typeof inferenceRouteSwitchEvents.$inferInsert>) {
    return getDb()
      .insert(inferenceRouteSwitchEvents)
      .values({
        requestId: `req-${randomUUID()}`,
        sequence: 0,
        accountId,
        applicationId,
        environment: 'production',
        routingPolicyVersionId: versionId,
        scope: 'deployment',
        reason: 'deployment_unavailable',
        fromModelReference: catalogue.modelReference,
        toModelReference: catalogue.modelReference,
        toProvider: 'oxy-hosted',
        occurredAt: new Date(),
        ...overrides,
      });
  }

  it('admits a same-model deployment failover', async () => {
    await expect(event({})).resolves.toBeDefined();
  });

  it('refuses a deployment switch that changes the model', async () => {
    const error = await rejection(event({ toModelReference: otherCatalogue.modelReference }));
    expect(pgErrorCode(error)).toBe(CHECK_VIOLATION);
  });

  it('admits an authorised cross-model substitution', async () => {
    await expect(
      event({
        scope: 'model',
        requestedModelId: catalogue.modelReference,
        toModelReference: otherCatalogue.modelReference,
        authorizationId,
      })
    ).resolves.toBeDefined();
  });

  it('refuses a model switch that names no authorisation', async () => {
    const error = await rejection(
      event({
        scope: 'model',
        requestedModelId: catalogue.modelReference,
        toModelReference: otherCatalogue.modelReference,
      })
    );
    expect(pgErrorCode(error)).toBe(CHECK_VIOLATION);
  });

  it('refuses a model switch whose authorisation belongs to another version', async () => {
    const error = await rejection(
      event({
        scope: 'model',
        routingPolicyVersionId: otherVersionId,
        requestedModelId: catalogue.modelReference,
        toModelReference: otherCatalogue.modelReference,
        authorizationId,
      })
    );
    expect(pgErrorCode(error)).toBe(FOREIGN_KEY_VIOLATION);
  });

  /**
   * The invariant, at the column level: a request that pinned a revision asked
   * for exactly those weights, and `requested_model_id`'s grammar has no
   * `@<revision>` alternative — so there is no value that satisfies the column
   * for such a request and the row cannot be constructed at all.
   */
  it('refuses a substitution of a request that pinned an exact revision', async () => {
    const error = await rejection(
      event({
        scope: 'model',
        requestedModelId: `${catalogue.modelReference}@${catalogue.revisionLabel}`,
        toModelReference: otherCatalogue.modelReference,
        authorizationId,
      })
    );
    expect(pgErrorCode(error)).toBe(CHECK_VIOLATION);
  });

  it('refuses a model switch that does not actually change the model', async () => {
    const error = await rejection(
      event({
        scope: 'model',
        requestedModelId: catalogue.modelReference,
        toModelReference: catalogue.modelReference,
        authorizationId,
      })
    );
    expect(pgErrorCode(error)).toBe(CHECK_VIOLATION);
  });
});

describe('a policy version is immutable once written', () => {
  let accountId: string;
  let policyId: string;
  let versionId: string;

  beforeAll(async () => {
    accountId = await insertAccount();
    policyId = await insertPolicy(accountId);
    /**
     * `sameModelDeploymentFallback: false`, against the fixture default, so the
     * `fallback_disabled` case below is refused by the TRIGGER and not by
     * `inference_routing_policy_versions_fallback_conflict`. Measured: with the
     * default `true`, deleting the whole immutability migration left that case
     * green, because setting `fallback_disabled` on such a row violates an
     * ordinary CHECK — the case was testing 0039, not 0040.
     */
    versionId = await insertVersion(policyId, accountId, {
      version: 600,
      sameModelDeploymentFallback: false,
    });
  });

  it('installed the trigger it claims to have installed', async () => {
    const rows = await getDb().execute<{ tgname: string }>(
      sql`select tgname from pg_trigger where not tgisinternal`
    );
    const names = rows.map((row) => row.tgname);
    expect(names).toContain(ROUTING_POLICY_VERSION_IMMUTABILITY_TRIGGER_NAME);
    for (const table of IMMUTABLE_ROUTING_RECORD_TABLES) {
      expect(names).toContain(`${table}_immutable`);
    }
  });

  /**
   * Driven per column rather than on one representative, because the guard's
   * whole point is that it covers columns nobody enumerated. A hand-written list
   * of protected columns would pass this test while leaving a new column
   * unguarded; the whole-row comparison is what makes every entry here fail if
   * the trigger is weakened.
   *
   * Every VALUE is chosen to satisfy the ordinary CHECKs on this table, so the
   * only thing left that can refuse the statement is the trigger. That is not a
   * detail: `byok_preference = 'require'` and `fallback_disabled = true` were
   * both refused by a CHECK instead, and stayed green through a run with the
   * whole immutability migration deleted.
   */
  it.each([
    ['optimise_for', sql`'price'`],
    ['oxy_hosted_only', sql`true`],
    ['provider_allowlist', sql`array['bedrock']::text[]`],
    ['fallback_disabled', sql`true`],
    ['byok_preference', sql`'prefer'`],
    ['version', sql`999`],
    ['created_at', sql`now()`],
  ])('refuses an update to %s', async (column, value) => {
    const error = await rejection(
      getDb().execute(
        sql`update inference_routing_policy_versions
            set ${sql.raw(`"${column}"`)} = ${value}
            where id = ${versionId}`
      )
    );
    expect(pgErrorCode(error)).toBe(CHECK_VIOLATION);
    // The trigger's own words, and the column it named. Nothing but this
    // trigger says "is immutable"; an ordinary CHECK violation cannot.
    expect(pgErrorMessage(error)).toContain(`inference_routing_policy_versions.${column}`);
    expect(pgErrorMessage(error)).toContain('is immutable');
  });

  it(`permits an update to ${ROUTING_POLICY_VERSION_MUTABLE_COLUMN}`, async () => {
    await expect(
      getDb()
        .update(inferenceRoutingPolicyVersions)
        .set({ isCurrent: true })
        .where(eq(inferenceRoutingPolicyVersions.id, versionId))
    ).resolves.toBeDefined();
  });

  /**
   * One case per table in {@link IMMUTABLE_ROUTING_RECORD_TABLES}, each driving
   * a REAL update. The presence test above proves the three triggers reached
   * `pg_trigger`; only this proves they refuse anything — a trigger calling a
   * function that returned `new` would satisfy the first and none of these.
   */
  it('refuses an update to a price cap, an authorisation and a switch notice', async () => {
    const catalogue = await insertCatalogueModel();
    const applicationId = await insertApplication(accountId);
    const recordVersion = await insertVersion(policyId, accountId, {
      version: 601,
      priceCeilingCurrency: 'USD',
    });

    await getDb().insert(inferenceRoutingPolicyPriceCaps).values({
      versionId: recordVersion,
      unit: 'input_tokens',
      currency: 'USD',
      amount: '0.000003000000',
      per: 1_000_000,
    });
    const capError = await rejection(
      getDb()
        .update(inferenceRoutingPolicyPriceCaps)
        .set({ amount: '9.000000000000' })
        .where(eq(inferenceRoutingPolicyPriceCaps.versionId, recordVersion))
    );
    expect(pgErrorCode(capError)).toBe(CHECK_VIOLATION);
    expect(pgErrorMessage(capError)).toContain('append-only');

    const [authorization] = await getDb()
      .insert(inferenceRoutingPolicyFallbacks)
      .values({ versionId: recordVersion, modelId: catalogue.modelRowId, position: 0 })
      .returning({ id: inferenceRoutingPolicyFallbacks.id });
    const authorizationError = await rejection(
      getDb()
        .update(inferenceRoutingPolicyFallbacks)
        .set({ position: 7 })
        .where(eq(inferenceRoutingPolicyFallbacks.id, authorization.id))
    );
    expect(pgErrorCode(authorizationError)).toBe(CHECK_VIOLATION);
    expect(pgErrorMessage(authorizationError)).toContain('append-only');

    const [notice] = await getDb()
      .insert(inferenceRouteSwitchEvents)
      .values({
        requestId: `req-${randomUUID()}`,
        sequence: 0,
        accountId,
        applicationId,
        environment: 'production',
        routingPolicyVersionId: recordVersion,
        scope: 'deployment',
        reason: 'deployment_unavailable',
        fromModelReference: catalogue.modelReference,
        toModelReference: catalogue.modelReference,
        toProvider: 'oxy-hosted',
        occurredAt: new Date(),
      })
      .returning({ id: inferenceRouteSwitchEvents.id });
    const noticeError = await rejection(
      getDb()
        .update(inferenceRouteSwitchEvents)
        .set({ toProvider: 'somewhere-else' })
        .where(eq(inferenceRouteSwitchEvents.id, notice.id))
    );
    expect(pgErrorCode(noticeError)).toBe(CHECK_VIOLATION);
    expect(pgErrorMessage(noticeError)).toContain('append-only');
  });
});

describe('a policy version a charge names cannot be removed', () => {
  it('refuses to delete the version a settled receipt points at', async () => {
    const accountId = await insertAccount();
    const applicationId = await insertApplication(accountId);
    const [credential] = await getDb()
      .insert(applicationCredentials)
      .values({
        applicationId,
        name: 'routing-test',
        publicKey: `oxy_dk_${randomUUID().replace(/-/g, '')}`,
        type: 'service',
        environment: 'production',
      })
      .returning({ id: applicationCredentials.id });
    const [priceVersion] = await getDb()
      .insert(priceVersions)
      .values({
        modelReference: `oxy/routing-${suffix()}`,
        provider: 'oxy-hosted',
        status: 'active',
        effectiveFrom: new Date(Date.now() - 60_000),
      })
      .returning({ id: priceVersions.id });

    const policyId = await insertPolicy(accountId);
    const versionId = await insertVersion(policyId, accountId, { version: 700 });

    await getDb()
      .insert(usageReceipts)
      .values({
        idempotencyKey: `rcp-${randomUUID()}`,
        accountId,
        applicationId,
        applicationCredentialId: credential.id,
        requestId: `req-${randomUUID()}`,
        environment: 'production',
        outcome: 'completed',
        usageSource: 'provider_reported',
        ...zeroUsageUnits(),
        outputTokens: 10,
        resolvedModelReference: 'oxy/routing-test',
        servingProvider: 'oxy-hosted',
        priceVersionId: priceVersion.id,
        routingPolicyVersionId: versionId,
        billedAmount: '0.000030000000',
        currency: 'USD',
        settledAt: new Date(),
      });

    const error = await rejection(
      getDb()
        .delete(inferenceRoutingPolicyVersions)
        .where(eq(inferenceRoutingPolicyVersions.id, versionId))
    );
    expect(pgErrorCode(error)).toBe(FOREIGN_KEY_VIOLATION);

    // ...and deleting the POLICY is refused too, because the cascade into its
    // versions runs into the same restriction.
    const cascade = await rejection(
      getDb().delete(inferenceRoutingPolicies).where(eq(inferenceRoutingPolicies.id, policyId))
    );
    expect(pgErrorCode(cascade)).toBe(FOREIGN_KEY_VIOLATION);
  });
});

describe('one active policy per scope', () => {
  it('refuses a second active account-scoped policy, and admits one after archiving', async () => {
    const accountId = await insertAccount();
    const first = await insertPolicy(accountId);

    const error = await rejection(insertPolicy(accountId));
    expect(pgErrorCode(error)).toBe(UNIQUE_VIOLATION);

    await getDb()
      .update(inferenceRoutingPolicies)
      .set({ status: 'archived' })
      .where(eq(inferenceRoutingPolicies.id, first));

    await expect(insertPolicy(accountId)).resolves.toEqual(expect.any(String));
  });

  it('refuses a second active policy for one application', async () => {
    const accountId = await insertAccount();
    const applicationId = await insertApplication(accountId);
    await insertPolicy(accountId, { scopeKind: 'application', applicationId });

    const error = await rejection(
      insertPolicy(accountId, { scopeKind: 'application', applicationId })
    );
    expect(pgErrorCode(error)).toBe(UNIQUE_VIOLATION);
  });

  it('refuses a scope kind that disagrees with the application column', async () => {
    const accountId = await insertAccount();
    const applicationId = await insertApplication(accountId);

    const missing = await rejection(insertPolicy(accountId, { scopeKind: 'application' }));
    expect(pgErrorCode(missing)).toBe(CHECK_VIOLATION);

    const spurious = await rejection(insertPolicy(accountId, { scopeKind: 'account', applicationId }));
    expect(pgErrorCode(spurious)).toBe(CHECK_VIOLATION);
  });
});
