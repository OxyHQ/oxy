/**
 * Model documentation: what a first-party release must DECLARE, what a
 * downstream developer may READ, and the request that ingests both.
 *
 * Issue #972 §12, the three items under "Future Alia model
 * publication/compliance" that `aliaModelRelease.ts` deliberately left open:
 * accepting the documentation set, publicising the customer-safe half of it, and
 * preserving the metadata an EU AI Act / GPAI documentation workflow needs.
 *
 * ## The section's own scope is what makes the compliance claim falsifiable
 *
 * The issue section is titled "Future Alia model publication/compliance", so the
 * obligations in play are the ones binding a PROVIDER of a general-purpose AI
 * model — Oxy/Alia, for an `alia/*` release it trained or derived. Oxy's position
 * on third-party weights is a different one (it received documentation rather
 * than produced it) with different obligations, and nothing here claims to
 * discharge those. Every field below names the obligation it serves; a field
 * whose obligation could not be named is not here, and two are listed at the
 * bottom as deliberately absent.
 *
 * References are to Regulation (EU) 2024/1689 (the AI Act): Article 50(2)
 * (marking synthetic output), Article 51 (classification as a model with
 * systemic risk), Article 53 (obligations of providers of general-purpose AI
 * models), Article 55 (additional obligations for systemic-risk models), Annex XI
 * (the technical documentation), Annex XII (the information for downstream
 * providers).
 *
 * ## Two shapes, and the Act itself draws the line between them
 *
 * {@link modelGpaiDocumentationSchema} is the whole record. {@link
 * modelDownstreamDocumentationSchema} is the subset served publicly. The split
 * is NOT editorial taste: Annex XI is documentation a provider keeps and
 * provides to the AI Office and national competent authorities on request, while
 * Annex XII is information a provider MAKES AVAILABLE to downstream providers.
 * Training compute, training time, energy consumption and the adversarial-testing
 * report are Annex XI Section 2 and Article 55(1)(a) — the first audience — so
 * they are in the record and not in the public projection, and
 * `db/schema/protectedColumns.ts` says the same thing a second time at the type
 * level.
 *
 * ## The conditionals are the Act's, not a convenience
 *
 * Article 53(2) exempts a model released under a free and open-source licence
 * from 53(1)(a) and 53(1)(b) — the Annex XI and Annex XII sets — UNLESS it is a
 * model with systemic risk. It does not exempt 53(1)(c) or 53(1)(d). So the
 * copyright policy and the training-content summary are required of every
 * release here, while the Annex XI/XII set is required of every release that is
 * not covered by that exemption. Writing it the other way round — everything
 * optional, checked by a human — is what makes a compliance record a field nobody
 * filled in.
 *
 * ## What is deliberately NOT here
 *
 * **The modality and FORMAT of inputs and outputs (Annex XI §1(6), Annex XII
 * §1(b)).** The modality half is already stored, as `inference_models`'
 * `input_modalities` / `output_modalities`. The format half is a property of the
 * Oxy API — one request envelope, one set of endpoints, identical for every model
 * — so a per-model column would record the same value on every row and invite a
 * reader to believe it could differ.
 *
 * **The technical means required for integration (Annex XII §1(c)).** Same
 * reason: for a model served over the Oxy API that is Oxy's own API
 * documentation, not a fact about the weights.
 *
 * **A verification finding for a release signature.** See
 * `aliaModelRelease.ts`: whether a signature checked out is Oxy's finding about
 * the document and not a claim the document makes, and no verifier exists yet
 * because what signs is undecided. The ingestion path stores the signatures and
 * the manifest as received so a verifier that lands later can check them; it
 * records no finding, because there is none.
 *
 * Decided in: docs/adr/0008-catalogue-concept-separation.md, issue #972 §12.
 */

import { z } from 'zod';
import { aliaModelReleaseManifestSchema } from './aliaModelRelease';
import {
  modelCapabilitiesSchema,
  modelEvaluationResultSchema,
  modelLicenseSchema,
  modelProvenanceSchema,
  modelSafetyMetadataSchema,
} from './catalogue';
import {
  inferenceDateSchema,
  inferenceHttpsUrlSchema,
  inferenceTimestampSchema,
  modelIdSchema,
  modelReferenceSchema,
  modelRevisionLabelSchema,
  sha256DigestSchema,
} from './identifiers';

/* -------------------------------------------------------------------------- */
/*  Vocabulary                                                                */
/* -------------------------------------------------------------------------- */

/**
 * How a release reaches the people who use it — Annex XI §1(4) and Annex XII
 * §1(a), "methods of distribution".
 *
 * TWO members, and both exist today: a release is served through the Oxy API, or
 * its weights are published for download, or both. A third channel is a
 * distribution decision somebody would have to make, and a closed enum gaining a
 * member is a MINOR contract-set change the handshake surfaces (`version.ts`),
 * which is the right amount of ceremony for it.
 *
 * `downloadable_weights` is also what the Article 53(2) free-and-open-source
 * exemption is assessed against — that exemption requires the model to be
 * "released under a free and open-source licence that allows for the access,
 * usage, modification and distribution of the model" — so it is required even
 * where the Annex XI set it belongs to is exempt.
 */
export const modelDistributionMethodSchema = z.enum(['oxy_api', 'downloadable_weights']);

/**
 * Whether this is a model with systemic risk, and on what basis — Article 51.
 *
 * Three states, because the two ways a model acquires the classification have
 * different evidence and a record that flattened them could not be checked:
 *
 * - `not_designated` — neither presumed nor designated.
 * - `presumed_by_training_compute` — Article 51(2): the cumulative compute used
 *   for training exceeds 10^25 floating point operations, which the Act makes a
 *   presumption of high-impact capabilities. The FIGURE is what creates it, so
 *   {@link modelGpaiDocumentationSchema} requires the figure alongside this
 *   value.
 * - `designated_by_commission` — Article 51(1)(b): a Commission decision, ex
 *   officio or following a qualified alert, that the model has capabilities
 *   equivalent to the presumption. Not derivable from anything Oxy holds, which
 *   is exactly why it is a declared value.
 */
export const modelSystemicRiskTierSchema = z.enum([
  'not_designated',
  'presumed_by_training_compute',
  'designated_by_commission',
]);

/**
 * Cumulative training compute in floating point operations — Annex XI §2(b).
 *
 * TEXT, in the same spirit as `modelEvaluationResultSchema.score` and for a
 * sharper reason: this is a PUBLISHED figure (`4.2e25`, `2.5e26`), the numbers
 * involved are far outside the exactly-representable integer range, and the
 * value is never arithmetic Oxy performs on a customer's behalf. A JSON number
 * would round it silently and make two records of one published figure compare
 * unequal.
 *
 * The one comparison that IS made — against Article 51(2)'s 10^25 threshold — is
 * a magnitude test, and `Number()` on a string this regex admits is exact enough
 * for a magnitude test by a factor of about 10^9. The refinement that performs
 * it is on {@link modelGpaiDocumentationSchema}.
 */
export const trainingComputeFlopsSchema = z
  .string()
  .max(40)
  .regex(
    /^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:e\+?(?:0|[1-9][0-9]?))?$/,
    'training compute must be a decimal or scientific figure, e.g. 4.2e25',
  );

/**
 * Article 51(2)'s presumption threshold, as a number.
 *
 * Named rather than inlined so the refinement that applies it and the enum
 * member that describes it (`presumed_by_training_compute`) cannot come to mean
 * different things.
 */
export const SYSTEMIC_RISK_COMPUTE_THRESHOLD_FLOPS = 1e25;

/* -------------------------------------------------------------------------- */
/*  The record                                                                */
/* -------------------------------------------------------------------------- */

/**
 * The subset of the documentation set that is served to downstream developers —
 * Annex XII, plus the two Article 53(1) items that are public by their own terms.
 *
 * Rides inside {@link modelDocumentationSchema} and inherits its version.
 *
 * Every field here is one a developer integrating the model needs in order to
 * decide whether they may use it and what they must say about it: what it is for,
 * how it is distributed, what it is built out of, where the training-content
 * summary and the copyright policy are, and whether it carries the systemic-risk
 * classification that puts obligations on them too.
 *
 * The optional members are optional for a REASON stated in the parent record's
 * refinement — Article 53(2) — and not because a value may be skipped.
 */
export const modelDownstreamDocumentationSchema = z
  .object({
    /** Annex XI §1(2), Annex XII §1(a): the tasks the model is intended for. */
    intendedTasks: z.string().min(1).max(2000).optional(),
    /** Annex XI §1(4), Annex XII §1(a). */
    distributionMethods: z.array(modelDistributionMethodSchema).min(1),
    /** Annex XI §1(5), reachable through Annex XII §1(a) ("points 1 to 5"). */
    architecture: z.string().min(1).max(500).optional(),
    /** Annex XI §1(5): the number of parameters. */
    parameterCount: z.number().int().positive().safe().optional(),
    /** Article 53(1)(d): the publicly available summary of training content. */
    trainingDataSummaryUrl: inferenceHttpsUrlSchema,
    /**
     * Article 53(1)(c): the policy for complying with Union copyright law,
     * including the reservation of rights under Article 4(3) of Directive
     * (EU) 2019/790. Required of every release — Article 53(2) does not exempt it.
     */
    copyrightPolicyUrl: inferenceHttpsUrlSchema,
    /** Article 51. */
    systemicRisk: modelSystemicRiskTierSchema,
    /**
     * Whether the release is under a free and open-source licence in the sense
     * of Article 53(2). Distinct from `modelLicenseSchema.commercialUseAllowed`,
     * which answers whether OXY may serve the model — a licence can permit
     * commercial use and still not permit access, modification and
     * redistribution of the weights, and it is the second question the exemption
     * turns on.
     */
    freeAndOpenSourceRelease: z.boolean(),
  })
  .strict();

/**
 * The whole documentation record for one revision, as ingested.
 *
 * `.strict()`, because this is a compliance record arriving over the wire: a
 * field silently dropped at the parse is a field the record does not contain,
 * and "we accepted your documentation" would then be true of less than was sent.
 *
 * Not versioned on its own — it rides inside
 * {@link modelReleaseIngestionRequestSchema} on the way in and inside
 * {@link modelDocumentationSchema} on the way out, and inherits whichever
 * message carries it.
 */
export const modelGpaiDocumentationSchema = modelDownstreamDocumentationSchema
  .extend({
    /** Annex XI §2(b): the computational resources used for training. */
    trainingComputeFlops: trainingComputeFlopsSchema.optional(),
    /** Annex XI §2(b): the training time. */
    trainingTimeHours: z.number().positive().safe().optional(),
    /**
     * Annex XI §2(c): the known or ESTIMATED energy consumption. The Act asks
     * for an estimate where the figure is not known, so absence here means the
     * Annex XI set is exempt rather than that the number was hard to obtain.
     */
    energyConsumptionMwh: z.number().nonnegative().safe().optional(),
    /**
     * Article 55(1)(a): the model evaluation, including adversarial testing,
     * performed for a model with systemic risk. A pointer, like every other
     * document reference here — the catalogue holds no report.
     */
    adversarialTestingReportUrl: inferenceHttpsUrlSchema.optional(),
  })
  .strict()
  .superRefine((documentation, ctx) => {
    // Article 53(2): the free-and-open-source exemption from 53(1)(a) and (b)
    // does not apply to a model with systemic risk. So the Annex XI/XII set is
    // required of everything else, and the ONE state that may omit it is a
    // free-and-open-source release that is not designated.
    const exempt =
      documentation.freeAndOpenSourceRelease && documentation.systemicRisk === 'not_designated';

    if (!exempt) {
      const required = [
        'intendedTasks',
        'architecture',
        'parameterCount',
        'trainingTimeHours',
        'energyConsumptionMwh',
      ] as const;
      for (const field of required) {
        if (documentation[field] === undefined) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [field],
            message:
              'required by Annex XI unless the Article 53(2) free-and-open-source exemption applies, which it does not for this release',
          });
        }
      }
    }

    // The presumption IS the compute figure (Article 51(2)). Declaring the tier
    // without the figure asserts a threshold was crossed while withholding the
    // only thing that says so.
    if (
      documentation.systemicRisk === 'presumed_by_training_compute' &&
      documentation.trainingComputeFlops === undefined
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['trainingComputeFlops'],
        message:
          'a systemic-risk presumption under Article 51(2) is the training-compute figure; declare it',
      });
    }

    // The other direction, which is the one that matters: a release whose own
    // declared compute is past the threshold cannot also declare that no
    // classification applies. Without this the field pair would let the record
    // contradict itself and still parse.
    if (
      documentation.trainingComputeFlops !== undefined &&
      documentation.systemicRisk === 'not_designated' &&
      Number(documentation.trainingComputeFlops) >= SYSTEMIC_RISK_COMPUTE_THRESHOLD_FLOPS
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['systemicRisk'],
        message:
          'training compute at or above 10^25 FLOP is presumed to be a model with systemic risk under Article 51(2)',
      });
    }

    // Article 55(1)(a) applies to every model with systemic risk, however it
    // acquired the classification.
    if (
      documentation.systemicRisk !== 'not_designated' &&
      documentation.adversarialTestingReportUrl === undefined
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['adversarialTestingReportUrl'],
        message:
          'a model with systemic risk documents its evaluation including adversarial testing (Article 55(1)(a))',
      });
    }
  });

/* -------------------------------------------------------------------------- */
/*  Ingestion                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * What OXY states about the model line a release belongs to.
 *
 * A signed release manifest carries a revision, a licence, a provenance block,
 * evaluations, safety metadata and an artifact inventory. It carries no
 * CAPABILITY SHEET — no modalities, no `maxContextTokens`, none of the
 * tool/streaming flags — and every one of those is required to create a model
 * line at all.
 *
 * That is not a gap in the manifest. A capability sheet is a statement about what
 * the Oxy API will serve, which is Oxy's to make and not the signer's: the same
 * weights behind a different gateway answer a different set of these questions.
 * So it travels beside the manifest, like the documentation record, and the
 * signature keeps covering exactly the document its signer wrote.
 *
 * Ignored when the model line already exists — a release does not edit a model.
 * The licence and provenance in the MANIFEST are checked against the stored ones
 * instead, because those are claims about somebody's rights rather than Oxy's own
 * editorial choices.
 */
export const modelLineDeclarationSchema = z
  .object({
    displayName: z.string().min(1).max(200),
    description: z.string().max(4000).optional(),
    capabilities: modelCapabilitiesSchema,
    knowledgeCutoff: inferenceDateSchema.optional(),
    releasedOn: inferenceDateSchema.optional(),
  })
  .strict();

/**
 * The body of the release-ingestion request.
 *
 * The documentation and the capability sheet travel BESIDE the manifest rather
 * than inside it, and that is the whole reason this wrapper exists.
 * `aliaModelReleaseManifestSchema` is a SIGNED document: adding a field to it
 * would change the bytes a signer covers and the version the data plane and Alia
 * compile against, for records that are Oxy's own rather than the signer's.
 * Keeping them separate means the signature still covers exactly what it covered.
 *
 * A signer that later chooses to cover the documentation too can: it would
 * become a second signed document with its own manifest, which is a contract
 * addition rather than a change to this one.
 */
export const modelReleaseIngestionRequestSchema = z
  .object({
    /** See `version.ts`: an ingestion payload is a whole message on the wire. */
    schemaVersion: z.literal(1),
    manifest: aliaModelReleaseManifestSchema,
    gpaiDocumentation: modelGpaiDocumentationSchema,
    model: modelLineDeclarationSchema,
  })
  .strict();

/**
 * What ingestion reports back.
 *
 * COUNTS for the artifacts and signatures rather than echoing them: the caller
 * sent them and the interesting fact is that all of them landed. Echoing a
 * signature would also make this response a place a credential-shaped value gets
 * logged, for no gain.
 *
 * No verification field — see this module's header, and `aliaModelRelease.ts`.
 */
export const modelReleaseIngestionResultSchema = z
  .object({
    /** See `version.ts`: served on its own, so it is versioned. */
    schemaVersion: z.literal(1),
    releaseId: z.string().min(1).max(128),
    modelId: modelIdSchema,
    revision: modelRevisionLabelSchema,
    reference: modelReferenceSchema,
    /** Whether this request created the release, or found it already ingested. */
    outcome: z.enum(['ingested', 'already_ingested']),
    artifactCount: z.number().int().positive().safe(),
    signatureCount: z.number().int().positive().safe(),
    evaluationCount: z.number().int().nonnegative().safe(),
    ingestedAt: inferenceTimestampSchema,
  })
  .strict();

/* -------------------------------------------------------------------------- */
/*  The customer-safe documentation view                                      */
/* -------------------------------------------------------------------------- */

/**
 * The documentation for ONE revision, as a downstream developer reads it.
 *
 * Revision-scoped, and that is the point of it existing beside
 * `modelCatalogueEntrySchema`. The catalogue entry carries the documentation of
 * whichever revision is CURRENT, so a customer who pinned
 * `<publisher>/<model>@<revision>` — which the catalogue invites, and which the
 * immutability trigger on `inference_model_revisions` exists to make meaningful —
 * had no way to read the model card, evaluations or safety metadata of the
 * revision they are actually calling. A model card that only describes the
 * newest weights is the exact conflation ADR 0008 separates revisions to prevent.
 *
 * `license` and `provenance` are the MODEL's, repeated here rather than linked,
 * for the same reason `modelCatalogueEntrySchema` repeats its fields: a
 * projection that nests the operational descriptors is one accident of nesting
 * away from serving an internal identifier.
 */
export const modelDocumentationSchema = z
  .object({
    /** See `version.ts`: this is a public response shape. */
    schemaVersion: z.literal(1),
    modelId: modelIdSchema,
    revision: modelRevisionLabelSchema,
    /** The exact string a customer pins. */
    reference: modelReferenceSchema,
    /** Whether a bare `<publisher>/<model>` resolves to this revision today. */
    isCurrentRevision: z.boolean(),
    releasedAt: inferenceTimestampSchema,
    retiredAt: inferenceTimestampSchema.optional(),
    modelCardUrl: inferenceHttpsUrlSchema.optional(),
    /**
     * The digest of the served artifact, where Oxy hosts the weights.
     *
     * Customer-safe, deliberately: it is the one field on this view that lets a
     * developer check that the weights they were handed are the weights the
     * documentation describes, and a digest discloses nothing but the identity of
     * bytes Oxy is already serving them.
     */
    artifactDigest: sha256DigestSchema.optional(),
    license: modelLicenseSchema,
    provenance: modelProvenanceSchema,
    evaluations: z.array(modelEvaluationResultSchema).default([]),
    safety: modelSafetyMetadataSchema.optional(),
    /** Absent for a revision with no documentation record — i.e. every one Oxy did not release. */
    gpai: modelDownstreamDocumentationSchema.optional(),
  })
  .strict()
  .superRefine((documentation, ctx) => {
    // The same check `modelRevisionSchema` makes, and it is load-bearing for a
    // different reason here: this view exists so a customer can read the
    // documentation of the revision they PINNED, so a reference that resolves
    // elsewhere would attach a model card to weights nobody is calling.
    if (documentation.reference !== `${documentation.modelId}@${documentation.revision}`) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['reference'],
        message: 'reference must be exactly <modelId>@<revision>',
      });
    }
  });

export type ModelDistributionMethod = z.infer<typeof modelDistributionMethodSchema>;
export type ModelSystemicRiskTier = z.infer<typeof modelSystemicRiskTierSchema>;
export type ModelDownstreamDocumentation = z.infer<typeof modelDownstreamDocumentationSchema>;
export type ModelGpaiDocumentation = z.infer<typeof modelGpaiDocumentationSchema>;
export type ModelLineDeclaration = z.infer<typeof modelLineDeclarationSchema>;
export type ModelReleaseIngestionRequest = z.infer<typeof modelReleaseIngestionRequestSchema>;
export type ModelReleaseIngestionResult = z.infer<typeof modelReleaseIngestionResultSchema>;
export type ModelDocumentation = z.infer<typeof modelDocumentationSchema>;
