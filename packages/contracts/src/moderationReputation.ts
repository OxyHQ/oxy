/**
 * Oxy Trust — the moderation reputation bridge (CrowdSource → Oxy Trust).
 *
 * SINGLE SOURCE OF TRUTH for the wire shapes crossing the one-way boundary
 * between a participatory-moderation service and the Oxy reputation ledger.
 *
 * The direction is not negotiable: a moderation service NEVER writes reputation.
 * It emits an authenticated internal event describing a decision it published,
 * and Oxy's own consequence engine validates that event and derives the effect.
 * Everything in this module is therefore either (a) the event, (b) the receipt
 * the engine returns, or (c) the derived state the engine publishes back to the
 * subject.
 *
 * Design anchors, all load-bearing:
 *
 *  - **Conduct is a separate axis from contribution.** A conduct penalty raises
 *    `activeRisk` and creates a strike; positive contribution points can never
 *    cancel a strike, because standing is derived from active risk and not from
 *    the point total. See {@link ReputationConduct}.
 *  - **The reporting axis carries only reporting signals.** `abuseScore` on the
 *    legacy reliability block conflated rejected reports with every negative
 *    transaction; {@link ReputationReporting} exists so a conduct penalty can
 *    never inflate a report-abuse figure.
 *  - **No binding proof, no effect.** {@link ModerationDecisionEventSubject}
 *    requires a `bindingProofId`, and the engine rejects an event whose binding
 *    does not resolve to the claimed principal at or before `occurredAt`. An
 *    application cannot move a reputation figure by naming a user id.
 *  - **One penalty per incident.** The idempotency key is
 *    `moderation:<incidentId>:<decisionRevision>:<effectType>`; a hundred
 *    reports about the same material produce one effect.
 *  - **Every effect carries the policy version it was decided under**, so a
 *    consequence can be recomputed under the original policy rather than under
 *    whatever the current tuning happens to be.
 *
 * Platform-agnostic — zod only. ESM-safe (no `require()`).
 */

import { z } from 'zod';

/* -------------------------------------------------------------------------- */
/*  Closed value sets                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Severity band of a moderation finding, lowest → highest.
 *
 * The band — not the taxonomy code — is what the consequence engine consumes:
 * points, active risk and expiry are all keyed by severity in the versioned
 * conduct policy, so a new taxonomy code needs no engine change and no
 * intimate category ever reaches the ledger.
 */
export const MODERATION_SEVERITIES = ['low', 'medium', 'high', 'critical'] as const;

export type ModerationSeverity = (typeof MODERATION_SEVERITIES)[number];

export const moderationSeveritySchema = z.enum(MODERATION_SEVERITIES);

/**
 * How far a finding reaches.
 *
 * - `application_local`   — the application enforces locally; Oxy Trust is NOT
 *   touched. Emitted for completeness; the engine rejects the effect.
 * - `oxy_network`         — conduct against the Oxy network as a whole.
 * - `identity_integrity`  — impersonation, sybil behaviour, credential abuse.
 *
 * Only `oxy_network` and `identity_integrity` can produce a global effect.
 */
export const MODERATION_FINDING_SCOPES = [
    'application_local',
    'oxy_network',
    'identity_integrity',
] as const;

export type ModerationFindingScope = (typeof MODERATION_FINDING_SCOPES)[number];

export const moderationFindingScopeSchema = z.enum(MODERATION_FINDING_SCOPES);

/** Which participant in the reported material the finding attributes to. */
export const MODERATION_ATTRIBUTIONS = ['author', 'sharer', 'reporter', 'reviewer'] as const;

export type ModerationAttribution = (typeof MODERATION_ATTRIBUTIONS)[number];

export const moderationAttributionSchema = z.enum(MODERATION_ATTRIBUTIONS);

/**
 * Lifecycle of the decision the event describes.
 *
 * `inconclusive` is its own outcome and never collapses into "no violation";
 * it simply produces no effect. `superseded` and `corrected` describe a
 * revision that a later one replaced — an event in either state is rejected,
 * because applying it would resurrect a consequence the appeal removed.
 */
export const MODERATION_DECISION_STATUSES = [
    'provisional',
    'final',
    'inconclusive',
    'superseded',
    'corrected',
] as const;

export type ModerationDecisionStatus = (typeof MODERATION_DECISION_STATUSES)[number];

export const moderationDecisionStatusSchema = z.enum(MODERATION_DECISION_STATUSES);

/**
 * The kind of consequence an effect carries. Each is its own axis, and the
 * idempotency key includes it — one incident may legitimately produce a conduct
 * effect for the author AND a report-abuse effect for a malicious reporter.
 */
export const MODERATION_EFFECT_TYPES = [
    'conduct_penalty',
    'report_abuse_penalty',
    'review_abuse_penalty',
] as const;

export type ModerationEffectType = (typeof MODERATION_EFFECT_TYPES)[number];

export const moderationEffectTypeSchema = z.enum(MODERATION_EFFECT_TYPES);

/** Lifecycle of a stored effect. */
export const MODERATION_EFFECT_STATUSES = ['applied', 'reversed'] as const;

export type ModerationEffectStatus = (typeof MODERATION_EFFECT_STATUSES)[number];

export const moderationEffectStatusSchema = z.enum(MODERATION_EFFECT_STATUSES);

/** Lifecycle of a conduct strike. Only `active` strikes carry active risk. */
export const CONDUCT_STRIKE_STATUSES = ['active', 'expired', 'reversed'] as const;

export type ConductStrikeStatus = (typeof CONDUCT_STRIKE_STATUSES)[number];

export const conductStrikeStatusSchema = z.enum(CONDUCT_STRIKE_STATUSES);

/**
 * Conduct standing, derived from ACTIVE RISK and nothing else.
 *
 * Deliberately independent of the point total: a person may hold a high
 * contribution tier and a `limited` standing at the same time, and earning
 * points cannot move standing back toward `good`. Only expiry or reversal can.
 */
export const CONDUCT_STANDINGS = ['good', 'watch', 'limited', 'restricted'] as const;

export type ConductStanding = (typeof CONDUCT_STANDINGS)[number];

export const conductStandingSchema = z.enum(CONDUCT_STANDINGS);

/** Contribution tier, derived from contribution points only. */
export const CONTRIBUTION_TIERS = ['new', 'trusted', 'high_trust'] as const;

export type ContributionTier = (typeof CONTRIBUTION_TIERS)[number];

export const contributionTierSchema = z.enum(CONTRIBUTION_TIERS);

/** Personhood status. Being a real person proves neither conduct nor competence. */
export const PERSONHOOD_STATUSES = ['unknown', 'probable', 'verified'] as const;

export type PersonhoodStatusValue = (typeof PERSONHOOD_STATUSES)[number];

export const personhoodStatusSchema = z.enum(PERSONHOOD_STATUSES);

/**
 * How an Oxy identity was bound to the actor an application reported.
 *
 * - `oauth_grant`        — the user authorized the application through Oxy's own
 *   OAuth flow. Oxy wrote the record; the application asserts nothing.
 * - `session_proof`      — the application presented the USER'S OWN Oxy access
 *   token alongside its service credential, proving the user was present in
 *   that application under a named local principal id.
 * - `commons_signature`  — a DID-verifiable signature over a server-issued nonce.
 * - `federated_actor`    — a resolvable, authorized federated actor link.
 */
export const IDENTITY_BINDING_TYPES = [
    'oauth_grant',
    'session_proof',
    'commons_signature',
    'federated_actor',
] as const;

export type IdentityBindingType = (typeof IDENTITY_BINDING_TYPES)[number];

export const identityBindingTypeSchema = z.enum(IDENTITY_BINDING_TYPES);

/** Binding lifecycle. A revoked binding proves nothing about a later action. */
export const IDENTITY_BINDING_STATUSES = ['active', 'revoked'] as const;

export type IdentityBindingStatus = (typeof IDENTITY_BINDING_STATUSES)[number];

export const identityBindingStatusSchema = z.enum(IDENTITY_BINDING_STATUSES);

/**
 * An application's own moderation standing. An external application can abuse
 * the system too, so it carries standing exactly like a person does.
 *
 * `sandbox` applications moderate locally and produce NO global effect.
 */
export const APPLICATION_MODERATION_STANDINGS = ['sandbox', 'trusted', 'restricted'] as const;

export type ApplicationModerationStanding = (typeof APPLICATION_MODERATION_STANDINGS)[number];

export const applicationModerationStandingSchema = z.enum(APPLICATION_MODERATION_STANDINGS);

/**
 * Why the engine declined to apply an effect.
 *
 * Returned rather than thrown for the cases that are a legitimate outcome of a
 * well-formed event (a sandboxed application, a local-only finding, an
 * inconclusive decision): the emitter must be able to record "delivered, no
 * effect" and stop retrying. Malformed or unauthorized events are HTTP errors,
 * not skip reasons.
 */
export const MODERATION_EFFECT_SKIP_REASONS = [
    'no_binding_proof',
    'binding_after_action',
    'binding_principal_mismatch',
    'binding_revoked',
    'decision_not_effective',
    'decision_superseded',
    'finding_scope_local',
    'finding_not_in_policy',
    'application_not_permitted',
    'no_effective_finding',
] as const;

export type ModerationEffectSkipReason = (typeof MODERATION_EFFECT_SKIP_REASONS)[number];

export const moderationEffectSkipReasonSchema = z.enum(MODERATION_EFFECT_SKIP_REASONS);

/* -------------------------------------------------------------------------- */
/*  The internal event                                                        */
/* -------------------------------------------------------------------------- */

/** One finding of a published decision. */
export interface ModerationFinding {
    /** Taxonomy code, e.g. `harassment.targeted_abuse`. Never rendered publicly. */
    code: string;
    severity: ModerationSeverity;
    scope: ModerationFindingScope;
    attribution: ModerationAttribution;
    /**
     * Conduct family the code belongs to (e.g. `harassment`). Repetition is
     * assessed per family and time window, so stacking taxonomy labels cannot
     * manufacture a disproportionate sanction.
     */
    family: string;
}

export const moderationFindingSchema: z.ZodType<ModerationFinding> = z.object({
    code: z.string().trim().min(1).max(200),
    severity: moderationSeveritySchema,
    scope: moderationFindingScopeSchema,
    attribution: moderationAttributionSchema,
    family: z.string().trim().min(1).max(100),
});

/** The principal a decision is about, and the proof it is who the emitter says. */
export interface ModerationDecisionEventSubject {
    /** Only `oxy_user` can carry a global reputation effect today. */
    principalType: 'oxy_user';
    /** The Oxy user id (or publicKey) the emitter claims the actor resolves to. */
    principalId: string;
    /**
     * The identity binding that proves it. REQUIRED — an event without a
     * resolvable binding produces no effect, by construction rather than by
     * policy.
     */
    bindingProofId: string;
}

export const moderationDecisionEventSubjectSchema: z.ZodType<ModerationDecisionEventSubject> =
    z.object({
        principalType: z.literal('oxy_user'),
        principalId: z.string().trim().min(1),
        bindingProofId: z.string().trim().min(1),
    });

/**
 * The policy versions a decision was made under. All three are recorded on the
 * effect so a consequence stays explainable after any of them moves on.
 */
export interface ModerationPolicyVersions {
    /** The universal taxonomy version. */
    universal: string;
    /** The application's own policy version. */
    application: string;
    /** The Oxy conduct policy version the consequence engine must resolve. */
    oxyConduct: string;
}

export const moderationPolicyVersionsSchema: z.ZodType<ModerationPolicyVersions> = z.object({
    universal: z.string().trim().min(1).max(100),
    application: z.string().trim().min(1).max(100),
    oxyConduct: z.string().trim().min(1).max(100),
});

/**
 * `POST /reputation/moderation/effects` — a decision a moderation service
 * published, offered to Oxy Trust for consequence derivation.
 *
 * The emitter states a decision. It never states an effect: no points, no risk,
 * no standing, no duration. Those are derived here from the policy version the
 * decision names, which is what keeps the direction one-way.
 */
export interface ModerationDecisionEvent {
    /** Emitter-unique event id. Replay of the same id is a no-op. */
    eventId: string;
    /**
     * The application the reported action happened in — NOT the emitter.
     *
     * This is in the body, and the reason is worth stating because the sibling
     * rule elsewhere is the opposite: at a moderation service's own ingress,
     * `applicationId` must come from the credential, because a tenant choosing
     * its own tenant id is an IDOR. Here the emitter is a privileged internal
     * service reporting ON BEHALF OF an application, so it cannot be the
     * credential's own id. What bounds it instead is that this field is checked
     * against TWO independent gates the emitter does not control: the named
     * application must itself be permitted to produce global effects, and the
     * binding proof must be one the NAMED application holds for this person.
     * Naming an application the subject never used therefore yields no effect.
     */
    reportedApplicationId: string;
    /** Event type + version, e.g. `moderation.decision.finalized.v1`. */
    type: string;
    caseId: string;
    /**
     * The cross-tenant incident the case belongs to. THE unit of consequence:
     * one incident yields one effect per (principal, effect type, revision).
     */
    incidentId: string;
    decisionId: string;
    /** 1-based revision. An appeal publishes revision 2, never edits revision 1. */
    decisionRevision: number;
    subject: ModerationDecisionEventSubject;
    findings: ModerationFinding[];
    decisionStatus: ModerationDecisionStatus;
    policyVersions: ModerationPolicyVersions;
    /**
     * ISO 8601 time of the REPORTED ACTION (not of the decision). The binding
     * must have existed at or before this instant, which is what makes the
     * binding a proof of presence rather than an after-the-fact claim.
     */
    occurredAt: string;
    /**
     * Hash of the private decision document. Recorded on the effect and in the
     * attestation so provenance is verifiable without the decision's contents.
     */
    proofHash: string;
}

export const moderationDecisionEventSchema: z.ZodType<ModerationDecisionEvent> = z.object({
    eventId: z.string().trim().min(1).max(200),
    reportedApplicationId: z.string().trim().min(1).max(200),
    type: z.string().trim().min(1).max(200),
    caseId: z.string().trim().min(1).max(200),
    incidentId: z.string().trim().min(1).max(200),
    decisionId: z.string().trim().min(1).max(200),
    decisionRevision: z.number().int().min(1),
    subject: moderationDecisionEventSubjectSchema,
    findings: z.array(moderationFindingSchema).min(1).max(20),
    decisionStatus: moderationDecisionStatusSchema,
    policyVersions: moderationPolicyVersionsSchema,
    occurredAt: z.string().trim().min(1),
    proofHash: z.string().trim().min(1).max(200),
});

/**
 * Which decision revision an operation addresses. Deliberately the whole body of
 * `POST /reputation/moderation/effects/finalize`: confirming that a consequence
 * landed must not be able to carry a figure, or it would become a second write
 * path into the ledger.
 */
export interface FinalizeModerationDecisionInput {
    decisionId: string;
    decisionRevision: number;
}

export const finalizeModerationDecisionSchema: z.ZodType<FinalizeModerationDecisionInput> =
    z.object({
        decisionId: z.string().trim().min(1).max(200),
        decisionRevision: z.number().int().min(1),
    });

/**
 * `POST /reputation/moderation/effects/reverse` — an appeal overturned a
 * decision revision, so the consequence it produced must be compensated.
 *
 * Names no figure either: the reversal is derived from the stored effect, so a
 * caller cannot choose how much to give back.
 */
export interface ReverseModerationEffectInput extends FinalizeModerationDecisionInput {
    /** Why the decision was overturned. Recorded on the reversal. */
    reason: string;
}

export const reverseModerationEffectSchema: z.ZodType<ReverseModerationEffectInput> = z.object({
    decisionId: z.string().trim().min(1).max(200),
    decisionRevision: z.number().int().min(1),
    reason: z.string().trim().min(1).max(500),
});

/* -------------------------------------------------------------------------- */
/*  The receipt                                                               */
/* -------------------------------------------------------------------------- */

/**
 * What the engine derived for one principal from one decision revision.
 *
 * `points` and `activeRisk` are already multiplied and capped; the multipliers
 * are reported so the figure is explainable without re-running the engine.
 */
export interface ModerationEffect {
    /** The effect's own id (its Mongo `_id` as a string). */
    id: string;
    incidentId: string;
    caseId: string;
    decisionId: string;
    decisionRevision: number;
    /** The Oxy user the effect landed on. */
    principalId: string;
    effectType: ModerationEffectType;
    status: ModerationEffectStatus;
    /** Signed point delta written to the ledger (negative for a penalty). */
    points: number;
    /** Active-risk delta added to conduct standing. */
    activeRisk: number;
    severity: ModerationSeverity;
    /** Repetition multiplier applied (1.0 for a first similar incident). */
    repetitionMultiplier: number;
    /** Multi-finding multiplier applied, capped by the policy. */
    multiFindingMultiplier: number;
    /** The idempotency key the ledger transaction was written under. */
    idempotencyKey: string;
    /** The ledger transaction this effect created. */
    transactionId: string;
    /** The conduct strike this effect created, when the effect carries risk. */
    strikeId?: string;
    /** The compensating transaction, once reversed. */
    reversalTransactionId?: string;
    policyVersions: ModerationPolicyVersions;
    /** ISO 8601 timestamp the effect was applied at. */
    appliedAt: string;
    /** ISO 8601 timestamp the effect was reversed at, if reversed. */
    reversedAt?: string;
}

export const moderationEffectSchema: z.ZodType<ModerationEffect> = z.object({
    id: z.string(),
    incidentId: z.string(),
    caseId: z.string(),
    decisionId: z.string(),
    decisionRevision: z.number(),
    principalId: z.string(),
    effectType: moderationEffectTypeSchema,
    status: moderationEffectStatusSchema,
    points: z.number(),
    activeRisk: z.number(),
    severity: moderationSeveritySchema,
    repetitionMultiplier: z.number(),
    multiFindingMultiplier: z.number(),
    idempotencyKey: z.string(),
    transactionId: z.string(),
    strikeId: z.string().optional(),
    reversalTransactionId: z.string().optional(),
    policyVersions: moderationPolicyVersionsSchema,
    appliedAt: z.string(),
    reversedAt: z.string().optional(),
});

/**
 * The response to an event submission.
 *
 * `applied: false` with a `skipReason` is a SUCCESS: the event was accepted and
 * durably recorded as producing no effect, so the emitter must not retry.
 */
export interface ApplyModerationDecisionResult {
    /** Whether a consequence was derived. */
    applied: boolean;
    /** Present when `applied` is true. */
    effect?: ModerationEffect;
    /** Present when `applied` is false. */
    skipReason?: ModerationEffectSkipReason;
    /**
     * True when this exact event (or an equivalent effect for the incident and
     * revision) had already been processed, so nothing new was written.
     */
    idempotent: boolean;
}

export const applyModerationDecisionResultSchema: z.ZodType<ApplyModerationDecisionResult> =
    z.object({
        applied: z.boolean(),
        effect: moderationEffectSchema.optional(),
        skipReason: moderationEffectSkipReasonSchema.optional(),
        idempotent: z.boolean(),
    });

/** The response to a reversal. */
export interface ReverseModerationEffectResult {
    /** Every effect the decision revision produced, now `reversed`. */
    reversed: ModerationEffect[];
    /** True when the effects were already reversed and nothing new was written. */
    idempotent: boolean;
}

export const reverseModerationEffectResultSchema: z.ZodType<ReverseModerationEffectResult> =
    z.object({
        reversed: z.array(moderationEffectSchema),
        idempotent: z.boolean(),
    });

/* -------------------------------------------------------------------------- */
/*  Identity binding                                                          */
/* -------------------------------------------------------------------------- */

/**
 * `POST /reputation/moderation/bindings` — register the fact that an Oxy user
 * was present in the calling application under a local principal id.
 *
 * The caller is a service credential AND must present the user's own Oxy access
 * token in `userProofToken`: the binding is only as strong as the proof, and a
 * body an application composes on its own is no proof at all. `applicationId`
 * comes from the credential.
 */
export interface RegisterIdentityBindingInput {
    /** The application's own id for this person. */
    localPrincipalId: string;
    /**
     * The USER'S Oxy access token, proving they were signed in to the calling
     * application. Verified server-side; its subject must be the bound user.
     */
    userProofToken: string;
}

export const registerIdentityBindingSchema: z.ZodType<RegisterIdentityBindingInput> = z.object({
    localPrincipalId: z.string().trim().min(1).max(200),
    userProofToken: z.string().trim().min(1),
});

/**
 * A registered binding, as returned to the application that registered it.
 *
 * Carries no proof material: the token is verified and discarded, never stored.
 * `id` is what an event's `bindingProofId` references.
 */
export interface IdentityBinding {
    id: string;
    applicationId: string;
    /** The bound Oxy user id. */
    userId: string;
    localPrincipalId: string;
    bindingType: IdentityBindingType;
    status: IdentityBindingStatus;
    /** ISO 8601 timestamp the binding was verified at. */
    verifiedAt: string;
    /** ISO 8601 creation timestamp. */
    createdAt: string;
}

export const identityBindingSchema: z.ZodType<IdentityBinding> = z.object({
    id: z.string(),
    applicationId: z.string(),
    userId: z.string(),
    localPrincipalId: z.string(),
    bindingType: identityBindingTypeSchema,
    status: identityBindingStatusSchema,
    verifiedAt: z.string(),
    createdAt: z.string(),
});

/* -------------------------------------------------------------------------- */
/*  The derived state — ReputationBalance V2 blocks                           */
/* -------------------------------------------------------------------------- */

/**
 * Personhood: whether Oxy believes this is a real, distinct person.
 *
 * Deliberately NOT a trust tier. Being a real person proves neither good
 * conduct nor moderation competence, so it is its own axis and confers nothing
 * on the others.
 */
export interface ReputationPersonhood {
    status: PersonhoodStatusValue;
    /** 0..1 confidence in that status. */
    score: number;
}

export const reputationPersonhoodSchema: z.ZodType<ReputationPersonhood> = z.object({
    status: personhoodStatusSchema,
    score: z.number(),
});

/**
 * Contribution: what the person has built. Positive-only ladder.
 *
 * `points` EXCLUDES conduct penalties — they live on the conduct axis. Their
 * ledger entries still count toward the legacy `total`, so the ledger stays
 * honest, but they neither lower the contribution tier nor can be offset by it.
 */
export interface ReputationContribution {
    points: number;
    tier: ContributionTier;
}

export const reputationContributionSchema: z.ZodType<ReputationContribution> = z.object({
    points: z.number(),
    tier: contributionTierSchema,
});

/**
 * Conduct: the standing that moderation outcomes move.
 *
 * `activeRisk` is the sum of risk carried by ACTIVE strikes; it decays as
 * strikes expire and drops immediately when one is reversed. `standing` is
 * derived from `activeRisk` alone, which is precisely why contribution points
 * cannot buy it back.
 */
export interface ReputationConduct {
    standing: ConductStanding;
    activeRisk: number;
    activeStrikes: number;
    /**
     * ISO 8601 timestamp the earliest-expiring active strike lapses at. Absent
     * when there is no active strike, or when every one of them requires manual
     * recovery review (critical severity never expires automatically).
     */
    nextExpiryAt?: string;
}

export const reputationConductSchema: z.ZodType<ReputationConduct> = z.object({
    standing: conductStandingSchema,
    activeRisk: z.number(),
    activeStrikes: z.number(),
    nextExpiryAt: z.string().optional(),
});

/**
 * Reporting: how reliable this person's reports are.
 *
 * A Beta-posterior mean with a neutral prior, plus a confidence that grows with
 * sample size — one accurate report does not make a perfect reporter, and a
 * newcomer keeps a neutral prior. `malicious` counts CONFIRMED report abuse,
 * and nothing else: a rejected report is not bad faith.
 */
export interface ReputationReporting {
    /** Smoothed 0..1 accuracy estimate. */
    reliability: number;
    /** 0..1 confidence in that estimate, from effective sample size. */
    confidence: number;
    confirmed: number;
    rejected: number;
    /** Confirmed report-abuse findings. */
    malicious: number;
}

export const reputationReportingSchema: z.ZodType<ReputationReporting> = z.object({
    reliability: z.number(),
    confidence: z.number(),
    confirmed: z.number(),
    rejected: z.number(),
    malicious: z.number(),
});

/**
 * Reviewing: how reliable this person is AS A REVIEWER, per category and
 * language rather than as one global number — competence in one category says
 * little about another.
 */
export interface ReputationReviewing {
    globalReliability: number;
    categoryReliability: Record<string, number>;
    languageReliability: Record<string, number>;
}

export const reputationReviewingSchema: z.ZodType<ReputationReviewing> = z.object({
    globalReliability: z.number(),
    categoryReliability: z.record(z.number()),
    languageReliability: z.record(z.number()),
});

/**
 * The contextual influence weights the V2 model publishes.
 *
 * Separate from the legacy four-weight block: selection probability for a jury
 * and the priority of a report are different questions, and neither is the
 * weight of a vote. A vote is never weighted — one qualified person, one vote.
 */
export interface ReputationContextualInfluence {
    reportPriorityWeight: number;
    reviewSelectionWeight: number;
    rankingWeight: number;
}

export const reputationContextualInfluenceSchema: z.ZodType<ReputationContextualInfluence> =
    z.object({
        reportPriorityWeight: z.number(),
        reviewSelectionWeight: z.number(),
        rankingWeight: z.number(),
    });

/* -------------------------------------------------------------------------- */
/*  Application moderation trust                                              */
/* -------------------------------------------------------------------------- */

/**
 * An application's own moderation standing. A new application moderates
 * locally from `sandbox` and produces no global effect until it has passed
 * technical review and a sufficient quality period.
 */
export interface ApplicationModerationTrust {
    applicationId: string;
    standing: ApplicationModerationStanding;
    /** 0..1 — how well the application's evidence survives scrutiny. */
    evidenceIntegrity: number;
    /** 0..1 — how well its identity bindings hold up. */
    identityBindingReliability: number;
    /** 0..1 — share of its decisions overturned on appeal. */
    decisionOverturnRate: number;
    /** 0..1 — assessed quality of its own policy. */
    policyQuality: number;
    /**
     * THE gate. False for every application until explicitly granted, so the
     * default for a newly-integrated application is local enforcement only.
     */
    globalReputationEffectsAllowed: boolean;
}

export const applicationModerationTrustSchema: z.ZodType<ApplicationModerationTrust> = z.object({
    applicationId: z.string(),
    standing: applicationModerationStandingSchema,
    evidenceIntegrity: z.number(),
    identityBindingReliability: z.number(),
    decisionOverturnRate: z.number(),
    policyQuality: z.number(),
    globalReputationEffectsAllowed: z.boolean(),
});
