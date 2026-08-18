/**
 * Model documentation: ingesting a signed release, and serving the
 * customer-safe documentation of one revision (issue #972 §12).
 *
 * Two halves of one domain. {@link ingestModelRelease} is how documentation
 * enters the catalogue; {@link getRevisionDocumentation} is how a downstream
 * developer reads it.
 *
 * ## What a signed manifest can and cannot create
 *
 * `aliaModelReleaseManifestSchema` carries a revision, a licence, a provenance
 * block, evaluations, safety metadata and an artifact inventory. It carries NO
 * capability sheet — no modalities, no `maxContextTokens`, none of the
 * `supports_*` flags — and every one of those is `NOT NULL` on
 * `inference_models`. So a manifest alone cannot create a MODEL LINE, only a
 * revision of one.
 *
 * That is not a defect in the manifest: a capability sheet is a statement about
 * what the OXY API will serve, which is Oxy's to make and not the signer's. So
 * the ingestion request carries it beside the manifest, exactly as the GPAI
 * documentation record does, and for the same reason — the signature covers the
 * document the signer wrote, and nothing else is smuggled inside it.
 *
 * ## Ingesting is not publishing, and the containment is structural
 *
 * Oxy holds no Alia signing key and what verifies a release manifest is an open
 * decision (`@oxyhq/contracts`' `inference/aliaModelRelease.ts` argues it), so
 * ingestion records no verification finding. What authorizes it is the staff
 * member, recorded on the release row and gated on
 * `inference:catalogue:publish`.
 *
 * That is acceptable because an ingested release is not servable and not listed:
 *
 *  - The revision is written with `is_current = false`. Which revision a bare
 *    `<publisher>/<model>` resolves to is a live editorial decision, and making
 *    an ingest change what every unpinned customer call resolves to would fold
 *    two decisions into one.
 *  - `buildCatalogueEntry` returns null for a model with no DEPLOYMENT, and this
 *    creates none. A deployment additionally needs an approved contract/legal
 *    review before any viewer can select it
 *    (`inference_deployments_approval_requires_legal_review`).
 *
 * So the worst an ingest can do is put documentation in the catalogue that
 * nobody is served. Promoting a revision to current, and creating a deployment
 * for it, are separate verbs this module deliberately does not have.
 *
 * ## What a re-ingest does
 *
 * `inference_model_releases.release_id` is UNIQUE, so ingestion is idempotent on
 * the manifest's own identity: a retried request finds the existing row and
 * reports `already_ingested`, rather than creating a second revision of the same
 * weights. A DIFFERENT release naming an already-ingested revision label is
 * refused by `inference_model_revisions_model_id_revision_key` — the same
 * constraint that makes a customer's pin definite.
 */

import { and, asc, eq } from 'drizzle-orm';
import { isUniqueViolation } from '@oxyhq/db';
import {
  type AliaModelReleaseManifest,
  type ModelDocumentation,
  type ModelGpaiDocumentation,
  type ModelLineDeclaration,
  type ModelReleaseIngestionResult,
  modelDocumentationSchema,
  modelReleaseIngestionResultSchema,
} from '@oxyhq/contracts';
import { getDb, type Transaction } from '../config/postgres';
import {
  inferenceModelEvaluations,
  inferenceModelGpaiDocumentation,
  inferenceModelReleaseArtifacts,
  inferenceModelReleaseSignatures,
  inferenceModelReleases,
  inferenceModelRevisions,
  inferenceModels,
  inferencePublishers,
} from '../db/schema';
import {
  type CatalogueViewer,
  composeModelReference,
  getCatalogueEntryForViewer,
} from './inferenceCatalogue.service';

/**
 * Raised when a release cannot be ingested, with a sentence saying why.
 *
 * Distinguished from a constraint error so the route can answer 409 with a
 * sentence rather than surfacing a SQLSTATE — but the CONSTRAINT is still there
 * and still authoritative: this class is a better message, never the enforcement.
 */
export class ModelReleaseRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ModelReleaseRefused';
  }
}

/** Raised when the revision a documentation write names does not exist. */
export class ModelRevisionNotFound extends Error {
  constructor(modelRevisionId: string) {
    super(`No model revision with id ${modelRevisionId}`);
    this.name = 'ModelRevisionNotFound';
  }
}

export interface IngestModelReleaseInput {
  readonly manifest: AliaModelReleaseManifest;
  readonly gpaiDocumentation: ModelGpaiDocumentation;
  readonly model: ModelLineDeclaration;
  /** The manifest EXACTLY as received, before any parse applied a default. */
  readonly manifestJson: string;
  readonly staffUserId: string;
}

/** `<publisher>/<model>` split into its two parts. */
function splitModelId(modelId: string): { publisher: string; slug: string } {
  const separator = modelId.indexOf('/');
  return { publisher: modelId.slice(0, separator), slug: modelId.slice(separator + 1) };
}

/**
 * Ingest a signed release manifest and the documentation record beside it.
 *
 * One transaction, because a release whose signatures landed and whose artifacts
 * did not is a record that claims to be signed evidence and is not — and because
 * the GPAI documentation is what makes the release DOCUMENTED, so a revision
 * without it would be exactly the state §12 exists to prevent.
 */
export async function ingestModelRelease(
  input: IngestModelReleaseInput
): Promise<ModelReleaseIngestionResult> {
  const { manifest } = input;
  const { publisher, slug } = splitModelId(manifest.revision.modelId);

  return getDb().transaction(async (tx): Promise<ModelReleaseIngestionResult> => {
    // Idempotency, read first so a retry is cheap and reports the truth rather
    // than racing to a constraint. The constraint is still the control: the
    // insert below carries `release_id` UNIQUE, and a concurrent request that
    // slipped past this read fails there.
    const [existing] = await tx
      .select({ id: inferenceModelReleases.id })
      .from(inferenceModelReleases)
      .where(eq(inferenceModelReleases.releaseId, manifest.releaseId));

    if (existing !== undefined) {
      return describeRelease(tx, existing.id, 'already_ingested');
    }

    // The publisher namespace has to be reserved already. `alia` is seeded by
    // `scripts/seed-inference-catalogue.ts`, and creating a publisher row here
    // would let an ingest mint a namespace — which is what
    // `inference_models_reserved_namespace_is_first_party` exists to constrain.
    const [publisherRow] = await tx
      .select({ slug: inferencePublishers.slug })
      .from(inferencePublishers)
      .where(eq(inferencePublishers.slug, publisher));

    if (publisherRow === undefined) {
      throw new ModelReleaseRefused(
        `No publisher namespace ${publisher} is reserved. Reserve it before ingesting a release under it.`
      );
    }

    const modelId = await resolveModelLine(tx, { publisher, slug, input });

    const revisionId = await insertRevision(tx, modelId, input);

    const evaluationCount = manifest.revision.evaluations.length;
    if (evaluationCount > 0) {
      await tx.insert(inferenceModelEvaluations).values(
        manifest.revision.evaluations.map((evaluation) => ({
          modelRevisionId: revisionId,
          suite: evaluation.suite,
          metric: evaluation.metric,
          score: evaluation.score,
          evaluatedAt: evaluation.evaluatedAt === undefined ? null : new Date(evaluation.evaluatedAt),
          reportUrl: evaluation.reportUrl ?? null,
        }))
      );
    }

    const [release] = await tx
      .insert(inferenceModelReleases)
      .values({
        releaseId: manifest.releaseId,
        modelRevisionId: revisionId,
        manifestSchemaVersion: manifest.schemaVersion,
        issuedAt: new Date(manifest.issuedAt),
        manifestJson: input.manifestJson,
        ingestedByUserId: input.staffUserId,
      })
      .returning({ id: inferenceModelReleases.id });

    await tx.insert(inferenceModelReleaseArtifacts).values(
      manifest.artifacts.map((artifact) => ({
        releaseId: release.id,
        path: artifact.path,
        digest: artifact.digest,
        sizeBytes: artifact.sizeBytes,
        mediaType: artifact.mediaType ?? null,
      }))
    );

    await tx.insert(inferenceModelReleaseSignatures).values(
      manifest.signatures.map((signature) => ({
        releaseId: release.id,
        algorithm: signature.algorithm,
        canonicalization: signature.canonicalization,
        keyId: signature.keyId,
        signature: signature.signature,
        signedAt: new Date(signature.signedAt),
      }))
    );

    await writeGpaiDocumentation(tx, revisionId, input.gpaiDocumentation, input.staffUserId);

    return describeRelease(tx, release.id, 'ingested');
  });
}

/**
 * Find the model line, or create it.
 *
 * On an EXISTING model the declaration is not applied — a release does not edit a
 * model line — but three fields are CHECKED, and the choice of which three is the
 * point. `license_id`, `release_kind` and `base_model_reference` are claims about
 * somebody's rights and somebody's weights: a manifest disagreeing with the
 * catalogue about any of them is either a relicensing (a catalogue decision
 * somebody should take deliberately) or a mistake, and both are better refused
 * than silently taken from whichever document arrived last.
 *
 * `display_name`, `description` and the capability sheet are deliberately NOT
 * checked. Those are editorial and Oxy's own, so a difference is not a claim
 * about anybody's rights — and refusing an ingest over a reworded description
 * would be a gate whose cheapest green is editing the model row to match.
 */
async function resolveModelLine(
  tx: Transaction,
  args: { publisher: string; slug: string; input: IngestModelReleaseInput }
): Promise<string> {
  const { publisher, slug, input } = args;
  const { manifest, model } = input;

  const [existing] = await tx
    .select({
      id: inferenceModels.id,
      licenseId: inferenceModels.licenseId,
      releaseKind: inferenceModels.releaseKind,
      baseModelReference: inferenceModels.baseModelReference,
    })
    .from(inferenceModels)
    .where(and(eq(inferenceModels.publisherSlug, publisher), eq(inferenceModels.slug, slug)));

  if (existing !== undefined) {
    const mismatches: string[] = [];
    if (existing.licenseId !== manifest.license.licenseId) {
      mismatches.push(
        `licence ${existing.licenseId} on record, ${manifest.license.licenseId} in the manifest`
      );
    }
    if (existing.releaseKind !== manifest.provenance.releaseKind) {
      mismatches.push(
        `release kind ${existing.releaseKind} on record, ${manifest.provenance.releaseKind} in the manifest`
      );
    }
    if ((existing.baseModelReference ?? undefined) !== manifest.provenance.baseModelId) {
      mismatches.push(
        `base model ${existing.baseModelReference ?? 'none'} on record, ${manifest.provenance.baseModelId ?? 'none'} in the manifest`
      );
    }
    if (mismatches.length > 0) {
      throw new ModelReleaseRefused(
        `This manifest disagrees with the model already in the catalogue: ${mismatches.join('; ')}. A relicensing or a provenance correction is a catalogue decision, not a release.`
      );
    }
    return existing.id;
  }

  const [created] = await tx
    .insert(inferenceModels)
    .values({
      publisherSlug: publisher,
      slug,
      displayName: model.displayName,
      description: model.description ?? null,
      inputModalities: [...model.capabilities.inputModalities],
      outputModalities: [...model.capabilities.outputModalities],
      supportsTools: model.capabilities.tools,
      supportsParallelToolCalls: model.capabilities.parallelToolCalls,
      supportsStructuredOutput: model.capabilities.structuredOutput,
      supportsJsonMode: model.capabilities.jsonMode,
      supportsReasoning: model.capabilities.reasoning,
      supportsStreaming: model.capabilities.streaming,
      supportsPromptCaching: model.capabilities.promptCaching,
      maxContextTokens: model.capabilities.maxContextTokens,
      maxOutputTokens: model.capabilities.maxOutputTokens,
      licenseId: manifest.license.licenseId,
      licenseDisplayName: manifest.license.displayName,
      licenseUrl: manifest.license.url ?? null,
      commercialUseAllowed: manifest.license.commercialUseAllowed,
      requiresAttribution: manifest.license.requiresAttribution,
      acceptableUsePolicyUrl: manifest.license.acceptableUsePolicyUrl ?? null,
      releaseKind: manifest.provenance.releaseKind,
      baseModelReference: manifest.provenance.baseModelId ?? null,
      trainingOrganization: manifest.provenance.trainingOrganization ?? null,
      knowledgeCutoff: model.knowledgeCutoff ?? null,
      releasedOn: model.releasedOn ?? null,
    })
    .returning({ id: inferenceModels.id });

  return created.id;
}

/**
 * Write the revision.
 *
 * `is_current: false` — see the module header. The safety object is written as a
 * whole or not at all, which is what
 * `inference_model_revisions_safety_is_whole` requires; the manifest's own
 * refinement already guarantees a first-party release has one, so the branch is
 * the type narrowing rather than a real second case.
 */
async function insertRevision(
  tx: Transaction,
  modelId: string,
  input: IngestModelReleaseInput
): Promise<string> {
  const { revision } = input.manifest;
  const safety = revision.safety;

  try {
    const [row] = await tx
      .insert(inferenceModelRevisions)
      .values({
        modelId,
        revision: revision.revision,
        isCurrent: false,
        releasedAt: new Date(revision.releasedAt),
        retiredAt: revision.retiredAt === undefined ? null : new Date(revision.retiredAt),
        artifactDigest: revision.artifactDigest ?? null,
        modelCardUrl: revision.modelCardUrl ?? null,
        contentFilteringDefault: safety?.contentFilteringDefault ?? null,
        provenanceMarking: safety?.provenanceMarking ?? null,
        safetyCardUrl: safety?.safetyCardUrl ?? null,
        knownLimitations: safety === undefined ? null : [...safety.knownLimitations],
      })
      .returning({ id: inferenceModelRevisions.id });
    return row.id;
  } catch (error) {
    if (isUniqueViolation(error, 'inference_model_revisions_model_id_revision_key')) {
      throw new ModelReleaseRefused(
        `Revision ${revision.reference} is already in the catalogue. A published revision always names the same weights, so a corrected release ships as a new revision.`
      );
    }
    throw error;
  }
}

/**
 * Write or replace the documentation record for a revision.
 *
 * Returns the instant it recorded, so a caller reports the value that LANDED
 * rather than one it computed beside the write. Two clocks for one fact is how a
 * response comes to disagree with the row it describes.
 */
async function writeGpaiDocumentation(
  tx: Transaction,
  modelRevisionId: string,
  documentation: ModelGpaiDocumentation,
  staffUserId: string
): Promise<Date> {
  const recordedAt = new Date();
  const values = {
    modelRevisionId,
    intendedTasks: documentation.intendedTasks ?? null,
    distributionMethods: [...documentation.distributionMethods],
    architecture: documentation.architecture ?? null,
    parameterCount: documentation.parameterCount ?? null,
    trainingDataSummaryUrl: documentation.trainingDataSummaryUrl,
    copyrightPolicyUrl: documentation.copyrightPolicyUrl,
    systemicRisk: documentation.systemicRisk,
    freeAndOpenSourceRelease: documentation.freeAndOpenSourceRelease,
    trainingComputeFlops: documentation.trainingComputeFlops ?? null,
    trainingTimeHours: documentation.trainingTimeHours ?? null,
    energyConsumptionMwh: documentation.energyConsumptionMwh ?? null,
    adversarialTestingReportUrl: documentation.adversarialTestingReportUrl ?? null,
    recordedAt,
    recordedByUserId: staffUserId,
  };

  // A REPLACEMENT, never a merge. A documentation record is a single statement
  // about a release, so patching one field of it would leave the rest asserted by
  // whoever wrote it last — and the Article 53(2) and Article 51(2) constraints
  // are about the record as a whole, so a partial update could satisfy them
  // against fields the caller never saw.
  await tx
    .insert(inferenceModelGpaiDocumentation)
    .values(values)
    .onConflictDoUpdate({
      target: inferenceModelGpaiDocumentation.modelRevisionId,
      set: values,
    });

  return recordedAt;
}

/**
 * Record a documentation statement about a revision that already exists.
 *
 * Separate from ingestion because Article 51(1)(b) allows the Commission to
 * designate a model as carrying systemic risk AFTER it was released, which turns
 * a compliant record into an incomplete one through no act of Oxy's. Without this
 * the only way to state the new classification would be a new release of
 * identical weights, which the revision immutability trigger is right to refuse.
 */
export async function recordRevisionGpaiDocumentation(input: {
  readonly modelRevisionId: string;
  readonly documentation: ModelGpaiDocumentation;
  readonly staffUserId: string;
}): Promise<{ readonly modelRevisionId: string; readonly recordedAt: string }> {
  const db = getDb();

  const [revision] = await db
    .select({ id: inferenceModelRevisions.id })
    .from(inferenceModelRevisions)
    .where(eq(inferenceModelRevisions.id, input.modelRevisionId));

  if (revision === undefined) throw new ModelRevisionNotFound(input.modelRevisionId);

  const recordedAt = await db.transaction((tx) =>
    writeGpaiDocumentation(tx, input.modelRevisionId, input.documentation, input.staffUserId)
  );

  return { modelRevisionId: input.modelRevisionId, recordedAt: recordedAt.toISOString() };
}

/** The ingestion result, read back from the rows that landed. */
async function describeRelease(
  tx: Transaction,
  releaseRowId: string,
  outcome: 'ingested' | 'already_ingested'
): Promise<ModelReleaseIngestionResult> {
  const [row] = await tx
    .select({
      releaseId: inferenceModelReleases.releaseId,
      createdAt: inferenceModelReleases.createdAt,
      revision: inferenceModelRevisions.revision,
      revisionId: inferenceModelRevisions.id,
      modelId: inferenceModels.modelId,
    })
    .from(inferenceModelReleases)
    .innerJoin(
      inferenceModelRevisions,
      eq(inferenceModelReleases.modelRevisionId, inferenceModelRevisions.id)
    )
    .innerJoin(inferenceModels, eq(inferenceModelRevisions.modelId, inferenceModels.id))
    .where(eq(inferenceModelReleases.id, releaseRowId));

  if (row === undefined || row.modelId === null) {
    // Unreachable through either caller — both read a row they have just
    // observed, inside the same transaction, and `model_id` is a GENERATED
    // column over two NOT NULL parts. Stated rather than asserted away with a
    // non-null operator, so the impossible case is a message instead of a
    // `TypeError` two frames later.
    throw new ModelReleaseRefused(`Release ${releaseRowId} could not be read back after ingest.`);
  }

  const artifacts = await tx
    .select({ id: inferenceModelReleaseArtifacts.id })
    .from(inferenceModelReleaseArtifacts)
    .where(eq(inferenceModelReleaseArtifacts.releaseId, releaseRowId));

  const signatures = await tx
    .select({ id: inferenceModelReleaseSignatures.id })
    .from(inferenceModelReleaseSignatures)
    .where(eq(inferenceModelReleaseSignatures.releaseId, releaseRowId));

  const evaluations = await tx
    .select({ id: inferenceModelEvaluations.id })
    .from(inferenceModelEvaluations)
    .where(eq(inferenceModelEvaluations.modelRevisionId, row.revisionId));

  return modelReleaseIngestionResultSchema.parse({
    schemaVersion: 1,
    releaseId: row.releaseId,
    modelId: row.modelId,
    revision: row.revision,
    reference: composeModelReference(row.modelId, row.revision),
    outcome,
    artifactCount: artifacts.length,
    signatureCount: signatures.length,
    evaluationCount: evaluations.length,
    ingestedAt: row.createdAt.toISOString(),
  });
}

/* -------------------------------------------------------------------------- */
/*  The customer-safe documentation read                                      */
/* -------------------------------------------------------------------------- */

/**
 * The documentation of one revision, for a viewer who may see the model.
 *
 * ## Selectability is delegated, not re-implemented
 *
 * The first thing this does is ask {@link getCatalogueEntryForViewer} whether the
 * MODEL is available to this viewer, and answer `undefined` when it is not. That
 * costs a second query set and buys the thing a local predicate could not: there
 * is exactly ONE selectability rule in this service layer, so this endpoint cannot
 * drift into being an existence oracle for models Oxy runs internally. A model
 * the viewer may not see and a model that does not exist are the same answer here
 * for the same reason they are on `GET /models/:publisher/:model`.
 *
 * ## The revision may be any revision, including a retired one
 *
 * That is the point of the endpoint. A customer pinned
 * `<publisher>/<model>@<revision>`, the catalogue entry documents whichever
 * revision is CURRENT, and until now the documentation of the weights actually
 * being called was unreadable. A retired revision still answers: its
 * documentation is what a developer needs in order to migrate off it, and
 * `retiredAt` on the response says plainly that it is retired.
 */
export async function getRevisionDocumentation(
  viewer: CatalogueViewer,
  modelId: string,
  revisionLabel?: string
): Promise<ModelDocumentation | undefined> {
  const entry = await getCatalogueEntryForViewer(viewer, modelId);
  if (entry === undefined) return undefined;

  const db = getDb();

  const [model] = await db
    .select({
      id: inferenceModels.id,
      modelId: inferenceModels.modelId,
      licenseId: inferenceModels.licenseId,
      licenseDisplayName: inferenceModels.licenseDisplayName,
      licenseUrl: inferenceModels.licenseUrl,
      commercialUseAllowed: inferenceModels.commercialUseAllowed,
      requiresAttribution: inferenceModels.requiresAttribution,
      acceptableUsePolicyUrl: inferenceModels.acceptableUsePolicyUrl,
      releaseKind: inferenceModels.releaseKind,
      baseModelReference: inferenceModels.baseModelReference,
      trainingOrganization: inferenceModels.trainingOrganization,
    })
    .from(inferenceModels)
    .where(eq(inferenceModels.modelId, modelId));

  if (model === undefined || model.modelId === null) return undefined;

  // Named revision, or the current one. `revisionLabel` absent is not "the
  // newest": the catalogue's own answer to an unpinned model id is its CURRENT
  // revision, and answering anything else here would document weights a bare
  // model id does not resolve to.
  const revisionWhere =
    revisionLabel === undefined
      ? and(eq(inferenceModelRevisions.modelId, model.id), eq(inferenceModelRevisions.isCurrent, true))
      : and(
          eq(inferenceModelRevisions.modelId, model.id),
          eq(inferenceModelRevisions.revision, revisionLabel)
        );

  const [revision] = await db
    .select({
      id: inferenceModelRevisions.id,
      revision: inferenceModelRevisions.revision,
      isCurrent: inferenceModelRevisions.isCurrent,
      releasedAt: inferenceModelRevisions.releasedAt,
      retiredAt: inferenceModelRevisions.retiredAt,
      artifactDigest: inferenceModelRevisions.artifactDigest,
      modelCardUrl: inferenceModelRevisions.modelCardUrl,
      contentFilteringDefault: inferenceModelRevisions.contentFilteringDefault,
      provenanceMarking: inferenceModelRevisions.provenanceMarking,
      safetyCardUrl: inferenceModelRevisions.safetyCardUrl,
      knownLimitations: inferenceModelRevisions.knownLimitations,
    })
    .from(inferenceModelRevisions)
    .where(revisionWhere);

  if (revision === undefined) return undefined;

  const evaluations = await db
    .select({
      suite: inferenceModelEvaluations.suite,
      metric: inferenceModelEvaluations.metric,
      score: inferenceModelEvaluations.score,
      evaluatedAt: inferenceModelEvaluations.evaluatedAt,
      reportUrl: inferenceModelEvaluations.reportUrl,
    })
    .from(inferenceModelEvaluations)
    .where(eq(inferenceModelEvaluations.modelRevisionId, revision.id))
    .orderBy(asc(inferenceModelEvaluations.suite), asc(inferenceModelEvaluations.metric));

  // The Annex XII columns, NAMED. The four Annex XI Section 2 / Article 55(1)(a)
  // columns are absent from this selection, which is what makes them
  // unreachable from here at the TYPE level — the row this builds from has no
  // property to read them through. `protectedColumns.ts` states the same set a
  // second time and the implicit-whole-row-read scan enforces it.
  const [documentation] = await db
    .select({
      intendedTasks: inferenceModelGpaiDocumentation.intendedTasks,
      distributionMethods: inferenceModelGpaiDocumentation.distributionMethods,
      architecture: inferenceModelGpaiDocumentation.architecture,
      parameterCount: inferenceModelGpaiDocumentation.parameterCount,
      trainingDataSummaryUrl: inferenceModelGpaiDocumentation.trainingDataSummaryUrl,
      copyrightPolicyUrl: inferenceModelGpaiDocumentation.copyrightPolicyUrl,
      systemicRisk: inferenceModelGpaiDocumentation.systemicRisk,
      freeAndOpenSourceRelease: inferenceModelGpaiDocumentation.freeAndOpenSourceRelease,
    })
    .from(inferenceModelGpaiDocumentation)
    .where(eq(inferenceModelGpaiDocumentation.modelRevisionId, revision.id));

  return modelDocumentationSchema.parse({
    schemaVersion: 1,
    modelId: model.modelId,
    revision: revision.revision,
    reference: composeModelReference(model.modelId, revision.revision),
    isCurrentRevision: revision.isCurrent,
    releasedAt: revision.releasedAt.toISOString(),
    ...(revision.retiredAt === null ? {} : { retiredAt: revision.retiredAt.toISOString() }),
    ...(revision.modelCardUrl === null ? {} : { modelCardUrl: revision.modelCardUrl }),
    ...(revision.artifactDigest === null ? {} : { artifactDigest: revision.artifactDigest }),
    license: {
      licenseId: model.licenseId,
      displayName: model.licenseDisplayName,
      ...(model.licenseUrl === null ? {} : { url: model.licenseUrl }),
      commercialUseAllowed: model.commercialUseAllowed,
      requiresAttribution: model.requiresAttribution,
      ...(model.acceptableUsePolicyUrl === null
        ? {}
        : { acceptableUsePolicyUrl: model.acceptableUsePolicyUrl }),
    },
    provenance: {
      releaseKind: model.releaseKind,
      ...(model.baseModelReference === null ? {} : { baseModelId: model.baseModelReference }),
      ...(model.trainingOrganization === null
        ? {}
        : { trainingOrganization: model.trainingOrganization }),
    },
    evaluations: evaluations.map((evaluation) => ({
      suite: evaluation.suite,
      metric: evaluation.metric,
      score: evaluation.score,
      ...(evaluation.evaluatedAt === null
        ? {}
        : { evaluatedAt: evaluation.evaluatedAt.toISOString() }),
      ...(evaluation.reportUrl === null ? {} : { reportUrl: evaluation.reportUrl }),
    })),
    ...(revision.contentFilteringDefault === null || revision.provenanceMarking === null
      ? {}
      : {
          safety: {
            ...(revision.safetyCardUrl === null ? {} : { safetyCardUrl: revision.safetyCardUrl }),
            contentFilteringDefault: revision.contentFilteringDefault,
            knownLimitations: revision.knownLimitations ?? [],
            provenanceMarking: revision.provenanceMarking,
          },
        }),
    ...(documentation === undefined
      ? {}
      : {
          gpai: {
            ...(documentation.intendedTasks === null
              ? {}
              : { intendedTasks: documentation.intendedTasks }),
            distributionMethods: documentation.distributionMethods,
            ...(documentation.architecture === null
              ? {}
              : { architecture: documentation.architecture }),
            ...(documentation.parameterCount === null
              ? {}
              : { parameterCount: documentation.parameterCount }),
            trainingDataSummaryUrl: documentation.trainingDataSummaryUrl,
            copyrightPolicyUrl: documentation.copyrightPolicyUrl,
            systemicRisk: documentation.systemicRisk,
            freeAndOpenSourceRelease: documentation.freeAndOpenSourceRelease,
          },
        }),
  });
}
