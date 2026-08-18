/**
 * The release-ingestion and GPAI-documentation schema, against a REAL Postgres
 * (issue #972 §12).
 *
 * One `describe` per decision the schema files argue for, because each of them is
 * the kind a comment cannot keep true:
 *
 *  - that the four conditionals of Regulation (EU) 2024/1689 the contract
 *    refines are ALSO constraints, so a `psql` session cannot write a record the
 *    route would refuse;
 *  - that an ingested signed manifest cannot be edited after the fact, while the
 *    one column an `ON DELETE SET NULL` must write stays writable;
 *  - that the schema's mirrored value sets still equal the contract's;
 *  - that the hand-written trigger DDL in the migration is still the text the
 *    schema declares authoritative.
 *
 * Every row carries a per-test random identifier, so no assertion depends on a
 * table being empty and no aggregate reads a sibling file's rows.
 */

import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { eq, sql } from 'drizzle-orm';
import {
  modelDistributionMethodSchema,
  modelSystemicRiskTierSchema,
  SYSTEMIC_RISK_COMPUTE_THRESHOLD_FLOPS,
  trainingComputeFlopsSchema,
} from '@oxyhq/contracts';
import { closePostgres, connectPostgres, getDb } from '../../../config/postgres';
import {
  GPAI_DOCUMENTATION_INTERNAL_COLUMNS,
  inferenceModelGpaiDocumentation,
  MODEL_DISTRIBUTION_METHODS,
  MODEL_SYSTEMIC_RISK_TIERS,
  SYSTEMIC_RISK_COMPUTE_THRESHOLD_SQL,
} from '../inferenceModelGpaiDocumentation';
import { inferenceModelReleaseArtifacts } from '../inferenceModelReleaseArtifacts';
import {
  INFERENCE_RELEASE_ARTIFACTS_IMMUTABILITY_TRIGGER_DDL,
  INFERENCE_RELEASE_ARTIFACTS_IMMUTABILITY_TRIGGER_NAME,
  INFERENCE_RELEASE_CHILD_IMMUTABILITY_DDL,
  INFERENCE_RELEASE_IMMUTABILITY_DDL,
  INFERENCE_RELEASE_IMMUTABILITY_TRIGGER_DDL,
  INFERENCE_RELEASE_IMMUTABILITY_TRIGGER_NAME,
  INFERENCE_RELEASE_SIGNATURES_IMMUTABILITY_TRIGGER_DDL,
  INFERENCE_RELEASE_SIGNATURES_IMMUTABILITY_TRIGGER_NAME,
} from '../inferenceModelReleaseImmutability';
import { inferenceModelReleaseSignatures } from '../inferenceModelReleaseSignatures';
import {
  INFERENCE_RELEASE_IMMUTABLE_COLUMNS,
  inferenceModelReleases,
} from '../inferenceModelReleases';
import { inferenceModelRevisions } from '../inferenceModelRevisions';
import { inferenceModels } from '../inferenceModels';
import { inferencePublishers } from '../inferencePublishers';
import { PROTECTED_COLUMNS_BY_TABLE } from '../protectedColumns';

/** Postgres `check_violation` — also what every trigger here raises. */
const CHECK_VIOLATION = '23514';
/** Postgres `unique_violation`. */
const UNIQUE_VIOLATION = '23505';

/** The migration that installs these four tables and the three triggers. */
const RELEASE_MIGRATION = '0053_inference_model_release_ingestion.sql';

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

async function rejection(query: Promise<unknown>): Promise<unknown> {
  try {
    await query;
  } catch (error) {
    return error;
  }
  throw new Error('Expected the query to be rejected by a constraint, but it succeeded.');
}

/** A revision to hang documentation and releases off. */
async function insertRevision(): Promise<string> {
  const db = getDb();
  const publisherSlug = `dpub${suffix()}`;
  await db.insert(inferencePublishers).values({ slug: publisherSlug, displayName: 'Doc Pub' });

  const [model] = await db
    .insert(inferenceModels)
    .values({
      publisherSlug,
      slug: `dmdl${suffix()}`,
      displayName: 'Doc Fixture Model',
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
      releaseKind: 'first_party_original',
    })
    .returning({ id: inferenceModels.id });

  const [revision] = await db
    .insert(inferenceModelRevisions)
    .values({ modelId: model.id, revision: `dr${suffix()}`, releasedAt: new Date() })
    .returning({ id: inferenceModelRevisions.id });

  return revision.id;
}

/**
 * The NON-EXEMPT documentation record: Article 53(2) does not apply, so every
 * conditional column is required. That is the state each constraint below is
 * driven from, because the exempt state satisfies four of them vacuously.
 */
function documentationValues(modelRevisionId: string) {
  return {
    modelRevisionId,
    intendedTasks: 'Text generation.',
    distributionMethods: ['oxy_api'],
    architecture: 'Decoder-only transformer',
    parameterCount: 70_000_000_000,
    trainingDataSummaryUrl: 'https://example.test/training-data-summary',
    copyrightPolicyUrl: 'https://example.test/copyright-policy',
    systemicRisk: 'presumed_by_training_compute' as const,
    freeAndOpenSourceRelease: false,
    trainingComputeFlops: '4.2e25',
    trainingTimeHours: 41_600,
    energyConsumptionMwh: 3_820,
    adversarialTestingReportUrl: 'https://example.test/red-team',
    recordedAt: new Date(),
  };
}

async function insertRelease(modelRevisionId: string): Promise<string> {
  const [row] = await getDb()
    .insert(inferenceModelReleases)
    .values({
      releaseId: `arel_${suffix()}`,
      modelRevisionId,
      manifestSchemaVersion: 1,
      issuedAt: new Date(),
      manifestJson: '{"schemaVersion":1}',
    })
    .returning({ id: inferenceModelReleases.id });
  return row.id;
}

/* -------------------------------------------------------------------------- */

describe('the schema mirrors the contract it was built from', () => {
  it('carries the same distribution methods', () => {
    for (const value of MODEL_DISTRIBUTION_METHODS) {
      expect(modelDistributionMethodSchema.safeParse(value).success).toBe(true);
    }
    expect(modelDistributionMethodSchema.options.slice().sort()).toEqual(
      [...MODEL_DISTRIBUTION_METHODS].sort()
    );
  });

  it('carries the same systemic-risk tiers', () => {
    expect(modelSystemicRiskTierSchema.options.slice().sort()).toEqual(
      [...MODEL_SYSTEMIC_RISK_TIERS].sort()
    );
  });

  it('reads Article 51(2) as the same number the contract does', () => {
    // The SQL literal and the JS constant are two spellings of one threshold. If
    // they diverge, a record the contract refuses is one the database admits.
    expect(Number(SYSTEMIC_RISK_COMPUTE_THRESHOLD_SQL)).toBe(
      SYSTEMIC_RISK_COMPUTE_THRESHOLD_FLOPS
    );
  });

  it('accepts exactly the compute figures the contract accepts', async () => {
    // Agreement driven through the REAL constraint rather than by comparing two
    // regex sources, which would pass on two patterns that are equal as text and
    // different as POSIX ARE vs JavaScript.
    const cases = ['4.2e25', '1e26', '2.5e+26', '42', '4.2E25', '-1e25', '1e', '01e25'];

    for (const value of cases) {
      const revisionId = await insertRevision();
      const contractAccepts = trainingComputeFlopsSchema.safeParse(value).success;

      // Everything here is above or below the threshold in a way the OTHER
      // constraints do not care about, so `designated_by_commission` keeps this
      // test about the format alone.
      const insert = getDb()
        .insert(inferenceModelGpaiDocumentation)
        .values({
          ...documentationValues(revisionId),
          systemicRisk: 'designated_by_commission',
          trainingComputeFlops: value,
        });

      if (contractAccepts) {
        await expect(insert).resolves.toBeDefined();
      } else {
        expect(pgErrorCode(await rejection(insert))).toBe(CHECK_VIOLATION);
      }
    }
  });
});

describe('inference_model_gpai_documentation constraints', () => {
  it('accepts a fully documented non-exempt release', async () => {
    const revisionId = await insertRevision();
    await getDb().insert(inferenceModelGpaiDocumentation).values(documentationValues(revisionId));

    const [row] = await getDb()
      .select({ parameterCount: inferenceModelGpaiDocumentation.parameterCount })
      .from(inferenceModelGpaiDocumentation)
      .where(eq(inferenceModelGpaiDocumentation.modelRevisionId, revisionId));

    // `bigint` with `mode: 'number'` — the driver hands back a string and the
    // result mapper converts it. A row read as `'70000000000'` would compare
    // unequal here.
    expect(row.parameterCount).toBe(70_000_000_000);
  });

  it('requires each Annex XI field unless Article 53(2) exempts the release', async () => {
    const nullable = [
      'intendedTasks',
      'architecture',
      'parameterCount',
      'trainingTimeHours',
      'energyConsumptionMwh',
    ] as const;

    for (const field of nullable) {
      const revisionId = await insertRevision();
      const error = await rejection(
        getDb()
          .insert(inferenceModelGpaiDocumentation)
          .values({ ...documentationValues(revisionId), [field]: null })
      );
      expect(pgErrorCode(error)).toBe(CHECK_VIOLATION);
    }
  });

  it('admits the exempt record with all five absent', async () => {
    // The positive control for the five refusals above: they are about the
    // exemption, not about those columns being NOT NULL.
    const revisionId = await insertRevision();
    await getDb()
      .insert(inferenceModelGpaiDocumentation)
      .values({
        modelRevisionId: revisionId,
        distributionMethods: ['downloadable_weights'],
        trainingDataSummaryUrl: 'https://example.test/summary',
        copyrightPolicyUrl: 'https://example.test/copyright',
        systemicRisk: 'not_designated',
        freeAndOpenSourceRelease: true,
        recordedAt: new Date(),
      });

    const [row] = await getDb()
      .select({ architecture: inferenceModelGpaiDocumentation.architecture })
      .from(inferenceModelGpaiDocumentation)
      .where(eq(inferenceModelGpaiDocumentation.modelRevisionId, revisionId));
    expect(row.architecture).toBeNull();
  });

  it('does not exempt a free-and-open-source model with systemic risk', async () => {
    const revisionId = await insertRevision();
    const error = await rejection(
      getDb()
        .insert(inferenceModelGpaiDocumentation)
        .values({
          modelRevisionId: revisionId,
          distributionMethods: ['downloadable_weights'],
          trainingDataSummaryUrl: 'https://example.test/summary',
          copyrightPolicyUrl: 'https://example.test/copyright',
          systemicRisk: 'designated_by_commission',
          adversarialTestingReportUrl: 'https://example.test/red-team',
          freeAndOpenSourceRelease: true,
          recordedAt: new Date(),
        })
    );
    expect(pgErrorCode(error)).toBe(CHECK_VIOLATION);
  });

  it('refuses a presumption that withholds the compute figure', async () => {
    const revisionId = await insertRevision();
    const error = await rejection(
      getDb()
        .insert(inferenceModelGpaiDocumentation)
        .values({ ...documentationValues(revisionId), trainingComputeFlops: null })
    );
    expect(pgErrorCode(error)).toBe(CHECK_VIOLATION);
  });

  it('refuses compute past Article 51(2) beside no classification, on both sides of the line', async () => {
    const below = await insertRevision();
    await getDb()
      .insert(inferenceModelGpaiDocumentation)
      .values({
        ...documentationValues(below),
        systemicRisk: 'not_designated',
        trainingComputeFlops: '9.9e24',
        adversarialTestingReportUrl: null,
      });

    const at = await insertRevision();
    const error = await rejection(
      getDb()
        .insert(inferenceModelGpaiDocumentation)
        .values({
          ...documentationValues(at),
          systemicRisk: 'not_designated',
          trainingComputeFlops: '1e25',
          adversarialTestingReportUrl: null,
        })
    );
    expect(pgErrorCode(error)).toBe(CHECK_VIOLATION);
  });

  it('requires the Article 55(1)(a) report of every systemic-risk model', async () => {
    for (const tier of ['presumed_by_training_compute', 'designated_by_commission'] as const) {
      const revisionId = await insertRevision();
      const error = await rejection(
        getDb()
          .insert(inferenceModelGpaiDocumentation)
          .values({
            ...documentationValues(revisionId),
            systemicRisk: tier,
            adversarialTestingReportUrl: null,
          })
      );
      expect(pgErrorCode(error)).toBe(CHECK_VIOLATION);
    }
  });

  it('refuses an empty distribution-method array and an unknown member', async () => {
    // `cardinality`, not `array_length`: the latter is NULL on `{}` and a CHECK
    // rejects only FALSE, so `>= 1` would ADMIT the empty array.
    const empty = await insertRevision();
    expect(
      pgErrorCode(
        await rejection(
          getDb()
            .insert(inferenceModelGpaiDocumentation)
            .values({ ...documentationValues(empty), distributionMethods: [] })
        )
      )
    ).toBe(CHECK_VIOLATION);

    const unknown = await insertRevision();
    expect(
      pgErrorCode(
        await rejection(
          getDb()
            .insert(inferenceModelGpaiDocumentation)
            .values({ ...documentationValues(unknown), distributionMethods: ['torrent'] })
        )
      )
    ).toBe(CHECK_VIOLATION);
  });

  it('holds at most one documentation record per revision', async () => {
    const revisionId = await insertRevision();
    await getDb().insert(inferenceModelGpaiDocumentation).values(documentationValues(revisionId));
    const error = await rejection(
      getDb().insert(inferenceModelGpaiDocumentation).values(documentationValues(revisionId))
    );
    expect(pgErrorCode(error)).toBe(UNIQUE_VIOLATION);
  });

  it('is UPDATABLE, because Article 51(1)(b) designation happens after release', async () => {
    // Stated as a test rather than left implicit: the revision this hangs off IS
    // immutable, and the natural reading of "documentation for an immutable
    // revision" is that it is immutable too. It must not be.
    const revisionId = await insertRevision();
    await getDb().insert(inferenceModelGpaiDocumentation).values(documentationValues(revisionId));

    await getDb()
      .update(inferenceModelGpaiDocumentation)
      .set({ systemicRisk: 'designated_by_commission' })
      .where(eq(inferenceModelGpaiDocumentation.modelRevisionId, revisionId));

    const [row] = await getDb()
      .select({ systemicRisk: inferenceModelGpaiDocumentation.systemicRisk })
      .from(inferenceModelGpaiDocumentation)
      .where(eq(inferenceModelGpaiDocumentation.modelRevisionId, revisionId));
    expect(row.systemicRisk).toBe('designated_by_commission');
  });
});

describe('an ingested release is evidence, so it cannot be edited', () => {
  it('installs all three triggers', async () => {
    const names = [
      INFERENCE_RELEASE_IMMUTABILITY_TRIGGER_NAME,
      INFERENCE_RELEASE_ARTIFACTS_IMMUTABILITY_TRIGGER_NAME,
      INFERENCE_RELEASE_SIGNATURES_IMMUTABILITY_TRIGGER_NAME,
    ];
    const rows = await getDb().execute<{ tgname: string }>(
      sql`select tgname from pg_trigger where tgname in (${sql.join(
        names.map((name) => sql`${name}`),
        sql`, `
      )})`
    );
    expect([...rows].map((row) => row.tgname).sort()).toEqual([...names].sort());
  });

  it('refuses an UPDATE to every column the signature covers', async () => {
    // Driven per column out of the exported tuple, so adding a column there
    // without adding it to the DDL fails, and removing one from the DDL without
    // removing it here fails too.
    const revisionId = await insertRevision();
    const releaseRowId = await insertRelease(revisionId);
    const otherRevisionId = await insertRevision();

    // Every replacement is a STRING or a NUMBER, never a `Date`: a bare `Date`
    // interpolated into a drizzle `sql` template fails at serialisation IN THE
    // DRIVER, which throws an error carrying no SQLSTATE — indistinguishable
    // here from a trigger that did not fire. Postgres infers the parameter type
    // from the target column, so an ISO string reaches `timestamptz` intact.
    const replacements: Record<(typeof INFERENCE_RELEASE_IMMUTABLE_COLUMNS)[number], string | number> = {
      release_id: `arel_${suffix()}`,
      model_revision_id: otherRevisionId,
      manifest_schema_version: 2,
      issued_at: '2020-01-01T00:00:00.000Z',
      manifest_json: '{"schemaVersion":1,"tampered":true}',
    };

    for (const column of INFERENCE_RELEASE_IMMUTABLE_COLUMNS) {
      const error = await rejection(
        getDb().execute(
          sql`update inference_model_releases set ${sql.raw(column)} = ${replacements[column]} where id = ${releaseRowId}`
        )
      );
      expect(pgErrorCode(error)).toBe(CHECK_VIOLATION);
      expect(String(error)).toContain(column);
    }
  });

  it('leaves the actor column writable, or a user deletion would fail on it', async () => {
    // `ingested_by_user_id` is `ON DELETE SET NULL`, which performs an UPDATE.
    // A trigger refusing it would turn an erasure request into a constraint
    // failure on a compliance record.
    const revisionId = await insertRevision();
    const releaseRowId = await insertRelease(revisionId);

    await getDb().execute(
      sql`update inference_model_releases set ingested_by_user_id = null where id = ${releaseRowId}`
    );

    const [row] = await getDb()
      .select({ ingestedByUserId: inferenceModelReleases.ingestedByUserId })
      .from(inferenceModelReleases)
      .where(eq(inferenceModelReleases.id, releaseRowId));
    expect(row.ingestedByUserId).toBeNull();
  });

  it('refuses any UPDATE to the artifact inventory and the signatures', async () => {
    const revisionId = await insertRevision();
    const releaseRowId = await insertRelease(revisionId);

    await getDb().insert(inferenceModelReleaseArtifacts).values({
      releaseId: releaseRowId,
      path: 'model.safetensors',
      digest: `sha256:${'b'.repeat(64)}`,
      sizeBytes: 1024,
    });
    await getDb().insert(inferenceModelReleaseSignatures).values({
      releaseId: releaseRowId,
      algorithm: 'ed25519',
      canonicalization: 'jcs',
      keyId: `key-${suffix()}`,
      signature: 'A'.repeat(86),
      signedAt: new Date(),
    });

    const artifactError = await rejection(
      getDb()
        .update(inferenceModelReleaseArtifacts)
        .set({ sizeBytes: 2048 })
        .where(eq(inferenceModelReleaseArtifacts.releaseId, releaseRowId))
    );
    expect(pgErrorCode(artifactError)).toBe(CHECK_VIOLATION);
    expect(String(artifactError)).toContain('inference_model_release_artifacts');

    const signatureError = await rejection(
      getDb()
        .update(inferenceModelReleaseSignatures)
        .set({ keyId: 'somebody-else' })
        .where(eq(inferenceModelReleaseSignatures.releaseId, releaseRowId))
    );
    expect(pgErrorCode(signatureError)).toBe(CHECK_VIOLATION);
    expect(String(signatureError)).toContain('inference_model_release_signatures');
  });

  it('still CASCADES a delete, which is why the guard is UPDATE-only', async () => {
    const revisionId = await insertRevision();
    const releaseRowId = await insertRelease(revisionId);
    await getDb().insert(inferenceModelReleaseArtifacts).values({
      releaseId: releaseRowId,
      path: 'model.safetensors',
      digest: `sha256:${'c'.repeat(64)}`,
      sizeBytes: 1024,
    });

    await getDb().delete(inferenceModelRevisions).where(eq(inferenceModelRevisions.id, revisionId));

    const remaining = await getDb()
      .select({ id: inferenceModelReleaseArtifacts.id })
      .from(inferenceModelReleaseArtifacts)
      .where(eq(inferenceModelReleaseArtifacts.releaseId, releaseRowId));
    expect(remaining).toHaveLength(0);
  });

  it('holds one release per manifest release id', async () => {
    const revisionId = await insertRevision();
    const releaseId = `arel_${suffix()}`;
    const values = {
      releaseId,
      modelRevisionId: revisionId,
      manifestSchemaVersion: 1,
      issuedAt: new Date(),
      manifestJson: '{}',
    };
    await getDb().insert(inferenceModelReleases).values(values);
    const error = await rejection(
      getDb()
        .insert(inferenceModelReleases)
        .values({ ...values, modelRevisionId: await insertRevision() })
    );
    expect(pgErrorCode(error)).toBe(UNIQUE_VIOLATION);
  });
});

describe('the Annex XI Section 2 columns are registered as protected', () => {
  it('registers exactly the four the public projection withholds', () => {
    expect(PROTECTED_COLUMNS_BY_TABLE.inference_model_gpai_documentation).toEqual(
      GPAI_DOCUMENTATION_INTERNAL_COLUMNS
    );
    expect(GPAI_DOCUMENTATION_INTERNAL_COLUMNS).toEqual([
      'trainingComputeFlops',
      'trainingTimeHours',
      'energyConsumptionMwh',
      'adversarialTestingReportUrl',
    ]);
  });

  it('names columns that exist on the table', () => {
    // A registry entry naming a column that was renamed away protects nothing,
    // and `publicColumns` would silently stop excluding it.
    for (const column of GPAI_DOCUMENTATION_INTERNAL_COLUMNS) {
      expect(Object.keys(inferenceModelGpaiDocumentation)).toContain(column);
    }
  });
});

describe(`${RELEASE_MIGRATION} carries the DDL the schema declares authoritative`, () => {
  const migration = readFileSync(
    join(__dirname, '..', '..', '..', '..', 'drizzle', RELEASE_MIGRATION),
    'utf8'
  );

  it('carries both function texts', () => {
    expect(migration).toContain(INFERENCE_RELEASE_IMMUTABILITY_DDL);
    expect(migration).toContain(INFERENCE_RELEASE_CHILD_IMMUTABILITY_DDL);
  });

  it('carries all three trigger texts', () => {
    expect(migration).toContain(INFERENCE_RELEASE_IMMUTABILITY_TRIGGER_DDL);
    expect(migration).toContain(INFERENCE_RELEASE_ARTIFACTS_IMMUTABILITY_TRIGGER_DDL);
    expect(migration).toContain(INFERENCE_RELEASE_SIGNATURES_IMMUTABILITY_TRIGGER_DDL);
  });

  it('declares a deploy phase, so the deploy knows which side it belongs on', () => {
    expect(migration).toContain('-- oxy:deploy-phase=pre');
  });

  it('touches no table that already existed, which is why it can be `pre`', () => {
    // An ALTER or a DROP of an existing table would make the OLD image's writes a
    // hazard during the roll-out, and the header claims this migration does
    // neither. Checked by naming every table the SQL touches, because a
    // `not.toContain('DROP TABLE')` would pass on a migration that dropped a
    // COLUMN, and a `^DROP` anchor passes on one that indents it.
    //
    // Comments are stripped FIRST. The header of this very file contains the
    // words "drop" and "ALTER", so a line-based grep over the raw text would
    // report a hit that is prose.
    const statements = migration
      .split('--> statement-breakpoint')
      .map((statement) => statement.replace(/^\s*--.*$/gm, '').trim())
      .filter((statement) => statement.length > 0);

    // Vacuity floor: a split that stopped matching would report an empty world
    // and every assertion below would pass for the wrong reason.
    expect(statements.length).toBeGreaterThanOrEqual(12);

    const NEW_TABLES = [
      'inference_model_gpai_documentation',
      'inference_model_release_artifacts',
      'inference_model_release_signatures',
      'inference_model_releases',
    ];

    const touched = new Set<string>();
    let recognised = 0;
    for (const statement of statements) {
      const match =
        /^(?:CREATE TABLE|ALTER TABLE|DROP TABLE)\s+"([a-z_]+)"/i.exec(statement) ??
        /\bON\s+"?([a-z_]+)"?/i.exec(statement);
      if (match === null) {
        // Only the two `CREATE OR REPLACE FUNCTION` bodies name no table.
        expect(statement).toMatch(/^CREATE OR REPLACE FUNCTION/);
        continue;
      }
      recognised += 1;
      touched.add(match[1]);
    }

    // The second floor: a regex that matched nothing would leave `touched` empty
    // and the equality below would compare two empty sets.
    expect(recognised).toBeGreaterThanOrEqual(10);
    expect([...touched].sort()).toEqual(NEW_TABLES);

    // Every statement is one of five ADDITIVE forms.
    //
    // An allow-list on the LEADING verb, not a search for a destructive word:
    // `ON DELETE cascade`, `ON UPDATE no action` and `BEFORE UPDATE` are all
    // legitimate here, so a `not.toMatch(/DROP|UPDATE/)` reports a hit on a
    // foreign key. Anchoring on the verb refuses a `DROP TABLE`, a `TRUNCATE`, a
    // `DELETE`, a bare `UPDATE` and an `ALTER TABLE ... DROP COLUMN` alike.
    const ADDITIVE_STATEMENT =
      /^(?:CREATE TABLE\s+"|ALTER TABLE\s+"[a-z_]+"\s+ADD CONSTRAINT\b|CREATE INDEX\s+"|CREATE OR REPLACE FUNCTION\b|CREATE TRIGGER\b)/i;
    for (const statement of statements) {
      expect(statement).toMatch(ADDITIVE_STATEMENT);
    }
  });
});
