/**
 * Reputation LEDGER semantics (#217) and the derived snapshot (#219), against a
 * real Postgres.
 *
 * The suite this replaces shipped a ~300-line hand-written Mongo emulator: nine
 * in-memory document stores, a `matchesQuery` that re-implemented `$gt`/`$in`/
 * `$exists`/`$ne`, chainable `sort/skip/limit/session/select/lean` stubs, and a
 * fake `.save()`. Every assertion was therefore a statement about that
 * emulator's fidelity, and its `expect(txnStore.docs.length).toBe(1)` checks
 * read the emulator's array rather than a table.
 *
 * The ledger's invariants are exactly the ones an emulator cannot vouch for:
 *
 *  - **Transactions are NEVER deleted.** A correction is a `reversed` original
 *    plus a compensating `active` entry, or a `voided` status flip — so the
 *    history stays auditable and the balance stays re-derivable.
 *  - **The balance is a RECOMPUTABLE CACHE**, always equal to the aggregate of
 *    the account's `active` transactions. Every case below re-reads it from the
 *    service after the write, and the reversal cases assert the pair nets to
 *    zero while BOTH rows survive in the table.
 *  - **The multi-write paths are atomic.** Postgres has real transactions in
 *    every deployment, so the Mongo `withTransaction` fallback that silently
 *    re-ran the work session-lessly is deleted rather than translated.
 *
 * Award idempotency on `(application_id, source_action_id)` and the
 * transactional atomicity of the award are covered against the partial unique
 * index in `reputationCivic.postgres.test.ts`; this suite deliberately does not
 * restate them and covers the arithmetic, the tiers and the corrections instead.
 *
 * The whole run shares one database, so every account and every rule carries a
 * per-test random key and no assertion depends on a table being empty.
 */

import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { applicationCredentials } from '../../db/schema/applicationCredentials';
import { applications } from '../../db/schema/applications';
import { reputationTransactions } from '../../db/schema/reputationTransactions';
import { users } from '../../db/schema/users';
import {
  INFLUENCE_MIN,
  INFLUENCE_MAX,
  REPORT_CONFIRMED_ACTION,
  REPORT_REJECTED_ACTION,
} from '../../utils/reputation.constants';
import reputationService from '../reputation.service';
import type { ReputationCategory } from '@oxyhq/contracts';

const uniqueId = () => randomUUID().replace(/-/g, '');

/** An action key no other test in the run can collide with. */
const actionKey = (label: string) => `${label}_${uniqueId().slice(0, 12)}`;

async function makeUser(verified = false): Promise<string> {
  const id = uniqueId();
  await getDb()
    .insert(users)
    .values({ id, username: `u${id}`, verified });
  return id;
}

/** A rule the service can resolve by `actionType`, written through the service. */
async function seedRule(
  actionType: string,
  points: number,
  category: ReputationCategory,
  cooldownInMinutes = 0
): Promise<string> {
  await reputationService.upsertRule({
    actionType,
    points,
    category,
    description: `${actionType} rule`,
    cooldownInMinutes,
    isEnabled: true,
  });
  return actionType;
}

/**
 * A real emitting application and one of its credentials.
 *
 * `reputation_transactions.application_id` / `.credential_id` are REAL foreign
 * keys now, which is itself part of the port's contract: a ledger row can no
 * longer name an application that does not exist. Seeding invented ids here
 * would fail the insert, so the provenance cases carry genuine rows.
 */
async function makeEmitter(): Promise<{ applicationId: string; credentialId: string }> {
  const [application] = await getDb()
    .insert(applications)
    .values({ name: `app-${uniqueId().slice(0, 8)}`, ownerAccountId: await makeUser() })
    .returning({ id: applications.id });

  const [credential] = await getDb()
    .insert(applicationCredentials)
    .values({
      applicationId: application.id,
      name: 'test credential',
      publicKey: `oxy_dk_${uniqueId()}`,
      type: 'service',
      environment: 'development',
    })
    .returning({ id: applicationCredentials.id });

  return { applicationId: application.id, credentialId: credential.id };
}

/** Ledger rows for one account, so "nothing was deleted" is checked directly. */
async function ledgerRows(userId: string) {
  return getDb()
    .select({
      id: reputationTransactions.id,
      points: reputationTransactions.points,
      status: reputationTransactions.status,
      reversedTransactionId: reputationTransactions.reversedTransactionId,
    })
    .from(reputationTransactions)
    .where(eq(reputationTransactions.userId, userId));
}

beforeAll(async () => {
  await connectPostgres();
});

afterAll(async () => {
  await closePostgres();
});

describe('award moves the balance by the rule’s points', () => {
  it('credits a positive transaction into its category and the total', async () => {
    const userId = await makeUser();
    const action = await seedRule(actionKey('post_created'), 5, 'content');

    await reputationService.award({ userId, actionType: action });
    const balance = await reputationService.getBalance(userId);

    expect(balance.total).toBe(5);
    expect(balance.positive).toBe(5);
    expect(balance.breakdown.content).toBe(5);
  });

  it('debits a negative transaction and restricts the tier', async () => {
    const userId = await makeUser();
    const action = await seedRule(actionKey('spam_flagged'), -10, 'penalty');

    await reputationService.award({ userId, actionType: action });
    const balance = await reputationService.getBalance(userId);

    expect(balance.total).toBe(-10);
    expect(balance.negative).toBe(-10);
    // `penalties` is the ABSOLUTE sum of negative points, across categories.
    expect(balance.breakdown.penalties).toBe(10);
    expect(balance.trustTier).toBe('restricted');
  });

  it('sums several awards across categories', async () => {
    const userId = await makeUser();
    const content = await seedRule(actionKey('content'), 10, 'content');
    const social = await seedRule(actionKey('social'), 3, 'social');
    const penalty = await seedRule(actionKey('penalty'), -4, 'penalty');

    await reputationService.award({ userId, actionType: content });
    await reputationService.award({ userId, actionType: social });
    await reputationService.award({ userId, actionType: penalty });

    const balance = await reputationService.getBalance(userId);
    expect(balance.total).toBe(9);
    expect(balance.positive).toBe(13);
    expect(balance.negative).toBe(-4);
    expect(balance.breakdown.content).toBe(10);
    expect(balance.breakdown.social).toBe(3);
    expect(balance.breakdown.penalties).toBe(4);
  });

  it('rejects an unknown action without writing a ledger row', async () => {
    const userId = await makeUser();

    await expect(
      reputationService.award({ userId, actionType: actionKey('nope') })
    ).rejects.toThrow(/Unknown or disabled/);
    expect(await ledgerRows(userId)).toEqual([]);
  });

  it('rejects a DISABLED action, which is the same refusal by a different route', async () => {
    const userId = await makeUser();
    const action = actionKey('retired');
    await reputationService.upsertRule({
      actionType: action,
      points: 5,
      category: 'content',
      description: 'retired rule',
      isEnabled: false,
    });

    await expect(reputationService.award({ userId, actionType: action })).rejects.toThrow(
      /Unknown or disabled/
    );
    expect(await ledgerRows(userId)).toEqual([]);
  });

  it('enforces the per-action cooldown and writes nothing on the refusal', async () => {
    const userId = await makeUser();
    const action = await seedRule(actionKey('daily_login'), 1, 'social', 60);

    await reputationService.award({ userId, actionType: action });
    await expect(reputationService.award({ userId, actionType: action })).rejects.toThrow(
      /cooldown/i
    );

    // The refusal must not have banked a second point.
    expect(await ledgerRows(userId)).toHaveLength(1);
    expect((await reputationService.getBalance(userId)).total).toBe(1);
  });

  it('scopes the cooldown to (user, action), not to the action alone', async () => {
    // A cooldown that ignored the subject would let one user's award block
    // everyone else's — a global rate limit wearing a per-user label.
    const action = await seedRule(actionKey('shared_cooldown'), 2, 'social', 60);
    const first = await makeUser();
    const second = await makeUser();

    await reputationService.award({ userId: first, actionType: action });
    await reputationService.award({ userId: second, actionType: action });

    expect((await reputationService.getBalance(second)).total).toBe(2);
  });

  it('records the emitting application and credential on the row', async () => {
    const userId = await makeUser();
    const action = await seedRule(actionKey('report_confirmed'), 8, 'moderation');
    const { applicationId, credentialId } = await makeEmitter();

    const txn = await reputationService.award({
      userId,
      actionType: action,
      applicationId,
      credentialId,
      sourceActionId: `src-${uniqueId()}`,
      sourceActionType: REPORT_CONFIRMED_ACTION,
    });

    expect(txn.applicationId).toBe(applicationId);
    expect(txn.credentialId).toBe(credentialId);
  });
});

describe('recalculateBalance re-derives the total from the ACTIVE rows', () => {
  it('excludes a void and nets a reversal pair to zero, deleting nothing', async () => {
    const userId = await makeUser();
    const a = await seedRule(actionKey('a'), 10, 'content');
    const b = await seedRule(actionKey('b'), 20, 'content');
    const c = await seedRule(actionKey('c'), 30, 'content');

    const txnA = await reputationService.award({ userId, actionType: a });
    const txnB = await reputationService.award({ userId, actionType: b });
    await reputationService.award({ userId, actionType: c });

    await reputationService.voidTransaction(txnA.id, {});
    await reputationService.reverseTransaction(txnB.id, {});

    const balance = await reputationService.recalculateBalance(userId);
    // a (10) voided → excluded; b (20) reversed, paired with its −20 → 0;
    // c (30) stays.
    expect(balance.total).toBe(30);
    expect(balance.breakdown.content).toBe(30);

    // The audit trail is intact: three originals plus one compensating entry.
    const rows = await ledgerRows(userId);
    expect(rows).toHaveLength(4);
    expect(rows.filter((row) => row.status === 'voided')).toHaveLength(1);
    expect(rows.filter((row) => row.status === 'reversed')).toHaveLength(1);
    expect(rows.filter((row) => row.status === 'active')).toHaveLength(2);
  });

  it('agrees with getBalance, so the cache never states a different total', async () => {
    // The balance table is a RECOMPUTABLE CACHE of the ledger. If the two ever
    // disagree, the cached one is what every consumer reads.
    const userId = await makeUser();
    const action = await seedRule(actionKey('cache'), 7, 'content');
    await reputationService.award({ userId, actionType: action });

    const recalculated = await reputationService.recalculateBalance(userId);
    const cached = await reputationService.getBalance(userId);

    expect(cached.total).toBe(recalculated.total);
    expect(cached.breakdown).toEqual(recalculated.breakdown);
    expect(cached.trustTier).toBe(recalculated.trustTier);
  });

  it('derives report reliability from the confirmed/rejected source actions', async () => {
    const userId = await makeUser();
    const confirmed = await seedRule(actionKey('rc'), 5, 'moderation');
    const rejected = await seedRule(actionKey('rr'), 5, 'moderation');
    const { applicationId } = await makeEmitter();

    for (let i = 0; i < 4; i += 1) {
      await reputationService.award({
        userId,
        actionType: confirmed,
        applicationId,
        sourceActionId: `c-${uniqueId()}`,
        sourceActionType: REPORT_CONFIRMED_ACTION,
      });
    }
    await reputationService.award({
      userId,
      actionType: rejected,
      applicationId,
      sourceActionId: `r-${uniqueId()}`,
      sourceActionType: REPORT_REJECTED_ACTION,
    });

    const balance = await reputationService.recalculateBalance(userId);
    expect(balance.reliability.accurateReports).toBe(4);
    expect(balance.reliability.rejectedReports).toBe(1);
    expect(balance.reliability.reportAccuracyScore).toBeCloseTo(0.8, 5);
  });

  it('counts reliability from ACTIVE rows only — a DISPUTED report stops counting', async () => {
    // "Reliability is derived from ACTIVE transactions only: cancelled
    // (reversed) or disputed reports do not count toward report accuracy."
    //
    // A `disputed` row is the discriminating fixture, and a `voided` one is NOT:
    // a void is already excluded by the query that loads the rows, so a suite
    // that only voids passes whether or not the per-row status branch exists.
    // `disputed` reaches the branch and must be skipped there.
    const userId = await makeUser();
    const confirmed = await seedRule(actionKey('rc_disputed'), 5, 'moderation');
    const { applicationId } = await makeEmitter();

    const awarded = [];
    for (let i = 0; i < 3; i += 1) {
      awarded.push(
        await reputationService.award({
          userId,
          actionType: confirmed,
          applicationId,
          sourceActionId: `c-${uniqueId()}`,
          sourceActionType: REPORT_CONFIRMED_ACTION,
        })
      );
    }

    expect((await reputationService.recalculateBalance(userId)).reliability.accurateReports).toBe(
      3
    );

    await reputationService.createDispute(awarded[0].id, userId, 'contested');

    expect((await reputationService.recalculateBalance(userId)).reliability.accurateReports).toBe(
      2
    );
  });

  it('reflects User.verified in the trust tier', async () => {
    const userId = await makeUser(true);
    const action = await seedRule(actionKey('x'), 1, 'content');
    await reputationService.award({ userId, actionType: action });

    expect((await reputationService.recalculateBalance(userId)).trustTier).toBe('verified');
  });

  it('ranks a negative total as restricted even for a verified account', async () => {
    // `restricted` sits ABOVE `verified` in the tier ladder: a verified badge
    // must not buy off a negative standing.
    const userId = await makeUser(true);
    const action = await seedRule(actionKey('bad'), -3, 'penalty');
    await reputationService.award({ userId, actionType: action });

    expect((await reputationService.recalculateBalance(userId)).trustTier).toBe('restricted');
  });

  it('counts only the subject’s own rows', async () => {
    const subject = await makeUser();
    const other = await makeUser();
    const action = await seedRule(actionKey('isolated'), 11, 'content');

    await reputationService.award({ userId: subject, actionType: action });
    await reputationService.award({ userId: other, actionType: action });

    expect((await reputationService.recalculateBalance(subject)).total).toBe(11);
    expect((await reputationService.recalculateBalance(other)).total).toBe(11);
  });
});

describe('a correction never deletes', () => {
  it('reverseTransaction marks the original and appends a compensating entry', async () => {
    const userId = await makeUser();
    const action = await seedRule(actionKey('p'), 15, 'content');
    const txn = await reputationService.award({ userId, actionType: action });

    const { original, reversal } = await reputationService.reverseTransaction(txn.id, {});

    expect(original.status).toBe('reversed');
    expect(reversal.points).toBe(-15);
    expect(reversal.status).toBe('active');
    expect(reversal.reversedTransactionId).toBe(original.id);

    // BOTH rows persist — this is the audit guarantee, and it is checked
    // against the table rather than against a returned object.
    const rows = await ledgerRows(userId);
    expect(rows).toHaveLength(2);
    expect(await reputationService.getBalance(userId)).toMatchObject({ total: 0 });
  });

  it('reversing twice appends no second compensating entry', async () => {
    const userId = await makeUser();
    const action = await seedRule(actionKey('twice'), 15, 'content');
    const txn = await reputationService.award({ userId, actionType: action });

    await reputationService.reverseTransaction(txn.id, {});
    await reputationService.reverseTransaction(txn.id, {});

    // A non-idempotent reversal would drive the total to −15 and read as a
    // penalty nobody issued.
    expect(await ledgerRows(userId)).toHaveLength(2);
    expect((await reputationService.getBalance(userId)).total).toBe(0);
  });

  it('voidTransaction excludes the row with NO compensating entry', async () => {
    const userId = await makeUser();
    const action = await seedRule(actionKey('q'), 25, 'content');
    const txn = await reputationService.award({ userId, actionType: action });

    const voided = await reputationService.voidTransaction(txn.id, {});

    expect(voided.status).toBe('voided');
    // The distinction from a reversal: one row, not two.
    expect(await ledgerRows(userId)).toHaveLength(1);
    expect((await reputationService.getBalance(userId)).total).toBe(0);
  });
});

describe('disputes', () => {
  it('createDispute marks the transaction disputed', async () => {
    const userId = await makeUser();
    const action = await seedRule(actionKey('d'), 7, 'content');
    const txn = await reputationService.award({ userId, actionType: action });

    const dispute = await reputationService.createDispute(txn.id, userId, 'This was wrong');

    expect(dispute.status).toBe('open');
    const [stored] = await getDb()
      .select({ status: reputationTransactions.status })
      .from(reputationTransactions)
      .where(eq(reputationTransactions.id, txn.id));
    expect(stored.status).toBe('disputed');
  });

  it('refuses a dispute of someone else’s transaction', async () => {
    const owner = await makeUser();
    const stranger = await makeUser();
    const action = await seedRule(actionKey('notyours'), 7, 'content');
    const txn = await reputationService.award({ userId: owner, actionType: action });

    await expect(
      reputationService.createDispute(txn.id, stranger, 'not mine')
    ).rejects.toThrow(/your own transactions/);

    const [stored] = await getDb()
      .select({ status: reputationTransactions.status })
      .from(reputationTransactions)
      .where(eq(reputationTransactions.id, txn.id));
    expect(stored.status).toBe('active');
  });

  it('accepting a dispute reverses the transaction', async () => {
    const userId = await makeUser();
    const action = await seedRule(actionKey('e'), 12, 'content');
    const txn = await reputationService.award({ userId, actionType: action });
    const dispute = await reputationService.createDispute(txn.id, userId, 'wrong');

    const resolved = await reputationService.resolveDispute(dispute.id, {
      status: 'accepted',
      resolvedByUserId: await makeUser(),
    });

    expect(resolved.status).toBe('accepted');
    const rows = await ledgerRows(userId);
    expect(rows.find((row) => row.id === txn.id)?.status).toBe('reversed');
    expect(rows).toHaveLength(2);
    expect((await reputationService.getBalance(userId)).total).toBe(0);
  });

  it('rejecting a dispute restores the transaction to active', async () => {
    const userId = await makeUser();
    const action = await seedRule(actionKey('f'), 9, 'content');
    const txn = await reputationService.award({ userId, actionType: action });
    const dispute = await reputationService.createDispute(txn.id, userId, 'wrong');

    const resolved = await reputationService.resolveDispute(dispute.id, {
      status: 'rejected',
      resolvedByUserId: await makeUser(),
    });

    expect(resolved.status).toBe('rejected');
    const rows = await ledgerRows(userId);
    expect(rows.find((row) => row.id === txn.id)?.status).toBe('active');
    // Restoring must not fabricate a compensating entry.
    expect(rows).toHaveLength(1);
    expect((await reputationService.getBalance(userId)).total).toBe(9);
  });

  it('cannot dispute a transaction that was already reversed', async () => {
    const userId = await makeUser();
    const action = await seedRule(actionKey('gone'), 4, 'content');
    const txn = await reputationService.award({ userId, actionType: action });
    await reputationService.reverseTransaction(txn.id, {});

    await expect(reputationService.createDispute(txn.id, userId, 'late')).rejects.toThrow(
      /no longer be disputed/
    );
  });
});

describe('getInfluence', () => {
  it('answers the context-specific weight, inside the clamp', async () => {
    const userId = await makeUser();
    const action = await seedRule(actionKey('g'), 50, 'content');
    await reputationService.award({ userId, actionType: action });

    const byContext = await Promise.all(
      (['default', 'report', 'moderation', 'ranking'] as const).map((context) =>
        reputationService.getInfluence(userId, context)
      )
    );

    for (const result of byContext) {
      expect(result.weight).toBeGreaterThanOrEqual(INFLUENCE_MIN);
      expect(result.weight).toBeLessThanOrEqual(INFLUENCE_MAX);
    }
    expect(byContext.map((result) => result.context)).toEqual([
      'default',
      'report',
      'moderation',
      'ranking',
    ]);

    // Each context reads its OWN axis off the influence block — a switch that
    // fell through would return the default weight everywhere.
    const { influence } = byContext[0];
    expect(byContext.map((result) => result.weight)).toEqual([
      influence.defaultWeight,
      influence.reportWeight,
      influence.moderationWeight,
      influence.rankingFeedbackWeight,
    ]);
  });

  it('floors every axis of a restricted account to the minimum', async () => {
    const userId = await makeUser();
    const action = await seedRule(actionKey('h'), -5, 'penalty');
    await reputationService.award({ userId, actionType: action });

    for (const context of ['default', 'report', 'moderation', 'ranking'] as const) {
      expect((await reputationService.getInfluence(userId, context)).weight).toBe(INFLUENCE_MIN);
    }
  });
});

describe('the ledger row records what it was awarded for', () => {
  it('carries the source action, target entity and category', async () => {
    const userId = await makeUser();
    const action = await seedRule(actionKey('provenance'), 6, 'trust');
    const targetEntityId = uniqueId();
    const { applicationId } = await makeEmitter();
    const sourceActionId = `src-${uniqueId()}`;

    await reputationService.award({
      userId,
      actionType: action,
      applicationId,
      sourceActionId,
      sourceActionType: REPORT_CONFIRMED_ACTION,
      targetEntityId,
      targetEntityType: 'post',
    });

    const [row] = await getDb()
      .select()
      .from(reputationTransactions)
      .where(
        and(
          eq(reputationTransactions.userId, userId),
          eq(reputationTransactions.sourceActionId, sourceActionId)
        )
      );

    expect(row).toMatchObject({
      actionType: action,
      points: 6,
      category: 'trust',
      status: 'active',
      sourceActionType: REPORT_CONFIRMED_ACTION,
      targetEntityId,
      targetEntityType: 'post',
      applicationId,
    });
  });
});
