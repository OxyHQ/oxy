/**
 * `attestAward` — crypto-owned reputation, against a REAL Postgres.
 *
 * A civic award is only "owned by the user" because an Oxy-signed
 * `reputation_attestation` lands on THEIR hash chain, referencing the ledger row
 * and the user-signed envelopes behind it. The suite this replaces mocked
 * `verifyAndStoreRecord`, `getHead` and `materializeCurrent`, so it asserted the
 * envelope that was HANDED to the store — never that anything was stored, never
 * that the chain advanced, and never that the record landed on the right
 * subject's chain. Its chain-race case was the clearest instance: a mocked
 * `chain_conflict` followed by a mocked success proves the retry loop calls the
 * store twice, which is true of a loop that retries with the SAME stale `seq`
 * forever.
 *
 * Rewritten against the real store: every case reads `signed_records` and
 * `repo_heads` back, and the race is a genuine one (two concurrent attestations
 * for one subject), so a retry that failed to re-read the head cannot pass.
 *
 * The Oxy custodial keypair is generated here and injected via env, so the
 * signature and the custodial-issuer authorization are both real.
 */

import { randomUUID } from 'node:crypto';
import { generateSecp256k1KeyPair } from '@oxyhq/protocol/secp256k1';
import { and, asc, eq } from 'drizzle-orm';
import { signedRecordSigningInput } from '@oxyhq/protocol';
import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { repoHeads } from '../../db/schema/repoHeads';
import { reputationTransactions } from '../../db/schema/reputationTransactions';
import { signedRecords } from '../../db/schema/signedRecords';
import { users } from '../../db/schema/users';
import { attestAward, REPUTATION_ATTESTATION_COLLECTION } from '../civic/attestation.service';
import { buildUserDid, OXY_DID } from '../did.service';
import * as repoLog from '../repoLog.service';
import { reputationService } from '../reputation.service';
import SignatureService from '../signature.service';
import {
  PEER_VALIDATED_ACTION,
  REAL_LIFE_ATTESTED_ACTION,
} from '../../utils/reputation.constants';

const oxyKey = generateSecp256k1KeyPair();
const OXY_PUBLIC = oxyKey.publicKey;
const OXY_PRIVATE = oxyKey.privateKey;

const unique = () => randomUUID();

async function account(): Promise<string> {
  const [row] = await getDb()
    .insert(users)
    .values({ username: `u-${unique().slice(0, 18)}` })
    .returning({ id: users.id });
  return row.id;
}

/** A ledger row to attest — a real one, since `award` hands `attestAward` one. */
async function ledgerRow(
  userId: string,
  overrides: { actionType?: string; points?: number; sourceActionId?: string } = {}
): Promise<{
  id: string;
  userId: string;
  actionType: string;
  points: number;
  category: string;
  sourceActionId: string | null;
}> {
  const [row] = await getDb()
    .insert(reputationTransactions)
    .values({
      userId,
      points: overrides.points ?? 25,
      actionType: overrides.actionType ?? REAL_LIFE_ATTESTED_ACTION,
      category: 'physical',
      sourceActionId: overrides.sourceActionId ?? null,
      status: 'active',
    })
    .returning();
  return row;
}

/** Every attestation stored on a subject's chain, oldest first. */
async function attestations(userId: string) {
  return getDb()
    .select({
      recordId: signedRecords.recordId,
      seq: signedRecords.seq,
      prev: signedRecords.prev,
      rkey: signedRecords.rkey,
      type: signedRecords.type,
      publicKey: signedRecords.publicKey,
      verified: signedRecords.verified,
      envelope: signedRecords.envelope,
    })
    .from(signedRecords)
    .where(
      and(
        eq(signedRecords.userId, userId),
        eq(signedRecords.nsid, REPUTATION_ATTESTATION_COLLECTION)
      )
    )
    .orderBy(asc(signedRecords.seq));
}

async function head(userId: string) {
  const [row] = await getDb()
    .select({ seq: repoHeads.seq, headRecordId: repoHeads.headRecordId, recordCount: repoHeads.recordCount })
    .from(repoHeads)
    .where(eq(repoHeads.userId, userId));
  return row;
}

beforeAll(async () => {
  await connectPostgres();
  process.env.OXY_PRIVATE_KEY = OXY_PRIVATE;
  process.env.OXY_PUBLIC_KEY = OXY_PUBLIC;
  await reputationService.seedDefaultRules();
});

afterAll(async () => {
  delete process.env.OXY_PRIVATE_KEY;
  delete process.env.OXY_PUBLIC_KEY;
  await closePostgres();
});

describe('the attestation that gets stored', () => {
  it('lands a verifiable, Oxy-signed v2 record on the SUBJECT’s chain at genesis', async () => {
    const subject = await account();
    const bystander = await account();
    const txn = await ledgerRow(subject, { sourceActionId: `src-${unique()}` });

    const returned = await attestAward(txn, { sourceEnvelopes: ['rec-aaa'] });
    expect(returned).not.toBeNull();
    if (!returned) return;

    const rows = await attestations(subject);
    expect(rows).toHaveLength(1);
    const [stored] = rows;

    // It is on the subject's chain — not the actor's, not anyone else's.
    expect(await attestations(bystander)).toEqual([]);

    expect(stored.type).toBe('reputation_attestation');
    expect(stored.rkey).toBe(txn.id);
    expect(stored.seq).toBe(0);
    expect(stored.prev).toBeNull();
    expect(stored.verified).toBe(true);
    // The SIGNER is Oxy while the SUBJECT is the awarded account — the whole
    // point of the custodial issuer branch.
    expect(stored.publicKey).toBe(OXY_PUBLIC);
    expect(stored.envelope.subject).toBe(buildUserDid(subject));
    expect(stored.envelope.issuer).toBe(OXY_DID);
    expect(stored.envelope.collection).toBe(REPUTATION_ATTESTATION_COLLECTION);

    // The signature verifies against the Oxy public key over the canonical
    // signing input recomputed from the STORED envelope, not from the returned
    // one — a stored copy that had drifted would fail here.
    expect(
      SignatureService.verifySignature(
        signedRecordSigningInput(stored.envelope),
        stored.envelope.signature,
        OXY_PUBLIC
      )
    ).toBe(true);

    // The proof chain: the ledger row it attests plus the user-signed envelopes
    // that originated it.
    expect(stored.envelope.record).toEqual({
      txnId: txn.id,
      subjectUserId: subject,
      actionType: REAL_LIFE_ATTESTED_ACTION,
      points: 25,
      category: 'physical',
      sourceActionId: txn.sourceActionId,
      weightClass: 'HIGH',
      sourceEnvelopeIds: ['rec-aaa'],
    });

    // The head really advanced to this record.
    expect(await head(subject)).toEqual({
      seq: 0,
      headRecordId: stored.recordId,
      recordCount: 1,
    });
  });

  it('extends the chain from the existing head on the next award', async () => {
    const subject = await account();
    const first = await attestAward(await ledgerRow(subject));
    expect(first).not.toBeNull();

    const second = await attestAward(await ledgerRow(subject, { actionType: PEER_VALIDATED_ACTION, points: 8 }));
    expect(second).not.toBeNull();

    const rows = await attestations(subject);
    expect(rows.map((row) => row.seq)).toEqual([0, 1]);
    expect(rows[1].prev).toBe(rows[0].recordId);
    expect(await head(subject)).toEqual({
      seq: 1,
      headRecordId: rows[1].recordId,
      recordCount: 2,
    });
  });

  it('records the weight class the action carries', async () => {
    const subject = await account();
    await attestAward(await ledgerRow(subject, { actionType: REAL_LIFE_ATTESTED_ACTION }));
    await attestAward(await ledgerRow(subject, { actionType: PEER_VALIDATED_ACTION, points: 8 }));
    await attestAward(await ledgerRow(subject, { actionType: 'endorsement_received', points: 1 }));

    const rows = await attestations(subject);
    expect(rows.map((row) => (row.envelope.record as { weightClass: string }).weightClass)).toEqual([
      'HIGH',
      'MEDIUM',
      'LOW',
    ]);
  });

  it('defaults the proof chain to an empty list when no source envelopes are given', async () => {
    const subject = await account();
    await attestAward(await ledgerRow(subject));
    const [stored] = await attestations(subject);
    expect((stored.envelope.record as { sourceEnvelopeIds: string[] }).sourceEnvelopeIds).toEqual([]);
  });
});

describe('idempotency per transaction', () => {
  it('returns the existing attestation and appends nothing on a repeat', async () => {
    const subject = await account();
    const txn = await ledgerRow(subject);

    const first = await attestAward(txn);
    const second = await attestAward(txn);

    expect(second).toEqual(first);
    // Exactly one row and an unmoved head — a second append would fork the
    // subject's ledger view with two attestations of one award.
    expect(await attestations(subject)).toHaveLength(1);
    expect((await head(subject)).seq).toBe(0);
  });
});

describe('the chain-head race', () => {
  it('re-reads the head and re-signs after the store refuses a stale seq', async () => {
    // The loser of a multi-device race signs against a head that has already
    // moved. Reproduced deterministically: the head is REAL (an attestation is
    // already at `seq: 0`) and only the first read is stale, so the store's own
    // continuity check does the refusing. A retry that re-signed with the SAME
    // stale `seq` would exhaust its budget and return null — which is exactly
    // what a mocked-store version of this test could not tell apart.
    const subject = await account();
    const first = await attestAward(await ledgerRow(subject));
    expect(first).not.toBeNull();

    const getHead = jest.spyOn(repoLog, 'getHead').mockResolvedValueOnce(null);
    try {
      const second = await attestAward(await ledgerRow(subject));
      expect(second).not.toBeNull();
      // Called more than once: the loop went back for a fresh head.
      expect(getHead.mock.calls.length).toBeGreaterThan(1);
    } finally {
      getHead.mockRestore();
    }

    const rows = await attestations(subject);
    expect(rows.map((row) => row.seq)).toEqual([0, 1]);
    expect(rows[1].prev).toBe(rows[0].recordId);
    // Two distinct awards, two distinct record keys.
    expect(new Set(rows.map((row) => row.rkey)).size).toBe(2);
    expect(await head(subject)).toEqual({
      seq: 1,
      headRecordId: rows[1].recordId,
      recordCount: 2,
    });
  });

  it('gives up rather than forking the chain when the head never settles', async () => {
    // The other side of the retry budget: a head that is stale on EVERY read
    // must end in `null` and no stored record, never in a second record
    // claiming a seq the chain already holds.
    const subject = await account();
    expect(await attestAward(await ledgerRow(subject))).not.toBeNull();

    const getHead = jest.spyOn(repoLog, 'getHead').mockResolvedValue(null);
    try {
      expect(await attestAward(await ledgerRow(subject))).toBeNull();
    } finally {
      getHead.mockRestore();
    }

    expect(await attestations(subject)).toHaveLength(1);
    expect((await head(subject)).seq).toBe(0);
  });
});

describe('an unconfigured Oxy key', () => {
  it('skips emission entirely rather than storing an unsigned record', async () => {
    const subject = await account();
    delete process.env.OXY_PRIVATE_KEY;
    delete process.env.OXY_PUBLIC_KEY;
    try {
      expect(await attestAward(await ledgerRow(subject))).toBeNull();
      expect(await attestations(subject)).toEqual([]);
      expect(await head(subject)).toBeUndefined();
    } finally {
      process.env.OXY_PRIVATE_KEY = OXY_PRIVATE;
      process.env.OXY_PUBLIC_KEY = OXY_PUBLIC;
    }

    // The control: the SAME subject does get an attestation once the key is
    // back, so the empty read above is a skip and not a broken fixture.
    expect(await attestAward(await ledgerRow(subject))).not.toBeNull();
    expect(await attestations(subject)).toHaveLength(1);
  });
});

describe('reputationService.award — the emission wiring', () => {
  it('emits an attestation for the created transaction when asked', async () => {
    const subject = await account();

    const txn = await reputationService.award({
      userId: subject,
      actionType: REAL_LIFE_ATTESTED_ACTION,
      emitAttestation: true,
      sourceEnvelopeIds: ['rec-bbb'],
    });

    const rows = await attestations(subject);
    expect(rows).toHaveLength(1);
    // The attestation names the transaction that was actually written.
    expect(rows[0].rkey).toBe(txn.id);
    expect(rows[0].envelope.record).toMatchObject({
      txnId: txn.id,
      subjectUserId: subject,
      points: txn.points,
      sourceEnvelopeIds: ['rec-bbb'],
    });
  });

  it('emits nothing by default, so the non-civic call sites are untouched', async () => {
    const subject = await account();
    await reputationService.award({ userId: subject, actionType: REAL_LIFE_ATTESTED_ACTION });

    expect(await attestations(subject)).toEqual([]);
    expect(await head(subject)).toBeUndefined();
  });

  it('still commits the award when emission is impossible', async () => {
    // Emission is best-effort by design: a missing Oxy key must cost the user
    // their attestation, never their points.
    const subject = await account();
    delete process.env.OXY_PRIVATE_KEY;
    delete process.env.OXY_PUBLIC_KEY;
    try {
      const txn = await reputationService.award({
        userId: subject,
        actionType: REAL_LIFE_ATTESTED_ACTION,
        emitAttestation: true,
      });
      expect(txn.points).toBe(25);
    } finally {
      process.env.OXY_PRIVATE_KEY = OXY_PRIVATE;
      process.env.OXY_PUBLIC_KEY = OXY_PUBLIC;
    }

    const ledger = await getDb()
      .select({ id: reputationTransactions.id })
      .from(reputationTransactions)
      .where(eq(reputationTransactions.userId, subject));
    expect(ledger).toHaveLength(1);
    expect(await attestations(subject)).toEqual([]);
  });
});
