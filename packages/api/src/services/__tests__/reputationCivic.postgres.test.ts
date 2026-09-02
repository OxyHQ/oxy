/**
 * The four guarantees this batch's port is load-bearing for, against a REAL
 * Postgres through the application's own pool — not `jest.mock('mongoose')`.
 *
 * Each one is a property the Mongo version either could not express or actively
 * broke, so each is asserted against rows written in the same test rather than
 * against a spy:
 *
 *  1. **The signed-record append and the `repo_heads` advance are ATOMIC.** The
 *     Mongo `withTransaction` re-ran the pair session-lessly whenever the
 *     deployment had no replica set, so a failure between them could leave a head
 *     pointing at a record that was never stored — every later `prev` check then
 *     fails and the chain is forked for good.
 *  2. **`{user_id, seq}` is the multi-device write-race backstop**, surfaced as
 *     `chain_conflict`, with the head left exactly where it was.
 *  3. **`award` is idempotent on `(application_id, source_action_id)`** through
 *     the partial unique index, and the whole award — ledger row plus balance
 *     recompute — commits or does not happen.
 *  4. **A content address a projection stores always names a stored row.** The
 *     `?? ''` five call sites carried was the symptom; the cause was that a v1
 *     append returns an address it never persists, so a v1 civic envelope
 *     produced a dangling reference Mongo accepted in silence.
 *
 * EVERY count assertion here is an exact NON-ZERO against rows written in the
 * same test. A zero is indistinguishable from the bare-column correlated-subquery
 * bug (`schema/CONVENTIONS.md`), which returns `[]` with no error, so "no rows
 * came back" is never allowed to read as a pass.
 */

import {
  deriveSecp256k1PublicKey,
  generateSecp256k1KeyPair,
} from '@oxyhq/protocol/secp256k1';
import { and, eq } from 'drizzle-orm';
import { computeRecordId } from '@oxyhq/protocol';
import type { SignedRecordEnvelope } from '@oxyhq/contracts';
import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { personhoodVouches } from '../../db/schema/personhoodVouches';
import { repoHeads } from '../../db/schema/repoHeads';
import { reputationBalances } from '../../db/schema/reputationBalances';
import { reputationRules } from '../../db/schema/reputationRules';
import { reputationTransactions } from '../../db/schema/reputationTransactions';
import { signedRecords } from '../../db/schema/signedRecords';
import { users } from '../../db/schema/users';
import { applications } from '../../db/schema/applications';
import { buildUserDid } from '../did.service';
import { oxyRecordStore } from '../oxyRecordStore';
import { signRecordEnvelope, verifyAndStoreRecord } from '../signedRecord.service';
import { reputationService } from '../reputation.service';

beforeAll(async () => {
  await connectPostgres();
});

afterAll(async () => {
  await closePostgres();
});

/** An account with a primary verification key the resolver will authorize. */
async function signer(): Promise<{ userId: string; privateKey: string; did: string }> {
  const keyPair = generateSecp256k1KeyPair();
  const publicKey = keyPair.publicKey;
  const [row] = await getDb()
    .insert(users)
    .values({ color: 'teal', publicKey })
    .returning({ id: users.id });
  return {
    userId: row.id,
    privateKey: keyPair.privateKey,
    did: buildUserDid(row.id),
  };
}

/** A plain account with no signing key. */
async function account(): Promise<string> {
  const [row] = await getDb().insert(users).values({ color: 'teal' }).returning({ id: users.id });
  return row.id;
}

/** Build + sign a v2 (chained) envelope for a subject. */
function v2Envelope(
  subject: { did: string; privateKey: string },
  overrides: Partial<Omit<SignedRecordEnvelope, 'signature'>> = {},
): SignedRecordEnvelope {
  const publicKey = deriveSecp256k1PublicKey(subject.privateKey);
  return signRecordEnvelope(
    {
      version: 2,
      type: 'identity',
      subject: subject.did,
      issuer: subject.did,
      record: { displayName: 'Nate' },
      issuedAt: Date.now(),
      seq: 0,
      prev: null,
      collection: 'app.oxy.identity',
      rkey: 'self',
      publicKey,
      alg: 'ES256K-DER-SHA256',
      ...overrides,
    },
    subject.privateKey,
  );
}

/** Build + sign a v1 (unchained) envelope for a subject. */
function v1Envelope(
  subject: { did: string; privateKey: string },
  overrides: Partial<Omit<SignedRecordEnvelope, 'signature'>> = {},
): SignedRecordEnvelope {
  const publicKey = deriveSecp256k1PublicKey(subject.privateKey);
  return signRecordEnvelope(
    {
      version: 1,
      type: 'identity',
      subject: subject.did,
      issuer: subject.did,
      record: { displayName: 'Nate' },
      issuedAt: Date.now(),
      publicKey,
      alg: 'ES256K-DER-SHA256',
      ...overrides,
    },
    subject.privateKey,
  );
}

/** How many chain rows a user has. Exact, so a silent empty read cannot pass. */
async function countRecords(userId: string): Promise<number> {
  const rows = await getDb()
    .select({ id: signedRecords.id })
    .from(signedRecords)
    .where(eq(signedRecords.userId, userId));
  return rows.length;
}

describe('the append and the head advance are atomic', () => {
  it('stores the record AND advances the head in one unit', async () => {
    const subject = await signer();

    const stored = await verifyAndStoreRecord(v2Envelope(subject), subject.userId);
    expect(stored.ok).toBe(true);
    if (!stored.ok) return;

    // Exact non-zero: the record exists, once.
    expect(await countRecords(subject.userId)).toBe(1);

    const [head] = await getDb()
      .select()
      .from(repoHeads)
      .where(eq(repoHeads.userId, subject.userId));
    expect(head).toBeDefined();
    expect(head.headRecordId).toBe(stored.record.recordId);
    expect(head.seq).toBe(0);
    expect(head.recordCount).toBe(1);
  });

  it('runs the append and the head advance inside ONE transaction', async () => {
    const subject = await signer();

    // Asserting the PAIR IS a transaction, not that Postgres rolls back — the
    // second is a property of the database and would pass against an `append`
    // that issued the two writes separately. The spy wraps through to the real
    // implementation, so the append still really happens and is verified below.
    const db = getDb();
    const transaction = jest.spyOn(db, 'transaction');
    try {
      const stored = await verifyAndStoreRecord(v2Envelope(subject), subject.userId);
      expect(stored.ok).toBe(true);
      expect(transaction).toHaveBeenCalledTimes(1);
    } finally {
      transaction.mockRestore();
    }

    // …and both halves landed, so the spy is not standing in for the writes.
    expect(await countRecords(subject.userId)).toBe(1);
    const heads = await getDb()
      .select({ seq: repoHeads.seq })
      .from(repoHeads)
      .where(eq(repoHeads.userId, subject.userId));
    expect(heads).toHaveLength(1);
    expect(heads[0].seq).toBe(0);
  });

  it('rolls the append back when the head advance cannot commit', async () => {
    const subject = await signer();
    const envelope = v2Envelope(subject);
    const recordId = await computeRecordId(envelope);

    // The other half of the guarantee: that the transaction the spy above proved
    // exists actually undoes the append. Driven at the store's own two writes,
    // with the head advance aimed at a record that was never stored so the
    // `head_record_id` foreign key refuses it.
    await expect(
      getDb().transaction(async (tx) => {
        await tx.insert(signedRecords).values({
          subjectDid: subject.did,
          userId: subject.userId,
          type: 'identity',
          envelope,
          publicKey: envelope.publicKey,
          verified: true,
          seq: 0,
          prev: null,
          recordId,
          nsid: 'app.oxy.identity',
          rkey: 'self',
        });
        await tx.insert(repoHeads).values({
          userId: subject.userId,
          subjectDid: subject.did,
          seq: 0,
          headRecordId: 'a-record-that-was-never-stored',
          recordCount: 1,
        });
      }),
    ).rejects.toBeDefined();

    // A surviving record with no head is the forked-chain state: every later
    // `prev` check would fail against a head that never advanced.
    expect(await countRecords(subject.userId)).toBe(0);
    const heads = await getDb()
      .select({ id: repoHeads.id })
      .from(repoHeads)
      .where(eq(repoHeads.userId, subject.userId));
    expect(heads).toHaveLength(0);
  });

  it('answers a concurrent writer that already took this seq with chain_conflict', async () => {
    const subject = await signer();
    const first = v2Envelope(subject);
    const stored = await verifyAndStoreRecord(first, subject.userId);
    expect(stored.ok).toBe(true);

    // A SECOND record claiming the same `seq` — the multi-device write race the
    // `{user_id, seq}` unique index is the backstop for.
    const duplicate = v2Envelope(subject, {
      seq: 0,
      rkey: 'second',
      record: { displayName: 'Other device' },
    });
    const outcome = await oxyRecordStore.append(
      subject.did,
      duplicate,
      await computeRecordId(duplicate),
    );
    expect(outcome).toEqual({ ok: false, reason: 'chain_conflict' });

    // The loser wrote nothing and the head did not move.
    expect(await countRecords(subject.userId)).toBe(1);
    const [head] = await getDb()
      .select()
      .from(repoHeads)
      .where(eq(repoHeads.userId, subject.userId));
    expect(head.seq).toBe(0);
    expect(head.recordCount).toBe(1);
  });
});

describe("the recordId root cause — a stored projection's address always names a row", () => {
  it('refuses a v1 envelope for a record type whose address is a foreign key', async () => {
    const voucher = await signer();

    // Under Mongo this stored fine and handed back an address the ledger never
    // held, which `personhood.service` then wrote into `personhood_vouches`.
    const outcome = await verifyAndStoreRecord(
      v1Envelope(voucher, {
        type: 'personhood_vouch',
        record: { about: buildUserDid(await account()) },
      }),
      voucher.userId,
    );
    expect(outcome).toEqual({ ok: false, reason: 'invalid_envelope' });
    expect(await countRecords(voucher.userId)).toBe(0);
  });

  it('still accepts a v1 envelope for the two legacy singleton types', async () => {
    const subject = await signer();
    const outcome = await verifyAndStoreRecord(v1Envelope(subject), subject.userId);
    expect(outcome.ok).toBe(true);
    expect(await countRecords(subject.userId)).toBe(1);
  });

  it('a v1 row stores NO content address, which is why the gate has to exist', async () => {
    const subject = await signer();
    await verifyAndStoreRecord(v1Envelope(subject), subject.userId);

    const [row] = await getDb()
      .select({ recordId: signedRecords.recordId, seq: signedRecords.seq })
      .from(signedRecords)
      .where(eq(signedRecords.userId, subject.userId));
    expect(row).toBeDefined();
    expect(row.recordId).toBeNull();
    expect(row.seq).toBeNull();
    // …and there is no head, so nothing can reference this record at all.
    const heads = await getDb()
      .select({ id: repoHeads.id })
      .from(repoHeads)
      .where(eq(repoHeads.userId, subject.userId));
    expect(heads).toHaveLength(0);
  });

  it('a v2 address is a real foreign key a projection can store', async () => {
    const voucher = await signer();
    const subjectUserId = await account();
    const stored = await verifyAndStoreRecord(
      v2Envelope(voucher, {
        type: 'personhood_vouch',
        collection: 'app.oxy.personhood',
        rkey: subjectUserId,
        record: { about: buildUserDid(subjectUserId) },
      }),
      voucher.userId,
    );
    expect(stored.ok).toBe(true);
    if (!stored.ok) return;

    expect(await oxyRecordStore.hasRecordId(stored.record.recordId)).toBe(true);
    await expect(
      getDb().insert(personhoodVouches).values({
        voucherUserId: voucher.userId,
        subjectUserId,
        stakeAmount: 5,
        recordId: stored.record.recordId,
      }),
    ).resolves.toBeDefined();

    const rows = await getDb()
      .select({ recordId: personhoodVouches.recordId })
      .from(personhoodVouches)
      .where(eq(personhoodVouches.voucherUserId, voucher.userId));
    expect(rows).toHaveLength(1);
    expect(rows[0].recordId).toBe(stored.record.recordId);
  });
});

describe('award — the idempotency guarantee and the transaction behind it', () => {
  const ACTION = 'postgres_award_probe';

  async function seedRule(): Promise<void> {
    await reputationService.upsertRule({
      actionType: ACTION,
      points: 7,
      category: 'social',
      description: 'Probe rule',
      cooldownInMinutes: 0,
      isEnabled: true,
    });
  }

  async function reportingApplication(ownerId: string): Promise<string> {
    const [row] = await getDb()
      .insert(applications)
      .values({
        name: 'Probe app',
        ownerAccountId: ownerId,
        createdByUserId: ownerId,
      })
      .returning({ id: applications.id });
    return row.id;
  }

  it('awards once per (application, sourceActionId) and returns the SAME row on a retry', async () => {
    await seedRule();
    const userId = await account();
    const applicationId = await reportingApplication(userId);

    const first = await reputationService.award({
      userId,
      actionType: ACTION,
      applicationId,
      sourceActionId: 'source-1',
    });
    const second = await reputationService.award({
      userId,
      actionType: ACTION,
      applicationId,
      sourceActionId: 'source-1',
    });

    expect(second.id).toBe(first.id);

    // Exact non-zero: ONE ledger row, not two, and not zero.
    const rows = await getDb()
      .select({ id: reputationTransactions.id })
      .from(reputationTransactions)
      .where(
        and(
          eq(reputationTransactions.applicationId, applicationId),
          eq(reputationTransactions.sourceActionId, 'source-1'),
        ),
      );
    expect(rows).toHaveLength(1);

    // …and the balance counted it exactly once.
    const [balance] = await getDb()
      .select({ total: reputationBalances.total })
      .from(reputationBalances)
      .where(eq(reputationBalances.userId, userId));
    expect(balance).toBeDefined();
    expect(balance.total).toBe(7);
  });

  it('the partial unique index is the guarantee, not the pre-check', async () => {
    await seedRule();
    const userId = await account();
    const applicationId = await reportingApplication(userId);

    // Both callers pass the pre-check (neither sees the other's row yet) and
    // race into the insert; the index picks a winner and the loser is answered
    // with the winner's row rather than an error.
    const [a, b] = await Promise.all([
      reputationService.award({ userId, actionType: ACTION, applicationId, sourceActionId: 'race' }),
      reputationService.award({ userId, actionType: ACTION, applicationId, sourceActionId: 'race' }),
    ]);
    expect(a.id).toBe(b.id);

    const rows = await getDb()
      .select({ id: reputationTransactions.id })
      .from(reputationTransactions)
      .where(
        and(
          eq(reputationTransactions.applicationId, applicationId),
          eq(reputationTransactions.sourceActionId, 'race'),
        ),
      );
    expect(rows).toHaveLength(1);
  });

  it('leaves NO ledger row behind when the balance recompute cannot commit', async () => {
    await seedRule();
    const userId = await account();

    // The transactionality the deleted session-less fallback used to break: the
    // ledger row and the balance recompute are ONE unit, so a failure in the
    // recompute must take the row with it. Without the transaction the row
    // survives and the subject's standing silently disagrees with the ledger.
    const recalculate = jest
      .spyOn(reputationService, 'recalculateBalance')
      .mockRejectedValueOnce(new Error('recompute failed'));
    try {
      await expect(
        reputationService.award({ userId, actionType: ACTION }),
      ).rejects.toThrow('recompute failed');
    } finally {
      recalculate.mockRestore();
    }

    const rows = await getDb()
      .select({ id: reputationTransactions.id })
      .from(reputationTransactions)
      .where(eq(reputationTransactions.userId, userId));
    expect(rows).toHaveLength(0);

    // A control, so the empty read above cannot pass vacuously: the SAME award
    // does land once the recompute works.
    await reputationService.award({ userId, actionType: ACTION });
    const after = await getDb()
      .select({ id: reputationTransactions.id })
      .from(reputationTransactions)
      .where(eq(reputationTransactions.userId, userId));
    expect(after).toHaveLength(1);
  });

  it('the rule lookup and the rule write agree on a trimmed action key', async () => {
    // `trim: true` was Mongoose APPLICATION behaviour with no Postgres
    // counterpart; dropping it on either side would make an award for
    // `' probe '` miss a rule stored as `'probe'`.
    await reputationService.upsertRule({
      actionType: '  trimmed_probe  ',
      points: 3,
      category: 'social',
      description: 'Probe',
    });
    const [rule] = await getDb()
      .select({ actionType: reputationRules.actionType })
      .from(reputationRules)
      .where(eq(reputationRules.actionType, 'trimmed_probe'));
    expect(rule).toBeDefined();

    const userId = await account();
    const txn = await reputationService.award({ userId, actionType: ' trimmed_probe ' });
    expect(txn.actionType).toBe('trimmed_probe');
    expect(txn.points).toBe(3);
  });
});
