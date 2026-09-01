/**
 * Oxy Trust — reputation API contracts.
 *
 * SINGLE SOURCE OF TRUTH for the reputation ledger's wire shapes: the closed
 * value sets (`REPUTATION_CATEGORIES`, `TRUST_TIERS`, …), the response entities
 * (`ReputationTransaction`, the two balance views, `ReputationDispute`,
 * `ReputationRule`, the leaderboard entry) and the request bodies the write
 * endpoints accept. The API validates its OUTPUT against these schemas and its
 * INPUT with the same request schemas the SDK's input types are derived from;
 * `@oxyhq/core`'s reputation mixin imports every type from here rather than
 * declaring its own.
 *
 * Why this module exists: the balance endpoint was view-split server-side
 * without the SDK type moving with it, and for hours the SDK affirmatively
 * type-checked a read of `balance.reliability.reportAccuracyScore` against a
 * response that no longer carried `reliability`. Nothing structural connected
 * the API's hand-written serializers (which returned `Record<string, unknown>`)
 * to the SDK's interfaces — only human attention. With the serializers
 * annotated against these definitions, that divergence is a build failure.
 *
 * Design anchors:
 *  - **Ids are strings, timestamps are ISO 8601 strings.** The server holds
 *    `ObjectId`s and `Date`s; every serializer converts at the boundary, so a
 *    `Date` leaking into a field this module types as `string` fails to compile.
 *  - **The balance has two views, and the union is the contract.** See
 *    {@link ReputationBalanceView} — the compile-time assertions below are what
 *    stop the private view's fields becoming reachable on a stranger's balance.
 *  - **The closed value sets live here, not beside the mongoose models.** The
 *    API's model enums and the SDK's unions are the same `as const` tuple, so a
 *    seventh category cannot be added on one side only.
 *
 * The response entities are declared as explicit `interface`s with their runtime
 * schemas annotated `z.ZodType<Interface>`, following `./links` and
 * `./userResponse`: a `z.infer<>` of a nested-object schema can degrade to `{}`
 * under a consumer's `moduleResolution: "node"` (node10) resolution, while a
 * literal interface emits the field types verbatim in the `.d.ts` and survives
 * both `node` and `bundler`.
 *
 * Platform-agnostic — zod only, no react/react-native/expo. ESM-safe (no
 * `require()`).
 */

import { z } from 'zod';
import { type UserNameResponse, userNameSchema } from './userResponse';
import {
    type ReputationConduct,
    type ReputationContextualInfluence,
    type ReputationContribution,
    type ReputationPersonhood,
    type ReputationReporting,
    type ReputationReviewing,
    reputationConductSchema,
    reputationContextualInfluenceSchema,
    reputationContributionSchema,
    reputationPersonhoodSchema,
    reputationReportingSchema,
    reputationReviewingSchema,
} from './moderationReputation';

/* -------------------------------------------------------------------------- */
/*  Closed value sets                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Category bucket a reputation transaction falls into. Drives the per-category
 * balance breakdown; every rule and transaction carries exactly one.
 *
 * - `content`    — posts, comments, media a user authored.
 * - `social`     — follows, likes, social interactions.
 * - `trust`      — identity / verification / trust-graph signals.
 * - `moderation` — reports filed, moderation actions, review outcomes.
 * - `physical`   — real-world signals (event check-ins, verified purchases).
 * - `penalty`    — negative adjustments for abuse / policy violations.
 * - `other`      — anything that does not fit the buckets above.
 */
export const REPUTATION_CATEGORIES = [
    'content',
    'social',
    'trust',
    'moderation',
    'physical',
    'penalty',
    'other',
] as const;

export type ReputationCategory = (typeof REPUTATION_CATEGORIES)[number];

export const reputationCategorySchema = z.enum(REPUTATION_CATEGORIES);

/**
 * Transaction lifecycle status.
 *
 * - `active`   — counts toward the balance.
 * - `disputed` — under dispute; still counts until the dispute resolves.
 * - `reversed` — superseded by a compensating reversal transaction; excluded.
 * - `voided`   — administratively excluded with no compensating entry.
 */
export const REPUTATION_TRANSACTION_STATUSES = [
    'active',
    'disputed',
    'reversed',
    'voided',
] as const;

export type ReputationTransactionStatus = (typeof REPUTATION_TRANSACTION_STATUSES)[number];

export const reputationTransactionStatusSchema = z.enum(REPUTATION_TRANSACTION_STATUSES);

/**
 * Trust tiers, lowest → highest trust, plus the punitive `restricted`.
 *
 * Publicly visible: this is the contribution ladder the reputation system
 * exists to publish. Note it doubles as the sanction marker — a `restricted`
 * account is publicly identifiable as such.
 */
export const TRUST_TIERS = ['restricted', 'new', 'trusted', 'high_trust', 'verified'] as const;

export type TrustTier = (typeof TRUST_TIERS)[number];

export const trustTierSchema = z.enum(TRUST_TIERS);

/** Kind of entity a transaction may target. */
export const REPUTATION_TARGET_ENTITY_TYPES = [
    'post',
    'comment',
    'report',
    'purchase',
    'event',
    'check_in',
    'manual_review',
    'user',
    'other',
] as const;

export type ReputationTargetEntityType = (typeof REPUTATION_TARGET_ENTITY_TYPES)[number];

export const reputationTargetEntityTypeSchema = z.enum(REPUTATION_TARGET_ENTITY_TYPES);

/** Dispute lifecycle status. */
export const REPUTATION_DISPUTE_STATUSES = [
    'open',
    'accepted',
    'rejected',
    'needs_review',
] as const;

export type ReputationDisputeStatus = (typeof REPUTATION_DISPUTE_STATUSES)[number];

export const reputationDisputeStatusSchema = z.enum(REPUTATION_DISPUTE_STATUSES);

/** Influence context selecting which capped weight axis to read. */
export const REPUTATION_INFLUENCE_CONTEXTS = [
    'default',
    'report',
    'moderation',
    'ranking',
] as const;

export type ReputationInfluenceContext = (typeof REPUTATION_INFLUENCE_CONTEXTS)[number];

export const reputationInfluenceContextSchema = z.enum(REPUTATION_INFLUENCE_CONTEXTS);

/* -------------------------------------------------------------------------- */
/*  Ledger entry                                                              */
/* -------------------------------------------------------------------------- */

/**
 * A single immutable entry in the reputation ledger.
 *
 * The ledger is append-only: transactions are NEVER deleted. A correction is
 * expressed either as a compensating REVERSAL (the original is marked
 * `reversed` and a new `active` transaction with negated points and
 * `reversedTransactionId` pointing at it is appended) or a VOID (the original is
 * marked `voided` and excluded from the balance, with no compensating entry).
 */
export interface ReputationTransaction {
    /** The transaction's Mongo `_id` as a string. */
    id: string;
    /** Subject of the reputation change — the user whose balance moves. */
    userId: string;
    /** Signed point delta. Positive awards, negative penalties/reversals. */
    points: number;
    /** The rule/action key that produced this transaction (e.g. `post_created`). */
    actionType: string;
    /** Category bucket the points fall into. */
    category: ReputationCategory;
    /** Canonical source application that reported the action, if any. */
    applicationId?: string;
    /** The specific credential used by the source application, if any. */
    credentialId?: string;
    /** Opaque id of the originating action in the source system (idempotency key). */
    sourceActionId?: string;
    /** Source-system action type (e.g. `report_confirmed`, `event_check_in`). */
    sourceActionType?: string;
    /** Id of the entity the action targeted (post id, report id, etc.). */
    targetEntityId?: string;
    /** Kind of the targeted entity. */
    targetEntityType?: ReputationTargetEntityType;
    /** Lifecycle status — only `active` transactions count toward the balance. */
    status: ReputationTransactionStatus;
    /**
     * Set ONLY on a compensating reversal transaction; references the original
     * transaction it reverses. The original carries `status: 'reversed'`.
     */
    reversedTransactionId?: string;
    /** Human-readable reason / note. */
    reason?: string;
    /**
     * Free-form structured metadata from the source system.
     *
     * Names third parties (the attestor who physically met the subject, the
     * staking voucher, a resolved validation's juror roster), which is why the
     * ledger read is owner-or-staff rather than public.
     */
    metadata?: Record<string, unknown>;
    /** The user who caused this change (the liker, the reporting user, staff). */
    createdByUserId?: string;
    /** Staff/service principal who reviewed (reversed/voided) this transaction. */
    reviewedByUserId?: string;
    /** ISO 8601 timestamp the transaction was reviewed at, if reviewed. */
    reviewedAt?: string;
    /** ISO 8601 creation timestamp. */
    createdAt: string;
    /** ISO 8601 last-update timestamp. */
    updatedAt: string;
}

export const reputationTransactionSchema: z.ZodType<ReputationTransaction> = z.object({
    id: z.string(),
    userId: z.string(),
    points: z.number(),
    actionType: z.string(),
    category: reputationCategorySchema,
    applicationId: z.string().optional(),
    credentialId: z.string().optional(),
    sourceActionId: z.string().optional(),
    sourceActionType: z.string().optional(),
    targetEntityId: z.string().optional(),
    targetEntityType: reputationTargetEntityTypeSchema.optional(),
    status: reputationTransactionStatusSchema,
    reversedTransactionId: z.string().optional(),
    reason: z.string().optional(),
    metadata: z.record(z.unknown()).optional(),
    createdByUserId: z.string().optional(),
    reviewedByUserId: z.string().optional(),
    reviewedAt: z.string().optional(),
    createdAt: z.string(),
    updatedAt: z.string(),
});

/* -------------------------------------------------------------------------- */
/*  Balance — the two views                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Per-category sums of a user's ACTIVE transactions. `penalties` is the
 * absolute sum of every negative-point transaction across all categories; the
 * named buckets carry the signed sum of transactions in that category.
 */
export interface ReputationBalanceBreakdown {
    content: number;
    social: number;
    trust: number;
    moderation: number;
    physical: number;
    penalties: number;
}

export const reputationBalanceBreakdownSchema: z.ZodType<ReputationBalanceBreakdown> = z.object({
    content: z.number(),
    social: z.number(),
    trust: z.number(),
    moderation: z.number(),
    physical: z.number(),
    penalties: z.number(),
});

/**
 * Capped influence weights. Every weight is clamped to a configured range and
 * restricted users are floored on every axis, so no single account can dominate
 * ranking, moderation or reporting.
 */
export interface ReputationInfluence {
    /** General-purpose trust weight derived from the lifetime total. */
    defaultWeight: number;
    /** Weight applied to this user's reports (scales with report accuracy). */
    reportWeight: number;
    /** Weight applied to this user's moderation actions (scales with tier). */
    moderationWeight: number;
    /** Damped weight applied to this user's ranking feedback. */
    rankingFeedbackWeight: number;
}

export const reputationInfluenceSchema: z.ZodType<ReputationInfluence> = z.object({
    defaultWeight: z.number(),
    reportWeight: z.number(),
    moderationWeight: z.number(),
    rankingFeedbackWeight: z.number(),
});

/** Reliability signals derived from the user's moderation track record. */
export interface ReputationReliability {
    /** Count of active transactions stamped `report_confirmed`. */
    accurateReports: number;
    /** Count of active transactions stamped `report_rejected`. */
    rejectedReports: number;
    /** accurate / (accurate + rejected), or the neutral 0.5 when no history. */
    reportAccuracyScore: number;
    /** Smoothed 0..1 abuse signal; high values force the `restricted` tier. */
    abuseScore: number;
}

export const reputationReliabilitySchema: z.ZodType<ReputationReliability> = z.object({
    accurateReports: z.number(),
    rejectedReports: z.number(),
    reportAccuracyScore: z.number(),
    abuseScore: z.number(),
});

/** The fields both balance views share. Kept as a shape so the full view can spread it. */
const balanceSummaryShape = {
    userId: z.string(),
    total: z.number(),
    trustTier: trustTierSchema,
};

/**
 * The PUBLIC view of a user's reputation — everything a caller who is neither
 * the subject nor platform staff receives from `GET /reputation/:userId/balance`.
 *
 * Deliberately limited to the two signals the already-public
 * `GET /reputation/leaderboard` publishes per user, so an untokened read of a
 * balance exposes no class of signal that is not public already.
 */
export interface ReputationBalanceSummary {
    userId: string;
    /** Net lifetime total across all active transactions. */
    total: number;
    trustTier: TrustTier;
}

export const reputationBalanceSummarySchema: z.ZodType<ReputationBalanceSummary> =
    z.object(balanceSummaryShape);

/**
 * The SUBJECT view of a user's reputation — the cached, recomputable snapshot in
 * full, served only to the subject themselves and to platform staff.
 *
 * Everything beyond {@link ReputationBalanceSummary} is the platform's internal
 * judgement about the person and is withheld from third parties: `reliability`
 * (the abuse verdict), `influence` (what the account is worth to ranking,
 * reporting and moderation), the `positive` / `negative` / `breakdown`
 * decomposition (which exposes sanction history the total alone hides), and the
 * timestamps (a timing oracle for the subject's last reputation event).
 *
 * Reach this type by reading YOUR OWN balance (`getMyReputationBalance`), by
 * narrowing a {@link ReputationBalanceView} with {@link isFullReputationBalance},
 * or from the staff-only `recalculateReputation`.
 */
export interface ReputationBalance extends ReputationBalanceSummary {
    /** Sum of positive points only. */
    positive: number;
    /** Sum of negative points only (a negative number). */
    negative: number;
    breakdown: ReputationBalanceBreakdown;
    influence: ReputationInfluence;
    reliability: ReputationReliability;
    /** ISO 8601 timestamp the snapshot was last recomputed at. */
    recalculatedAt: string;
    /** ISO 8601 last-update timestamp. */
    updatedAt: string;

    // ---------------------------------------------------------------------
    // V2 — the multidimensional snapshot.
    //
    // OPTIONAL on the wire and additive by design: a client written against
    // the single-score model keeps working, and a balance document written
    // before the multidimensional recompute simply omits them. A current
    // server always sends all six. Each block is a SEPARATE AXIS — the whole
    // reason they exist is that a single `total` let contribution offset
    // conduct, and let one small penalty restrict a new account outright.
    // ---------------------------------------------------------------------

    /** Whether Oxy believes this is a real, distinct person. Confers nothing else. */
    personhood?: ReputationPersonhood;
    /** What the person built. Excludes conduct penalties. */
    contribution?: ReputationContribution;
    /**
     * The standing moderation outcomes move. Derived from ACTIVE RISK alone, so
     * earning contribution points cannot cancel an active strike.
     */
    conduct?: ReputationConduct;
    /** Reporting accuracy, smoothed with a neutral prior plus a confidence. */
    reporting?: ReputationReporting;
    /** Reviewer reliability, per category and language rather than global. */
    reviewing?: ReputationReviewing;
    /** Contextual weights: report priority, jury selection, ranking. Never vote weight. */
    contextualInfluence?: ReputationContextualInfluence;
}

export const reputationBalanceSchema: z.ZodType<ReputationBalance> = z.object({
    ...balanceSummaryShape,
    positive: z.number(),
    negative: z.number(),
    breakdown: reputationBalanceBreakdownSchema,
    influence: reputationInfluenceSchema,
    reliability: reputationReliabilitySchema,
    recalculatedAt: z.string(),
    updatedAt: z.string(),
    personhood: reputationPersonhoodSchema.optional(),
    contribution: reputationContributionSchema.optional(),
    conduct: reputationConductSchema.optional(),
    reporting: reputationReportingSchema.optional(),
    reviewing: reputationReviewingSchema.optional(),
    contextualInfluence: reputationContextualInfluenceSchema.optional(),
});

/**
 * What `GET /reputation/:userId/balance` may return for an ARBITRARY subject:
 * the full {@link ReputationBalance} when the caller is that subject or staff,
 * the {@link ReputationBalanceSummary} otherwise.
 *
 * The server decides at request time from the caller's token, so a client asking
 * for someone else's balance cannot know statically which view it will get —
 * hence the union. Reading anything past `userId` / `total` / `trustTier`
 * requires narrowing with {@link isFullReputationBalance}.
 */
export type ReputationBalanceView = ReputationBalance | ReputationBalanceSummary;

/**
 * The fields the full {@link ReputationBalance} carries beyond the public
 * {@link ReputationBalanceSummary} that the API sends ALL-OR-NOTHING. The
 * runtime discriminant between the two views.
 *
 * The V2 blocks (`conduct`, `contribution`, …) are deliberately NOT listed:
 * they are optional on the wire, so requiring them here would make a balance
 * from a server that predates them fail to narrow, hiding the whole private
 * view. Read a V2 block by checking that block.
 */
const FULL_BALANCE_FIELDS = [
    'positive',
    'negative',
    'breakdown',
    'influence',
    'reliability',
    'recalculatedAt',
    'updatedAt',
] as const satisfies readonly (keyof Omit<ReputationBalance, keyof ReputationBalanceSummary>)[];

/**
 * Whether a balance came back as the SUBJECT view, and so carries the
 * breakdown / influence / reliability blocks.
 *
 * Checks every extra field rather than one representative: the point of the
 * guard is that the caller then dereferences those blocks, so a partial payload
 * must not narrow.
 *
 * @param balance - A balance from `getReputationBalance`.
 */
export function isFullReputationBalance(
    balance: ReputationBalanceView,
): balance is ReputationBalance {
    return FULL_BALANCE_FIELDS.every((field) => field in balance);
}

/** Compile-time assertion helper: fails to instantiate unless `T` is `true`. */
type AssertTrue<T extends true> = T;

/**
 * THE INVARIANT THIS MODULE EXISTS TO HOLD, checked by the compiler.
 *
 * `keyof` a union is the keys COMMON to its members, so a private field is only
 * `keyof ReputationBalanceView` if the PUBLIC view declares it too. Should
 * anyone widen {@link ReputationBalanceSummary} — or collapse the union back to
 * a single shape — one of these arms becomes `false` and `tsc` fails, rather
 * than a consumer silently regaining `balance.reliability.x` on a stranger's
 * balance and crashing at runtime.
 *
 * This lives in the source, NOT in `__tests__`, so `tsc --noEmit` and
 * `build:types` both check it on every build.
 */
type _PrivateFieldsAreUnreachableOnTheView = AssertTrue<
    'reliability' extends keyof ReputationBalanceView
        ? false
        : 'influence' extends keyof ReputationBalanceView
          ? false
          : 'breakdown' extends keyof ReputationBalanceView
            ? false
            : 'positive' extends keyof ReputationBalanceView
              ? false
              : // The V2 blocks are the most sensitive of the lot: `conduct`
                // names a sanction and `reporting` names the abuse verdict.
                'conduct' extends keyof ReputationBalanceView
                ? false
                : 'reporting' extends keyof ReputationBalanceView
                  ? false
                  : 'reviewing' extends keyof ReputationBalanceView
                    ? false
                    : true
>;

/**
 * The other half: the public trust signal must stay reachable with NO
 * narrowing, so the common "show a tier and a total" render never needs a guard.
 */
type _PublicFieldsStayReachableOnTheView = AssertTrue<
    'userId' extends keyof ReputationBalanceView
        ? 'total' extends keyof ReputationBalanceView
            ? 'trustTier' extends keyof ReputationBalanceView
                ? true
                : false
            : false
        : false
>;

/* -------------------------------------------------------------------------- */
/*  Dispute, rule, leaderboard, influence                                     */
/* -------------------------------------------------------------------------- */

/** A user-initiated dispute against a specific reputation transaction. */
export interface ReputationDispute {
    /** The dispute's Mongo `_id` as a string. */
    id: string;
    /** The transaction being disputed. */
    transactionId: string;
    /** The user raising the dispute. */
    userId: string;
    /** Why the user believes the transaction is wrong. */
    reason: string;
    status: ReputationDisputeStatus;
    /** Optional supporting evidence (URLs / references). */
    evidence?: string[];
    /** ISO 8601 timestamp the dispute was resolved at, if resolved. */
    resolvedAt?: string;
    /** Staff principal who resolved the dispute, if resolved. */
    resolvedByUserId?: string;
    /** ISO 8601 creation timestamp. */
    createdAt: string;
    /** ISO 8601 last-update timestamp. */
    updatedAt: string;
}

export const reputationDisputeSchema: z.ZodType<ReputationDispute> = z.object({
    id: z.string(),
    transactionId: z.string(),
    userId: z.string(),
    reason: z.string(),
    status: reputationDisputeStatusSchema,
    evidence: z.array(z.string()).optional(),
    resolvedAt: z.string().optional(),
    resolvedByUserId: z.string().optional(),
    createdAt: z.string(),
    updatedAt: z.string(),
});

/**
 * A configurable reputation award/penalty rule, keyed by `actionType`. The
 * `GET /reputation/rules` response emits no timestamps.
 */
export interface ReputationRule {
    /** The rule's Mongo `_id` as a string. */
    id: string;
    /** Unique action key (e.g. `post_created`). */
    actionType: string;
    /** Signed points the rule awards (may be negative for penalties). */
    points: number;
    /** Category the resulting transaction is filed under. */
    category: ReputationCategory;
    description: string;
    /** Per (user, actionType) cooldown in minutes; 0 disables the cooldown. */
    cooldownInMinutes: number;
    isEnabled: boolean;
}

export const reputationRuleSchema: z.ZodType<ReputationRule> = z.object({
    id: z.string(),
    actionType: z.string(),
    points: z.number(),
    category: reputationCategorySchema,
    description: z.string(),
    cooldownInMinutes: z.number(),
    isEnabled: z.boolean(),
});

/**
 * The user a {@link ReputationLeaderboardEntry} is about.
 *
 * A deliberately narrow projection, not a full user DTO: the leaderboard is
 * public, so it publishes only what is needed to render a row and route to the
 * profile. `name` comes from the same canonical composition every other user
 * DTO uses, so `name.displayName` is present exactly when the API resolved a
 * real name — fall back to the handle when it is absent, never recompose.
 */
export interface ReputationLeaderboardUser {
    /** The user's Mongo `_id` as a string. */
    id: string;
    username: string;
    name: UserNameResponse;
    /** Avatar FILE ID (not a URL) — resolve it through the SDK's media chokepoint. */
    avatar?: string;
    /** secp256k1 public key; absent for accounts with no self-custody identity. */
    publicKey?: string;
}

export const reputationLeaderboardUserSchema: z.ZodType<ReputationLeaderboardUser> = z.object({
    id: z.string(),
    username: z.string(),
    name: userNameSchema,
    avatar: z.string().optional(),
    publicKey: z.string().optional(),
});

/** A single leaderboard row: the user, their lifetime total, tier and rank. */
export interface ReputationLeaderboardEntry {
    user: ReputationLeaderboardUser;
    /** Net lifetime total. */
    total: number;
    /** Derived trust tier. */
    trustTier: TrustTier;
    /** 1-based rank within the leaderboard (`offset + index + 1`). */
    rank: number;
}

export const reputationLeaderboardEntrySchema: z.ZodType<ReputationLeaderboardEntry> = z.object({
    user: reputationLeaderboardUserSchema,
    total: z.number(),
    trustTier: trustTierSchema,
    rank: z.number(),
});

/**
 * `GET /reputation/:userId/influence` — the requested context, the single capped
 * weight for that context, and the full influence block.
 */
export interface ReputationInfluenceResult {
    context: ReputationInfluenceContext;
    weight: number;
    influence: ReputationInfluence;
}

export const reputationInfluenceResultSchema: z.ZodType<ReputationInfluenceResult> = z.object({
    context: reputationInfluenceContextSchema,
    weight: z.number(),
    influence: reputationInfluenceSchema,
});

/**
 * `POST /reputation/transactions/:id/reverse` — the now-`reversed` original plus
 * the compensating `active` reversal entry.
 */
export interface ReverseReputationTransactionResult {
    original: ReputationTransaction;
    reversal: ReputationTransaction;
}

export const reverseReputationTransactionResultSchema: z.ZodType<ReverseReputationTransactionResult> =
    z.object({
        original: reputationTransactionSchema,
        reversal: reputationTransactionSchema,
    });

/* -------------------------------------------------------------------------- */
/*  Request bodies                                                            */
/* -------------------------------------------------------------------------- */

/**
 * `POST /reputation/award`.
 *
 * Awarding is restricted to service tokens carrying the privileged
 * `reputation:write` scope (the canonical path — a source app reports an
 * action) and to platform staff; regular users may NOT award reputation. When
 * called with a service token, `applicationId` / `credentialId` are resolved
 * from the token and any client-supplied values for those two are ignored.
 */
export interface AwardReputationInput {
    /** The subject whose reputation changes (`_id` or publicKey). */
    userId: string;
    /** The enabled rule's action key (e.g. `post_created`). */
    actionType: string;
    /** Source application id (ignored for service tokens). */
    applicationId?: string;
    /** Source credential id (ignored for service tokens). */
    credentialId?: string;
    /** Opaque originating-action id used as the idempotency key. */
    sourceActionId?: string;
    /** Source-system action type. */
    sourceActionType?: string;
    /** Id of the targeted entity. */
    targetEntityId?: string;
    /** Kind of the targeted entity. */
    targetEntityType?: ReputationTargetEntityType;
    /** Optional human-readable reason (max 500 chars). */
    reason?: string;
    /** Free-form structured metadata from the source system. */
    metadata?: Record<string, unknown>;
}

export const awardReputationSchema: z.ZodType<AwardReputationInput> = z.object({
    userId: z.string().trim().min(1),
    actionType: z.string().trim().min(1),
    applicationId: z.string().trim().min(1).optional(),
    credentialId: z.string().trim().min(1).optional(),
    sourceActionId: z.string().trim().min(1).optional(),
    sourceActionType: z.string().trim().min(1).optional(),
    targetEntityId: z.string().trim().min(1).optional(),
    targetEntityType: reputationTargetEntityTypeSchema.optional(),
    reason: z.string().trim().max(500).optional(),
    metadata: z.record(z.unknown()).optional(),
});

/**
 * `POST /reputation/disputes` — open a dispute. The disputer is the
 * authenticated user and must be the disputed transaction's subject.
 */
export interface CreateReputationDisputeInput {
    /** The transaction being disputed. */
    transactionId: string;
    /** Why the transaction is believed to be wrong (1..1000 chars). */
    reason: string;
    /** Optional supporting evidence (URLs / references; max 20). */
    evidence?: string[];
}

export const createReputationDisputeSchema: z.ZodType<CreateReputationDisputeInput> = z.object({
    transactionId: z.string().trim().min(1),
    reason: z.string().trim().min(1).max(1000),
    evidence: z.array(z.string().trim().min(1)).max(20).optional(),
});

/** `POST /reputation/disputes/:id/resolve` (staff). */
export interface ResolveReputationDisputeInput {
    /** Accepting reverses the disputed transaction; rejecting restores it. */
    status: 'accepted' | 'rejected';
}

export const resolveReputationDisputeSchema: z.ZodType<ResolveReputationDisputeInput> = z.object({
    status: z.enum(['accepted', 'rejected']),
});

/**
 * `POST /reputation/rules` (staff) — create or update a rule, keyed by
 * `actionType`. `cooldownInMinutes` and `isEnabled` may be omitted; the server
 * fills them in (see {@link UpsertReputationRuleRequest}).
 */
export interface UpsertReputationRuleInput {
    /** Unique action key (e.g. `post_created`). */
    actionType: string;
    /** Signed points the rule awards (may be negative). */
    points: number;
    /** Category the resulting transaction is filed under. */
    category: ReputationCategory;
    /** Human-readable description (1..500 chars). */
    description: string;
    /** Per (user, actionType) cooldown in minutes; defaults to 0. */
    cooldownInMinutes?: number;
    /** Whether the rule is active; defaults to true. */
    isEnabled?: boolean;
}

/**
 * The upsert body AFTER the schema's defaults are applied — what the route
 * handler actually receives. Distinct from {@link UpsertReputationRuleInput},
 * where the defaulted fields are still optional.
 */
export interface UpsertReputationRuleRequest extends UpsertReputationRuleInput {
    cooldownInMinutes: number;
    isEnabled: boolean;
}

export const upsertReputationRuleSchema: z.ZodType<
    UpsertReputationRuleRequest,
    z.ZodTypeDef,
    UpsertReputationRuleInput
> = z.object({
    actionType: z.string().trim().min(1),
    points: z.number(),
    category: reputationCategorySchema,
    description: z.string().trim().min(1).max(500),
    cooldownInMinutes: z.number().int().min(0).default(0),
    isEnabled: z.boolean().default(true),
});

/**
 * `POST /reputation/transactions/:id/reverse` and `.../void` (staff). The
 * reviewing principal is the authenticated user.
 */
export interface ReverseReputationTransactionInput {
    /** Optional human-readable reason (max 500 chars). */
    reason?: string;
}

export const reverseReputationTransactionSchema: z.ZodType<ReverseReputationTransactionInput> =
    z.object({
        reason: z.string().trim().max(500).optional(),
    });
