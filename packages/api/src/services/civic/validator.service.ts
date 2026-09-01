/**
 * Validator Jury Service (civic / Commons — Fase 2 Part B, the anti-collusion core).
 *
 * A MEDIUM-weight (8 pt) claim is validated by a RANDOMLY-SELECTED jury of
 * trusted peers who each submit a SIGNED verdict. The anti-"bring my friends"
 * defences are layered:
 *  - RANDOM selection — weighted reservoir sampling keyed by a per-request RNG
 *    seed (stored for audit), so a subject cannot predict or pack their jury.
 *  - GRAPH EXCLUSION — the shared `isSockPuppetRelation` (2 hops + shared
 *    device) drops the subject's neighbours from the pool.
 *  - AFFINITY THROTTLE — a candidate that has co-voted heavily with an
 *    already-selected juror is skipped (breaks up voting rings).
 *  - SLASHING — if the resulting award is later reversed (dispute/fraud), the
 *    endorsing jurors are slashed (see `slash.service`).
 *
 * No self-award: jurors submit signed verdicts; THIS service tallies quorum and
 * calls `reputationService.award` in-process for the subject + correct jurors.
 *
 * ## The open-request dedup is a DATABASE constraint again
 *
 * `ValidationRequest.ts` recorded that the dedup "is enforced in the service —
 * partialFilterExpression does not portably support `$in`". That was a MongoDB
 * limitation, and `openValidationRequest` paid for it with a `findOne` → `create`
 * check-then-act: two concurrent callers could both find nothing and both open a
 * jury for one action, splitting the juror pool across two requests that could
 * each only expire. Postgres expresses it directly —
 * `unique (source_action_id) where status in ('pending', 'quorum_met')` — so the
 * friendly lookup stays (returning the existing request is the nice path) and
 * the INDEX is the guarantee: the loser of the race reads the winner back
 * instead of opening a second jury.
 *
 * ## `selected_validator_ids[]` is a junction table
 *
 * The Mongo array of juror ids is `validation_request_validators`, with real
 * foreign keys and the draw `position` preserved — so a seat can no longer name
 * an account that does not exist, and the juror inbox is an indexed join rather
 * than a multikey scan.
 */

import crypto from 'crypto';
import { and, asc, desc, eq, gt, inArray, lte, notInArray, sql } from 'drizzle-orm';
import { canonicalize, verifyEnvelopeSignature } from '@oxyhq/protocol';
import { validationVerdictRecordSchema, type ValidationVerdict } from '@oxyhq/contracts';
import type { SignedRecordEnvelope } from '@oxyhq/contracts';
import { getDb } from '../../config/postgres';
import { isUniqueViolation } from '@oxyhq/db';
import { reputationBalances } from '../../db/schema/reputationBalances';
import {
  validationRequestValidators,
  validationRequests,
} from '../../db/schema/validationRequests';
import { validationVotes } from '../../db/schema/validationVotes';
import { validatorAffinities } from '../../db/schema/validatorAffinities';
import { isSockPuppetRelation } from './graphExclusion';
import { verifyAndStoreRecord } from '../signedRecord.service';
import { reputationService } from '../reputation.service';
import { isSelfIssuedByUser } from '../did.service';
import {
  PEER_VALIDATED_ACTION,
  VALIDATION_CORRECT_ACTION,
} from '../../utils/reputation.constants';
import {
  VALIDATOR_POOL_TIERS,
  VALIDATOR_COUNT,
  VALIDATOR_QUORUM,
  VALIDATOR_SUPERMAJORITY,
  VALIDATION_EXCLUSION_HOPS,
  VALIDATION_TTL_MS,
  AFFINITY_MAX_COVOTES,
  VALIDATOR_POOL_CAP,
  PERSONHOOD_AUDIT_ACTION,
} from '../../utils/civic.constants';
import { logger } from '../../utils/logger';

/** A stored validation request. */
export type ValidationRequestRow = typeof validationRequests.$inferSelect;

/**
 * A request plus its jury.
 *
 * The jury lived on the document as `selectedValidatorIds[]`; it is a junction
 * table now, so a reader that needs both asks for this rather than re-joining at
 * each call site.
 */
export interface ValidationRequestView extends ValidationRequestRow {
  selectedValidatorIds: string[];
}

/** A stored juror verdict. */
export type ValidationVoteRow = typeof validationVotes.$inferSelect;

/** The partial unique index that makes "one open request per source action" true. */
const OPEN_SOURCE_ACTION_UNIQUE = 'validation_requests_open_source_action_key';
/** One vote per juror per request. */
const REQUEST_VALIDATOR_UNIQUE = 'validation_votes_request_validator_key';
/** The two statuses in which a request is still open and holds the dedup slot. */
const OPEN_STATUSES = ['pending', 'quorum_met'] as const;

/* -------------------------------------------------------------------------- */
/*  Weighting + deterministic RNG                                             */
/* -------------------------------------------------------------------------- */

/** Damped, capped juror weight from the trust tier (higher tier ⇒ more weight). */
function validatorWeight(trustTier: string): number {
  switch (trustTier) {
    case 'verified':
      return 2;
    case 'high_trust':
      return 1.5;
    default:
      return 1; // trusted
  }
}

/**
 * Deterministic uniform in (0,1) for a (seed, id) pair — the per-candidate
 * randomness of the weighted reservoir. Deterministic so the selection is
 * reproducible from the stored `rngSeed` (audit) yet unpredictable without it.
 */
function hashUnit(seed: string, id: string): number {
  const digest = crypto.createHash('sha256').update(`${seed}:${id}`).digest();
  const n = digest.readUIntBE(0, 6); // 48 bits
  const u = n / 2 ** 48;
  return u <= 0 ? Number.MIN_VALUE : u;
}

/**
 * Canonical (sorted) pair for a `validator_affinities` lookup.
 *
 * The table now carries `check (validator_a < validator_b)`, so the canonical
 * form is the ONLY representable one — Mongo allowed `(b, a)` as a second,
 * invisible row that silently halved every co-vote count it should have been
 * part of.
 */
function affinityPair(a: string, b: string): { validatorA: string; validatorB: string } {
  return a < b ? { validatorA: a, validatorB: b } : { validatorA: b, validatorB: a };
}

/* -------------------------------------------------------------------------- */
/*  Selection                                                                 */
/* -------------------------------------------------------------------------- */

export interface ValidatorSelection {
  validatorIds: string[];
  rngSeed: string;
  candidateSnapshot: Array<{ userId: string; weight: number }>;
}

/**
 * Select the jury for `subjectUserId`. Eligible pool = balances with a
 * jury-eligible trust tier, minus the subject and anyone the shared exclusion
 * test flags (graph neighbour within {@link VALIDATION_EXCLUSION_HOPS} or shared
 * device). The remaining candidates are ranked by a seeded weighted-reservoir
 * key; the top `VALIDATOR_COUNT` are taken, skipping any candidate with high
 * co-vote affinity to an already-selected juror.
 *
 * KNOWN STRUCTURAL GAP, deliberately unchanged by this port: nothing here checks
 * that the surviving pool still clears `VALIDATOR_QUORUM`, so an undersized
 * panel opens and can only ever expire. The port makes the check expressible —
 * `selected.length` is right here — but adding it would change behaviour, which
 * is not this task's call to make.
 */
export async function selectValidators(
  subjectUserId: string,
  opts: { rngSeed?: string } = {},
): Promise<ValidatorSelection> {
  const rngSeed = opts.rngSeed ?? crypto.randomBytes(32).toString('hex');

  const balances = await getDb()
    .select({ userId: reputationBalances.userId, trustTier: reputationBalances.trustTier })
    .from(reputationBalances)
    .where(inArray(reputationBalances.trustTier, [...VALIDATOR_POOL_TIERS]))
    .limit(VALIDATOR_POOL_CAP);

  // Exclude the subject + sock-puppets; snapshot the eligible candidate pool.
  const candidates: Array<{ userId: string; weight: number }> = [];
  for (const balance of balances) {
    const candidateId = balance.userId;
    if (candidateId === subjectUserId) {
      continue;
    }
    const relation = await isSockPuppetRelation(subjectUserId, candidateId, {
      hops: VALIDATION_EXCLUSION_HOPS,
    });
    if (relation.excluded) {
      continue;
    }
    candidates.push({ userId: candidateId, weight: validatorWeight(balance.trustTier) });
  }

  // Weighted reservoir: key = u^(1/w); highest keys win. Deterministic in seed.
  const ranked = candidates
    .map((c) => ({ ...c, key: Math.pow(hashUnit(rngSeed, c.userId), 1 / c.weight) }))
    .sort((a, b) => b.key - a.key);

  const selected: string[] = [];
  for (const candidate of ranked) {
    if (selected.length >= VALIDATOR_COUNT) {
      break;
    }
    if (await hasHighAffinity(candidate.userId, selected)) {
      continue;
    }
    selected.push(candidate.userId);
  }

  return { validatorIds: selected, rngSeed, candidateSnapshot: candidates };
}

/** True when `candidate` has met the co-vote affinity ceiling with any `selected`. */
async function hasHighAffinity(candidate: string, selected: string[]): Promise<boolean> {
  for (const other of selected) {
    const pair = affinityPair(candidate, other);
    const [edge] = await getDb()
      .select({ coVoteCount: validatorAffinities.coVoteCount })
      .from(validatorAffinities)
      .where(
        and(
          eq(validatorAffinities.validatorA, pair.validatorA),
          eq(validatorAffinities.validatorB, pair.validatorB),
        ),
      )
      .limit(1);
    if (edge && edge.coVoteCount >= AFFINITY_MAX_COVOTES) {
      return true;
    }
  }
  return false;
}

/* -------------------------------------------------------------------------- */
/*  Reading a request with its jury                                           */
/* -------------------------------------------------------------------------- */

/** The juror ids of one request, in draw order. */
async function juryOf(requestId: string): Promise<string[]> {
  const seats = await getDb()
    .select({ userId: validationRequestValidators.userId })
    .from(validationRequestValidators)
    .where(eq(validationRequestValidators.requestId, requestId))
    .orderBy(asc(validationRequestValidators.position));
  return seats.map((seat) => seat.userId);
}

/** A request plus its jury, or `null` when there is no such request. */
export async function getValidationRequest(requestId: string): Promise<ValidationRequestView | null> {
  const [request] = await getDb()
    .select()
    .from(validationRequests)
    .where(eq(validationRequests.id, requestId))
    .limit(1);
  if (!request) {
    return null;
  }
  return { ...request, selectedValidatorIds: await juryOf(request.id) };
}

/* -------------------------------------------------------------------------- */
/*  Opening a request                                                         */
/* -------------------------------------------------------------------------- */

export interface OpenValidationInput {
  subjectUserId: string;
  actionType: string;
  sourceActionId: string;
  payload: Record<string, unknown>;
  applicationId?: string;
  highValue?: boolean;
}

/** The open request for a source action, with its jury, or `null`. */
async function findOpenRequest(sourceActionId: string): Promise<ValidationRequestView | null> {
  const [existing] = await getDb()
    .select()
    .from(validationRequests)
    .where(
      and(
        eq(validationRequests.sourceActionId, sourceActionId),
        inArray(validationRequests.status, [...OPEN_STATUSES]),
      ),
    )
    .limit(1);
  if (!existing) {
    return null;
  }
  return { ...existing, selectedValidatorIds: await juryOf(existing.id) };
}

/**
 * Open a validation request: select the jury, snapshot the selection rationale,
 * and persist. Idempotent on `sourceActionId` while an open request exists — the
 * lookup answers the common case and the partial unique index answers the race,
 * so two concurrent callers can never split one action's jury across two
 * requests.
 */
export async function openValidationRequest(
  input: OpenValidationInput,
): Promise<ValidationRequestView> {
  const existing = await findOpenRequest(input.sourceActionId);
  if (existing) {
    return existing;
  }

  const selection = await selectValidators(input.subjectUserId);
  const payloadHash = crypto.createHash('sha256').update(canonicalize(input.payload)).digest('hex');
  const highValue = input.highValue ?? false;

  try {
    return await getDb().transaction(async (tx) => {
      const [request] = await tx
        .insert(validationRequests)
        .values({
          subjectUserId: input.subjectUserId,
          actionType: input.actionType,
          applicationId: input.applicationId,
          sourceActionId: input.sourceActionId,
          payload: input.payload,
          payloadHash,
          status: 'pending',
          quorum: VALIDATOR_QUORUM,
          threshold: highValue ? VALIDATOR_SUPERMAJORITY : VALIDATOR_QUORUM,
          highValue,
          rngSeed: selection.rngSeed,
          candidateSnapshot: selection.candidateSnapshot,
          expiresAt: new Date(Date.now() + VALIDATION_TTL_MS),
        })
        .returning();

      if (selection.validatorIds.length > 0) {
        await tx.insert(validationRequestValidators).values(
          selection.validatorIds.map((userId, position) => ({
            requestId: request.id,
            userId,
            position,
          })),
        );
      }

      return { ...request, selectedValidatorIds: selection.validatorIds };
    });
  } catch (error) {
    // The race the index exists for: a concurrent caller took the open slot for
    // this source action between our lookup and our insert. Read their request
    // back rather than opening a second jury.
    if (isUniqueViolation(error, OPEN_SOURCE_ACTION_UNIQUE)) {
      const winner = await findOpenRequest(input.sourceActionId);
      if (winner) {
        return winner;
      }
    }
    throw error;
  }
}

/* -------------------------------------------------------------------------- */
/*  Voting                                                                    */
/* -------------------------------------------------------------------------- */

export type VoteRejectionReason =
  | 'request_not_found'
  | 'request_closed'
  | 'not_selected'
  | 'invalid_type'
  | 'not_self_issued'
  | 'invalid_verdict_record'
  | 'request_mismatch'
  | 'payload_mismatch'
  | 'bad_signature'
  | 'already_voted'
  | 'store_failed';

export type VoteResult =
  | { ok: true; verdict: ValidationVerdict; status: ValidationRequestRow['status'] }
  | { ok: false; reason: VoteRejectionReason };

/**
 * Record a juror's SIGNED verdict on a request and (re)tally. The verdict is a
 * self-issued `validation_verdict` envelope bound to the request id + payload
 * hash; it is stored on the juror's chain. One vote per juror (unique index).
 */
export async function submitVote(
  requestId: string,
  validatorUserId: string,
  envelope: SignedRecordEnvelope,
): Promise<VoteResult> {
  const request = await getValidationRequest(requestId);
  if (!request) {
    return { ok: false, reason: 'request_not_found' };
  }
  if (request.status !== 'pending' && request.status !== 'quorum_met') {
    return { ok: false, reason: 'request_closed' };
  }
  if (request.expiresAt.getTime() <= Date.now()) {
    return { ok: false, reason: 'request_closed' };
  }
  if (!request.selectedValidatorIds.includes(validatorUserId)) {
    return { ok: false, reason: 'not_selected' };
  }

  if (envelope.type !== 'validation_verdict') {
    return { ok: false, reason: 'invalid_type' };
  }
  // Account-based self-issuance check (the SDK's DID spelling may differ from
  // the server's `DID_WEB_DOMAIN` anchor for the same account).
  if (!isSelfIssuedByUser(envelope, validatorUserId)) {
    return { ok: false, reason: 'not_self_issued' };
  }

  const parsed = validationVerdictRecordSchema.safeParse(envelope.record);
  if (!parsed.success) {
    return { ok: false, reason: 'invalid_verdict_record' };
  }
  const verdict = parsed.data.verdict;
  if (parsed.data.requestId !== requestId) {
    return { ok: false, reason: 'request_mismatch' };
  }
  if (parsed.data.payloadHash !== request.payloadHash) {
    return { ok: false, reason: 'payload_mismatch' };
  }

  if (!(await verifyEnvelopeSignature(envelope))) {
    return { ok: false, reason: 'bad_signature' };
  }

  // A `validation_verdict` must be a v2 (chained) envelope — `oxyStorePolicy`
  // enforces that — so the returned content address always names a stored row,
  // which is what `validation_votes.record_id`'s foreign key requires.
  const stored = await verifyAndStoreRecord(envelope, validatorUserId);
  if (!stored.ok) {
    return { ok: false, reason: 'store_failed' };
  }

  const [balance] = await getDb()
    .select({ trustTier: reputationBalances.trustTier })
    .from(reputationBalances)
    .where(eq(reputationBalances.userId, validatorUserId))
    .limit(1);
  try {
    await getDb().insert(validationVotes).values({
      requestId,
      validatorUserId,
      verdict,
      envelope,
      publicKey: envelope.publicKey,
      recordId: stored.record.recordId,
      stakeWeight: validatorWeight(balance?.trustTier ?? 'trusted'),
    });
  } catch (error) {
    if (isUniqueViolation(error, REQUEST_VALIDATOR_UNIQUE)) {
      return { ok: false, reason: 'already_voted' };
    }
    throw error;
  }

  const status = await tallyAndResolve(requestId);
  return { ok: true, verdict, status };
}

/* -------------------------------------------------------------------------- */
/*  Tally + resolve                                                           */
/* -------------------------------------------------------------------------- */

/** Decide an outcome (or null to stay open) from the vote counts. */
function decideOutcome(
  valid: number,
  invalid: number,
  threshold: number,
  allVoted: boolean,
  expired: boolean,
): 'validated' | 'rejected' | null {
  if (valid >= threshold) {
    return 'validated';
  }
  if (invalid >= threshold) {
    return 'rejected';
  }
  if (allVoted || expired) {
    return valid > invalid ? 'validated' : 'rejected';
  }
  return null;
}

/**
 * Tally a request. Resolves (awards the subject + rewards correct jurors) when a
 * side reaches threshold, on full participation, or on expiry with quorum; marks
 * `expired` when it lapses without quorum; otherwise leaves it pending. The
 * status transition is an atomic compare-and-set so it resolves at most once.
 */
export async function tallyAndResolve(requestId: string): Promise<ValidationRequestRow['status']> {
  const request = await getValidationRequest(requestId);
  if (!request) {
    return 'expired';
  }
  if (request.status === 'validated' || request.status === 'rejected' || request.status === 'expired') {
    return request.status;
  }

  const votes = await getDb()
    .select()
    .from(validationVotes)
    .where(eq(validationVotes.requestId, requestId));
  const valid = votes.filter((v) => v.verdict === 'valid');
  const invalid = votes.filter((v) => v.verdict === 'invalid');
  const total = votes.length;
  const expired = request.expiresAt.getTime() <= Date.now();
  const allVoted = total >= request.selectedValidatorIds.length;

  if (total < request.quorum) {
    if (expired) {
      // Same compare-and-set as the resolution below: only one sweeper may
      // retire a request, and only from an OPEN status.
      const lapsed = await getDb()
        .update(validationRequests)
        .set({ status: 'expired' })
        .where(
          and(
            eq(validationRequests.id, requestId),
            inArray(validationRequests.status, [...OPEN_STATUSES]),
          ),
        )
        .returning({ status: validationRequests.status });
      return lapsed[0]?.status ?? request.status;
    }
    return request.status;
  }

  const outcome = decideOutcome(valid.length, invalid.length, request.threshold, allVoted, expired);
  if (!outcome) {
    if (request.status !== 'quorum_met') {
      await getDb()
        .update(validationRequests)
        .set({ status: 'quorum_met' })
        .where(and(eq(validationRequests.id, requestId), eq(validationRequests.status, 'pending')));
      return 'quorum_met';
    }
    return request.status;
  }

  // Atomic claim: only one resolver advances past pending/quorum_met. `status`
  // and `outcome` move in ONE statement because the table's terminal CHECK
  // requires them to agree.
  const [claimed] = await getDb()
    .update(validationRequests)
    .set({ status: outcome, outcome })
    .where(
      and(
        eq(validationRequests.id, requestId),
        inArray(validationRequests.status, [...OPEN_STATUSES]),
      ),
    )
    .returning();
  if (!claimed) {
    return request.status;
  }

  const winners = outcome === 'validated' ? valid : invalid;
  // The jury mechanism is generic; the RESOLUTION is action-specific. A
  // `personhood_audit` does not award `peer_validated` — instead it rewards the
  // majority and, on `rejected`, runs the staking slash cascade. Dynamically
  // imported to avoid a validator↔audit module cycle.
  if (claimed.actionType === PERSONHOOD_AUDIT_ACTION) {
    const { resolvePersonhoodAuditOutcome } = await import('./personhoodAudit.service.js');
    await resolvePersonhoodAuditOutcome(
      claimed,
      outcome,
      winners.map((v) => v.validatorUserId),
    );
  } else {
    await resolveAwards(claimed, outcome, valid, votes);
  }
  await bumpAffinity(winners.map((v) => v.validatorUserId));

  logger.info('Validation request resolved', {
    component: 'civic.validator',
    requestId,
    outcome,
    valid: valid.length,
    invalid: invalid.length,
  });

  return outcome;
}

/** On a `validated` outcome, award the subject + reward the correct jurors. */
async function resolveAwards(
  request: ValidationRequestRow,
  outcome: 'validated' | 'rejected',
  validVotes: ValidationVoteRow[],
  allVotes: ValidationVoteRow[],
): Promise<void> {
  if (outcome !== 'validated') {
    return;
  }

  const txn = await reputationService.award({
    userId: request.subjectUserId,
    actionType: PEER_VALIDATED_ACTION,
    sourceActionId: request.id,
    reason: 'Validated by a randomly-selected jury of peers',
    metadata: {
      requestId: request.id,
      voterUserIds: allVotes.map((v) => v.validatorUserId),
    },
    emitAttestation: true,
    // Every vote row's `record_id` is a foreign key onto a stored record, so the
    // `.filter(id => id.length > 0)` the Mongo version needed is gone with the
    // `?? ''` that made it necessary.
    sourceEnvelopeIds: validVotes.map((v) => v.recordId),
  });
  await getDb()
    .update(validationRequests)
    .set({ resolvedTxnId: txn.id })
    .where(eq(validationRequests.id, request.id));

  // Reward each juror who voted with the resolving majority.
  for (const vote of validVotes) {
    await reputationService.award({
      userId: vote.validatorUserId,
      actionType: VALIDATION_CORRECT_ACTION,
      sourceActionId: `${request.id}:${vote.validatorUserId}`,
      reason: 'Voted with the resolving majority on a peer validation',
    });
  }
}

/** Increment the co-vote affinity for every pair within the winning side. */
async function bumpAffinity(winnerIds: string[]): Promise<void> {
  for (let i = 0; i < winnerIds.length; i += 1) {
    for (let j = i + 1; j < winnerIds.length; j += 1) {
      const pair = affinityPair(winnerIds[i], winnerIds[j]);
      await getDb()
        .insert(validatorAffinities)
        .values({ ...pair, coVoteCount: 1, lastCoVoteAt: new Date() })
        .onConflictDoUpdate({
          target: [validatorAffinities.validatorA, validatorAffinities.validatorB],
          set: {
            coVoteCount: sql`${validatorAffinities.coVoteCount} + 1`,
            lastCoVoteAt: new Date(),
          },
        });
    }
  }
}

export type DenyResult =
  | { ok: true }
  | { ok: false; reason: 'request_not_found' | 'request_closed' | 'not_selected' };

/**
 * A selected juror RECUSES from a request (e.g. a conflict of interest they
 * know of). The juror is removed from the jury and the request is re-tallied
 * (so a now-complete set can resolve, or lapse to `expired` if it can no longer
 * reach quorum). Replacement-juror selection is a future enhancement.
 */
export async function denyValidation(requestId: string, validatorUserId: string): Promise<DenyResult> {
  const [request] = await getDb()
    .select({ status: validationRequests.status })
    .from(validationRequests)
    .where(eq(validationRequests.id, requestId))
    .limit(1);
  if (!request) {
    return { ok: false, reason: 'request_not_found' };
  }
  if (request.status !== 'pending' && request.status !== 'quorum_met') {
    return { ok: false, reason: 'request_closed' };
  }

  // The delete IS the membership check: it removes the seat and reports whether
  // there was one, so a recusal cannot race a concurrent one into a false
  // "removed" answer the way a read-then-write could.
  const removed = await getDb()
    .delete(validationRequestValidators)
    .where(
      and(
        eq(validationRequestValidators.requestId, requestId),
        eq(validationRequestValidators.userId, validatorUserId),
      ),
    )
    .returning({ userId: validationRequestValidators.userId });
  if (removed.length === 0) {
    return { ok: false, reason: 'not_selected' };
  }

  await tallyAndResolve(requestId);
  return { ok: true };
}

/* -------------------------------------------------------------------------- */
/*  Inbox + sweep                                                             */
/* -------------------------------------------------------------------------- */

/** The pending requests a juror still needs to vote on. */
export async function getValidatorInbox(validatorUserId: string): Promise<ValidationRequestView[]> {
  // The juror's own votes, as a NOT IN sub-select: the "drop what I already
  // voted on" step was a second round trip and an in-memory filter under Mongo,
  // which could not join a multikey array to another collection at all.
  const alreadyVoted = getDb()
    .select({ requestId: validationVotes.requestId })
    .from(validationVotes)
    .where(eq(validationVotes.validatorUserId, validatorUserId));

  const rows = await getDb()
    .select({ request: validationRequests })
    .from(validationRequests)
    .innerJoin(
      validationRequestValidators,
      eq(validationRequestValidators.requestId, validationRequests.id),
    )
    .where(
      and(
        eq(validationRequestValidators.userId, validatorUserId),
        inArray(validationRequests.status, [...OPEN_STATUSES]),
        gt(validationRequests.expiresAt, new Date()),
        notInArray(validationRequests.id, alreadyVoted),
      ),
    )
    .orderBy(desc(validationRequests.createdAt))
    .limit(100);

  return Promise.all(
    rows.map(async (row) => ({ ...row.request, selectedValidatorIds: await juryOf(row.request.id) })),
  );
}

/**
 * Sweep stale validation requests: re-tally those past their expiry so they
 * resolve (on quorum) or are marked `expired`. Returns the count swept. Intended
 * to run periodically (alongside `seedDefaultRules`) and is a no-op when there
 * is nothing to do.
 */
export async function sweepValidations(): Promise<number> {
  const stale = await getDb()
    .select({ id: validationRequests.id })
    .from(validationRequests)
    .where(
      and(
        inArray(validationRequests.status, [...OPEN_STATUSES]),
        lte(validationRequests.expiresAt, new Date()),
      ),
    )
    .limit(200);

  for (const request of stale) {
    await tallyAndResolve(request.id);
  }
  return stale.length;
}
