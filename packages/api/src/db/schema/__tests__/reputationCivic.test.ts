/**
 * Reputation and civic constraints, against a REAL Postgres.
 *
 * One `describe` per decision this batch made that a reader could reasonably
 * reverse — the partial vs plain UNIQUE split, the dedup constraint moved back
 * out of service code, the canonical affinity pair, and the coherence CHECKs
 * that make a contradictory row unrepresentable rather than merely unlikely.
 *
 * Closed value sets are additionally held against `@oxyhq/contracts` here, so
 * widening a union there without widening the CHECK fails as a test rather than
 * as a 500 the first time the new value is written.
 */

import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import {
  CONDUCT_STANDINGS as CONTRACT_CONDUCT_STANDINGS,
  CONTRIBUTION_TIERS as CONTRACT_CONTRIBUTION_TIERS,
  PERSONHOOD_STATUSES as CONTRACT_PERSONHOOD_STATUSES,
  REPUTATION_CATEGORIES as CONTRACT_REPUTATION_CATEGORIES,
  REPUTATION_DISPUTE_STATUSES as CONTRACT_DISPUTE_STATUSES,
  REPUTATION_TARGET_ENTITY_TYPES as CONTRACT_TARGET_ENTITY_TYPES,
  REPUTATION_TRANSACTION_STATUSES as CONTRACT_TRANSACTION_STATUSES,
  TRUST_TIERS as CONTRACT_TRUST_TIERS,
  oxySignedRecordTypeSchema,
} from '@oxyhq/contracts';
import type { SignedRecordEnvelope } from '@oxyhq/contracts';
import { closePostgres, connectPostgres, getDb } from '../../../config/postgres';
import { applications } from '../applications';
import { personhoodVouches } from '../personhoodVouches';
import {
  CONDUCT_STANDINGS,
  CONTRIBUTION_TIERS,
  PERSONHOOD_STATUSES,
  reputationBalances,
  reputationReviewingReliability,
} from '../reputationBalances';
import { REPUTATION_DISPUTE_STATUSES, reputationDisputes } from '../reputationDisputes';
import { REPUTATION_CATEGORIES, reputationRules } from '../reputationRules';
import {
  REPUTATION_TARGET_ENTITY_TYPES,
  REPUTATION_TRANSACTION_STATUSES,
  reputationTransactions,
} from '../reputationTransactions';
import { OXY_SIGNED_RECORD_TYPES, signedRecords } from '../signedRecords';
import { TRUST_TIERS, users } from '../users';
import { validationRequests, validationRequestValidators } from '../validationRequests';
import { validationVotes } from '../validationVotes';
import { validatorAffinities } from '../validatorAffinities';
import { verifiableCredentials } from '../verifiableCredentials';

/** Postgres `unique_violation`. */
const UNIQUE_VIOLATION = '23505';
/** Postgres `check_violation`. */
const CHECK_VIOLATION = '23514';
/** Postgres `foreign_key_violation`. */
const FOREIGN_KEY_VIOLATION = '23503';

beforeAll(async () => {
  await connectPostgres();
});

afterAll(async () => {
  await closePostgres();
});

async function owner(): Promise<string> {
  const [row] = await getDb().insert(users).values({ color: 'teal' }).returning({ id: users.id });
  return row.id;
}

/**
 * Read a field off the driver error. Drizzle wraps a driver failure in its own
 * error, so `code` and `constraint_name` live on the `cause` — walking the chain
 * is what keeps an assertion "THIS constraint fired" rather than "something
 * threw". The wrapper's own message contains only the SQL, never the constraint.
 */
function pgField(error: unknown, field: string): string | undefined {
  for (let current = error; current instanceof Error; current = current.cause) {
    const value: unknown = Reflect.get(current, field);
    if (typeof value === 'string') return value;
  }
  return undefined;
}

/** The SQLSTATE a driver error carries. */
function pgErrorCode(error: unknown): string | undefined {
  return pgField(error, 'code');
}

/** The name of the constraint that rejected the statement. */
function pgConstraint(error: unknown): string | undefined {
  return pgField(error, 'constraint_name');
}

/** The DEEPEST message in the chain — where a trigger's `RAISE` text lands. */
function pgMessage(error: unknown): string {
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
  throw new Error('Expected the query to be rejected by a constraint, but it succeeded.');
}

/** A stored signed record, so `record_id` foreign keys have something to point at. */
async function storedRecord(userId: string): Promise<string> {
  const subject = `did:web:oxy.so:u:${userId}`;
  const recordId = `rec-${randomUUID()}`;
  const envelope: SignedRecordEnvelope = {
    version: 2,
    type: 'personhood_vouch',
    subject,
    issuer: subject,
    record: {},
    issuedAt: 1_700_000_000_000,
    seq: 0,
    prev: null,
    collection: 'app.oxy.personhood',
    rkey: 'self',
    publicKey: 'pk',
    alg: 'ES256K-DER-SHA256',
    signature: 'unsigned-fixture',
  };

  await getDb().insert(signedRecords).values({
    subjectDid: subject,
    userId,
    type: 'personhood_vouch',
    envelope,
    publicKey: 'pk',
    seq: 0,
    prev: null,
    recordId,
    nsid: 'app.oxy.personhood',
    rkey: 'self',
  });
  return recordId;
}

describe('personhood_vouches — the active-only partial unique', () => {
  it('rejects a second ACTIVE vouch for the same pair', async () => {
    const voucherUserId = await owner();
    const subjectUserId = await owner();
    const recordId = await storedRecord(voucherUserId);

    await getDb()
      .insert(personhoodVouches)
      .values({ voucherUserId, subjectUserId, stakeAmount: 5, recordId });

    const error = await rejection(
      getDb()
        .insert(personhoodVouches)
        .values({ voucherUserId, subjectUserId, stakeAmount: 5, recordId })
    );

    expect(pgErrorCode(error)).toBe(UNIQUE_VIOLATION);
    expect(pgConstraint(error)).toBe('personhood_vouches_active_pair_key');
  });

  it('admits a second vouch once the first is WITHDRAWN — the history stays', async () => {
    // This is why the index stays partial rather than collapsing to a plain
    // UNIQUE like the others in this batch: withdrawn and slashed rows are audit
    // history, and a plain UNIQUE would make a legitimate re-vouch impossible.
    const voucherUserId = await owner();
    const subjectUserId = await owner();
    const recordId = await storedRecord(voucherUserId);

    const [first] = await getDb()
      .insert(personhoodVouches)
      .values({ voucherUserId, subjectUserId, stakeAmount: 5, recordId })
      .returning({ id: personhoodVouches.id });

    await getDb()
      .update(personhoodVouches)
      .set({ status: 'withdrawn' })
      .where(eq(personhoodVouches.id, first.id));

    await expect(
      getDb()
        .insert(personhoodVouches)
        .values({ voucherUserId, subjectUserId, stakeAmount: 5, recordId })
    ).resolves.toBeDefined();

    const rows = await getDb()
      .select()
      .from(personhoodVouches)
      .where(eq(personhoodVouches.subjectUserId, subjectUserId));
    expect(rows).toHaveLength(2);
    expect(rows.filter((row) => row.status === 'active')).toHaveLength(1);
  });

  it('does the same for a SLASHED vouch', async () => {
    const voucherUserId = await owner();
    const subjectUserId = await owner();
    const recordId = await storedRecord(voucherUserId);

    const [first] = await getDb()
      .insert(personhoodVouches)
      .values({ voucherUserId, subjectUserId, stakeAmount: 5, recordId })
      .returning({ id: personhoodVouches.id });
    await getDb()
      .update(personhoodVouches)
      .set({ status: 'slashed' })
      .where(eq(personhoodVouches.id, first.id));

    await expect(
      getDb()
        .insert(personhoodVouches)
        .values({ voucherUserId, subjectUserId, stakeAmount: 5, recordId })
    ).resolves.toBeDefined();
  });

  it('refuses a self-vouch', async () => {
    const userId = await owner();
    const recordId = await storedRecord(userId);

    const error = await rejection(
      getDb()
        .insert(personhoodVouches)
        .values({ voucherUserId: userId, subjectUserId: userId, stakeAmount: 5, recordId })
    );

    expect(pgErrorCode(error)).toBe(CHECK_VIOLATION);
    expect(pgConstraint(error)).toBe('personhood_vouches_not_self_check');
  });

  it("refuses the `?? ''` dangling record id the service can still produce", async () => {
    // `personhood.service.ts` writes `stored.record.recordId ?? ''`. Under Mongo
    // that was a silently dangling reference; the foreign key now makes it a
    // loud failure the call-site port has to fix.
    const voucherUserId = await owner();
    const subjectUserId = await owner();

    const error = await rejection(
      getDb()
        .insert(personhoodVouches)
        .values({ voucherUserId, subjectUserId, stakeAmount: 5, recordId: '' })
    );

    expect(pgErrorCode(error)).toBe(FOREIGN_KEY_VIOLATION);
  });
});

describe('validation_requests — the dedup constraint Mongo could not express', () => {
  async function openRequest(sourceActionId: string, status: 'pending' | 'quorum_met') {
    return getDb().insert(validationRequests).values({
      subjectUserId: await owner(),
      actionType: 'real_life_attested',
      sourceActionId,
      payload: {},
      payloadHash: 'h',
      status,
      quorum: 3,
      threshold: 3,
      rngSeed: 'seed',
      expiresAt: new Date(Date.now() + 86_400_000),
    });
  }

  it('allows only one OPEN request per source action, across BOTH open statuses', async () => {
    // Mongo's `partialFilterExpression` cannot express `status $in [...]`, which
    // is why this lived in `openValidationRequest`'s check-then-create. Postgres
    // can, so the check-then-create race is closed.
    const sourceActionId = `src-${randomUUID()}`;
    await openRequest(sourceActionId, 'pending');

    const error = await rejection(openRequest(sourceActionId, 'quorum_met'));

    expect(pgErrorCode(error)).toBe(UNIQUE_VIOLATION);
    expect(pgConstraint(error)).toBe('validation_requests_open_source_action_key');
  });

  it('closes the check-then-create window under real concurrency', async () => {
    const sourceActionId = `src-${randomUUID()}`;
    const settled = await Promise.allSettled([
      openRequest(sourceActionId, 'pending'),
      openRequest(sourceActionId, 'pending'),
    ]);

    expect(settled.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = settled.find((r) => r.status === 'rejected');
    expect(rejected && pgErrorCode(rejected.reason)).toBe(UNIQUE_VIOLATION);
  });

  it('frees the slot once the request reaches a terminal state', async () => {
    const sourceActionId = `src-${randomUUID()}`;
    await openRequest(sourceActionId, 'pending');
    await getDb()
      .update(validationRequests)
      .set({ status: 'expired' })
      .where(eq(validationRequests.sourceActionId, sourceActionId));

    await expect(openRequest(sourceActionId, 'pending')).resolves.toBeDefined();
  });

  it('refuses a terminal status with no outcome, and a mismatched pair', async () => {
    const subjectUserId = await owner();
    const base = {
      subjectUserId,
      actionType: 'real_life_attested',
      payload: {},
      payloadHash: 'h',
      quorum: 3,
      threshold: 3,
      rngSeed: 'seed',
      expiresAt: new Date(Date.now() + 86_400_000),
    };

    const missing = await rejection(
      getDb()
        .insert(validationRequests)
        .values({ ...base, sourceActionId: `src-${randomUUID()}`, status: 'validated' })
    );
    expect(pgErrorCode(missing)).toBe(CHECK_VIOLATION);

    const mismatched = await rejection(
      getDb()
        .insert(validationRequests)
        .values({
          ...base,
          sourceActionId: `src-${randomUUID()}`,
          status: 'validated',
          outcome: 'rejected',
        })
    );
    expect(pgErrorCode(mismatched)).toBe(CHECK_VIOLATION);
  });

  it('refuses a threshold below the quorum', async () => {
    const error = await rejection(
      getDb().insert(validationRequests).values({
        subjectUserId: await owner(),
        actionType: 'real_life_attested',
        sourceActionId: `src-${randomUUID()}`,
        payload: {},
        payloadHash: 'h',
        quorum: 3,
        threshold: 2,
        rngSeed: 'seed',
        expiresAt: new Date(Date.now() + 86_400_000),
      })
    );

    expect(pgErrorCode(error)).toBe(CHECK_VIOLATION);
  });
});

describe('the jury junction table', () => {
  it('answers the juror inbox by join, with a real foreign key per seat', async () => {
    const juror = await owner();
    const [request] = await getDb()
      .insert(validationRequests)
      .values({
        subjectUserId: await owner(),
        actionType: 'real_life_attested',
        sourceActionId: `src-${randomUUID()}`,
        payload: {},
        payloadHash: 'h',
        quorum: 3,
        threshold: 3,
        rngSeed: 'seed',
        expiresAt: new Date(Date.now() + 86_400_000),
      })
      .returning({ id: validationRequests.id });

    await getDb()
      .insert(validationRequestValidators)
      .values({ requestId: request.id, userId: juror, position: 0 });

    const inbox = await getDb()
      .select({ id: validationRequests.id })
      .from(validationRequestValidators)
      .innerJoin(
        validationRequests,
        eq(validationRequests.id, validationRequestValidators.requestId)
      )
      .where(
        sql`${validationRequestValidators.userId} = ${juror} and ${validationRequests.status} in ('pending', 'quorum_met') and ${validationRequests.expiresAt} > now()`
      );

    expect(inbox).toEqual([{ id: request.id }]);
  });

  it('refuses a juror who is not an account — which Mongo\'s id array could not', async () => {
    const [request] = await getDb()
      .insert(validationRequests)
      .values({
        subjectUserId: await owner(),
        actionType: 'real_life_attested',
        sourceActionId: `src-${randomUUID()}`,
        payload: {},
        payloadHash: 'h',
        quorum: 3,
        threshold: 3,
        rngSeed: 'seed',
        expiresAt: new Date(Date.now() + 86_400_000),
      })
      .returning({ id: validationRequests.id });

    const error = await rejection(
      getDb()
        .insert(validationRequestValidators)
        .values({ requestId: request.id, userId: `ghost-${randomUUID()}`, position: 1 })
    );

    expect(pgErrorCode(error)).toBe(FOREIGN_KEY_VIOLATION);
  });

  it('holds one vote per juror per request', async () => {
    const juror = await owner();
    const recordId = await storedRecord(juror);
    const [request] = await getDb()
      .insert(validationRequests)
      .values({
        subjectUserId: await owner(),
        actionType: 'real_life_attested',
        sourceActionId: `src-${randomUUID()}`,
        payload: {},
        payloadHash: 'h',
        quorum: 3,
        threshold: 3,
        rngSeed: 'seed',
        expiresAt: new Date(Date.now() + 86_400_000),
      })
      .returning({ id: validationRequests.id });

    const vote = {
      requestId: request.id,
      validatorUserId: juror,
      verdict: 'valid' as const,
      envelope: {
        version: 2 as const,
        type: 'validation_verdict',
        subject: `did:web:oxy.so:u:${juror}`,
        issuer: `did:web:oxy.so:u:${juror}`,
        record: {},
        issuedAt: 1_700_000_000_000,
        seq: 0,
        prev: null,
        collection: 'app.oxy.validation',
        rkey: 'self',
        publicKey: 'pk',
        alg: 'ES256K-DER-SHA256' as const,
        signature: 'unsigned-fixture',
      },
      publicKey: 'pk',
      recordId,
      stakeWeight: 1,
    };

    await getDb().insert(validationVotes).values(vote);
    const error = await rejection(getDb().insert(validationVotes).values(vote));

    expect(pgErrorCode(error)).toBe(UNIQUE_VIOLATION);
  });
});

describe('validator_affinities — the canonical pair', () => {
  it('refuses the reversed pair, which Mongo stored as a second invisible row', async () => {
    const a = await owner();
    const b = await owner();
    const [smaller, larger] = a < b ? [a, b] : [b, a];

    await getDb()
      .insert(validatorAffinities)
      .values({ validatorA: smaller, validatorB: larger, coVoteCount: 1 });

    const error = await rejection(
      getDb()
        .insert(validatorAffinities)
        .values({ validatorA: larger, validatorB: smaller, coVoteCount: 1 })
    );

    expect(pgErrorCode(error)).toBe(CHECK_VIOLATION);
    expect(pgConstraint(error)).toBe('validator_affinities_canonical_pair_check');
  });

  it('refuses an account paired with itself', async () => {
    const a = await owner();
    const error = await rejection(
      getDb().insert(validatorAffinities).values({ validatorA: a, validatorB: a, coVoteCount: 1 })
    );

    expect(pgErrorCode(error)).toBe(CHECK_VIOLATION);
  });

  it('has no created_at or updated_at — `timestamps: false`, carried over', async () => {
    const rows = await getDb().execute<{ column_name: string }>(sql`
      select column_name from information_schema.columns
      where table_schema = 'public' and table_name = 'validator_affinities'
    `);
    const names = rows.map((row) => row.column_name);

    expect(names).toContain('last_co_vote_at');
    expect(names).not.toContain('created_at');
    expect(names).not.toContain('updated_at');
  });
});

describe('reputation_transactions — idempotency without a partial index', () => {
  it('rejects a repeat of the same (application, source action)', async () => {
    const userId = await owner();
    // `reputation_transactions.application_id` carries a real foreign key now
    // that the applications batch has landed, so a synthetic id no longer
    // satisfies it.
    const [application] = await getDb()
      .insert(applications)
      .values({ name: `App ${randomUUID()}`, ownerAccountId: userId })
      .returning({ id: applications.id });
    const applicationId = application.id;
    const sourceActionId = `act-${randomUUID()}`;

    await getDb()
      .insert(reputationTransactions)
      .values({ userId, points: 5, actionType: 'x', category: 'trust', applicationId, sourceActionId });

    const error = await rejection(
      getDb()
        .insert(reputationTransactions)
        .values({ userId, points: 5, actionType: 'x', category: 'trust', applicationId, sourceActionId })
    );

    expect(pgErrorCode(error)).toBe(UNIQUE_VIOLATION);
  });

  it('exempts a row with no application — NULLS DISTINCT does what the partial filter did', async () => {
    // Mongo needed `partialFilterExpression: { $exists: true }` on both fields
    // because a missing field reads as null and every staff/civic award would
    // collide. Postgres gives that for free, which is the whole reason this is a
    // plain UNIQUE — and the case that would break if someone "tidied" the
    // column to NOT NULL DEFAULT ''.
    const userId = await owner();
    const sourceActionId = `act-${randomUUID()}`;

    await expect(
      getDb()
        .insert(reputationTransactions)
        .values([
          { userId, points: 5, actionType: 'x', category: 'trust', sourceActionId },
          { userId, points: 5, actionType: 'x', category: 'trust', sourceActionId },
        ])
    ).resolves.toBeDefined();
  });

  it('keeps a reversal from naming itself', async () => {
    const userId = await owner();
    const [row] = await getDb()
      .insert(reputationTransactions)
      .values({ userId, points: 5, actionType: 'x', category: 'trust' })
      .returning({ id: reputationTransactions.id });

    const error = await rejection(
      getDb()
        .update(reputationTransactions)
        .set({ reversedTransactionId: row.id })
        .where(eq(reputationTransactions.id, row.id))
    );

    expect(pgErrorCode(error)).toBe(CHECK_VIOLATION);
  });

  it('keeps a third party\'s ledger entry when the ACTOR is erased', async () => {
    // `created_by_user_id` is SET NULL rather than CASCADE: deleting the liker
    // or the moderator must not delete the subject's earned points.
    const userId = await owner();
    const actorId = await owner();
    const [row] = await getDb()
      .insert(reputationTransactions)
      .values({ userId, points: 5, actionType: 'x', category: 'trust', createdByUserId: actorId })
      .returning({ id: reputationTransactions.id });

    await getDb().delete(users).where(eq(users.id, actorId));

    const [after] = await getDb()
      .select()
      .from(reputationTransactions)
      .where(eq(reputationTransactions.id, row.id));
    expect(after.points).toBe(5);
    expect(after.createdByUserId).toBeNull();
  });
});

describe('reputation_balances — nine subdocuments as columns', () => {
  it('reproduces every Mongoose default from a row with only a user id', async () => {
    // Each subdocument defaulted to `() => ({})`, which Mongoose expanded to the
    // per-field defaults. The neutral 0.5 on the two reliability estimates is
    // the one that matters: "no history" is not "a terrible record".
    const userId = await owner();
    const [row] = await getDb().insert(reputationBalances).values({ userId }).returning();

    expect(row.total).toBe(0);
    expect(row.breakdownPenalties).toBe(0);
    expect(row.trustTier).toBe('new');
    expect(row.influenceDefaultWeight).toBe(0);
    expect(row.personhoodStatus).toBe('unknown');
    expect(row.contributionTier).toBe('new');
    expect(row.conductStanding).toBe('good');
    expect(row.conductNextExpiryAt).toBeNull();
    expect(row.reportingReliability).toBe(0.5);
    expect(row.reviewingGlobalReliability).toBe(0.5);
    expect(row.contextualRankingWeight).toBe(0);
  });

  it('refuses a probability outside [0, 1]', async () => {
    const userId = await owner();
    const error = await rejection(
      getDb().insert(reputationBalances).values({ userId, reportingReliability: 1.4 })
    );

    expect(pgErrorCode(error)).toBe(CHECK_VIOLATION);
    expect(pgConstraint(error)).toBe('reputation_balances_scores_check');
  });

  it('refuses a positive sum that is negative, and vice versa', async () => {
    const positive = await rejection(
      getDb().insert(reputationBalances).values({ userId: await owner(), positive: -1 })
    );
    expect(pgErrorCode(positive)).toBe(CHECK_VIOLATION);

    const negative = await rejection(
      getDb().insert(reputationBalances).values({ userId: await owner(), negative: 1 })
    );
    expect(pgErrorCode(negative)).toBe(CHECK_VIOLATION);
  });

  it('stores per-scope reviewer reliability as rows, not a blob', async () => {
    const userId = await owner();
    const [balance] = await getDb()
      .insert(reputationBalances)
      .values({ userId })
      .returning({ id: reputationBalances.id });

    await getDb().insert(reputationReviewingReliability).values([
      { balanceId: balance.id, scope: 'category', key: 'harassment', reliability: 0.9 },
      { balanceId: balance.id, scope: 'language', key: 'es-ES', reliability: 0.7 },
    ]);

    // The query a `jsonb` blob could not answer without deserializing every row.
    const strong = await getDb()
      .select()
      .from(reputationReviewingReliability)
      .where(
        sql`${reputationReviewingReliability.balanceId} = ${balance.id} and ${reputationReviewingReliability.scope} = 'category' and ${reputationReviewingReliability.reliability} >= 0.8`
      );
    expect(strong.map((row) => row.key)).toEqual(['harassment']);

    // One value per key, which a Map could hold twice on the way in.
    const duplicate = await rejection(
      getDb()
        .insert(reputationReviewingReliability)
        .values({ balanceId: balance.id, scope: 'category', key: 'harassment', reliability: 0.1 })
    );
    expect(pgErrorCode(duplicate)).toBe(UNIQUE_VIOLATION);
  });
});

describe('reputation_disputes — a resolution is whole or absent', () => {
  it('refuses a resolved status with no resolution timestamp', async () => {
    const userId = await owner();
    const [txn] = await getDb()
      .insert(reputationTransactions)
      .values({ userId, points: 5, actionType: 'x', category: 'trust' })
      .returning({ id: reputationTransactions.id });

    const error = await rejection(
      getDb()
        .insert(reputationDisputes)
        .values({ transactionId: txn.id, userId, reason: 'wrong', status: 'accepted' })
    );

    expect(pgErrorCode(error)).toBe(CHECK_VIOLATION);
    expect(pgConstraint(error)).toBe('reputation_disputes_resolution_check');
  });

  it('distinguishes absent evidence from empty evidence', async () => {
    // `default: undefined` in Mongoose means ABSENT, so the column has no
    // default. `'{}'` would be a different value the user actually supplied.
    const userId = await owner();
    const [txn] = await getDb()
      .insert(reputationTransactions)
      .values({ userId, points: 5, actionType: 'x', category: 'trust' })
      .returning({ id: reputationTransactions.id });

    const [absent] = await getDb()
      .insert(reputationDisputes)
      .values({ transactionId: txn.id, userId, reason: 'no evidence' })
      .returning();
    const [empty] = await getDb()
      .insert(reputationDisputes)
      .values({ transactionId: txn.id, userId, reason: 'empty evidence', evidence: [] })
      .returning();

    expect(absent.evidence).toBeNull();
    expect(empty.evidence).toEqual([]);
  });
});

describe('verifiable_credentials — revocation coherence', () => {
  it('refuses a revocation timestamp on an active credential', async () => {
    const holderUserId = await owner();
    const recordId = await storedRecord(holderUserId);

    const error = await rejection(
      getDb().insert(verifiableCredentials).values({
        holderUserId,
        holderDid: `did:web:oxy.so:u:${holderUserId}`,
        issuerDid: 'did:web:oxy.so',
        types: ['VerifiableCredential'],
        claims: {},
        recordId,
        status: 'active',
        issuedAt: new Date(),
        revokedAt: new Date(),
      })
    );

    expect(pgErrorCode(error)).toBe(CHECK_VIOLATION);
  });

  it('refuses an expiry that precedes issuance', async () => {
    const holderUserId = await owner();
    const recordId = await storedRecord(holderUserId);

    const error = await rejection(
      getDb().insert(verifiableCredentials).values({
        holderUserId,
        holderDid: `did:web:oxy.so:u:${holderUserId}`,
        issuerDid: 'did:web:oxy.so',
        types: ['VerifiableCredential'],
        claims: {},
        recordId,
        issuedAt: new Date(1_700_000_000_000),
        expiresAt: new Date(1_600_000_000_000),
      })
    );

    expect(pgErrorCode(error)).toBe(CHECK_VIOLATION);
  });

  it('keeps a holder\'s credential when the ISSUING account is erased', async () => {
    // `issuer_user_id` is SET NULL: an issuer's own erasure must not silently
    // delete a third party's credential row.
    const holderUserId = await owner();
    const issuerUserId = await owner();
    const recordId = await storedRecord(holderUserId);

    const [row] = await getDb()
      .insert(verifiableCredentials)
      .values({
        holderUserId,
        holderDid: `did:web:oxy.so:u:${holderUserId}`,
        issuerUserId,
        issuerDid: `did:web:oxy.so:u:${issuerUserId}`,
        types: ['VerifiableCredential'],
        claims: { role: 'engineer' },
        recordId,
        issuedAt: new Date(),
      })
      .returning({ id: verifiableCredentials.id });

    await getDb().delete(users).where(eq(users.id, issuerUserId));

    const [after] = await getDb()
      .select()
      .from(verifiableCredentials)
      .where(eq(verifiableCredentials.id, row.id));
    expect(after.issuerUserId).toBeNull();
    expect(after.claims).toEqual({ role: 'engineer' });
  });
});

describe('closed value sets stay equal to the contract', () => {
  it.each([
    ['signed record types', OXY_SIGNED_RECORD_TYPES, [...oxySignedRecordTypeSchema.options]],
    ['reputation categories', REPUTATION_CATEGORIES, [...CONTRACT_REPUTATION_CATEGORIES]],
    ['transaction statuses', REPUTATION_TRANSACTION_STATUSES, [...CONTRACT_TRANSACTION_STATUSES]],
    ['target entity types', REPUTATION_TARGET_ENTITY_TYPES, [...CONTRACT_TARGET_ENTITY_TYPES]],
    ['dispute statuses', REPUTATION_DISPUTE_STATUSES, [...CONTRACT_DISPUTE_STATUSES]],
    ['trust tiers', TRUST_TIERS, [...CONTRACT_TRUST_TIERS]],
    ['personhood statuses', PERSONHOOD_STATUSES, [...CONTRACT_PERSONHOOD_STATUSES]],
    ['contribution tiers', CONTRIBUTION_TIERS, [...CONTRACT_CONTRIBUTION_TIERS]],
    ['conduct standings', CONDUCT_STANDINGS, [...CONTRACT_CONDUCT_STANDINGS]],
  ])('%s', (_label, schemaValues, contractValues) => {
    expect([...schemaValues]).toEqual(contractValues);
  });

  it('refuses every undeclared value from a raw write', async () => {
    // Raw SQL on purpose: the typed columns already refuse these at compile
    // time, so only a hand-written statement (backfill, psql) reaches the CHECK.
    const userId = await owner();
    const cases: Array<[string, ReturnType<typeof sql>]> = [
      [
        'reputation_transactions.category',
        sql`insert into reputation_transactions (id, user_id, points, action_type, category)
            values (${randomUUID()}, ${userId}, 1, 'x', 'vibes')`,
      ],
      [
        'reputation_transactions.status',
        sql`insert into reputation_transactions (id, user_id, points, action_type, category, status)
            values (${randomUUID()}, ${userId}, 1, 'x', 'trust', 'pending')`,
      ],
      [
        'reputation_balances.trust_tier',
        sql`insert into reputation_balances (id, user_id, trust_tier)
            values (${randomUUID()}, ${await owner()}, 'legend')`,
      ],
      [
        'reputation_balances.conduct_standing',
        sql`insert into reputation_balances (id, user_id, conduct_standing)
            values (${randomUUID()}, ${await owner()}, 'banned')`,
      ],
      [
        'validation_votes.verdict',
        sql`insert into validation_votes (id, request_id, validator_user_id, verdict, envelope, public_key, record_id)
            values (${randomUUID()}, ${randomUUID()}, ${userId}, 'maybe', '{}'::jsonb, 'pk', 'rec')`,
      ],
      [
        'user_nodes.status',
        sql`insert into user_nodes (id, user_id, endpoint, node_public_key, status)
            values (${randomUUID()}, ${await owner()}, 'https://n', 'pk', 'flaky')`,
      ],
      [
        'reputation_reviewing_reliability.scope',
        sql`insert into reputation_reviewing_reliability (balance_id, scope, key, reliability)
            values (${randomUUID()}, 'mood', 'k', 0.5)`,
      ],
    ];

    for (const [label, statement] of cases) {
      const error = await rejection(getDb().execute(statement));
      expect([label, pgErrorCode(error)]).toEqual([label, CHECK_VIOLATION]);
    }
  });
});

describe('reputation_rules', () => {
  it('holds one rule per action key', async () => {
    const actionType = `act-${randomUUID()}`;
    await getDb()
      .insert(reputationRules)
      .values({ actionType, points: 5, category: 'trust', description: 'd' });

    const error = await rejection(
      getDb()
        .insert(reputationRules)
        .values({ actionType, points: 9, category: 'social', description: 'd' })
    );

    expect(pgErrorCode(error)).toBe(UNIQUE_VIOLATION);
  });

  it('refuses a negative cooldown', async () => {
    const error = await rejection(
      getDb().insert(reputationRules).values({
        actionType: `act-${randomUUID()}`,
        points: 5,
        category: 'trust',
        description: 'd',
        cooldownInMinutes: -1,
      })
    );

    expect(pgErrorCode(error)).toBe(CHECK_VIOLATION);
  });
});
