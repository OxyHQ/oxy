/**
 * The repo-log read service (F0.2 / F5a public node log), against a REAL Postgres.
 *
 * The suite this replaces mocked `SignedRecord.find` and asserted on the FILTER
 * OBJECT the service built (`{ userId, seq: { $gt: 2 } }`) and on the argument
 * passed to a fake `.sort()`. Those models are gone, the mocks were inert, and a
 * filter-shape assertion could never have caught the two things that actually
 * break a node sync:
 *
 *  - **the ORDER.** A node ingests the log as a sequence and advances a cursor;
 *    out-of-order records break `prev` resolution downstream. Every fixture here
 *    is inserted in DESCENDING `seq` so heap order is the REVERSE of the answer —
 *    a missing `order by` returns the wrong array rather than the right one by
 *    luck.
 *  - **the BOUNDARY.** `sinceSeq` is exclusive: a cursor equal to a stored `seq`
 *    must NOT re-emit that record, or every resumed pull double-ingests one.
 *
 * Plus the parts that are policy rather than plumbing: the public export is
 * restricted to the {@link PUBLIC_LOG_COLLECTIONS} allowlist AND to verified
 * rows, and every read is scoped to one subject.
 *
 * Every row is written under a per-test account, so no assertion depends on a
 * table being empty.
 */

import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { SignedRecordEnvelope } from '@oxyhq/contracts';
import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { repoHeads } from '../../db/schema/repoHeads';
import { signedRecords } from '../../db/schema/signedRecords';
import { users } from '../../db/schema/users';
import { buildUserDid } from '../did.service';
import {
  PUBLIC_LOG_COLLECTIONS,
  getHead,
  getLogSince,
  getPublicLogSince,
  materializeCurrent,
  resolveCursorSeq,
} from '../repoLog.service';

/** The documented page defaults of the log reads — the contract, not a re-import. */
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

/** A wall-clock base every fixture's `issuedAt` is offset from. */
const T0 = 1_700_000_000_000;

const DEFAULT_COLLECTION = 'app.oxy.identity';

interface RowSpec {
  seq: number;
  collection?: string;
  rkey?: string;
  verified?: boolean;
  createdAt?: Date;
}

beforeAll(async () => {
  await connectPostgres();
});

afterAll(async () => {
  await closePostgres();
});

async function account(): Promise<string> {
  const [row] = await getDb().insert(users).values({}).returning({ id: users.id });
  return row.id;
}

/**
 * Write chain rows for an account, **in descending `seq`** so the physical heap
 * order is the reverse of the ascending order every read must produce.
 *
 * The envelopes are well-formed but UNSIGNED — no read under test verifies a
 * signature, and a real one would only obscure what is being asserted.
 * `signedRecord.service.test.ts` signs for real.
 */
async function seedRows(userId: string, specs: RowSpec[]): Promise<string[]> {
  const subjectDid = buildUserDid(userId);
  const inSeqOrder = [...specs].sort((a, b) => a.seq - b.seq);
  const values: Array<typeof signedRecords.$inferInsert> = inSeqOrder.map((spec) => {
    const collection = spec.collection ?? DEFAULT_COLLECTION;
    const rkey = spec.rkey ?? 'self';
    const envelope: SignedRecordEnvelope = {
      version: 2,
      type: 'identity',
      subject: subjectDid,
      issuer: subjectDid,
      record: { position: spec.seq },
      issuedAt: T0 + spec.seq,
      seq: spec.seq,
      prev: null,
      collection,
      rkey,
      publicKey: 'pk',
      alg: 'ES256K-DER-SHA256',
      signature: 'unsigned-fixture',
    };
    return {
      subjectDid,
      userId,
      type: 'identity',
      envelope,
      publicKey: 'pk',
      verified: spec.verified ?? true,
      seq: spec.seq,
      prev: null,
      recordId: `${userId}-${spec.seq}`,
      nsid: collection,
      rkey,
      ...(spec.createdAt ? { createdAt: spec.createdAt } : {}),
    };
  });

  await getDb()
    .insert(signedRecords)
    .values([...values].reverse());
  // The content addresses, in ascending `seq` order — the order a caller reads.
  return inSeqOrder.map((spec) => `${userId}-${spec.seq}`);
}

/** The `seq` of each returned envelope — what a node reads the log as. */
function seqsOf(envelopes: SignedRecordEnvelope[]): Array<number | undefined> {
  return envelopes.map((envelope) => envelope.seq);
}

describe('getLogSince', () => {
  /** One account holding MAX_LIMIT + 1 records, so both page bounds are reachable. */
  let bulkUserId: string;

  beforeAll(async () => {
    bulkUserId = await account();
    await seedRows(
      bulkUserId,
      Array.from({ length: MAX_LIMIT + 1 }, (_unused, seq) => ({ seq }))
    );
  });

  it('returns the slice ASCENDING by seq, from genesis', async () => {
    const page = await getLogSince(bulkUserId, -1, 5);
    expect(seqsOf(page)).toEqual([0, 1, 2, 3, 4]);
  });

  it('treats `since` as EXCLUSIVE: a cursor on a stored seq never re-emits it', async () => {
    const page = await getLogSince(bulkUserId, 3, 4);
    // 3 is the last record the caller already has, so the page starts at 4.
    expect(seqsOf(page)).toEqual([4, 5, 6, 7]);
  });

  it('defaults the page to 100 when no limit is given', async () => {
    const page = await getLogSince(bulkUserId, -1);
    expect(page).toHaveLength(DEFAULT_LIMIT);
    expect(seqsOf(page)).toEqual(Array.from({ length: DEFAULT_LIMIT }, (_unused, seq) => seq));
  });

  it('clamps an unbounded limit to the 500 ceiling', async () => {
    const page = await getLogSince(bulkUserId, -1, 10_000);
    expect(page).toHaveLength(MAX_LIMIT);
    expect(seqsOf(page)).toEqual(Array.from({ length: MAX_LIMIT }, (_unused, seq) => seq));
    // ...and the record beyond the ceiling is reachable by advancing the cursor,
    // so the clamp pages rather than truncates the log.
    expect(seqsOf(await getLogSince(bulkUserId, MAX_LIMIT - 1, 10_000))).toEqual([MAX_LIMIT]);
  });

  it('is scoped to ONE subject', async () => {
    const otherId = await account();
    await seedRows(otherId, [{ seq: 0 }, { seq: 1 }]);

    const page = await getLogSince(otherId, -1, 50);
    expect(seqsOf(page)).toEqual([0, 1]);
    // Exact, not "contains": the bulk account's 501 records share the table.
    expect(page.every((envelope) => envelope.subject === buildUserDid(otherId))).toBe(true);
  });

  it('returns an empty page past the end of the chain', async () => {
    const emptyId = await account();
    expect(await getLogSince(emptyId, -1, 10)).toEqual([]);
  });
});

describe('getPublicLogSince', () => {
  it('exports every allowlisted collection and nothing else', async () => {
    const userId = await account();
    const publicCollections = [...PUBLIC_LOG_COLLECTIONS];
    const privateSeq = publicCollections.length;
    const unverifiedSeq = privateSeq + 1;

    await seedRows(userId, [
      ...publicCollections.map((collection, seq) => ({ seq, collection })),
      // A civic collection: verified, on the same chain, and NOT exportable.
      { seq: privateSeq, collection: 'app.oxy.personhood' },
      // A public collection that never passed verification.
      { seq: unverifiedSeq, collection: publicCollections[0], verified: false },
    ]);

    const page = await getPublicLogSince(userId, -1, 50);
    expect(page.map((envelope) => envelope.collection)).toEqual(publicCollections);
    expect(seqsOf(page)).toEqual(publicCollections.map((_unused, seq) => seq));

    // The two exclusions are load-bearing, so name them: the private collection
    // and the unverified row are both present on the chain the ordinary log
    // returns in full.
    expect(seqsOf(await getLogSince(userId, -1, 50))).toEqual(
      Array.from({ length: unverifiedSeq + 1 }, (_unused, seq) => seq)
    );
  });

  it('honours the cursor and the limit', async () => {
    const userId = await account();
    const publicCollection = PUBLIC_LOG_COLLECTIONS[0];
    await seedRows(userId, [
      { seq: 0, collection: publicCollection },
      { seq: 1, collection: publicCollection },
      { seq: 2, collection: publicCollection },
    ]);

    expect(seqsOf(await getPublicLogSince(userId, 0, 50))).toEqual([1, 2]);
    expect(seqsOf(await getPublicLogSince(userId, -1, 2))).toEqual([0, 1]);
  });
});

describe('getHead', () => {
  it('returns the O(1) head pointer', async () => {
    const userId = await account();
    const [genesisId, secondId] = await seedRows(userId, [{ seq: 0 }, { seq: 1 }]);
    await getDb().insert(repoHeads).values({
      userId,
      subjectDid: buildUserDid(userId),
      seq: 1,
      headRecordId: secondId,
      recordCount: 2,
    });

    expect(await getHead(userId)).toEqual({ headRecordId: secondId, seq: 1, recordCount: 2 });
    // Not merely "a head came back": it names the LATEST record, not the first.
    expect(genesisId).not.toBe(secondId);
  });

  it('returns null for an account with no chain', async () => {
    expect(await getHead(await account())).toBeNull();
  });
});

describe('resolveCursorSeq', () => {
  it('maps a stored content address to its seq', async () => {
    const userId = await account();
    const [, secondId] = await seedRows(userId, [{ seq: 0 }, { seq: 1 }, { seq: 2 }]);
    expect(await resolveCursorSeq(userId, secondId)).toBe(1);
  });

  it('returns null for an address this account does not hold', async () => {
    const userId = await account();
    const otherId = await account();
    await seedRows(userId, [{ seq: 0 }]);
    const [foreignRecordId] = await seedRows(otherId, [{ seq: 0 }]);

    // Scoping is the point: `record_id` is globally unique, so a read that
    // forgot the subject would resolve another account's cursor and hand a node
    // a position on someone else's chain.
    expect(await resolveCursorSeq(userId, foreignRecordId)).toBeNull();
    expect(await resolveCursorSeq(userId, `missing-${randomUUID()}`)).toBeNull();
    // The control: on its OWN account that same address resolves.
    expect(await resolveCursorSeq(otherId, foreignRecordId)).toBe(0);
  });
});

describe('materializeCurrent', () => {
  const OLDER = new Date('2026-01-01T00:00:00.000Z');
  const NEWER = new Date('2026-02-01T00:00:00.000Z');
  const NEWEST = new Date('2026-03-01T00:00:00.000Z');

  it('answers the LAST writer for the key', async () => {
    const userId = await account();
    await seedRows(userId, [
      { seq: 0, collection: 'app.oxy.profile', rkey: 'self', createdAt: OLDER },
      { seq: 1, collection: 'app.oxy.profile', rkey: 'self', createdAt: NEWER },
    ]);

    const current = await materializeCurrent(userId, 'app.oxy.profile', 'self');
    expect(current?.seq).toBe(1);
  });

  it('ignores a newer record on a DIFFERENT key', async () => {
    // A read that dropped the `rkey` from the filter would return `other` here —
    // the materialized "current" value of one key overwritten by another's.
    const userId = await account();
    await seedRows(userId, [
      { seq: 0, collection: 'app.oxy.credential', rkey: 'wanted', createdAt: OLDER },
      { seq: 1, collection: 'app.oxy.credential', rkey: 'other', createdAt: NEWEST },
      { seq: 2, collection: 'app.oxy.personhood', rkey: 'wanted', createdAt: NEWEST },
    ]);

    const current = await materializeCurrent(userId, 'app.oxy.credential', 'wanted');
    expect(current?.seq).toBe(0);
  });

  it('ignores an UNVERIFIED record, however new', async () => {
    const userId = await account();
    await seedRows(userId, [
      { seq: 0, collection: 'app.oxy.profile', rkey: 'self', createdAt: OLDER },
      { seq: 1, collection: 'app.oxy.profile', rkey: 'self', createdAt: NEWEST, verified: false },
    ]);

    const current = await materializeCurrent(userId, 'app.oxy.profile', 'self');
    expect(current?.seq).toBe(0);
  });

  it('is scoped to the subject, and null for a key with no record', async () => {
    const userId = await account();
    const otherId = await account();
    await seedRows(otherId, [{ seq: 0, collection: 'app.oxy.profile', rkey: 'self' }]);

    expect(await materializeCurrent(userId, 'app.oxy.profile', 'self')).toBeNull();
    expect(await materializeCurrent(otherId, 'app.oxy.profile', 'missing')).toBeNull();
    expect((await materializeCurrent(otherId, 'app.oxy.profile', 'self'))?.seq).toBe(0);
  });
});

describe('the log reads address one account', () => {
  it('never mixes two subjects’ chains', async () => {
    const mine = await account();
    const theirs = await account();
    await seedRows(mine, [{ seq: 0 }, { seq: 1 }]);
    await seedRows(theirs, [{ seq: 0 }]);

    const [row] = await getDb()
      .select({ subjectDid: signedRecords.subjectDid })
      .from(signedRecords)
      .where(eq(signedRecords.recordId, `${theirs}-0`));
    expect(row.subjectDid).toBe(buildUserDid(theirs));

    expect(await getLogSince(mine, -1, 50)).toHaveLength(2);
    expect(await getLogSince(theirs, -1, 50)).toHaveLength(1);
  });
});
