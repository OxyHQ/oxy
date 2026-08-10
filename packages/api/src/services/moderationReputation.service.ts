/**
 * The reputation bridge — the ONLY path by which a moderation decision becomes a
 * reputation consequence.
 *
 * THE DIRECTION IS ONE-WAY AND IS THE POINT. A moderation service never writes
 * reputation. It emits an authenticated event describing a decision it
 * published; this module validates that event and DERIVES the effect from the
 * policy version the decision names. The emitter states no points, no risk, no
 * duration and no standing. If it could, the reputation ledger would be an API
 * an application writes to, and every guarantee below would be advisory.
 *
 * FOUR OPERATIONS (§11.5), each doing distinct work:
 *  - {@link applyModerationDecision}     validate, derive, write — or record a skip.
 *  - {@link finalizeModerationDecision}  confirm the consequence landed and the
 *    snapshot reflects it. This is what a lost queue job is re-derived through.
 *  - {@link reverseModerationDecision}   an appeal succeeded: compensate the
 *    points and remove the active risk.
 *  - {@link reconcileModerationIncident} audit an incident end to end and repair
 *    a partially-applied consequence.
 *
 * WHAT MAKES "ONE PENALTY PER INCIDENT" TRUE
 *
 * Three independent guards, not one:
 *  1. `ModerationEffect` unique `(incidentId, principalId, effectType,
 *     decisionRevision)` — the semantic key. A hundred reports collapse to one
 *     incident and therefore one effect, whatever the transport did.
 *  2. `ModerationEffect` unique `eventId` — the transport key. A redelivery is
 *     answered from the stored effect.
 *  3. The ledger's existing unique `(applicationId, sourceActionId)`, with
 *     `sourceActionId` set to the idempotency key. Reused deliberately rather
 *     than reinvented: a second mechanism would be a second thing to get wrong,
 *     and this one already backs every other idempotent award.
 *
 * A pre-check makes the common retry cheap; the indexes make it CORRECT under
 * concurrency, which a pre-check alone never can.
 *
 * WHAT MAKES A CONSEQUENCE EXPLAINABLE AND REVERSIBLE
 *
 * Every effect stores the multipliers that produced it and all three policy
 * versions, so it can be recomputed under the policy it was decided under rather
 * than under today's tuning. Reversal is a COMPENSATING ledger entry — the
 * original transaction is never edited or deleted — plus a strike marked
 * `reversed`, so the history survives while the net balance and the active risk
 * are corrected.
 */

import { and, asc, eq, gte, inArray, lte, ne } from 'drizzle-orm';
import type {
  ModerationDecisionEvent,
  ModerationEffectSkipReason,
  ModerationEffectType,
  ModerationFinding,
  ModerationSeverity,
} from '@oxyhq/contracts';

import { getDb } from '../config/postgres';
import { isUniqueViolation } from '../db/pgErrors';
import { applicationModerationTrust } from '../db/schema/applicationModerationTrust';
import { conductStrikes } from '../db/schema/conductStrikes';
import { moderationEffects } from '../db/schema/moderationEffects';
import { moderationPolicies } from '../db/schema/moderationPolicies';
import { moderationPolicySeverityRules } from '../db/schema/moderationPolicySeverityRules';
import { moderationPolicyStandingThresholds } from '../db/schema/moderationPolicyStandingThresholds';
import { reputationTransactions } from '../db/schema/reputationTransactions';
import reputationService, { type ReputationTransactionHandle } from './reputation.service';
import { attestModerationEffect } from './civic/attestation.service';
import { resolveBindingProof } from './identityBinding.service';
import {
  MODERATION_CONDUCT_SOURCE_ACTION_TYPE,
  MODERATION_LEDGER_CATEGORY,
  MODERATION_VIOLATION_ACTIONS,
  REPORT_ABUSE_CONFIRMED_ACTION,
  REVIEW_ABUSE_CONFIRMED_ACTION,
} from '../utils/moderation.constants';
import { BadRequestError, NotFoundError } from '../utils/error';
import { logger } from '../utils/logger';
import { resolveUserIdToObjectId } from '../utils/validation';

/** A stored conduct strike. */
export type ConductStrikeRow = typeof conductStrikes.$inferSelect;
/** A stored moderation effect. */
export type ModerationEffectRow = typeof moderationEffects.$inferSelect;
/** One severity band's figures within a policy version. */
export type ModerationSeverityRule = typeof moderationPolicySeverityRules.$inferSelect;
/** One standing threshold within a policy version. */
export type ConductStandingThreshold = typeof moderationPolicyStandingThresholds.$inferSelect;

/**
 * A published policy version with its two child tables loaded.
 *
 * The Mongo document embedded `severityRules[]` and `standingThresholds[]`; both
 * are real tables now, so a reader that needs the whole version asks for this
 * rather than re-joining at each call site. A version is IMMUTABLE once
 * published, so loading it whole is a read of frozen data.
 */
export interface ModerationPolicyView {
  id: string;
  policyVersion: string;
  conductFamilies: string[];
  repetitionMultipliers: number[];
  repetitionWindowDays: number;
  multiFindingSecondaryShare: number;
  multiFindingCap: number;
  provisionalEffectsAllowed: boolean;
  severityRules: ModerationSeverityRule[];
  standingThresholds: ConductStandingThreshold[];
}

/**
 * The seed shape of one severity band — the figures without the surrogate id and
 * `policy_id` the child row gets on insert.
 */
export type SeedSeverityRule = Omit<ModerationSeverityRule, 'id' | 'policyId'>;

/** The seed shape of one standing threshold. */
export type SeedStandingThreshold = Omit<ConductStandingThreshold, 'id' | 'policyId'>;

/** The two unique indexes that make "one penalty per incident" true. */
const EFFECT_SEMANTIC_UNIQUE = 'moderation_effects_incident_principal_type_revision_key';
const EFFECT_EVENT_UNIQUE = 'moderation_effects_event_id_key';

/** Load a policy version with its severity rules and standing thresholds. */
async function loadPolicy(policyVersion: string): Promise<ModerationPolicyView | null> {
  const [policy] = await getDb()
    .select()
    .from(moderationPolicies)
    .where(eq(moderationPolicies.policyVersion, policyVersion))
    .limit(1);
  if (!policy) {
    return null;
  }
  const [severityRules, standingThresholds] = await Promise.all([
    getDb()
      .select()
      .from(moderationPolicySeverityRules)
      .where(eq(moderationPolicySeverityRules.policyId, policy.id)),
    getDb()
      .select()
      .from(moderationPolicyStandingThresholds)
      .where(eq(moderationPolicyStandingThresholds.policyId, policy.id))
      .orderBy(asc(moderationPolicyStandingThresholds.minRisk)),
  ]);
  return {
    id: policy.id,
    policyVersion: policy.policyVersion,
    conductFamilies: policy.conductFamilies,
    repetitionMultipliers: policy.repetitionMultipliers,
    repetitionWindowDays: policy.repetitionWindowDays,
    multiFindingSecondaryShare: policy.multiFindingSecondaryShare,
    multiFindingCap: policy.multiFindingCap,
    provisionalEffectsAllowed: policy.provisionalEffectsAllowed,
    severityRules,
    standingThresholds,
  };
}

/** Identity of the service credential the event arrived on. */
export interface ModerationEventContext {
  /** The emitting application (the moderation service), from its credential. */
  emitterApplicationId: string;
  /** The credential itself, recorded for audit. */
  emitterCredentialId?: string;
}

/** Outcome of {@link applyModerationDecision}. */
export interface ApplyResult {
  applied: boolean;
  effect?: ModerationEffectRow;
  skipReason?: ModerationEffectSkipReason;
  idempotent: boolean;
}

/** Outcome of {@link reverseModerationDecision}. */
export interface ReverseResult {
  reversed: ModerationEffectRow[];
  idempotent: boolean;
}

/** Outcome of {@link reconcileModerationIncident}. */
export interface ReconcileResult {
  incidentId: string;
  effectsExamined: number;
  /** Effects whose strike was missing or inconsistent and has been repaired. */
  strikesRepaired: number;
  /** Effects superseded by a later revision and now reversed. */
  supersededReversed: number;
  /** Subjects whose balance snapshot was recomputed. */
  balancesRecalculated: number;
}

/**
 * Severity ordering, used only to pick the PRIMARY finding. Kept here rather
 * than in the policy document because it is the definition of the words, not a
 * tunable: `critical` outranking `high` is not a policy choice.
 */
const SEVERITY_RANK: Readonly<Record<ModerationSeverity, number>> = {
  low: 1,
  medium: 2,
  high: 3,
  critical: 4,
};

/**
 * Finding scopes that can reach the global ledger.
 *
 * `application_local` is excluded by design: the application enforces it itself
 * and Oxy Trust is not touched. That is not a limitation, it is the boundary
 * between "this community's rules" and "conduct against the network".
 */
const GLOBAL_FINDING_SCOPES: ReadonlySet<string> = new Set([
  'oxy_network',
  'identity_integrity',
]);

/**
 * Decision statuses that may produce an effect at all.
 *
 * `inconclusive` is its own outcome and produces nothing — it is neither guilt
 * nor innocence, and collapsing it into either would be the single most damaging
 * shortcut available here. `superseded` and `corrected` describe a revision a
 * later one replaced, so applying one would resurrect a consequence an appeal
 * removed.
 */
const EFFECTIVE_DECISION_STATUSES: ReadonlySet<string> = new Set(['final', 'provisional']);

/** Map a finding's attribution onto the axis its consequence lands on. */
function effectTypeForAttribution(finding: ModerationFinding): ModerationEffectType {
  switch (finding.attribution) {
    case 'reporter':
      return 'report_abuse_penalty';
    case 'reviewer':
      return 'review_abuse_penalty';
    case 'author':
    case 'sharer':
      return 'conduct_penalty';
  }
}

/** Ledger action key for an effect type and severity. */
function actionTypeFor(
  effectType: ModerationEffectType,
  severity: ModerationSeverity
): string {
  switch (effectType) {
    case 'report_abuse_penalty':
      return REPORT_ABUSE_CONFIRMED_ACTION;
    case 'review_abuse_penalty':
      return REVIEW_ABUSE_CONFIRMED_ACTION;
    case 'conduct_penalty':
      return MODERATION_VIOLATION_ACTIONS[severity];
  }
}

/**
 * The idempotency key for one consequence.
 *
 * Carries the incident, the revision, the SUBJECT and the AXIS. Dropping the
 * subject would collide when one incident finds both an author and a resharer in
 * violation; dropping the axis would collide when one person is both the author
 * and a colluding reviewer. Both are rare and both are real, and a collision
 * here does not error — it silently swallows the second legitimate consequence.
 */
export function buildIdempotencyKey(
  incidentId: string,
  decisionRevision: number,
  principalId: string,
  effectType: ModerationEffectType
): string {
  return `moderation:${incidentId}:${decisionRevision}:${principalId}:${effectType}`;
}

/** Round toward the nearest integer, keeping the sign of a penalty. */
function scale(base: number, multiplier: number): number {
  return Math.round(base * multiplier);
}

/**
 * The identifiers of a decision event, coerced to primitives.
 *
 * WHY THIS EXISTS RATHER THAN TRUSTING THE CALLER: every method on this service
 * is exported, and a queue worker, a reconciliation script or a future caller is
 * under no obligation to have passed a body through the route's schema. A Mongo
 * filter handed `{ $ne: null }` where it expects an id matches EVERY document —
 * for `findOne({ eventId })` that turns the transport idempotency check into
 * "some effect exists", and for a reversal it would reverse an unrelated one. So
 * the coercion lives where the query lives, not three layers up.
 *
 * The route's schema already rejects an object, which makes this defence in
 * depth rather than the only guard. Both are wanted: the schema gives a clean
 * 400 at the edge, this makes the service correct however it is reached.
 */
interface EventIdentifiers {
  eventId: string;
  incidentId: string;
  caseId: string;
  decisionId: string;
  decisionRevision: number;
  oxyConductVersion: string;
  principalId: string;
  bindingProofId: string;
  reportedApplicationId: string;
  occurredAt: Date;
  proofHash: string;
}

/**
 * Coerce a decision revision to a positive integer, or reject it.
 *
 * A silent `NaN` would be worse than an error: it matches no document, so a
 * reversal would report "no effect exists for that revision" and an operator
 * would go looking for a missing effect rather than a malformed request.
 */
function toDecisionRevision(value: unknown): number {
  const revision = Number(value);
  if (!Number.isInteger(revision) || revision < 1) {
    throw new BadRequestError('decisionRevision must be a positive integer');
  }
  return revision;
}

/** Coerce every identifier of an event that reaches a query or a write. */
function readEventIdentifiers(event: ModerationDecisionEvent): EventIdentifiers {
  const occurredAt = new Date(String(event.occurredAt));
  if (Number.isNaN(occurredAt.getTime())) {
    throw new BadRequestError('occurredAt must be a valid ISO 8601 timestamp');
  }
  return {
    eventId: String(event.eventId),
    incidentId: String(event.incidentId),
    caseId: String(event.caseId),
    decisionId: String(event.decisionId),
    decisionRevision: toDecisionRevision(event.decisionRevision),
    oxyConductVersion: String(event.policyVersions.oxyConduct),
    principalId: String(event.subject.principalId),
    bindingProofId: String(event.subject.bindingProofId),
    reportedApplicationId: String(event.reportedApplicationId),
    occurredAt,
    proofHash: String(event.proofHash),
  };
}

class ModerationReputationService {
  /**
   * Validate a decision event and derive its consequence.
   *
   * THE EIGHT PRE-EFFECT CHECKS, in the order they run and with the reason each
   * runs where it does:
   *
   *  1. EMITTER AUTHORITY — the caller holds `reputation:moderation:apply`.
   *     Enforced at the route, before this method is entered, because an
   *     unauthorized caller must not reach the derivation logic at all. What is
   *     re-checked here is only that the context carries a credential identity.
   *  2. NOT ALREADY PROCESSED — the `eventId` and the semantic key are both
   *     looked up, then enforced by unique indexes at write time.
   *  3. DECISION IS EFFECTIVE — `final`, or `provisional` when the resolved
   *     policy version permits provisional effects.
   *  4. BINDING PROOF — the binding resolves to the claimed principal, is
   *     active, belongs to the reported application, and was verified at or
   *     before the reported action.
   *  5. FINDING SCOPE — at least one finding reaches `oxy_network` or
   *     `identity_integrity`.
   *  6. POLICY RECOGNISES IT — the conduct family and the severity both exist in
   *     the named policy version. An unrecognised family produces nothing rather
   *     than a guess.
   *  7. INCIDENT NOT ALREADY PENALISED — one effect per incident, principal,
   *     axis and revision.
   *  8. NOT SUPERSEDED — a revision a later one replaced produces nothing.
   *
   * Checks 3, 5, 6 and the application gate return a SKIP rather than throwing:
   * they are legitimate outcomes of a well-formed event, and the emitter needs to
   * record "delivered, no effect" and stop retrying. Malformed input and missing
   * authority throw.
   */
  async applyModerationDecision(
    event: ModerationDecisionEvent,
    context: ModerationEventContext
  ): Promise<ApplyResult> {
    // (1) The emitter's authority is established by the route's scope check. A
    // context with no credential identity means the route was bypassed, which is
    // a programming error rather than a client one.
    if (!context.emitterApplicationId) {
      throw new BadRequestError('Moderation events require an emitting service credential');
    }

    // Every identifier this method queries or writes with is coerced ONCE, here.
    // See `readEventIdentifiers` for why the coercion belongs at the service
    // boundary rather than being trusted from the route's schema.
    const ids = readEventIdentifiers(event);

    // (2a) Transport-level replay: answer from the stored effect.
    const alreadySeen = await this.findEffectByEventId(ids.eventId);
    if (alreadySeen) {
      return { applied: true, effect: alreadySeen, idempotent: true };
    }

    // (8) A superseded or corrected revision must not be applied: a later
    // revision already replaced it, and applying this one would resurrect a
    // consequence an appeal removed.
    if (event.decisionStatus === 'superseded' || event.decisionStatus === 'corrected') {
      return { applied: false, skipReason: 'decision_superseded', idempotent: false };
    }

    // (3a) `inconclusive` is its own outcome. No effect, and never read as
    // "no violation".
    if (!EFFECTIVE_DECISION_STATUSES.has(event.decisionStatus)) {
      return { applied: false, skipReason: 'decision_not_effective', idempotent: false };
    }

    // (6a) The named policy version must exist. Falling back to the current one
    // would apply today's tuning to a decision made under another, which is
    // precisely what versioning exists to prevent.
    const policy = await loadPolicy(ids.oxyConductVersion);
    if (!policy) {
      throw new BadRequestError(
        `Unknown Oxy conduct policy version: ${ids.oxyConductVersion}`
      );
    }

    // (3b) A provisional decision produces an effect only where the policy says
    // so. The baseline policy says no.
    if (event.decisionStatus === 'provisional' && !policy.provisionalEffectsAllowed) {
      return { applied: false, skipReason: 'decision_not_effective', idempotent: false };
    }

    // The reported application must itself be permitted to produce global
    // effects. An absent trust document is treated as `sandbox`: a newly
    // integrated application moderates locally and touches nothing global, so
    // forgetting to configure one fails safe.
    const reportedApplicationId = ids.reportedApplicationId;
    const [trust] = await getDb()
      .select({
        globalReputationEffectsAllowed:
          applicationModerationTrust.globalReputationEffectsAllowed,
      })
      .from(applicationModerationTrust)
      .where(eq(applicationModerationTrust.applicationId, reportedApplicationId))
      .limit(1);
    if (!trust?.globalReputationEffectsAllowed) {
      return { applied: false, skipReason: 'application_not_permitted', idempotent: false };
    }

    const principalObjectId = await resolveUserIdToObjectId(ids.principalId);

    // (4) THE binding check. Without it, this whole module would be an API for
    // penalising an arbitrary user id.
    const binding = await resolveBindingProof({
      applicationId: ids.reportedApplicationId,
      bindingProofId: ids.bindingProofId,
      principalId: principalObjectId,
      occurredAt: ids.occurredAt,
    });
    if (!binding.ok) {
      return { applied: false, skipReason: binding.reason, idempotent: false };
    }

    // (5) + (6b) Keep only the findings that reach the network AND that this
    // policy version recognises.
    const eligible = this.selectEffectiveFindings(event.findings, policy);
    if (!eligible.ok) {
      return { applied: false, skipReason: eligible.reason, idempotent: false };
    }
    const { primary, rule, effectiveCount } = eligible;

    const effectType = effectTypeForAttribution(primary);
    const idempotencyKey = buildIdempotencyKey(
      ids.incidentId,
      ids.decisionRevision,
      principalObjectId,
      effectType
    );

    // (7) One effect per incident, principal, axis and revision. The pre-check
    // makes the common retry cheap; the unique index is what makes it correct
    // under concurrency.
    const existing = await this.findEffectBySemanticKey({
      incidentId: ids.incidentId,
      principalId: principalObjectId,
      effectType,
      decisionRevision: ids.decisionRevision,
    });
    if (existing) {
      return { applied: true, effect: existing, idempotent: true };
    }

    const repetitionMultiplier = await this.resolveRepetitionMultiplier(
      principalObjectId,
      primary.family,
      ids.incidentId,
      policy
    );
    const multiFindingMultiplier = Math.min(
      1 + policy.multiFindingSecondaryShare * (effectiveCount - 1),
      policy.multiFindingCap
    );
    const combined = repetitionMultiplier * multiFindingMultiplier;

    const points = scale(rule.points, combined);
    const activeRisk = scale(rule.riskPoints, combined);

    try {
      const effect = await this.writeEffect({
        event,
        ids,
        context,
        policy,
        primary,
        effectType,
        points,
        activeRisk,
        repetitionMultiplier,
        multiFindingMultiplier,
        idempotencyKey,
        principalObjectId,
        reportedApplicationId,
        bindingId: binding.binding.id,
        riskExpiryDays: rule.riskExpiryDays,
      });
      return { applied: true, effect, idempotent: false };
    } catch (error) {
      // A concurrent delivery won the race. Both unique indexes surface as
      // E11000; either way the winner is the answer, not an error.
      const duplicate = await this.findDuplicateWinner(error, {
        eventId: ids.eventId,
        incidentId: ids.incidentId,
        principalId: principalObjectId,
        effectType,
        decisionRevision: ids.decisionRevision,
      });
      if (duplicate) {
        return { applied: true, effect: duplicate, idempotent: true };
      }
      throw error;
    }
  }

  /**
   * Confirm that a decision revision's consequence exists and that the subject's
   * snapshot reflects it.
   *
   * This is the operation a lost dispatch is recovered through: the effect and
   * its strike are the durable record, so re-deriving the snapshot from them is
   * always safe and never double-counts. It creates nothing — an effect that was
   * never applied cannot be conjured from a decision id alone, and pretending
   * otherwise would invent a consequence.
   */
  async finalizeModerationDecision(
    decisionId: string,
    decisionRevision: number
  ): Promise<ModerationEffectRow[]> {
    // Coerced for the same reason `readEventIdentifiers` exists: this method is
    // exported, and a filter handed an operator object here would report on
    // effects belonging to other decisions entirely.
    const effects = await this.findEffectsByDecision(decisionId, decisionRevision);
    if (effects.length === 0) {
      throw new NotFoundError('No moderation effect exists for that decision revision');
    }

    const subjects = new Set(effects.map((effect) => effect.principalId));
    for (const subject of subjects) {
      await reputationService.recalculateBalance(subject);
    }
    return effects;
  }

  /**
   * An appeal overturned a decision revision: compensate the points and remove
   * the active risk.
   *
   * The ledger is append-only, so the correction is a COMPENSATING entry — the
   * original transaction keeps its points and is marked `reversed`, and the pair
   * nets to zero. Nothing is edited and nothing disappears; what changes is the
   * net balance and the active risk.
   *
   * ORDER MATTERS. The strike is marked `reversed` BEFORE the compensating entry
   * is appended, because `reverseTransaction` recomputes the balance and must see
   * the risk already gone. If the process dies between the two writes, the
   * person is out from under the consequence with their points not yet
   * compensated — the recoverable direction. The opposite order would leave
   * someone whose appeal SUCCEEDED still carrying active risk, which is the
   * failure this operation exists to prevent. Every step is idempotent, so a
   * retry completes the rest.
   *
   * The credential is part of the lookup key: decision ids are chosen by the
   * emitter and are neither globally unique nor authority-bearing.
   */
  async reverseModerationDecision(
    decisionId: string,
    decisionRevision: number,
    reason: string,
    emitterCredentialId: string
  ): Promise<ReverseResult> {
    // Coerced before it reaches the filter: reversing on an operator object
    // would compensate an unrelated decision's consequence, which is the worst
    // failure available on this path.
    const effects = await this.findEffectsByDecisionForCredential(
      decisionId,
      decisionRevision,
      emitterCredentialId
    );
    if (effects.length === 0) {
      throw new NotFoundError('No moderation effect exists for that decision revision');
    }

    const pending = effects.filter((effect) => effect.status === 'applied');
    if (pending.length === 0) {
      return { reversed: effects, idempotent: true };
    }

    const reversedEffects: ModerationEffectRow[] = [];
    for (const effect of pending) {
      if (effect.strikeId) {
        // `status` and `resolved_at` move in ONE statement: the table's
        // `conduct_strikes_resolution_complete_check` requires them to agree, so
        // "not active but never resolved" is now unrepresentable rather than a
        // state every reader had to guard for.
        await getDb()
          .update(conductStrikes)
          .set({ status: 'reversed', resolvedAt: new Date() })
          .where(and(eq(conductStrikes.id, effect.strikeId), eq(conductStrikes.status, 'active')));
      }

      const { reversal } = await reputationService.reverseTransaction(
        effect.transactionId,
        { reason: `Moderation decision reversed: ${reason}` }
      );

      const [updated] = await getDb()
        .update(moderationEffects)
        .set({
          status: 'reversed',
          reversalTransactionId: reversal.id,
          reversedAt: new Date(),
          reversalReason: reason,
        })
        .where(eq(moderationEffects.id, effect.id))
        .returning();
      reversedEffects.push(updated);
    }

    return { reversed: reversedEffects, idempotent: false };
  }

  /**
   * Audit an incident end to end and repair a partially-applied consequence.
   *
   * Two failure shapes this exists for, both of which a dropped background job
   * can produce: an effect whose strike never landed (points deducted, no
   * standing change) and an effect from a revision a later one superseded
   * (consequence still active after an appeal). Both are silent — nothing errors,
   * the numbers are simply wrong — so a reconciliation pass is the only thing
   * that finds them.
   *
   * Idempotent: a healthy incident is examined and nothing is written.
   */
  async reconcileModerationIncident(incidentId: string): Promise<ReconcileResult> {
    const incident = String(incidentId);
    const effects = await getDb()
      .select()
      .from(moderationEffects)
      .where(eq(moderationEffects.incidentId, incident))
      .orderBy(asc(moderationEffects.decisionRevision));

    const latestRevision = effects.reduce(
      (max, effect) => Math.max(max, effect.decisionRevision),
      0
    );
    const touched = new Set<string>();
    let strikesRepaired = 0;
    let supersededReversed = 0;

    for (const effect of effects) {
      // An applied effect from a superseded revision is a consequence an appeal
      // should already have removed.
      if (effect.status === 'applied' && effect.decisionRevision < latestRevision) {
        await this.reverseModerationDecision(
          effect.decisionId,
          effect.decisionRevision,
          `Superseded by revision ${latestRevision}`,
          effect.credentialId ?? ''
        );
        supersededReversed += 1;
        touched.add(effect.principalId);
        continue;
      }

      if (effect.status !== 'applied' || effect.activeRisk === 0) {
        continue;
      }

      // The strike is what carries active risk. Without it the points were
      // deducted and the standing never moved.
      const strike = effect.strikeId ? await this.findStrikeById(effect.strikeId) : null;
      if (!strike) {
        const repaired = await this.repairStrike(effect);
        await getDb()
          .update(moderationEffects)
          .set({ strikeId: repaired.id })
          .where(eq(moderationEffects.id, effect.id));
        strikesRepaired += 1;
        touched.add(effect.principalId);
      }
    }

    for (const subject of touched) {
      await reputationService.recalculateBalance(subject);
    }

    return {
      incidentId: incident,
      effectsExamined: effects.length,
      strikesRepaired,
      supersededReversed,
      balancesRecalculated: touched.size,
    };
  }

  /**
   * Expire the active strikes whose risk has lapsed.
   *
   * The ledger transaction stays exactly where it is: the history is permanent,
   * only the consequence decays. That combination is what stops a minor error
   * from becoming a life sentence while keeping the record honest. Critical
   * strikes carry no `expiresAt` and so are never selected — they need a
   * specialised recovery review, not a timer.
   *
   * @param limit - Ceiling on strikes expired in one pass, so a backlog cannot
   *   stall a scheduled tick.
   */
  async expireConductStrikes(limit: number): Promise<{ expired: number; subjects: number }> {
    const due = await getDb()
      .select({ id: conductStrikes.id, userId: conductStrikes.userId })
      .from(conductStrikes)
      .where(and(eq(conductStrikes.status, 'active'), lte(conductStrikes.expiresAt, new Date())))
      .orderBy(asc(conductStrikes.expiresAt))
      .limit(limit);

    if (due.length === 0) {
      return { expired: 0, subjects: 0 };
    }

    const subjects = new Set<string>();
    for (const strike of due) {
      // Predicated on `status = 'active'` so a concurrent reversal wins rather
      // than being overwritten by the sweep, and both fields move together for
      // the resolution CHECK.
      await getDb()
        .update(conductStrikes)
        .set({ status: 'expired', resolvedAt: new Date() })
        .where(and(eq(conductStrikes.id, strike.id), eq(conductStrikes.status, 'active')));
      subjects.add(strike.userId);
    }

    for (const subject of subjects) {
      await reputationService.recalculateBalance(subject);
    }

    logger.info('Conduct risk expired', {
      component: 'moderationReputation',
      expired: due.length,
      subjects: subjects.size,
    });

    return { expired: due.length, subjects: subjects.size };
  }

  /**
   * Seed the baseline Oxy Conduct Policy. Idempotent, and deliberately NOT an
   * upsert of the values: a published policy version is immutable, so an existing
   * document is left exactly as it is. Changing a tuning means publishing a new
   * version, not editing the one past decisions were made under.
   */
  async seedBaselinePolicy(params: {
    policyVersion: string;
    severityRules: readonly SeedSeverityRule[];
    conductFamilies: readonly string[];
    repetitionMultipliers: readonly number[];
    repetitionWindowDays: number;
    multiFindingSecondaryShare: number;
    multiFindingCap: number;
    standingThresholds: readonly SeedStandingThreshold[];
  }): Promise<ModerationPolicyView> {
    const existing = await loadPolicy(params.policyVersion);
    if (existing) {
      return existing;
    }

    // The version and its two child tables land in ONE transaction: a policy row
    // with no severity rules would be a published version under which no
    // consequence can be derived, and `applyModerationDecision` would answer
    // `finding_not_in_policy` for every event rather than failing visibly.
    await getDb().transaction(async (tx) => {
      const [policy] = await tx
        .insert(moderationPolicies)
        .values({
          policyVersion: params.policyVersion,
          status: 'active',
          conductFamilies: [...params.conductFamilies],
          repetitionMultipliers: [...params.repetitionMultipliers],
          repetitionWindowDays: params.repetitionWindowDays,
          multiFindingSecondaryShare: params.multiFindingSecondaryShare,
          multiFindingCap: params.multiFindingCap,
          provisionalEffectsAllowed: false,
        })
        .returning({ id: moderationPolicies.id });

      if (params.severityRules.length > 0) {
        await tx.insert(moderationPolicySeverityRules).values(
          params.severityRules.map((rule) => ({ policyId: policy.id, ...rule }))
        );
      }
      if (params.standingThresholds.length > 0) {
        await tx.insert(moderationPolicyStandingThresholds).values(
          params.standingThresholds.map((threshold) => ({ policyId: policy.id, ...threshold }))
        );
      }
    });

    const seeded = await loadPolicy(params.policyVersion);
    if (!seeded) {
      throw new Error('Baseline conduct policy seed produced no policy');
    }
    return seeded;
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /**
   * Keep the findings this policy version can act on, and pick the primary.
   *
   * Returns the most specific reason when nothing qualifies, so an emitter can
   * tell "we do not act on local findings" apart from "your taxonomy names a
   * family we do not recognise" — two very different things to fix.
   */
  private selectEffectiveFindings(
    findings: readonly ModerationFinding[],
    policy: ModerationPolicyView
  ):
    | {
        ok: true;
        primary: ModerationFinding;
        rule: ModerationSeverityRule;
        effectiveCount: number;
      }
    | { ok: false; reason: ModerationEffectSkipReason } {
    const globalScoped = findings.filter((finding) => GLOBAL_FINDING_SCOPES.has(finding.scope));
    if (globalScoped.length === 0) {
      return { ok: false, reason: 'finding_scope_local' };
    }

    const families = new Set(policy.conductFamilies);
    const recognised = globalScoped.filter(
      (finding) =>
        families.has(finding.family) &&
        policy.severityRules.some((rule) => rule.severity === finding.severity)
    );
    if (recognised.length === 0) {
      return { ok: false, reason: 'finding_not_in_policy' };
    }

    // The primary is the most severe recognised finding. Ties keep the emitter's
    // order, so the same event always derives the same effect.
    //
    // `family` is re-read as a primitive: it reaches a Mongo filter in the
    // repetition lookup, and the same reasoning as `readEventIdentifiers`
    // applies — a filter handed an operator object there would count every prior
    // strike as similar and escalate the penalty.
    const worst = recognised.reduce((current, finding) =>
      SEVERITY_RANK[finding.severity] > SEVERITY_RANK[current.severity] ? finding : current
    );
    const primary: ModerationFinding = { ...worst, family: String(worst.family) };
    const rule = policy.severityRules.find((entry) => entry.severity === primary.severity);
    if (!rule) {
      return { ok: false, reason: 'finding_not_in_policy' };
    }

    return { ok: true, primary, rule, effectiveCount: recognised.length };
  }

  /**
   * Repetition multiplier for a subject and conduct family.
   *
   * Similarity is by FAMILY and time window, never by taxonomy code, so
   * relabelling the same behaviour does not reset the counter — and, in the other
   * direction, stacking labels on one incident cannot manufacture repetition.
   * Prior incidents are counted as DISTINCT `incidentId`s, and reversed strikes
   * are excluded: a decision that was overturned is not a prior offence.
   */
  private async resolveRepetitionMultiplier(
    principalId: string,
    family: string,
    incidentId: string,
    policy: ModerationPolicyView
  ): Promise<number> {
    const multipliers = policy.repetitionMultipliers;
    if (multipliers.length === 0) {
      return 1;
    }

    const since = new Date(Date.now() - policy.repetitionWindowDays * 24 * 60 * 60 * 1000);
    const priors = await getDb()
      .select({ incidentId: conductStrikes.incidentId })
      .from(conductStrikes)
      .where(
        and(
          eq(conductStrikes.userId, principalId),
          eq(conductStrikes.family, String(family)),
          ne(conductStrikes.status, 'reversed'),
          ne(conductStrikes.incidentId, String(incidentId)),
          gte(conductStrikes.createdAt, since)
        )
      );

    const distinctIncidents = new Set(priors.map((strike) => strike.incidentId));
    const ordinal = Math.min(distinctIncidents.size, multipliers.length - 1);
    return multipliers[ordinal];
  }

  /**
   * Write the consequence: ledger transaction, strike and effect record.
   *
   * All three commit in ONE transaction where the deployment supports it, so the
   * three guards cannot end up disagreeing about whether a consequence exists.
   * The attestation is emitted afterwards and is non-fatal — a signing failure
   * must never roll back a consequence, and a consequence with no attestation is
   * recoverable while a rolled-back one is invisible.
   */
  private async writeEffect(params: {
    event: ModerationDecisionEvent;
    /** The event's identifiers, already coerced at the service boundary. */
    ids: EventIdentifiers;
    context: ModerationEventContext;
    policy: ModerationPolicyView;
    primary: ModerationFinding;
    effectType: ModerationEffectType;
    points: number;
    activeRisk: number;
    repetitionMultiplier: number;
    multiFindingMultiplier: number;
    idempotencyKey: string;
    principalObjectId: string;
    reportedApplicationId: string;
    bindingId: string;
    riskExpiryDays: number | null;
  }): Promise<ModerationEffectRow> {
    // Only what this method itself logs or attests. The three writes take the
    // whole `params` object, so destructuring the rest here would be a second,
    // drifting copy of the same values.
    const {
      ids,
      context,
      policy,
      primary,
      effectType,
      points,
      activeRisk,
      idempotencyKey,
      principalObjectId,
      reportedApplicationId,
      bindingId,
    } = params;

    // ONE real transaction, no fallback. The Mongo version re-ran the three
    // writes SESSION-LESS whenever the deployment had no replica set, which is
    // precisely the case where a half-applied consequence — points deducted, no
    // strike, no effect record — could survive an interruption and be invisible
    // to every one of the three idempotency guards.
    const effect = await getDb().transaction(async (tx) => this.writeEffectInTransaction(params, tx));

    // Provenance, deliberately minimal: a severity BAND, the points, the hash of
    // the private decision and the policy version. No taxonomy code, no victim,
    // no content — an attestation is exportable, and a sanction ledger that names
    // categories would be worse than no attestation at all.
    try {
      await attestModerationEffect({
        transactionId: effect.transactionId,
        subjectUserId: principalObjectId,
        severityBand: primary.severity,
        points,
        decisionHash: ids.proofHash,
        policyVersion: policy.policyVersion,
        sourceActionId: idempotencyKey,
      });
    } catch (error) {
      logger.warn('Moderation attestation emission failed (non-fatal)', {
        component: 'moderationReputation',
        effectId: effect.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    logger.info('Moderation reputation effect applied', {
      component: 'moderationReputation',
      incidentId: ids.incidentId,
      decisionRevision: ids.decisionRevision,
      effectType,
      severity: primary.severity,
      points,
      activeRisk,
      reportedApplicationId,
      emitterApplicationId: context.emitterApplicationId,
      bindingId,
    });

    return effect;
  }

  /** The three writes themselves, inside the caller's transaction. */
  private async writeEffectInTransaction(
    params: Parameters<ModerationReputationService['writeEffect']>[0],
    tx: ReputationTransactionHandle
  ): Promise<ModerationEffectRow> {
    const {
      ids,
      context,
      policy,
      primary,
      effectType,
      points,
      activeRisk,
      repetitionMultiplier,
      multiFindingMultiplier,
      idempotencyKey,
      principalObjectId,
      reportedApplicationId,
      bindingId,
      riskExpiryDays,
    } = params;

    const transaction = await reputationService.award({
      userId: principalObjectId,
      actionType: actionTypeFor(effectType, primary.severity),
      applicationId: reportedApplicationId,
      // The idempotency key IS the ledger's `sourceActionId`, so the existing
      // unique `(applicationId, sourceActionId)` index becomes the third guard
      // against a double penalty. Reused rather than reinvented.
      sourceActionId: idempotencyKey,
      sourceActionType: MODERATION_CONDUCT_SOURCE_ACTION_TYPE,
      targetEntityId: ids.incidentId,
      targetEntityType: 'manual_review',
      reason: `Moderation decision ${ids.decisionId} revision ${ids.decisionRevision}`,
      // Metadata names no taxonomy code, no reporter and no content — the ledger
      // is readable by its subject, and a sanction row must explain itself
      // without becoming a dossier.
      metadata: {
        incidentId: ids.incidentId,
        decisionRevision: ids.decisionRevision,
        severity: primary.severity,
        family: primary.family,
      },
      ruleOverride: {
        points,
        category: MODERATION_LEDGER_CATEGORY,
        description: `Moderation conduct effect (${primary.severity})`,
        policyVersion: policy.policyVersion,
      },
      tx,
    });

    let strike: ConductStrikeRow | undefined;
    if (activeRisk !== 0) {
      const expiresAt =
        riskExpiryDays === null
          ? undefined
          : new Date(Date.now() + riskExpiryDays * 24 * 60 * 60 * 1000);
      const [created] = await tx
        .insert(conductStrikes)
        .values({
          userId: principalObjectId,
          incidentId: ids.incidentId,
          decisionId: ids.decisionId,
          decisionRevision: ids.decisionRevision,
          applicationId: reportedApplicationId,
          effectType,
          severity: primary.severity,
          riskPoints: activeRisk,
          family: primary.family,
          status: 'active',
          expiresAt,
          policyVersion: policy.policyVersion,
          transactionId: transaction.id,
        })
        .returning();
      strike = created;
    }

    const [createdEffect] = await tx
      .insert(moderationEffects)
      .values({
        eventId: ids.eventId,
        incidentId: ids.incidentId,
        caseId: ids.caseId,
        decisionId: ids.decisionId,
        decisionRevision: ids.decisionRevision,
        principalId: principalObjectId,
        bindingId,
        applicationId: reportedApplicationId,
        credentialId: context.emitterCredentialId,
        effectType,
        status: 'applied',
        points,
        activeRisk,
        severity: primary.severity,
        family: primary.family,
        repetitionMultiplier,
        multiFindingMultiplier,
        idempotencyKey,
        transactionId: transaction.id,
        strikeId: strike?.id,
        policyVersionUniversal: String(params.event.policyVersions.universal),
        policyVersionApplication: String(params.event.policyVersions.application),
        policyVersionOxyConduct: ids.oxyConductVersion,
        proofHash: ids.proofHash,
        appliedAt: new Date(),
      })
      .returning();

    // The strike changed the subject's active risk, so the snapshot must be
    // recomputed inside the same unit of work — otherwise a reader between the
    // two sees points deducted and standing unchanged.
    await reputationService.recalculateBalance(principalObjectId, tx);

    return createdEffect;
  }

  /**
   * Resolve the winner of a duplicate-key race.
   *
   * Both unique indexes and the ledger's own surface as E11000, and which one
   * fired does not matter: the stored effect is the answer either way. Returns
   * `null` for any other error so the caller rethrows rather than swallowing it.
   */
  private async findDuplicateWinner(
    error: unknown,
    key: {
      eventId: string;
      incidentId: string;
      principalId: string;
      effectType: ModerationEffectType;
      decisionRevision: number;
    }
  ): Promise<ModerationEffectRow | null> {
    // Either of the two unique indexes may have fired, and which one does not
    // matter: the stored effect is the answer either way. Named rather than a
    // bare `unique_violation` so a future index on this table cannot silently
    // start being answered as "already applied".
    if (
      !isUniqueViolation(error, EFFECT_EVENT_UNIQUE) &&
      !isUniqueViolation(error, EFFECT_SEMANTIC_UNIQUE)
    ) {
      return null;
    }
    const byEvent = await this.findEffectByEventId(key.eventId);
    if (byEvent) {
      return byEvent;
    }
    return this.findEffectBySemanticKey(key);
  }

  /** The effect a transport `eventId` already produced, or `null`. */
  private async findEffectByEventId(eventId: string): Promise<ModerationEffectRow | null> {
    const [effect] = await getDb()
      .select()
      .from(moderationEffects)
      .where(eq(moderationEffects.eventId, String(eventId)))
      .limit(1);
    return effect ?? null;
  }

  /** The effect for one incident, principal, axis and revision, or `null`. */
  private async findEffectBySemanticKey(key: {
    incidentId: string;
    principalId: string;
    effectType: ModerationEffectType;
    decisionRevision: number;
  }): Promise<ModerationEffectRow | null> {
    const [effect] = await getDb()
      .select()
      .from(moderationEffects)
      .where(
        and(
          eq(moderationEffects.incidentId, String(key.incidentId)),
          eq(moderationEffects.principalId, key.principalId),
          eq(moderationEffects.effectType, key.effectType),
          eq(moderationEffects.decisionRevision, Number(key.decisionRevision))
        )
      )
      .limit(1);
    return effect ?? null;
  }

  /** Every effect a decision revision produced. */
  private async findEffectsByDecision(
    decisionId: string,
    decisionRevision: number
  ): Promise<ModerationEffectRow[]> {
    // Coerced for the same reason `readEventIdentifiers` exists: these methods
    // are exported, and a filter handed an operator object would report on
    // effects belonging to other decisions entirely.
    return getDb()
      .select()
      .from(moderationEffects)
      .where(
        and(
          eq(moderationEffects.decisionId, String(decisionId)),
          eq(moderationEffects.decisionRevision, toDecisionRevision(decisionRevision))
        )
      );
  }

  /** Effects owned by the service credential requesting a reversal. */
  private async findEffectsByDecisionForCredential(
    decisionId: string,
    decisionRevision: number,
    emitterCredentialId: string
  ): Promise<ModerationEffectRow[]> {
    return getDb()
      .select()
      .from(moderationEffects)
      .where(
        and(
          eq(moderationEffects.decisionId, String(decisionId)),
          eq(moderationEffects.decisionRevision, toDecisionRevision(decisionRevision)),
          eq(moderationEffects.credentialId, String(emitterCredentialId))
        )
      );
  }

  /** One conduct strike by id, or `null`. */
  private async findStrikeById(strikeId: string): Promise<ConductStrikeRow | null> {
    const [strike] = await getDb()
      .select()
      .from(conductStrikes)
      .where(eq(conductStrikes.id, strikeId))
      .limit(1);
    return strike ?? null;
  }

  /**
   * Rebuild a missing strike from its effect, reconstructing the consequence the
   * subject SHOULD have been under — not a fresh one.
   *
   * Two things here are easy to get wrong and both make the repair harsher than
   * the original, which is the worst direction for a repair to err in:
   *
   *  - The expiry is measured from the effect's `appliedAt`, NOT from now.
   *    Measuring from now would silently extend a 90-day consequence by however
   *    long the strike was missing, so a reconciliation pass would punish the
   *    subject for an operational failure.
   *  - An expiry that has ALREADY passed produces an `expired` strike, not an
   *    active one. Otherwise reconciliation resurrects a consequence that had
   *    lapsed, and — because the sweep only selects strikes whose `expiresAt` is
   *    due — a resurrected one with no expiry would never lapse again.
   *
   * The figures come from the effect and the expiry from the effect's OWN policy
   * version, so a repair is bounded by what was already recorded and cannot
   * invent a consequence. A `null` expiry (critical severity) stays absent, which
   * is the one case where a permanent strike is correct.
   */
  private async repairStrike(effect: ModerationEffectRow): Promise<ConductStrikeRow> {
    const policy = await loadPolicy(effect.policyVersionOxyConduct);
    const rule = policy?.severityRules.find((entry) => entry.severity === effect.severity);
    const expiryDays = rule?.riskExpiryDays ?? null;

    const expiresAt =
      expiryDays === null
        ? undefined
        : new Date(effect.appliedAt.getTime() + expiryDays * 24 * 60 * 60 * 1000);
    const hasLapsed = expiresAt !== undefined && expiresAt.getTime() <= Date.now();

    const [repaired] = await getDb()
      .insert(conductStrikes)
      .values({
        userId: effect.principalId,
        incidentId: effect.incidentId,
        decisionId: effect.decisionId,
        decisionRevision: effect.decisionRevision,
        applicationId: effect.applicationId,
        effectType: effect.effectType,
        severity: effect.severity,
        riskPoints: effect.activeRisk,
        family: effect.family,
        status: hasLapsed ? 'expired' : 'active',
        expiresAt,
        policyVersion: effect.policyVersionOxyConduct,
        transactionId: effect.transactionId,
        resolvedAt: hasLapsed ? new Date() : undefined,
      })
      .returning();
    return repaired;
  }

  /**
   * The ledger transaction an effect produced, for the owner-facing explanation
   * surface. Kept here rather than on the reputation service because the join
   * from effect to transaction is a bridge concern.
   */
  async getEffectTransaction(effect: ModerationEffectRow) {
    const [transaction] = await getDb()
      .select()
      .from(reputationTransactions)
      .where(eq(reputationTransactions.id, effect.transactionId))
      .limit(1);
    return transaction ?? null;
  }
}

export const moderationReputationService = new ModerationReputationService();
export default moderationReputationService;
