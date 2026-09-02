/**
 * The v2 per-subject hash chain (F0.2), against a REAL Postgres.
 *
 * The suite this replaces mocked `SignedRecord`, `RepoHead` and
 * `mongoose.startSession`, then asserted on the ARGUMENTS handed to
 * `SignedRecord.create` and `RepoHead.findOneAndUpdate`. None of those models is
 * imported by the service any more, so the mocks were inert and the assertions
 * described a Mongoose call shape that no longer exists. The chain's actual
 * guarantees are structural, so they are asserted against stored rows here:
 *
 *  - **`prev` is the content address of the record before it.** The chain is
 *    walked from genesis to head and every link is re-derived with
 *    `computeRecordId`, so a store that wrote a plausible-looking hash of
 *    something else would fail.
 *  - **`seq` is one monotone sequence per ACCOUNT**, shared by every
 *    `(collection, rkey)` key on that account and independent of other accounts'.
 *  - **A refused append is a no-op on BOTH tables.** `chain_fork`, `bad_seq` and
 *    `chain_gap` each leave the ledger and `repo_heads` exactly as they were —
 *    and a correct append still lands afterwards, so "nothing changed" is never
 *    a passing description of a poisoned chain.
 *
 * The atomicity of the append + head advance, and the `{user_id, seq}`
 * `chain_conflict` backstop, are covered in `reputationCivic.postgres.test.ts`
 * and are deliberately not restated.
 *
 * Every account is created per test, so no assertion depends on a table being
 * empty.
 */

import { generateSecp256k1KeyPair } from '@oxyhq/protocol/secp256k1';
import { asc, eq } from 'drizzle-orm';
import { computeRecordId } from '@oxyhq/protocol';
import type { SignedRecordEnvelope } from '@oxyhq/contracts';
import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { repoHeads } from '../../db/schema/repoHeads';
import { signedRecords } from '../../db/schema/signedRecords';
import { users } from '../../db/schema/users';
import { buildUserDid } from '../did.service';
import { signRecordEnvelope, verifyAndStoreRecord } from '../signedRecord.service';


/** A wall-clock base every envelope's `issuedAt` is offset from, so ordering is explicit. */
const T0 = 1_700_000_000_000;

interface Signer {
  userId: string;
  did: string;
  publicKey: string;
  privateKey: string;
}

beforeAll(async () => {
  await connectPostgres();
});

afterAll(async () => {
  await closePostgres();
});

/** An account whose primary `users.public_key` authorizes the returned signer. */
async function signer(): Promise<Signer> {
  const pair = generateSecp256k1KeyPair();
  const publicKey = pair.publicKey;
  const [row] = await getDb().insert(users).values({ publicKey }).returning({ id: users.id });
  return { userId: row.id, did: buildUserDid(row.id), publicKey, privateKey: pair.privateKey };
}

/** Build + sign a v2 (chained) envelope. Defaults to the genesis position. */
function v2Envelope(
  subject: Signer,
  overrides: Partial<Omit<SignedRecordEnvelope, 'signature'>> = {}
): SignedRecordEnvelope {
  return signRecordEnvelope(
    {
      version: 2,
      type: 'identity',
      subject: subject.did,
      issuer: subject.did,
      record: { displayName: 'Nate' },
      issuedAt: T0,
      seq: 0,
      prev: null,
      collection: 'app.oxy.identity',
      rkey: 'self',
      publicKey: subject.publicKey,
      alg: 'ES256K-DER-SHA256',
      ...overrides,
    },
    subject.privateKey
  );
}

/** Append an envelope, failing the test loudly if it was refused. */
async function append(subject: Signer, envelope: SignedRecordEnvelope): Promise<string> {
  const outcome = await verifyAndStoreRecord(envelope, subject.userId);
  if (!outcome.ok) {
    throw new Error(`expected the append to succeed, got ${outcome.reason}`);
  }
  return outcome.record.recordId;
}

/** The account's chain rows in `seq` order. */
async function chainRows(userId: string) {
  return getDb()
    .select({
      seq: signedRecords.seq,
      prev: signedRecords.prev,
      recordId: signedRecords.recordId,
      nsid: signedRecords.nsid,
      rkey: signedRecords.rkey,
    })
    .from(signedRecords)
    .where(eq(signedRecords.userId, userId))
    .orderBy(asc(signedRecords.seq));
}

/** The account's head row, or `undefined` when it has no chain. */
async function headRow(userId: string) {
  const [row] = await getDb()
    .select({
      seq: repoHeads.seq,
      headRecordId: repoHeads.headRecordId,
      recordCount: repoHeads.recordCount,
      subjectDid: repoHeads.subjectDid,
    })
    .from(repoHeads)
    .where(eq(repoHeads.userId, userId));
  return row;
}

describe('every record links to the content address of the one before it', () => {
  it('walks genesis → head with each prev re-derived from the previous envelope', async () => {
    const subject = await signer();

    const genesis = v2Envelope(subject);
    const genesisId = await append(subject, genesis);
    expect(genesisId).toBe(await computeRecordId(genesis));

    const second = v2Envelope(subject, {
      seq: 1,
      prev: genesisId,
      issuedAt: T0 + 1_000,
      record: { displayName: 'Nate II' },
    });
    const secondId = await append(subject, second);

    const third = v2Envelope(subject, {
      seq: 2,
      prev: secondId,
      issuedAt: T0 + 2_000,
      record: { displayName: 'Nate III' },
    });
    const thirdId = await append(subject, third);

    // Re-derived, not echoed: `computeRecordId` is the same function the client
    // uses, so a server that hashed anything else would diverge here.
    expect([genesisId, secondId, thirdId]).toEqual([
      await computeRecordId(genesis),
      await computeRecordId(second),
      await computeRecordId(third),
    ]);
    expect(new Set([genesisId, secondId, thirdId]).size).toBe(3);

    const rows = await chainRows(subject.userId);
    expect(rows.map((row) => row.seq)).toEqual([0, 1, 2]);
    expect(rows.map((row) => row.recordId)).toEqual([genesisId, secondId, thirdId]);
    // The links themselves: genesis has none, and each later record names the
    // address of its predecessor.
    expect(rows.map((row) => row.prev)).toEqual([null, genesisId, secondId]);
    // The envelope's `collection` is denormalized to the `nsid` column.
    expect(rows.map((row) => row.nsid)).toEqual([
      'app.oxy.identity',
      'app.oxy.identity',
      'app.oxy.identity',
    ]);

    expect(await headRow(subject.userId)).toEqual({
      seq: 2,
      headRecordId: thirdId,
      recordCount: 3,
      subjectDid: subject.did,
    });
  });
});

describe('a refused append leaves the ledger AND the head untouched', () => {
  it('rejects a `prev` that is not the current head with chain_fork', async () => {
    const subject = await signer();
    const genesisId = await append(subject, v2Envelope(subject));

    const forked = v2Envelope(subject, {
      seq: 1,
      prev: 'f'.repeat(64),
      issuedAt: T0 + 1_000,
      record: { displayName: 'Fork' },
    });
    expect(await verifyAndStoreRecord(forked, subject.userId)).toEqual({
      ok: false,
      reason: 'chain_fork',
    });

    expect(await chainRows(subject.userId)).toHaveLength(1);
    expect(await headRow(subject.userId)).toMatchObject({
      seq: 0,
      headRecordId: genesisId,
      recordCount: 1,
    });

    // ...and the chain is still writable, so "unchanged" is not a description of
    // a chain the rejection broke.
    const secondId = await append(
      subject,
      v2Envelope(subject, { seq: 1, prev: genesisId, issuedAt: T0 + 2_000, record: { ok: true } })
    );
    expect(await headRow(subject.userId)).toMatchObject({
      seq: 1,
      headRecordId: secondId,
      recordCount: 2,
    });
  });

  it('rejects a re-genesis once a chain exists', async () => {
    // `seq: 0, prev: null` against a live head is the chain-reset shape: it
    // would orphan every existing record while looking like a first write.
    const subject = await signer();
    const genesisId = await append(subject, v2Envelope(subject));

    const regenesis = v2Envelope(subject, { issuedAt: T0 + 1_000, record: { displayName: 'Reset' } });
    expect(await verifyAndStoreRecord(regenesis, subject.userId)).toEqual({
      ok: false,
      reason: 'chain_fork',
    });

    expect(await chainRows(subject.userId)).toHaveLength(1);
    expect(await headRow(subject.userId)).toMatchObject({ seq: 0, headRecordId: genesisId });
  });

  it('rejects a seq that skips ahead of the head with bad_seq', async () => {
    const subject = await signer();
    const genesisId = await append(subject, v2Envelope(subject));

    // The `prev` is CORRECT here — only the sequence is wrong, which is what
    // separates `bad_seq` from `chain_fork`.
    const skipped = v2Envelope(subject, {
      seq: 5,
      prev: genesisId,
      issuedAt: T0 + 1_000,
      record: { displayName: 'Skip' },
    });
    expect(await verifyAndStoreRecord(skipped, subject.userId)).toEqual({
      ok: false,
      reason: 'bad_seq',
    });

    expect(await chainRows(subject.userId)).toHaveLength(1);
    expect(await headRow(subject.userId)).toMatchObject({ seq: 0, recordCount: 1 });
  });

  it('rejects a non-genesis record when the account has no chain with chain_gap', async () => {
    const subject = await signer();

    const orphan = v2Envelope(subject, { seq: 1, prev: 'a'.repeat(64), issuedAt: T0 + 1_000 });
    expect(await verifyAndStoreRecord(orphan, subject.userId)).toEqual({
      ok: false,
      reason: 'chain_gap',
    });

    expect(await chainRows(subject.userId)).toHaveLength(0);
    expect(await headRow(subject.userId)).toBeUndefined();

    // The account can still open a chain at genesis — the refusal above was
    // about the position, not about the account.
    await append(subject, v2Envelope(subject));
    expect(await headRow(subject.userId)).toMatchObject({ seq: 0, recordCount: 1 });
  });
});

describe('one chain per account', () => {
  it('shares a single seq sequence across every (collection, rkey) key', async () => {
    // `nsid`/`rkey` partition records WITHIN one chain for last-writer-wins
    // materialization; they must not fork `seq` or the head.
    const subject = await signer();

    const identityId = await append(subject, v2Envelope(subject));
    const vouch = v2Envelope(subject, {
      type: 'personhood_vouch',
      seq: 1,
      prev: identityId,
      issuedAt: T0 + 1_000,
      collection: 'app.oxy.personhood',
      rkey: 'subject-a',
      record: { about: buildUserDid('someone') },
    });
    const vouchId = await append(subject, vouch);

    const rows = await chainRows(subject.userId);
    expect(rows.map((row) => [row.seq, row.nsid, row.rkey])).toEqual([
      [0, 'app.oxy.identity', 'self'],
      [1, 'app.oxy.personhood', 'subject-a'],
    ]);

    const heads = await getDb()
      .select({ seq: repoHeads.seq, headRecordId: repoHeads.headRecordId })
      .from(repoHeads)
      .where(eq(repoHeads.userId, subject.userId));
    expect(heads).toEqual([{ seq: 1, headRecordId: vouchId }]);
  });

  it('keeps two accounts’ chains independent', async () => {
    const first = await signer();
    const second = await signer();

    const firstGenesis = await append(first, v2Envelope(first));
    await append(
      first,
      v2Envelope(first, { seq: 1, prev: firstGenesis, issuedAt: T0 + 1_000, record: { n: 2 } })
    );

    // The second account's FIRST record is a genesis even though the first
    // account is already at seq 1 — a chain scoped to anything wider than the
    // account would reject this as `bad_seq`/`chain_gap`.
    const secondGenesis = await append(second, v2Envelope(second));

    expect(await headRow(first.userId)).toMatchObject({ seq: 1, recordCount: 2 });
    expect(await headRow(second.userId)).toMatchObject({
      seq: 0,
      headRecordId: secondGenesis,
      recordCount: 1,
    });
    expect(await chainRows(second.userId)).toHaveLength(1);
  });
});
