/**
 * Reputation service — the single source of truth for all reputation mutations
 * (#217 ledger + #219 derived trust tiers / capped influence).
 *
 * Invariants:
 *  - Transactions are NEVER deleted. Corrections are expressed as reversals
 *    (compensating entry) or voids (status flip, no compensating entry).
 *  - A user's balance is always re-derivable by aggregating their `active`
 *    transactions; `reputation_balances` is a recomputable cache of that.
 *  - Awards are idempotent on (application_id, source_action_id).
 *  - Every constant lives in `reputation.constants.ts`.
 *
 * ## The transaction fallback is DELETED, not translated
 *
 * The Mongo version wrapped every multi-write in a `withTransaction` that
 * string-matched "no replica set" on the failure and then RE-RAN the same work
 * SESSION-LESS. That made `award`, `reverseTransaction`, `voidTransaction` and
 * dispute creation non-atomic on any deployment without a replica set: an
 * interruption could leave a ledger row with no balance recompute behind it, or
 * a `reversed` original with no compensating entry — a permanent, silent
 * mis-statement of someone's standing. Postgres has real transactions in every
 * deployment, so the fallback has nothing to fall back to and is gone; every
 * write below either commits whole or does not happen.
 *
 * ## What that changes about duplicate-key recovery
 *
 * A `unique_violation` inside a Postgres transaction ABORTS it — no further
 * statement on that connection succeeds until it rolls back. So the
 * "return the winner of the idempotency race" read cannot live inside the
 * failing transaction the way `findOne` did inside the Mongo one. It runs
 * AFTER, on a fresh connection ({@link ReputationService.findBySourceAction}),
 * and only when this service owns the transaction — when a CALLER supplied one
 * (the moderation bridge), the abort belongs to them and the error is rethrown
 * so their own handler resolves the winner.
 */

import type { ExtractTablesWithRelations } from 'drizzle-orm';
import { and, asc, count, desc, eq, gt, inArray, ne } from 'drizzle-orm';
import type { PostgresJsTransaction } from 'drizzle-orm/postgres-js';
import type {
  ReputationCategory,
  ReputationInfluenceContext,
  ReputationTargetEntityType,
  TrustTier,
} from '@oxyhq/contracts';

import { getDb, type Database } from '../config/postgres';
import { isUniqueViolation } from '@oxyhq/db';
import type * as schema from '../db/schema';
import { conductStrikes } from '../db/schema/conductStrikes';
import { personhoodStatuses } from '../db/schema/personhoodStatuses';
import { reporterReputationProfiles } from '../db/schema/reporterReputationProfiles';
import {
  reputationBalances,
  reputationReviewingReliability,
  type ReputationBreakdown,
  type ReputationConductSnapshot,
  type ReputationContextualInfluenceSnapshot,
  type ReputationContributionSnapshot,
  type ReputationInfluence,
  type ReputationPersonhoodSnapshot,
  type ReputationReliability,
  type ReputationReportingSnapshot,
  type ReputationReviewingSnapshot,
} from '../db/schema/reputationBalances';
import { reputationDisputes } from '../db/schema/reputationDisputes';
import { reputationRules } from '../db/schema/reputationRules';
import { reputationTransactions } from '../db/schema/reputationTransactions';
import { reviewerReputationProfiles } from '../db/schema/reviewerReputationProfiles';
import { users } from '../db/schema/users';
import {
  REPORT_CONFIRMED_ACTION,
  REPORT_REJECTED_ACTION,
  ENDORSEMENT_RECEIVED_ACTION,
  ENDORSEMENT_RECEIVED_POINTS,
  REAL_LIFE_ATTESTED_ACTION,
  REAL_LIFE_ATTESTED_POINTS,
  PEER_VALIDATED_ACTION,
  PEER_VALIDATED_POINTS,
  VALIDATION_CORRECT_ACTION,
  VALIDATION_CORRECT_POINTS,
  VALIDATION_INCORRECT_ACTION,
  VALIDATION_INCORRECT_POINTS,
  PERSONHOOD_VOUCHED_ACTION,
  PERSONHOOD_VOUCHED_POINTS,
  VOUCH_SLASHED_ACTION,
  VOUCH_SLASHED_POINTS,
  LEASE_SIGNED_ACTION,
  LEASE_SIGNED_POINTS,
  LEASE_COMPLETED_ACTION,
  LEASE_COMPLETED_POINTS,
  CLEAN_MOVEOUT_ACTION,
  CLEAN_MOVEOUT_POINTS,
  LEASE_DEFAULT_ACTION,
  LEASE_DEFAULT_POINTS,

} from '../utils/reputation.constants';
import {
  CONDUCT_ACTION_TYPES,
  NEUTRAL_REVIEWER_RELIABILITY,
  REPORT_ABUSE_ACTION_TYPES,
} from '../utils/moderation.constants';
import { attestAward } from './civic/attestation.service';
import {
  computeReliability,
  computeReporting,
  deriveConductStanding,
  deriveContextualInfluence,
  deriveContributionTier,
  deriveInfluence,
  deriveTrustTier,
} from '../utils/reputationDerive';
import { BadRequestError, ConflictError, NotFoundError } from '../utils/error';
import { logger } from '../utils/logger';
import userCache from '../utils/userCache';

/**
 * An open transaction on the reputation tables.
 *
 * Exported because it is part of {@link AwardInput}: the moderation bridge opens
 * ONE transaction covering the ledger row, its strike and its effect record, and
 * hands it here so the three commit together or not at all. It replaces the
 * Mongo `ClientSession` in exactly that role.
 */
export type ReputationTransactionHandle = PostgresJsTransaction<
  typeof schema,
  ExtractTablesWithRelations<typeof schema>
>;

/** Either the pool or an open transaction — every read/write below accepts both. */
export type ReputationDbHandle = Database | ReputationTransactionHandle;

/** A row of the reputation ledger. */
export type ReputationTransactionRow = typeof reputationTransactions.$inferSelect;
/** A row of the dispute table. */
export type ReputationDisputeRow = typeof reputationDisputes.$inferSelect;
/** A row of the configurable rule table. */
export type ReputationRuleRow = typeof reputationRules.$inferSelect;

/**
 * The recomputed standing of one account.
 *
 * The Mongo document nested nine `{_id: false}` subdocuments; the table holds
 * them as prefixed columns plus one child table. This view re-assembles the
 * nested shape the wire contract and every consumer already speak, so the
 * storage change stops at this boundary.
 */
export interface ReputationBalanceView {
  userId: string;
  total: number;
  positive: number;
  negative: number;
  breakdown: ReputationBreakdown;
  trustTier: TrustTier;
  influence: ReputationInfluence;
  reliability: ReputationReliability;
  personhood: ReputationPersonhoodSnapshot;
  contribution: ReputationContributionSnapshot;
  conduct: ReputationConductSnapshot;
  reporting: ReputationReportingSnapshot;
  reviewing: ReputationReviewingSnapshot;
  contextualInfluence: ReputationContextualInfluenceSnapshot;
  lastTransactionId?: string;
  recalculatedAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * One leaderboard row: a balance plus the inline public projection of its
 * subject.
 *
 * The Mongo aggregate `$lookup`ed the user and projected it into `userId`, which
 * left the route serializer casting an id-typed field to a user object. The join
 * is a real join now, so the row NAMES the projection — a serializer that reads
 * `row.user.username` cannot be handed an id by mistake.
 *
 * `user` is the FLAT users-row shape on purpose: `userIdentityFields`
 * (`utils/userTransform.ts`) is the sole definition of `id`/`name`/`username`/
 * `avatar` for every user DTO and reads `name_first`/`name_last` directly, so
 * the route hands it this object rather than reassembling a nested `name` here
 * and drifting from the contract every ecosystem app reads.
 */
export interface ReputationLeaderboardRow {
  total: number;
  trustTier: TrustTier;
  user: {
    id: string;
    username: string | null;
    nameFirst: string | null;
    nameLast: string | null;
    avatar: string | null;
    publicKey: string | null;
  };
}

/**
 * A points/category pair supplied by a VERSIONED policy instead of by a
 * `reputation_rules` row.
 *
 * Exists for exactly one caller: the moderation reputation bridge. A conduct
 * consequence's points come from the `moderation_policies` row of the version
 * the decision was made under, because a consequence must be recomputable under
 * the original policy — a mutable rule row cannot express that, and keeping one
 * alongside the policy would be a second authority for the same number, free to
 * drift.
 *
 * NOT reachable from HTTP: `awardReputationSchema` does not declare the field,
 * and `POST /reputation/award` passes each input field explicitly rather than
 * spreading the body, so a client cannot choose its own points.
 */
export interface AwardRuleOverride {
  /** Signed points, already multiplied and capped by the policy engine. */
  points: number;
  category: ReputationCategory;
  /** Human-readable reason recorded on the transaction. */
  description: string;
  /** The policy version the figures came from, recorded for provenance. */
  policyVersion: string;
}

/** Input for `award`. `userId` is the subject whose reputation changes. */
export interface AwardInput {
  userId: string;
  actionType: string;
  applicationId?: string;
  credentialId?: string;
  sourceActionId?: string;
  sourceActionType?: string;
  targetEntityId?: string;
  targetEntityType?: ReputationTargetEntityType;
  reason?: string;
  createdByUserId?: string;
  metadata?: Record<string, unknown>;
  /**
   * When `true`, emit an Oxy-signed `reputation_attestation` record onto the
   * subject's hash chain after the award commits (crypto-owned reputation —
   * Fase 1). Default `false`: the 14 existing call sites are unaffected. Civic
   * awards pass `true`. Emission is non-fatal and never blocks the award.
   */
  emitAttestation?: boolean;
  /**
   * The `recordId`s of the user-signed envelopes that originated this award
   * (e.g. the counterparty's real-life attestation, the jurors' verdicts) —
   * embedded in the Oxy attestation as the proof chain. Only used when
   * `emitAttestation` is `true`.
   */
  sourceEnvelopeIds?: string[];
  /**
   * Bridge-only: take the points and category from a versioned policy instead of
   * from a rule row. When present the rule lookup and the per-action cooldown
   * are both skipped — a moderation consequence is governed by the decision's
   * idempotency key, not by a rate limit on the action key.
   */
  ruleOverride?: AwardRuleOverride;
  /**
   * Run the ledger write inside a transaction the CALLER already opened, so the
   * transaction, its strike and its effect record commit together or not at all.
   * Without this the bridge could leave a ledger row with no strike behind it.
   */
  tx?: ReputationTransactionHandle;
}

/** Input for a reversal or void review action. */
export interface ReviewInput {
  reviewedByUserId?: string;
  reason?: string;
}

/** Input for upserting a reputation rule. */
export interface UpsertRuleInput {
  actionType: string;
  points: number;
  category: ReputationCategory;
  description: string;
  cooldownInMinutes?: number;
  isEnabled?: boolean;
}

/** The idempotency guard's index name, so a duplicate is answered SPECIFICALLY. */
const SOURCE_ACTION_UNIQUE = 'reputation_transactions_source_action_key';

/**
 * A `jsonb` column round-trips as `unknown`. Metadata is a free-form object from
 * the source system, so a non-object value (including the `null` an absent
 * column yields) reads as "no metadata" rather than being forced into a shape it
 * never had.
 */
export function readMetadata(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

/**
 * A `jsonb` map of string → number, as the reviewer profile stores its per-key
 * reliability. Non-numeric entries are dropped rather than propagated: the
 * destination column carries a `between 0 and 1` CHECK, so a bad value would
 * fail the write with a constraint error that names nothing useful.
 */
function readReliabilityMap(value: unknown): Map<string, number> {
  const map = new Map<string, number>();
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return map;
  }
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry === 'number' && Number.isFinite(entry) && entry >= 0 && entry <= 1) {
      map.set(key, entry);
    }
  }
  return map;
}

class ReputationService {
  /**
   * Award (or penalise) reputation to a user by `actionType`.
   *
   * Resolves the enabled rule, enforces the per (user, actionType) cooldown,
   * enforces idempotency on (applicationId, sourceActionId), creates the
   * transaction, and recomputes the balance. Returns the created (or, on an
   * idempotent hit, the pre-existing) transaction.
   */
  async award(input: AwardInput): Promise<ReputationTransactionRow> {
    // Coerced once, here, because `award` has fourteen call sites and is
    // exported: most of them never pass through an HTTP schema at all. `trim`
    // is the Mongoose `trim: true` on `ReputationRule.actionType`, which was
    // APPLICATION behaviour with no Postgres counterpart and is therefore
    // re-applied at the call site (`CONVENTIONS.md`) — on the lookup as well as
    // on the write, since Mongoose applied it to query filters too.
    const actionType = String(input.actionType).trim();
    const sourceActionId =
      input.sourceActionId === undefined ? undefined : String(input.sourceActionId);

    // CONDUCT ACTION TYPES ARE BRIDGE-ONLY, and this is what makes that
    // structural rather than accidental.
    //
    // Without it, the guarantee rests on the fact that no rule for a conduct
    // action happens to be seeded — so one `POST /reputation/rules` by a staff
    // account would quietly open `POST /reputation/award` to minting
    // conduct-stamped penalties for arbitrary users, on `reputation:write`, which
    // every official application already holds. That transaction would carry no
    // strike, so no active risk and no standing change, but it would still be a
    // penalty attributed to moderation that no decision and no identity binding
    // ever authorised. `ruleOverride` is set only by the bridge and is not
    // expressible over HTTP, so requiring it here is the same boundary the rest
    // of the phase enforces.
    if (!input.ruleOverride && CONDUCT_ACTION_TYPES.has(actionType)) {
      throw new BadRequestError(
        'Conduct action types are produced only by the moderation reputation bridge'
      );
    }

    // The figures come from ONE of two authorities, never from both: a rule row
    // (every ordinary award) or a versioned policy the bridge resolved (a
    // moderation consequence, which must stay recomputable under the policy
    // version it was decided under).
    const override = input.ruleOverride;
    let points: number;
    let category: ReputationCategory;
    let defaultReason: string;
    let cooldownInMinutes: number;

    if (override) {
      points = override.points;
      category = override.category;
      defaultReason = override.description;
      // No cooldown: a moderation consequence is bounded by the decision's
      // idempotency key, and a cooldown here would silently drop the second
      // legitimate incident of the same severity.
      cooldownInMinutes = 0;
    } else {
      const [rule] = await getDb()
        .select({
          points: reputationRules.points,
          category: reputationRules.category,
          description: reputationRules.description,
          cooldownInMinutes: reputationRules.cooldownInMinutes,
        })
        .from(reputationRules)
        .where(and(eq(reputationRules.actionType, actionType), eq(reputationRules.isEnabled, true)))
        .limit(1);
      if (!rule) {
        throw new BadRequestError('Unknown or disabled reputation action');
      }
      points = rule.points;
      category = rule.category;
      defaultReason = rule.description;
      cooldownInMinutes = rule.cooldownInMinutes;
    }

    const applicationId = input.applicationId;
    const sourceKeyed = applicationId !== undefined && sourceActionId !== undefined;

    // Idempotency: a given (applicationId, sourceActionId) may award at most
    // once. Short-circuit BEFORE the cooldown check so a retried delivery of
    // the same source action returns the original transaction rather than a
    // cooldown conflict.
    if (sourceKeyed) {
      const existing = await this.findBySourceAction(applicationId, sourceActionId);
      if (existing) {
        return existing;
      }
    }

    // Cooldown: reject a repeat of the same action for the same subject within
    // the rule's window.
    if (cooldownInMinutes > 0) {
      const threshold = new Date(Date.now() - cooldownInMinutes * 60 * 1000);
      const [recent] = await getDb()
        .select({ id: reputationTransactions.id })
        .from(reputationTransactions)
        .where(
          and(
            eq(reputationTransactions.userId, input.userId),
            eq(reputationTransactions.actionType, actionType),
            eq(reputationTransactions.status, 'active'),
            gt(reputationTransactions.createdAt, threshold)
          )
        )
        .limit(1);
      if (recent) {
        throw new ConflictError('This action is on cooldown. Please try again later.');
      }
    }

    // Provenance for a policy-derived award: the version the figures came from
    // is recorded on the transaction itself, so the row explains itself without
    // a join and stays explainable after the policy moves on.
    const metadata = override
      ? { ...(input.metadata ?? {}), policyVersion: override.policyVersion }
      : input.metadata;

    const writeTransaction = async (
      handle: ReputationDbHandle
    ): Promise<ReputationTransactionRow> => {
      const [created] = await handle
        .insert(reputationTransactions)
        .values({
          userId: input.userId,
          points,
          actionType,
          category,
          applicationId,
          credentialId: input.credentialId,
          sourceActionId,
          sourceActionType: input.sourceActionType,
          targetEntityId: input.targetEntityId,
          targetEntityType: input.targetEntityType,
          status: 'active',
          reason: input.reason ?? defaultReason,
          metadata,
          createdByUserId: input.createdByUserId,
        })
        .returning();

      await this.recalculateBalance(input.userId, handle);
      return created;
    };

    // A caller-supplied transaction means the ledger write is one part of a
    // larger atomic unit (the bridge commits the transaction, its strike and its
    // effect record together). Without one, open a transaction here.
    let transaction: ReputationTransactionRow;
    if (input.tx) {
      // No duplicate recovery on this path: a unique violation aborts the
      // CALLER'S transaction, so no read on it can succeed. The caller owns the
      // rollback and resolves the winner afterwards on a live connection.
      transaction = await writeTransaction(input.tx);
    } else {
      try {
        transaction = await getDb().transaction(writeTransaction);
      } catch (error) {
        // Idempotency race: the unique index rejected a concurrent duplicate.
        // Return the winner. Read AFTER the rollback, never inside the aborted
        // transaction.
        if (isUniqueViolation(error, SOURCE_ACTION_UNIQUE) && sourceKeyed) {
          const winner = await this.findBySourceAction(applicationId, sourceActionId);
          if (winner) {
            return winner;
          }
        }
        throw error;
      }
    }

    // Crypto-owned reputation (Fase 1): emit an Oxy-signed attestation onto the
    // subject's hash chain AFTER the award commits, so a signing/chain failure
    // can never roll back or block the award. Idempotent per txn + non-fatal.
    if (input.emitAttestation) {
      try {
        await attestAward(transaction, { sourceEnvelopes: input.sourceEnvelopeIds });
      } catch (error) {
        logger.warn('Reputation attestation emission failed (non-fatal)', {
          component: 'reputation.service',
          actionType,
          userId: input.userId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return transaction;
  }

  /**
   * The transaction holding an (application, source action) idempotency slot, or
   * `null`. Always read on the pool: its two callers run either before a
   * transaction is opened or after one has already rolled back.
   */
  private async findBySourceAction(
    applicationId: string,
    sourceActionId: string
  ): Promise<ReputationTransactionRow | null> {
    const [existing] = await getDb()
      .select()
      .from(reputationTransactions)
      .where(
        and(
          eq(reputationTransactions.applicationId, applicationId),
          eq(reputationTransactions.sourceActionId, sourceActionId)
        )
      )
      .limit(1);
    return existing ?? null;
  }

  /**
   * Reverse a transaction: mark the original `reversed` and append a
   * compensating `active` transaction with negated points that references the
   * original. Never deletes. Recomputes the balance. Idempotent — a transaction
   * already reversed is returned unchanged.
   */
  async reverseTransaction(
    transactionId: string,
    review: ReviewInput
  ): Promise<{ original: ReputationTransactionRow; reversal: ReputationTransactionRow }> {
    const reviewedByUserId = review.reviewedByUserId;

    const [original] = await getDb()
      .select()
      .from(reputationTransactions)
      .where(eq(reputationTransactions.id, transactionId))
      .limit(1);
    if (!original) {
      throw new NotFoundError('Transaction not found');
    }

    if (original.status === 'reversed') {
      const [existingReversal] = await getDb()
        .select()
        .from(reputationTransactions)
        .where(eq(reputationTransactions.reversedTransactionId, original.id))
        .limit(1);
      if (existingReversal) {
        return { original, reversal: existingReversal };
      }
    }

    if (original.status === 'voided') {
      throw new ConflictError('A voided transaction cannot be reversed');
    }

    const result = await getDb().transaction(async (tx) => {
      const reviewedAt = new Date();
      const [flipped] = await tx
        .update(reputationTransactions)
        .set({
          status: 'reversed',
          reviewedByUserId,
          reviewedAt,
          ...(review.reason ? { reason: review.reason } : {}),
        })
        .where(eq(reputationTransactions.id, original.id))
        .returning();

      const [reversal] = await tx
        .insert(reputationTransactions)
        .values({
          userId: original.userId,
          points: -original.points,
          actionType: original.actionType,
          category: original.category,
          applicationId: original.applicationId,
          credentialId: original.credentialId,
          sourceActionType: original.sourceActionType,
          targetEntityId: original.targetEntityId,
          targetEntityType: original.targetEntityType,
          status: 'active',
          reversedTransactionId: original.id,
          reason: review.reason ?? `Reversal of ${original.id}`,
          createdByUserId: reviewedByUserId,
          reviewedByUserId,
          reviewedAt,
        })
        .returning();

      await this.recalculateBalance(original.userId, tx);
      return { original: flipped, reversal };
    });

    // Staking slash (Fase 2): a reversed civic award slashes the jurors /
    // attestor who vouched for it. Non-fatal + dynamically imported to avoid a
    // reputation↔slash module cycle; never blocks or rolls back the reversal.
    try {
      const { slashForReversedTransaction } = await import('./civic/slash.service.js');
      await slashForReversedTransaction(result.original);
    } catch (error) {
      logger.warn('Reputation slash hook failed (non-fatal)', {
        component: 'reputation.service',
        transactionId,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    return result;
  }

  /**
   * Void a transaction: mark it `voided` so it is excluded from the balance,
   * with NO compensating entry. Never deletes. Recomputes the balance.
   */
  async voidTransaction(
    transactionId: string,
    review: ReviewInput
  ): Promise<ReputationTransactionRow> {
    const [txn] = await getDb()
      .select()
      .from(reputationTransactions)
      .where(eq(reputationTransactions.id, transactionId))
      .limit(1);
    if (!txn) {
      throw new NotFoundError('Transaction not found');
    }
    if (txn.status === 'voided') {
      return txn;
    }
    if (txn.status === 'reversed') {
      throw new ConflictError('A reversed transaction cannot be voided');
    }

    return getDb().transaction(async (tx) => {
      const [voided] = await tx
        .update(reputationTransactions)
        .set({
          status: 'voided',
          reviewedByUserId: review.reviewedByUserId,
          reviewedAt: new Date(),
          ...(review.reason ? { reason: review.reason } : {}),
        })
        .where(eq(reputationTransactions.id, txn.id))
        .returning();

      await this.recalculateBalance(txn.userId, tx);
      return voided;
    });
  }

  /**
   * Recompute and persist a user's balance snapshot. This is the function #219
   * hinges on.
   *
   * Counting model:
   *  - MONETARY aggregation (total/positive/negative/breakdown) sums every
   *    transaction EXCEPT `voided` ones. A reversal is expressed as a pair —
   *    the `reversed` original (its points retained for audit) and a `active`
   *    compensating entry with negated points — so the pair nets to ZERO. A
   *    `voided` transaction contributes nothing. A `disputed` transaction still
   *    counts until its dispute resolves.
   *  - RELIABILITY counts (accurate/rejected reports, penalties) are derived
   *    from `active` transactions ONLY, so a cancelled (reversed) report no
   *    longer inflates a user's reliability.
   *  - `penalties` = absolute sum of all negative-point counted transactions.
   *  - trust tier needs `users.verified`; influence weights are derived last.
   */
  async recalculateBalance(
    userId: string,
    handle: ReputationDbHandle = getDb()
  ): Promise<ReputationBalanceView> {
    const transactions = await handle
      .select({
        id: reputationTransactions.id,
        points: reputationTransactions.points,
        actionType: reputationTransactions.actionType,
        category: reputationTransactions.category,
        status: reputationTransactions.status,
        sourceActionType: reputationTransactions.sourceActionType,
        createdAt: reputationTransactions.createdAt,
      })
      .from(reputationTransactions)
      .where(
        and(
          eq(reputationTransactions.userId, userId),
          ne(reputationTransactions.status, 'voided')
        )
      );

    let total = 0;
    let positive = 0;
    let negative = 0;
    let penalties = 0;
    let accurateReports = 0;
    let rejectedReports = 0;
    let reportAbuseCount = 0;
    // Net of everything OUTSIDE the conduct axis. The legacy `restricted`
    // trigger reads this instead of `total`, so a conduct penalty is judged on
    // the conduct axis rather than also forcing a restriction through a negative
    // total — a low-severity finding is worth `watch`, not a restriction.
    let nonConductTotal = 0;
    // Contribution counts only what was BUILT: positive points outside the
    // conduct axis. Conduct penalties still land in `total`, so the ledger stays
    // honest, but they neither lower the contribution tier nor can be offset by
    // it.
    let contributionPoints = 0;
    let lastTransactionId: string | undefined;
    let lastCreatedAt = 0;

    const breakdown: ReputationBreakdown = {
      content: 0,
      social: 0,
      trust: 0,
      moderation: 0,
      physical: 0,
      penalties: 0,
    };

    for (const txn of transactions) {
      const isConduct = CONDUCT_ACTION_TYPES.has(txn.actionType);

      // Monetary aggregation over the not-voided set.
      total += txn.points;
      if (txn.points > 0) {
        positive += txn.points;
      } else if (txn.points < 0) {
        negative += txn.points;
        penalties += Math.abs(txn.points);
      }

      if (!isConduct) {
        nonConductTotal += txn.points;
        if (txn.points > 0) {
          contributionPoints += txn.points;
        }
      }

      // Category breakdown carries the signed sum per named category. The
      // `penalty` category folds into the dedicated `penalties` bucket below.
      switch (txn.category) {
        case 'content':
          breakdown.content += txn.points;
          break;
        case 'social':
          breakdown.social += txn.points;
          break;
        case 'trust':
          breakdown.trust += txn.points;
          break;
        case 'moderation':
          breakdown.moderation += txn.points;
          break;
        case 'physical':
          breakdown.physical += txn.points;
          break;
        case 'penalty':
        case 'other':
          break;
      }

      // Reliability is derived from ACTIVE transactions only — cancelled
      // (reversed) or disputed reports do not count toward report accuracy.
      //
      // Only CONFIRMED REPORT ABUSE feeds the abuse signal. It used to be every
      // negative transaction at double weight, which meant a penalty for
      // unrelated conduct drove a report-abuse verdict — and that verdict forces
      // the `restricted` tier. Conduct now lands on the conduct axis instead.
      if (txn.status === 'active') {
        if (REPORT_ABUSE_ACTION_TYPES.has(txn.actionType)) {
          reportAbuseCount += 1;
        }
        if (txn.sourceActionType === REPORT_CONFIRMED_ACTION) {
          accurateReports += 1;
        } else if (txn.sourceActionType === REPORT_REJECTED_ACTION) {
          rejectedReports += 1;
        }
      }

      const createdMs = txn.createdAt.getTime();
      if (createdMs >= lastCreatedAt) {
        lastCreatedAt = createdMs;
        lastTransactionId = txn.id;
      }
    }

    breakdown.penalties = penalties;

    const reliability = computeReliability({
      accurateReports,
      rejectedReports,
      reportAbuseCount,
    });

    const [user] = await handle
      .select({ verified: users.verified })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    const verified = user?.verified === true;

    const conduct = await this.deriveConductSnapshot(userId, handle);

    const trustTier = deriveTrustTier({
      total,
      nonConductTotal,
      verified,
      reliability,
      conductStanding: conduct.standing,
    });
    const influence = deriveInfluence(total, trustTier, reliability);

    // Sequential rather than `Promise.all`: a transaction handle is ONE
    // connection, and postgres.js pipelines concurrent statements on it in an
    // order the driver chooses. Reads that must see the same snapshot as the
    // write that follows them stay ordered.
    const personhood = await this.derivePersonhoodSnapshot(userId, handle);
    const reporting = await this.deriveReportingSnapshot(userId, handle);
    const reviewing = await this.deriveReviewingSnapshot(userId, handle);

    const contribution: ReputationContributionSnapshot = {
      points: contributionPoints,
      tier: deriveContributionTier(contributionPoints),
    };

    const contextualInfluence = deriveContextualInfluence({
      contributionPoints,
      conductStanding: conduct.standing,
      reportingReliability: reporting.reliability,
      reportingConfidence: reporting.confidence,
      reviewingReliability: reviewing.globalReliability,
    });

    const recalculatedAt = new Date();
    const columns = {
      total,
      positive,
      negative,
      breakdownContent: breakdown.content,
      breakdownSocial: breakdown.social,
      breakdownTrust: breakdown.trust,
      breakdownModeration: breakdown.moderation,
      breakdownPhysical: breakdown.physical,
      breakdownPenalties: breakdown.penalties,
      trustTier,
      influenceDefaultWeight: influence.defaultWeight,
      influenceReportWeight: influence.reportWeight,
      influenceModerationWeight: influence.moderationWeight,
      influenceRankingFeedbackWeight: influence.rankingFeedbackWeight,
      reliabilityAccurateReports: reliability.accurateReports,
      reliabilityRejectedReports: reliability.rejectedReports,
      reliabilityReportAccuracyScore: reliability.reportAccuracyScore,
      reliabilityAbuseScore: reliability.abuseScore,
      personhoodStatus: personhood.status,
      personhoodScore: personhood.score,
      contributionPoints: contribution.points,
      contributionTier: contribution.tier,
      conductStanding: conduct.standing,
      conductActiveRisk: conduct.activeRisk,
      conductActiveStrikes: conduct.activeStrikes,
      conductNextExpiryAt: conduct.nextExpiryAt ?? null,
      reportingReliability: reporting.reliability,
      reportingConfidence: reporting.confidence,
      reportingConfirmed: reporting.confirmed,
      reportingRejected: reporting.rejected,
      reportingMalicious: reporting.malicious,
      reviewingGlobalReliability: reviewing.globalReliability,
      contextualReportPriorityWeight: contextualInfluence.reportPriorityWeight,
      contextualReviewSelectionWeight: contextualInfluence.reviewSelectionWeight,
      contextualRankingWeight: contextualInfluence.rankingWeight,
      lastTransactionId: lastTransactionId ?? null,
      recalculatedAt,
    };

    const [balance] = await handle
      .insert(reputationBalances)
      .values({ userId, ...columns })
      .onConflictDoUpdate({
        target: reputationBalances.userId,
        set: { ...columns, updatedAt: new Date() },
      })
      .returning();

    // The two open-key-space reliability maps live in a child table rather than
    // a blob, so the snapshot is rewritten wholesale: a key the reviewer profile
    // no longer carries must disappear from the snapshot, which an upsert alone
    // would leave behind.
    await handle
      .delete(reputationReviewingReliability)
      .where(eq(reputationReviewingReliability.balanceId, balance.id));
    const reliabilityRows = [
      ...[...reviewing.categoryReliability].map(([key, value]) => ({
        balanceId: balance.id,
        scope: 'category' as const,
        key,
        reliability: value,
      })),
      ...[...reviewing.languageReliability].map(([key, value]) => ({
        balanceId: balance.id,
        scope: 'language' as const,
        key,
        reliability: value,
      })),
    ];
    if (reliabilityRows.length > 0) {
      await handle.insert(reputationReviewingReliability).values(reliabilityRows);
    }

    // Denormalize the ranking weight + tier onto the user so the recommendation
    // scorer can join the reputation signal cheaply at query time (a sort/floor
    // on user columns instead of a per-user lookup into reputation_balances).
    // Kept in the same recompute path/transaction as the balance write so the
    // two never diverge.
    await handle
      .update(users)
      .set({
        reputationRankWeight: influence.rankingFeedbackWeight,
        reputationTier: trustTier,
      })
      .where(eq(users.id, userId));
    userCache.invalidate(userId);

    return {
      userId,
      total: balance.total,
      positive: balance.positive,
      negative: balance.negative,
      breakdown,
      trustTier,
      influence,
      reliability,
      personhood,
      contribution,
      conduct,
      reporting,
      reviewing,
      contextualInfluence,
      lastTransactionId,
      recalculatedAt: balance.recalculatedAt,
      createdAt: balance.createdAt,
      updatedAt: balance.updatedAt,
    };
  }

  /**
   * The conduct snapshot: active risk, active strike count, and when the
   * earliest-expiring strike lapses.
   *
   * Read from `conduct_strikes` rather than from the ledger, because the ledger
   * cannot express "still under consequence". A reversed or expired strike stops
   * contributing immediately while its transaction stays in the ledger, which is
   * how traceability survives forgiveness. Critical strikes carry no `expiresAt`
   * and so never appear as a next expiry — they need a recovery review.
   */
  private async deriveConductSnapshot(
    userId: string,
    handle: ReputationDbHandle
  ): Promise<ReputationConductSnapshot> {
    const strikes = await handle
      .select({ riskPoints: conductStrikes.riskPoints, expiresAt: conductStrikes.expiresAt })
      .from(conductStrikes)
      .where(and(eq(conductStrikes.userId, userId), eq(conductStrikes.status, 'active')));

    let activeRisk = 0;
    let nextExpiryAt: Date | undefined;
    for (const strike of strikes) {
      activeRisk += strike.riskPoints;
      if (strike.expiresAt && (!nextExpiryAt || strike.expiresAt < nextExpiryAt)) {
        nextExpiryAt = strike.expiresAt;
      }
    }

    return {
      standing: deriveConductStanding(activeRisk),
      activeRisk,
      activeStrikes: strikes.length,
      nextExpiryAt,
    };
  }

  /**
   * The personhood snapshot, mirrored from the web-of-trust's own recomputable
   * status. Its own axis: being a real person proves neither conduct nor
   * competence, so it confers nothing on the others.
   */
  private async derivePersonhoodSnapshot(
    userId: string,
    handle: ReputationDbHandle
  ): Promise<ReputationPersonhoodSnapshot> {
    const [status] = await handle
      .select({ isRealPerson: personhoodStatuses.isRealPerson, score: personhoodStatuses.score })
      .from(personhoodStatuses)
      .where(eq(personhoodStatuses.userId, userId))
      .limit(1);
    if (!status) {
      return { status: 'unknown', score: 0 };
    }
    return {
      status: status.isRealPerson ? 'verified' : status.score > 0 ? 'probable' : 'unknown',
      score: status.score,
    };
  }

  /**
   * The reporting snapshot, from the reporter profile only.
   *
   * Absent profile means no reporting history, which is a NEUTRAL prior rather
   * than a zero — a person who has never filed a report is not an unreliable
   * reporter.
   */
  private async deriveReportingSnapshot(
    userId: string,
    handle: ReputationDbHandle
  ): Promise<ReputationReportingSnapshot> {
    const [profile] = await handle
      .select({
        confirmed: reporterReputationProfiles.confirmed,
        rejected: reporterReputationProfiles.rejected,
        malicious: reporterReputationProfiles.malicious,
      })
      .from(reporterReputationProfiles)
      .where(eq(reporterReputationProfiles.userId, userId))
      .limit(1);
    return computeReporting({
      confirmed: profile?.confirmed ?? 0,
      rejected: profile?.rejected ?? 0,
      malicious: profile?.malicious ?? 0,
    });
  }

  /**
   * The reviewing snapshot, from the reviewer profile only. Per category and
   * language, because competence in one category says little about another.
   */
  private async deriveReviewingSnapshot(
    userId: string,
    handle: ReputationDbHandle
  ): Promise<ReputationReviewingSnapshot> {
    const [profile] = await handle
      .select({
        globalReliability: reviewerReputationProfiles.globalReliability,
        categoryReliability: reviewerReputationProfiles.categoryReliability,
        languageReliability: reviewerReputationProfiles.languageReliability,
      })
      .from(reviewerReputationProfiles)
      .where(eq(reviewerReputationProfiles.userId, userId))
      .limit(1);
    if (!profile) {
      return {
        globalReliability: NEUTRAL_REVIEWER_RELIABILITY,
        categoryReliability: new Map<string, number>(),
        languageReliability: new Map<string, number>(),
      };
    }
    return {
      globalReliability: profile.globalReliability,
      categoryReliability: readReliabilityMap(profile.categoryReliability),
      languageReliability: readReliabilityMap(profile.languageReliability),
    };
  }

  /** Return the cached balance, recomputing it when absent. */
  async getBalance(userId: string): Promise<ReputationBalanceView> {
    const [existing] = await getDb()
      .select()
      .from(reputationBalances)
      .where(eq(reputationBalances.userId, userId))
      .limit(1);
    if (!existing) {
      return this.recalculateBalance(userId);
    }

    const reliabilityRows = await getDb()
      .select({
        scope: reputationReviewingReliability.scope,
        key: reputationReviewingReliability.key,
        reliability: reputationReviewingReliability.reliability,
      })
      .from(reputationReviewingReliability)
      .where(eq(reputationReviewingReliability.balanceId, existing.id));
    const categoryReliability = new Map<string, number>();
    const languageReliability = new Map<string, number>();
    for (const row of reliabilityRows) {
      const target = row.scope === 'category' ? categoryReliability : languageReliability;
      target.set(row.key, row.reliability);
    }

    return {
      userId: existing.userId,
      total: existing.total,
      positive: existing.positive,
      negative: existing.negative,
      breakdown: {
        content: existing.breakdownContent,
        social: existing.breakdownSocial,
        trust: existing.breakdownTrust,
        moderation: existing.breakdownModeration,
        physical: existing.breakdownPhysical,
        penalties: existing.breakdownPenalties,
      },
      trustTier: existing.trustTier,
      influence: {
        defaultWeight: existing.influenceDefaultWeight,
        reportWeight: existing.influenceReportWeight,
        moderationWeight: existing.influenceModerationWeight,
        rankingFeedbackWeight: existing.influenceRankingFeedbackWeight,
      },
      reliability: {
        accurateReports: existing.reliabilityAccurateReports,
        rejectedReports: existing.reliabilityRejectedReports,
        reportAccuracyScore: existing.reliabilityReportAccuracyScore,
        abuseScore: existing.reliabilityAbuseScore,
      },
      personhood: { status: existing.personhoodStatus, score: existing.personhoodScore },
      contribution: { points: existing.contributionPoints, tier: existing.contributionTier },
      conduct: {
        standing: existing.conductStanding,
        activeRisk: existing.conductActiveRisk,
        activeStrikes: existing.conductActiveStrikes,
        nextExpiryAt: existing.conductNextExpiryAt ?? undefined,
      },
      reporting: {
        reliability: existing.reportingReliability,
        confidence: existing.reportingConfidence,
        confirmed: existing.reportingConfirmed,
        rejected: existing.reportingRejected,
        malicious: existing.reportingMalicious,
      },
      reviewing: {
        globalReliability: existing.reviewingGlobalReliability,
        categoryReliability,
        languageReliability,
      },
      contextualInfluence: {
        reportPriorityWeight: existing.contextualReportPriorityWeight,
        reviewSelectionWeight: existing.contextualReviewSelectionWeight,
        rankingWeight: existing.contextualRankingWeight,
      },
      lastTransactionId: existing.lastTransactionId ?? undefined,
      recalculatedAt: existing.recalculatedAt,
      createdAt: existing.createdAt,
      updatedAt: existing.updatedAt,
    };
  }

  /**
   * Return the capped influence weight(s) for a user. `context` selects a single
   * axis; the full block is always recomputed when no snapshot exists yet.
   */
  async getInfluence(
    userId: string,
    context: ReputationInfluenceContext
  ): Promise<{ context: ReputationInfluenceContext; weight: number; influence: ReputationInfluence }> {
    const balance = await this.getBalance(userId);
    const { influence } = balance;
    const weight =
      context === 'report'
        ? influence.reportWeight
        : context === 'moderation'
          ? influence.moderationWeight
          : context === 'ranking'
            ? influence.rankingFeedbackWeight
            : influence.defaultWeight;
    return { context, weight, influence };
  }

  /**
   * Open a dispute against a transaction and mark the transaction `disputed`.
   * The disputing user must own the transaction (be its subject).
   */
  async createDispute(
    transactionId: string,
    userId: string,
    reason: string,
    evidence?: string[]
  ): Promise<ReputationDisputeRow> {
    const [txn] = await getDb()
      .select({
        id: reputationTransactions.id,
        userId: reputationTransactions.userId,
        status: reputationTransactions.status,
      })
      .from(reputationTransactions)
      .where(eq(reputationTransactions.id, transactionId))
      .limit(1);
    if (!txn) {
      throw new NotFoundError('Transaction not found');
    }
    if (txn.userId !== userId) {
      throw new BadRequestError('You can only dispute your own transactions');
    }
    if (txn.status === 'reversed' || txn.status === 'voided') {
      throw new ConflictError('This transaction can no longer be disputed');
    }

    return getDb().transaction(async (tx) => {
      const [dispute] = await tx
        .insert(reputationDisputes)
        .values({
          transactionId: txn.id,
          userId,
          reason,
          evidence,
          status: 'open',
        })
        .returning();

      await tx
        .update(reputationTransactions)
        .set({ status: 'disputed' })
        .where(eq(reputationTransactions.id, txn.id));

      return dispute;
    });
  }

  /**
   * Resolve a dispute. Accepting reverses the disputed transaction; rejecting
   * restores it to `active`. Sets resolution metadata on the dispute.
   */
  async resolveDispute(
    disputeId: string,
    params: { status: 'accepted' | 'rejected'; resolvedByUserId: string }
  ): Promise<ReputationDisputeRow> {
    const [dispute] = await getDb()
      .select()
      .from(reputationDisputes)
      .where(eq(reputationDisputes.id, disputeId))
      .limit(1);
    if (!dispute) {
      throw new NotFoundError('Dispute not found');
    }
    if (dispute.status === 'accepted' || dispute.status === 'rejected') {
      throw new ConflictError('Dispute is already resolved');
    }

    if (params.status === 'accepted') {
      await this.reverseTransaction(dispute.transactionId, {
        reviewedByUserId: params.resolvedByUserId,
        reason: `Dispute ${dispute.id} accepted`,
      });
    } else {
      // Only a still-`disputed` transaction returns to `active`: the predicate is
      // part of the UPDATE rather than a read-then-write, so a concurrent
      // reversal cannot be undone by a rejection that read a stale status.
      await getDb()
        .update(reputationTransactions)
        .set({
          status: 'active',
          reviewedByUserId: params.resolvedByUserId,
          reviewedAt: new Date(),
        })
        .where(
          and(
            eq(reputationTransactions.id, dispute.transactionId),
            eq(reputationTransactions.status, 'disputed')
          )
        );
    }

    const [resolved] = await getDb()
      .update(reputationDisputes)
      .set({
        status: params.status,
        resolvedByUserId: params.resolvedByUserId,
        resolvedAt: new Date(),
      })
      .where(eq(reputationDisputes.id, dispute.id))
      .returning();

    return resolved;
  }

  /** Leaderboard ordered by lifetime total descending. */
  async getLeaderboard(
    limit: number,
    offset: number
  ): Promise<{ items: ReputationLeaderboardRow[]; total: number }> {
    // Archived accounts and restricted tiers are excluded from the public board.
    // Both columns are `NOT NULL` with a default, so `<>` needs no NULL arm —
    // unlike Mongo's `$ne`, which also matched a missing field.
    const eligible = and(
      ne(users.accountStatus, 'archived'),
      ne(users.reputationTier, 'restricted')
    );

    const rows = await getDb()
      .select({
        total: reputationBalances.total,
        trustTier: reputationBalances.trustTier,
        userId: users.id,
        username: users.username,
        nameFirst: users.nameFirst,
        nameLast: users.nameLast,
        avatar: users.avatar,
        publicKey: users.publicKey,
      })
      .from(reputationBalances)
      .innerJoin(users, eq(users.id, reputationBalances.userId))
      .where(eligible)
      .orderBy(desc(reputationBalances.total))
      .offset(offset)
      .limit(limit);

    const [totals] = await getDb()
      .select({ total: count() })
      .from(reputationBalances)
      .innerJoin(users, eq(users.id, reputationBalances.userId))
      .where(eligible);

    return {
      items: rows.map((row) => ({
        total: row.total,
        trustTier: row.trustTier,
        user: {
          id: row.userId,
          username: row.username,
          nameFirst: row.nameFirst,
          nameLast: row.nameLast,
          avatar: row.avatar,
          publicKey: row.publicKey,
        },
      })),
      total: totals?.total ?? 0,
    };
  }

  /** Paginated ledger for a user, newest first. */
  async listTransactions(
    userId: string,
    limit: number,
    offset: number
  ): Promise<{ items: ReputationTransactionRow[]; total: number }> {
    const items = await getDb()
      .select()
      .from(reputationTransactions)
      .where(eq(reputationTransactions.userId, userId))
      .orderBy(desc(reputationTransactions.createdAt))
      .offset(offset)
      .limit(limit);
    const [totals] = await getDb()
      .select({ total: count() })
      .from(reputationTransactions)
      .where(eq(reputationTransactions.userId, userId));
    return { items, total: totals?.total ?? 0 };
  }

  /** Disputes raised by a single user. */
  async listDisputesForUser(
    userId: string,
    limit: number,
    offset: number
  ): Promise<{ items: ReputationDisputeRow[]; total: number }> {
    const items = await getDb()
      .select()
      .from(reputationDisputes)
      .where(eq(reputationDisputes.userId, userId))
      .orderBy(desc(reputationDisputes.createdAt))
      .offset(offset)
      .limit(limit);
    const [totals] = await getDb()
      .select({ total: count() })
      .from(reputationDisputes)
      .where(eq(reputationDisputes.userId, userId));
    return { items, total: totals?.total ?? 0 };
  }

  /** Open disputes across all users (staff queue). */
  async listOpenDisputes(
    limit: number,
    offset: number
  ): Promise<{ items: ReputationDisputeRow[]; total: number }> {
    const open = inArray(reputationDisputes.status, ['open', 'needs_review']);
    const items = await getDb()
      .select()
      .from(reputationDisputes)
      .where(open)
      .orderBy(asc(reputationDisputes.createdAt))
      .offset(offset)
      .limit(limit);
    const [totals] = await getDb()
      .select({ total: count() })
      .from(reputationDisputes)
      .where(open);
    return { items, total: totals?.total ?? 0 };
  }

  /** Enabled rules (for client display). */
  async listEnabledRules(): Promise<ReputationRuleRow[]> {
    return getDb()
      .select()
      .from(reputationRules)
      .where(eq(reputationRules.isEnabled, true))
      .orderBy(asc(reputationRules.category), asc(reputationRules.actionType));
  }

  /**
   * Idempotently seed the platform-default reputation rules that the code awards
   * directly (not migrated from legacy karma). Currently the cross-app
   * `endorsement_received` rule. Safe to call repeatedly — it upserts by
   * `actionType` and performs no write when the rule is already up to date.
   */
  async seedDefaultRules(): Promise<void> {
    await this.upsertRule({
      actionType: ENDORSEMENT_RECEIVED_ACTION,
      points: ENDORSEMENT_RECEIVED_POINTS,
      category: 'social',
      description: 'Endorsed by another user in a connected app',
      cooldownInMinutes: 0,
      isEnabled: true,
    });

    // Civic / Commons rules (Fase 1) — crypto-owned reputation.
    await this.upsertRule({
      actionType: REAL_LIFE_ATTESTED_ACTION,
      points: REAL_LIFE_ATTESTED_POINTS,
      category: 'physical',
      description: 'A real-world interaction a counterparty cryptographically attested',
      cooldownInMinutes: 0,
      isEnabled: true,
    });
    await this.upsertRule({
      actionType: PEER_VALIDATED_ACTION,
      points: PEER_VALIDATED_POINTS,
      category: 'trust',
      description: 'Validated by a randomly-selected jury of peers',
      cooldownInMinutes: 0,
      isEnabled: true,
    });
    await this.upsertRule({
      actionType: VALIDATION_CORRECT_ACTION,
      points: VALIDATION_CORRECT_POINTS,
      category: 'trust',
      description: 'Voted with the resolving majority on a peer validation',
      cooldownInMinutes: 0,
      isEnabled: true,
    });
    await this.upsertRule({
      actionType: VALIDATION_INCORRECT_ACTION,
      points: VALIDATION_INCORRECT_POINTS,
      category: 'penalty',
      description: 'Endorsed a verdict later reverted as fraud',
      cooldownInMinutes: 0,
      isEnabled: true,
    });
    await this.upsertRule({
      actionType: PERSONHOOD_VOUCHED_ACTION,
      points: PERSONHOOD_VOUCHED_POINTS,
      category: 'trust',
      description: 'Vouched for as a real person by a staking voucher',
      cooldownInMinutes: 0,
      isEnabled: true,
    });
    await this.upsertRule({
      actionType: VOUCH_SLASHED_ACTION,
      points: VOUCH_SLASHED_POINTS,
      category: 'penalty',
      description: 'Vouched for a person found to be fake (staking slash)',
      cooldownInMinutes: 0,
      isEnabled: true,
    });

    // Homiio RE lifecycle — awarded by the Homiio service credential (`reputation:write`).
    await this.upsertRule({
      actionType: LEASE_SIGNED_ACTION,
      points: LEASE_SIGNED_POINTS,
      category: 'trust',
      description: 'Lease fully signed by landlord and tenant (Homiio)',
      cooldownInMinutes: 0,
      isEnabled: true,
    });
    await this.upsertRule({
      actionType: LEASE_COMPLETED_ACTION,
      points: LEASE_COMPLETED_POINTS,
      category: 'trust',
      description: 'Lease completed without early termination (Homiio)',
      cooldownInMinutes: 0,
      isEnabled: true,
    });
    await this.upsertRule({
      actionType: CLEAN_MOVEOUT_ACTION,
      points: CLEAN_MOVEOUT_POINTS,
      category: 'trust',
      description: 'Clean move-out with no damage or outstanding obligations (Homiio)',
      cooldownInMinutes: 0,
      isEnabled: true,
    });
    await this.upsertRule({
      actionType: LEASE_DEFAULT_ACTION,
      points: LEASE_DEFAULT_POINTS,
      category: 'penalty',
      description: 'Lease ended in default — unpaid rent, abandonment, or breach (Homiio)',
      cooldownInMinutes: 0,
      isEnabled: true,
    });
  }

  /** Create or update a rule keyed by `actionType`. */
  async upsertRule(input: UpsertRuleInput): Promise<ReputationRuleRow> {
    // `trim` was Mongoose APPLICATION behaviour on this column; re-applied here,
    // at the one write path, so the stored key matches what `award` looks up.
    const actionType = String(input.actionType).trim();

    // And a conduct rule must not exist at all. Its points would be a second,
    // mutable authority for a figure the versioned conduct policy owns, and
    // creating one is the single step that would make a conduct action awardable
    // outside the bridge.
    if (CONDUCT_ACTION_TYPES.has(actionType)) {
      throw new BadRequestError(
        'Conduct action types are governed by the versioned Oxy conduct policy, not by a reputation rule'
      );
    }

    const values = {
      points: input.points,
      category: input.category,
      description: input.description,
      cooldownInMinutes: input.cooldownInMinutes ?? 0,
      isEnabled: input.isEnabled ?? true,
    };
    const [rule] = await getDb()
      .insert(reputationRules)
      .values({ actionType, ...values })
      .onConflictDoUpdate({
        target: reputationRules.actionType,
        set: { ...values, updatedAt: new Date() },
      })
      .returning();
    return rule;
  }
}

export const reputationService = new ReputationService();
export default reputationService;
