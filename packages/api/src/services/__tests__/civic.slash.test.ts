/**
 * `slashForReversedTransaction` — the staking loop, against a REAL Postgres.
 *
 * This is what makes the civic signals expensive to game: when a civic award is
 * reversed as fraud, everyone who VOUCHED for it loses reputation. The suite it
 * replaces mocked `ValidationRequest.findOne` / `ValidationVote.find` and
 * asserted on the ARGUMENTS handed to a mocked `award` — so it proved a call was
 * shaped a certain way, never that a penalty was recorded, and it could not have
 * caught the failure that actually matters here: slashing the WRONG jurors. The
 * fixture returned whatever rows the test named, `verdict` included, so a query
 * that forgot `verdict = 'valid'` and slashed the dissenters too would have
 * passed.
 *
 * Rewritten around real rows and real ledger writes. Every jury below therefore
 * contains a juror who voted `valid`, one who voted `invalid` and one who
 * abstained, and each assertion states both who was slashed and who was not.
 */

import { randomUUID } from 'node:crypto';
import { generateSecp256k1KeyPair } from '@oxyhq/protocol/secp256k1';
import { and, eq } from 'drizzle-orm';
import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { personhoodVouches } from '../../db/schema/personhoodVouches';
import { reputationTransactions } from '../../db/schema/reputationTransactions';
import { users } from '../../db/schema/users';
import { validationRequests } from '../../db/schema/validationRequests';
import { validationVotes } from '../../db/schema/validationVotes';
import { buildUserDid } from '../did.service';
import { getHead } from '../repoLog.service';
import { reputationService } from '../reputation.service';
import { signRecordEnvelope, verifyAndStoreRecord } from '../signedRecord.service';
import { slashForReversedTransaction } from '../civic/slash.service';
import {
  PEER_VALIDATED_ACTION,
  VALIDATION_INCORRECT_ACTION,
  VALIDATION_INCORRECT_POINTS,
  VOUCH_SLASHED_ACTION,
  VOUCH_SLASHED_POINTS,
} from '../../utils/reputation.constants';

const unique = () => randomUUID();

interface Signer {
  id: string;
  privateKey: string;
  publicKey: string;
}

/** An account holding a signing key, so its verdict/vouch envelopes verify. */
async function signer(): Promise<Signer> {
  const keyPair = generateSecp256k1KeyPair();
  const publicKey = keyPair.publicKey;
  const [row] = await getDb()
    .insert(users)
    .values({ username: `u-${unique().slice(0, 18)}`, publicKey })
    .returning({ id: users.id });
  return { id: row.id, privateKey: keyPair.privateKey, publicKey };
}

/** A plain account with no signing key. */
async function account(): Promise<string> {
  const [row] = await getDb()
    .insert(users)
    .values({ username: `u-${unique().slice(0, 18)}` })
    .returning({ id: users.id });
  return row.id;
}

/**
 * Append a real v2 record to `author`'s own chain and return its content
 * address. `validation_votes.record_id` and `personhood_vouches.record_id` are
 * genuine foreign keys, so a projection cannot be seeded without the proof.
 */
async function chainRecord(
  author: Signer,
  type: 'validation_verdict' | 'personhood_vouch',
  collection: string,
  rkey: string,
  record: Record<string, unknown>
): Promise<{ recordId: string; envelope: ReturnType<typeof signRecordEnvelope> }> {
  const head = await getHead(author.id);
  const envelope = signRecordEnvelope(
    {
      version: 2,
      type,
      subject: buildUserDid(author.id),
      issuer: buildUserDid(author.id),
      record,
      issuedAt: Date.now(),
      seq: head ? head.seq + 1 : 0,
      prev: head ? head.headRecordId : null,
      collection,
      rkey,
      publicKey: author.publicKey,
      alg: 'ES256K-DER-SHA256',
    },
    author.privateKey
  );
  const stored = await verifyAndStoreRecord(envelope, author.id);
  if (!stored.ok) {
    throw new Error(`chain fixture failed to store: ${stored.reason}`);
  }
  return { recordId: stored.record.recordId, envelope };
}

/** A resolved `peer_validated` ledger row, without going through `award`. */
async function peerValidatedTransaction(subjectUserId: string): Promise<string> {
  const [row] = await getDb()
    .insert(reputationTransactions)
    .values({
      userId: subjectUserId,
      points: 8,
      actionType: PEER_VALIDATED_ACTION,
      category: 'trust',
      status: 'active',
    })
    .returning({ id: reputationTransactions.id });
  return row.id;
}

/** A tallied validation request bound to `resolvedTxnId`, with its jury's votes. */
async function resolvedRequest(
  subjectUserId: string,
  resolvedTxnId: string,
  votes: Array<{ juror: Signer; verdict: 'valid' | 'invalid' | 'abstain' }>
): Promise<string> {
  const [request] = await getDb()
    .insert(validationRequests)
    .values({
      subjectUserId,
      actionType: PEER_VALIDATED_ACTION,
      sourceActionId: `src-${unique()}`,
      payload: { claim: 'probe' },
      payloadHash: `hash-${unique()}`,
      status: 'validated',
      outcome: 'validated',
      quorum: 3,
      threshold: 3,
      rngSeed: unique().replace(/-/g, ''),
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      resolvedTxnId,
    })
    .returning({ id: validationRequests.id });

  for (const vote of votes) {
    const { recordId, envelope } = await chainRecord(
      vote.juror,
      'validation_verdict',
      'app.oxy.validation',
      request.id,
      { requestId: request.id, verdict: vote.verdict }
    );
    await getDb().insert(validationVotes).values({
      requestId: request.id,
      validatorUserId: vote.juror.id,
      verdict: vote.verdict,
      envelope,
      publicKey: vote.juror.publicKey,
      recordId,
    });
  }
  return request.id;
}

/** A real, active personhood vouch by `voucher` for `subjectUserId`. */
async function vouch(voucher: Signer, subjectUserId: string, status: 'active' | 'withdrawn'): Promise<string> {
  const { recordId } = await chainRecord(
    voucher,
    'personhood_vouch',
    'app.oxy.personhood',
    subjectUserId,
    { about: buildUserDid(subjectUserId), stake: 10 }
  );
  const [row] = await getDb()
    .insert(personhoodVouches)
    .values({
      voucherUserId: voucher.id,
      subjectUserId,
      stakeAmount: 10,
      recordId,
      status,
    })
    .returning({ id: personhoodVouches.id });
  return row.id;
}

/** The ledger rows of one action type belonging to one account. */
async function ledger(userId: string, actionType: string): Promise<Array<{ points: number }>> {
  return getDb()
    .select({ points: reputationTransactions.points })
    .from(reputationTransactions)
    .where(
      and(
        eq(reputationTransactions.userId, userId),
        eq(reputationTransactions.actionType, actionType)
      )
    );
}

beforeAll(async () => {
  await connectPostgres();
  // `award` resolves points from a rule row, so the civic rules have to exist
  // before any slash can be recorded. Idempotent by `action_type`.
  await reputationService.seedDefaultRules();
});

afterAll(async () => {
  await closePostgres();
});

describe('a reversed peer_validated slashes the jurors who endorsed it', () => {
  it('penalises the valid-voting jurors and NOBODY else', async () => {
    const subject = await account();
    const endorsedA = await signer();
    const endorsedB = await signer();
    const dissented = await signer();
    const abstained = await signer();
    const txnId = await peerValidatedTransaction(subject);
    await resolvedRequest(subject, txnId, [
      { juror: endorsedA, verdict: 'valid' },
      { juror: endorsedB, verdict: 'valid' },
      { juror: dissented, verdict: 'invalid' },
      { juror: abstained, verdict: 'abstain' },
    ]);

    const slashed = await slashForReversedTransaction({
      id: txnId,
      actionType: PEER_VALIDATED_ACTION,
      userId: subject,
    });

    expect(slashed).toBe(2);
    // Exact non-zero for the endorsers…
    expect(await ledger(endorsedA.id, VALIDATION_INCORRECT_ACTION)).toEqual([
      { points: VALIDATION_INCORRECT_POINTS },
    ]);
    expect(await ledger(endorsedB.id, VALIDATION_INCORRECT_ACTION)).toEqual([
      { points: VALIDATION_INCORRECT_POINTS },
    ]);
    // …and nothing at all for the juror who said no, the one who abstained, or
    // the subject of the reversed award.
    expect(await ledger(dissented.id, VALIDATION_INCORRECT_ACTION)).toEqual([]);
    expect(await ledger(abstained.id, VALIDATION_INCORRECT_ACTION)).toEqual([]);
    expect(await ledger(subject, VALIDATION_INCORRECT_ACTION)).toEqual([]);
  });

  it('slashes only the jury of the request bound to THIS transaction', async () => {
    // Two tallied requests exist for the same subject; only one resolved the
    // transaction being reversed. A lookup that matched on subject or action
    // type instead of `resolved_txn_id` would slash both juries.
    const subject = await account();
    const ours = await signer();
    const theirs = await signer();
    const reversedTxnId = await peerValidatedTransaction(subject);
    const otherTxnId = await peerValidatedTransaction(subject);
    await resolvedRequest(subject, reversedTxnId, [{ juror: ours, verdict: 'valid' }]);
    await resolvedRequest(subject, otherTxnId, [{ juror: theirs, verdict: 'valid' }]);

    const slashed = await slashForReversedTransaction({
      id: reversedTxnId,
      actionType: PEER_VALIDATED_ACTION,
      userId: subject,
    });

    expect(slashed).toBe(1);
    expect(await ledger(ours.id, VALIDATION_INCORRECT_ACTION)).toHaveLength(1);
    expect(await ledger(theirs.id, VALIDATION_INCORRECT_ACTION)).toEqual([]);
  });

  it('slashes nobody when no request resolved the transaction', async () => {
    const subject = await account();
    const juror = await signer();
    // A jury exists — for a DIFFERENT transaction — so "no rows" here is a real
    // miss rather than an empty table.
    await resolvedRequest(subject, await peerValidatedTransaction(subject), [
      { juror, verdict: 'valid' },
    ]);

    const orphanTxnId = await peerValidatedTransaction(subject);
    expect(
      await slashForReversedTransaction({
        id: orphanTxnId,
        actionType: PEER_VALIDATED_ACTION,
        userId: subject,
      })
    ).toBe(0);
    expect(await ledger(juror.id, VALIDATION_INCORRECT_ACTION)).toEqual([]);
  });
});

describe('a reversed real_life_attested slashes the counterparty', () => {
  it('penalises the attestor named on the transaction, not the subject', async () => {
    const subject = await account();
    const attestor = await account();
    // The reversed row itself is only an idempotency key on this branch — the
    // counterparty comes from `created_by_user_id`, not from any lookup.
    const txnId = await peerValidatedTransaction(subject);

    const slashed = await slashForReversedTransaction({
      id: txnId,
      actionType: 'real_life_attested',
      userId: subject,
      createdByUserId: attestor,
    });

    expect(slashed).toBe(1);
    expect(await ledger(attestor, VALIDATION_INCORRECT_ACTION)).toEqual([
      { points: VALIDATION_INCORRECT_POINTS },
    ]);
    expect(await ledger(subject, VALIDATION_INCORRECT_ACTION)).toEqual([]);
  });

  it('slashes nobody when the transaction records no attestor', async () => {
    const subject = await account();
    const txnId = await peerValidatedTransaction(subject);

    expect(
      await slashForReversedTransaction({
        id: txnId,
        actionType: 'real_life_attested',
        userId: subject,
        createdByUserId: null,
      })
    ).toBe(0);
    expect(await ledger(subject, VALIDATION_INCORRECT_ACTION)).toEqual([]);
  });
});

describe('a reversed personhood_vouched cascades to every active voucher', () => {
  it('slashes the active vouchers, flips their vouches, and leaves a withdrawn one alone', async () => {
    const subject = await account();
    const activeA = await signer();
    const activeB = await signer();
    const withdrawn = await signer();
    const activeAId = await vouch(activeA, subject, 'active');
    const activeBId = await vouch(activeB, subject, 'active');
    const withdrawnId = await vouch(withdrawn, subject, 'withdrawn');

    const slashed = await slashForReversedTransaction({
      id: await peerValidatedTransaction(subject),
      actionType: 'personhood_vouched',
      userId: subject,
    });

    expect(slashed).toBe(2);
    // The cascade owns the penalty — it is `vouch_slashed` (−20), NOT the
    // `validation_incorrect` (−10) the other two branches apply.
    expect(await ledger(activeA.id, VOUCH_SLASHED_ACTION)).toEqual([
      { points: VOUCH_SLASHED_POINTS },
    ]);
    expect(await ledger(activeB.id, VOUCH_SLASHED_ACTION)).toEqual([
      { points: VOUCH_SLASHED_POINTS },
    ]);
    expect(await ledger(activeA.id, VALIDATION_INCORRECT_ACTION)).toEqual([]);
    // Someone who had already withdrawn their stake is not slashed for it.
    expect(await ledger(withdrawn.id, VOUCH_SLASHED_ACTION)).toEqual([]);

    const statuses = await getDb()
      .select({ id: personhoodVouches.id, status: personhoodVouches.status })
      .from(personhoodVouches)
      .where(eq(personhoodVouches.subjectUserId, subject));
    expect(new Map(statuses.map((row) => [row.id, row.status]))).toEqual(
      new Map([
        [activeAId, 'slashed'],
        [activeBId, 'slashed'],
        [withdrawnId, 'withdrawn'],
      ])
    );
  });
});

describe('a reversal that is not civic slashes nobody', () => {
  it('leaves the jury of an unrelated action untouched', async () => {
    const subject = await account();
    const juror = await signer();
    const voucher = await signer();
    // Both cascades have something to find, so a branch that ignored
    // `actionType` would light up.
    const txnId = await peerValidatedTransaction(subject);
    await resolvedRequest(subject, txnId, [{ juror, verdict: 'valid' }]);
    await vouch(voucher, subject, 'active');

    expect(
      await slashForReversedTransaction({
        id: txnId,
        actionType: 'endorsement_received',
        userId: subject,
      })
    ).toBe(0);
    expect(await ledger(juror.id, VALIDATION_INCORRECT_ACTION)).toEqual([]);
    expect(await ledger(voucher.id, VOUCH_SLASHED_ACTION)).toEqual([]);
  });
});

describe('the hook really fires from reverseTransaction', () => {
  it('slashes the endorsing jurors when the award is reversed for real', async () => {
    // The wiring is a dynamically-imported, non-fatal hook — precisely the shape
    // that can silently stop firing. Driving it end to end is the only way to
    // see that it still does.
    const subject = await account();
    const endorsed = await signer();
    const dissented = await signer();
    const award = await reputationService.award({
      userId: subject,
      actionType: PEER_VALIDATED_ACTION,
      reason: 'Jury verdict',
    });
    await resolvedRequest(subject, award.id, [
      { juror: endorsed, verdict: 'valid' },
      { juror: dissented, verdict: 'invalid' },
    ]);

    await reputationService.reverseTransaction(award.id, { reason: 'Proven fraudulent' });

    expect(await ledger(endorsed.id, VALIDATION_INCORRECT_ACTION)).toEqual([
      { points: VALIDATION_INCORRECT_POINTS },
    ]);
    expect(await ledger(dissented.id, VALIDATION_INCORRECT_ACTION)).toEqual([]);
  });
});
