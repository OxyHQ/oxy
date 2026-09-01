/**
 * The Oxy `RecordStore` adapter's own reads, against a REAL Postgres.
 *
 * The suite this replaces mocked `SignedRecord.findOne` and asserted that the
 * store BUILT a particular Mongo filter object
 * (`{ userId: {$eq}, nsid: {$eq}, rkey: {$eq} }`). The model is gone, the mock was
 * inert, and a filter-shape assertion answers a narrower question than the one
 * that matters: what the store RETURNS for the row it finds. Each case below
 * seeds rows and asserts the answer.
 *
 * The headline is `latestIssuedAtForKey`, the monotonicity frontier the engine's
 * replay/rollback defence reads. It must be scoped to the LOGICAL record key —
 * `(nsid, rkey)` on v2, `type` on a v1 singleton. A filter that collapsed to a
 * global latest would compare an append against the newest record on ANY key and
 * reject valid writes; every fixture here therefore carries a NEWER record on a
 * DIFFERENT key, which is the input that tells the two apart. A v2 envelope
 * missing its key must answer "no prior record" rather than issue that global
 * query at all.
 *
 * Every row is written under a per-test account, so no assertion depends on a
 * table being empty.
 */

import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { computeRecordId } from '@oxyhq/protocol';
import type { OxySignedRecordType, SignedRecordEnvelope } from '@oxyhq/contracts';
import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { repoHeads } from '../../db/schema/repoHeads';
import { signedRecords } from '../../db/schema/signedRecords';
import { users } from '../../db/schema/users';
import { buildUserDid } from '../did.service';
import {
  MAX_RECORD_AUTHORS,
  MAX_RECORD_COLLECTIONS,
  oxyRecordStore,
  subjectKeyForUser,
} from '../oxyRecordStore';

/** A wall-clock base every fixture's `issuedAt` is offset from. */
const T0 = 1_700_000_000_000;

interface RowSpec {
  seq?: number;
  type?: OxySignedRecordType;
  collection?: string;
  rkey?: string;
  issuedAt: number;
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
 * Write rows directly. A `seq` makes the row v2 (chained, with `nsid`/`rkey`);
 * omitting it makes it a v1 singleton, which by the schema's completeness CHECK
 * can carry none of the four chain fields.
 *
 * The envelopes are well-formed but UNSIGNED — none of the reads under test
 * verifies a signature. `signedRecord.service.test.ts` signs for real.
 */
async function seedRows(userId: string, specs: RowSpec[]): Promise<string[]> {
  const subjectDid = buildUserDid(userId);
  const values: Array<typeof signedRecords.$inferInsert> = specs.map((spec, index) => {
    const chained = typeof spec.seq === 'number';
    const collection = spec.collection ?? 'app.oxy.identity';
    const rkey = spec.rkey ?? 'self';
    const envelope: SignedRecordEnvelope = {
      version: chained ? 2 : 1,
      type: spec.type ?? 'identity',
      subject: subjectDid,
      issuer: subjectDid,
      record: { position: index },
      issuedAt: spec.issuedAt,
      ...(chained ? { seq: spec.seq, prev: null, collection, rkey } : {}),
      publicKey: 'pk',
      alg: 'ES256K-DER-SHA256',
      signature: 'unsigned-fixture',
    };
    return {
      subjectDid,
      userId,
      type: spec.type ?? 'identity',
      envelope,
      publicKey: 'pk',
      verified: spec.verified ?? true,
      ...(chained
        ? { seq: spec.seq, prev: null, recordId: `${userId}-${spec.seq}`, nsid: collection, rkey }
        : {}),
      ...(spec.createdAt ? { createdAt: spec.createdAt } : {}),
    };
  });

  await getDb().insert(signedRecords).values(values);
  // The content addresses, in spec order. A v1 row has none — the schema's
  // completeness CHECK forbids it — so its slot is empty and no test reads it.
  return specs.map((spec) => (typeof spec.seq === 'number' ? `${userId}-${spec.seq}` : ''));
}

/** A well-formed v2 envelope for a subject — the shape the frontier is asked about. */
function v2Envelope(
  subjectDid: string,
  overrides: Partial<SignedRecordEnvelope> = {}
): SignedRecordEnvelope {
  return {
    version: 2,
    type: 'identity',
    subject: subjectDid,
    issuer: subjectDid,
    record: { displayName: 'Nate' },
    issuedAt: T0,
    seq: 0,
    prev: null,
    collection: 'app.oxy.identity',
    rkey: 'self',
    publicKey: 'pk',
    alg: 'ES256K-DER-SHA256',
    signature: 'unsigned-fixture',
    ...overrides,
  };
}

/** The same envelope with one required chain-key field genuinely ABSENT. */
function v2EnvelopeMissing(
  subjectDid: string,
  omit: 'collection' | 'rkey'
): SignedRecordEnvelope {
  const { collection, rkey, ...rest } = v2Envelope(subjectDid);
  return omit === 'collection' ? { ...rest, rkey } : { ...rest, collection };
}

/** A v1 envelope of an explicit record type. */
function v1Envelope(subjectDid: string, type: string, issuedAt: number): SignedRecordEnvelope {
  return {
    version: 1,
    type,
    subject: subjectDid,
    issuer: subjectDid,
    record: { displayName: 'Nate' },
    issuedAt,
    publicKey: 'pk',
    alg: 'ES256K-DER-SHA256',
    signature: 'unsigned-fixture',
  };
}

async function countRecords(userId: string): Promise<number> {
  const rows = await getDb()
    .select({ id: signedRecords.id })
    .from(signedRecords)
    .where(eq(signedRecords.userId, userId));
  return rows.length;
}

describe('latestIssuedAtForKey — the frontier is scoped to the logical record key', () => {
  it('answers the latest issuedAt for THAT (nsid, rkey), not the newest on any key', async () => {
    const userId = await account();
    const subject = subjectKeyForUser(userId);
    // The wanted key's record is the OLDEST row by `created_at` too, so it can
    // never be the answer a collapsed filter would give: that filter orders by
    // `created_at desc` and would return one of the two rows below. Seeding all
    // three at the same instant is NOT enough — the store takes `limit 1` off an
    // ambiguous sort, and Postgres happened to return the wanted row anyway,
    // which made this case pass against the exact bug it exists to catch.
    await seedRows(userId, [
      {
        seq: 0,
        collection: 'app.oxy.credential',
        rkey: 'wanted',
        issuedAt: T0,
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
      },
      // NEWER, on a different key. A global-latest read returns this instead,
      // and the caller's valid append on `wanted` is refused `stale_issued_at`.
      {
        seq: 1,
        collection: 'app.oxy.credential',
        rkey: 'other',
        issuedAt: T0 + 10_000,
        createdAt: new Date('2026-02-01T00:00:00.000Z'),
      },
      {
        seq: 2,
        collection: 'app.oxy.personhood',
        rkey: 'wanted',
        issuedAt: T0 + 20_000,
        createdAt: new Date('2026-03-01T00:00:00.000Z'),
      },
    ]);

    const frontier = await oxyRecordStore.latestIssuedAtForKey(
      subject,
      v2Envelope(subject, { collection: 'app.oxy.credential', rkey: 'wanted' })
    );
    expect(frontier).toBe(T0);
  });

  it('advances with the newest record ON that key', async () => {
    const userId = await account();
    const subject = subjectKeyForUser(userId);
    await seedRows(userId, [
      {
        seq: 0,
        collection: 'app.oxy.profile',
        rkey: 'self',
        issuedAt: T0,
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
      },
      {
        seq: 1,
        collection: 'app.oxy.profile',
        rkey: 'self',
        issuedAt: T0 + 5_000,
        createdAt: new Date('2026-02-01T00:00:00.000Z'),
      },
    ]);

    expect(
      await oxyRecordStore.latestIssuedAtForKey(
        subject,
        v2Envelope(subject, { collection: 'app.oxy.profile', rkey: 'self' })
      )
    ).toBe(T0 + 5_000);
  });

  it('answers null for a key with no record, even on a busy chain', async () => {
    const userId = await account();
    const subject = subjectKeyForUser(userId);
    await seedRows(userId, [
      { seq: 0, collection: 'app.oxy.credential', rkey: 'taken', issuedAt: T0 + 10_000 },
    ]);

    expect(
      await oxyRecordStore.latestIssuedAtForKey(
        subject,
        v2Envelope(subject, { collection: 'app.oxy.credential', rkey: 'fresh' })
      )
    ).toBeNull();
  });

  it.each(['collection', 'rkey'] as const)(
    'answers null for a v2 envelope missing `%s` rather than falling back to a global latest',
    async (omitted) => {
      const userId = await account();
      const subject = subjectKeyForUser(userId);
      // A record exists, so a collapsed filter WOULD return a frontier here.
      await seedRows(userId, [{ seq: 0, issuedAt: T0 + 10_000 }]);

      expect(
        await oxyRecordStore.latestIssuedAtForKey(subject, v2EnvelopeMissing(subject, omitted))
      ).toBeNull();
    }
  );

  it('answers null when the subject DID does not belong to this server', async () => {
    const userId = await account();
    await seedRows(userId, [{ seq: 0, issuedAt: T0 + 10_000 }]);
    const foreign = `did:web:evil.com:u:${userId}`;

    expect(await oxyRecordStore.latestIssuedAtForKey(foreign, v2Envelope(foreign))).toBeNull();
  });

  it('scopes a v1 singleton by TYPE, not by the account’s newest record', async () => {
    const userId = await account();
    const subject = subjectKeyForUser(userId);
    await seedRows(userId, [
      { type: 'identity', issuedAt: T0, createdAt: new Date('2026-01-01T00:00:00.000Z') },
      // The `profile` singleton is newer on BOTH axes — `issued_at` and the
      // `created_at` the store sorts on — so an unscoped read answers with it
      // for either query and rejects a perfectly valid `identity` update.
      { type: 'profile', issuedAt: T0 + 10_000, createdAt: new Date('2026-02-01T00:00:00.000Z') },
    ]);

    expect(
      await oxyRecordStore.latestIssuedAtForKey(subject, v1Envelope(subject, 'identity', T0 + 1))
    ).toBe(T0);
    expect(
      await oxyRecordStore.latestIssuedAtForKey(subject, v1Envelope(subject, 'profile', T0 + 1))
    ).toBe(T0 + 10_000);
  });

  it('answers null for a v1 type outside the Oxy store set', async () => {
    const userId = await account();
    const subject = subjectKeyForUser(userId);
    await seedRows(userId, [{ type: 'identity', issuedAt: T0 + 10_000 }]);

    // A PER-APP type, not `app_record`: the set admits the one shared app
    // category, so no stored row can carry THIS — the column's CHECK forbids it
    // — and there is no frontier, certainly not the account's newest record.
    expect(
      await oxyRecordStore.latestIssuedAtForKey(subject, v1Envelope(subject, 'app.syra.listen', T0))
    ).toBeNull();
  });

  it('is scoped to the subject', async () => {
    const mine = await account();
    const theirs = await account();
    await seedRows(theirs, [
      { seq: 0, collection: 'app.oxy.profile', rkey: 'self', issuedAt: T0 + 10_000 },
    ]);

    const subject = subjectKeyForUser(mine);
    expect(
      await oxyRecordStore.latestIssuedAtForKey(
        subject,
        v2Envelope(subject, { collection: 'app.oxy.profile', rkey: 'self' })
      )
    ).toBeNull();
  });
});

describe('reads by content address', () => {
  it('returns the stored envelope verbatim for an address, and null for an unknown one', async () => {
    // Credential verification re-canonicalizes from THIS value rather than
    // trusting a projection, so what comes back has to be the envelope that was
    // stored, not a reconstruction.
    const userId = await account();
    const [recordId] = await seedRows(userId, [
      { seq: 0, collection: 'app.oxy.credential', rkey: 'cred-1', issuedAt: T0 },
    ]);

    const [row] = await getDb()
      .select({ envelope: signedRecords.envelope })
      .from(signedRecords)
      .where(eq(signedRecords.recordId, recordId));
    expect(await oxyRecordStore.envelopeByRecordId(recordId)).toEqual(row.envelope);
    expect(await oxyRecordStore.envelopeByRecordId(`missing-${randomUUID()}`)).toBeNull();
  });

  it('distinguishes an address the ledger HOLDS from one merely computed', async () => {
    const userId = await account();
    const [recordId] = await seedRows(userId, [{ seq: 0, issuedAt: T0 }]);

    expect(await oxyRecordStore.hasRecordId(recordId)).toBe(true);
    // The v1 append path returns an address it never persists; every projection
    // that stores `record_id` as a foreign key depends on telling the two apart.
    const unstored = await computeRecordId(v1Envelope(subjectKeyForUser(userId), 'identity', T0));
    expect(await oxyRecordStore.hasRecordId(unstored)).toBe(false);
  });
});

describe('the subject DID gates every read and the append', () => {
  it('returns no head for a foreign spelling of an account that HAS one', async () => {
    const userId = await account();
    const [recordId] = await seedRows(userId, [{ seq: 0, issuedAt: T0 }]);
    await getDb().insert(repoHeads).values({
      userId,
      subjectDid: buildUserDid(userId),
      seq: 0,
      headRecordId: recordId,
      recordCount: 1,
    });

    expect(await oxyRecordStore.getHead(subjectKeyForUser(userId))).toEqual({
      headRecordId: recordId,
      seq: 0,
      recordCount: 1,
    });
    // Same account id, another issuer's namespace: this server owns no chain
    // for it, so the head must not leak across the domain boundary.
    expect(await oxyRecordStore.getHead(`did:web:evil.com:u:${userId}`)).toBeNull();
  });

  it('returns null head for an account that has no chain', async () => {
    expect(await oxyRecordStore.getHead(subjectKeyForUser(await account()))).toBeNull();
  });

  it('refuses to append under a DID this server does not own', async () => {
    const userId = await account();
    const foreign = `did:web:evil.com:u:${userId}`;
    const envelope = v2Envelope(foreign);

    expect(await oxyRecordStore.append(foreign, envelope, await computeRecordId(envelope))).toEqual({
      ok: false,
      reason: 'chain_gap',
    });
    expect(await countRecords(userId)).toBe(0);
  });

  it('refuses to append a record type outside the Oxy store set', async () => {
    const userId = await account();
    const subject = subjectKeyForUser(userId);
    // A PER-APP type. `app_record` is IN the set — see the case below — so an
    // app that invents its own category is what this still refuses.
    const envelope = v2Envelope(subject, { type: 'app.syra.listen' });

    // The re-narrowing carries `oxyStorePolicy`'s guarantee into the INSERT, so
    // the store stays correct even when driven by another caller.
    expect(await oxyRecordStore.append(subject, envelope, await computeRecordId(envelope))).toEqual({
      ok: false,
      reason: 'invalid_envelope',
    });
    expect(await countRecords(userId)).toBe(0);
  });

  /**
   * The append that the whole shared-chain idea rests on: an app's record lands
   * on the SUBJECT'S OWN chain, under the shared `app_record` category, with the
   * lexicon carried by `collection` and denormalized to `nsid`.
   *
   * This is the positive control for the case above — without it, a mutation
   * that re-closed the set against `app_record` would leave every other
   * assertion in this file green.
   */
  it('appends an app record under the subject’s own chain', async () => {
    const userId = await account();
    const subject = subjectKeyForUser(userId);
    const envelope = v2Envelope(subject, {
      type: 'app_record',
      collection: 'app.mention.feed.post',
      rkey: 'post_1',
    });
    const recordId = await computeRecordId(envelope);

    expect(await oxyRecordStore.append(subject, envelope, recordId)).toEqual({
      ok: true,
      recordId,
      seq: 0,
    });

    // Stored under the lexicon, which is what the multi-author read filters on.
    const [row] = await getDb()
      .select({ nsid: signedRecords.nsid, type: signedRecords.type })
      .from(signedRecords)
      .where(eq(signedRecords.recordId, recordId));
    expect(row).toEqual({ nsid: 'app.mention.feed.post', type: 'app_record' });
  });
});

/**
 * The multi-author read — the one query on this store that spans subjects.
 *
 * Fixtures vary `collection` (the `nsid` column) freely while keeping `type`
 * inside the Oxy store's accepted set, because the CHECK constraint still
 * rejects an app `type` (see the append case above). That split is deliberate:
 * `nsid` is what this query filters on, so the suite exercises it today without
 * depending on the separate decision to admit app records.
 */
describe('listRecordsByAuthors', () => {
  const FEED = 'app.mention.feed.post';
  const OTHER = 'app.syra.listen';

  it('merges several authors into one page ordered by store time', async () => {
    const [a, b] = [await account(), await account()];
    await seedRows(a, [
      { seq: 0, collection: FEED, issuedAt: T0, createdAt: new Date(T0 + 1000) },
      { seq: 1, collection: FEED, issuedAt: T0, createdAt: new Date(T0 + 3000) },
    ]);
    await seedRows(b, [{ seq: 0, collection: FEED, issuedAt: T0, createdAt: new Date(T0 + 2000) }]);

    const page = await oxyRecordStore.listRecordsByAuthors({
      userIds: [a, b],
      collections: [FEED],
    });

    // Interleaved by time across authors — not grouped by author, which is what
    // a naive per-author loop would produce.
    expect(page.records.map((r) => r.recordId)).toEqual([`${a}-0`, `${b}-0`, `${a}-1`]);
    expect(page.records.every((r) => r.nsid === FEED)).toBe(true);
  });

  it('returns only the requested collections', async () => {
    const userId = await account();
    await seedRows(userId, [
      { seq: 0, collection: FEED, issuedAt: T0, createdAt: new Date(T0 + 1000) },
      { seq: 1, collection: OTHER, issuedAt: T0, createdAt: new Date(T0 + 2000) },
    ]);

    const page = await oxyRecordStore.listRecordsByAuthors({ userIds: [userId], collections: [FEED] });

    expect(page.records.map((r) => r.recordId)).toEqual([`${userId}-0`]);
  });

  it('excludes unverified rows and v1 rows', async () => {
    const userId = await account();
    await seedRows(userId, [
      { seq: 0, collection: FEED, issuedAt: T0, createdAt: new Date(T0 + 1000), verified: false },
      // No `seq` ⇒ v1: the completeness CHECK leaves `nsid` null, so it can
      // never carry a lexicon to be asked for.
      { issuedAt: T0, createdAt: new Date(T0 + 2000) },
      { seq: 1, collection: FEED, issuedAt: T0, createdAt: new Date(T0 + 3000) },
    ]);

    const page = await oxyRecordStore.listRecordsByAuthors({ userIds: [userId], collections: [FEED] });

    expect(page.records.map((r) => r.recordId)).toEqual([`${userId}-1`]);
  });

  /**
   * The fixture that tells a ROW-VALUE cursor from a plain timestamp one.
   *
   * Both rows share `created_at` to the microsecond. `created_at > cursor` skips
   * the second row forever; `created_at >= cursor` returns the first one again
   * on every poll. Only `(created_at, id) > (…, …)` resumes exactly once — and
   * every other case in this block would pass under all three, which is why
   * this one exists.
   */
  it('resumes past a cursor when two records share a timestamp', async () => {
    const userId = await account();
    const sameInstant = new Date(T0 + 5000);
    await seedRows(userId, [
      { seq: 0, collection: FEED, issuedAt: T0, createdAt: sameInstant },
      { seq: 1, collection: FEED, issuedAt: T0, createdAt: sameInstant },
    ]);

    const first = await oxyRecordStore.listRecordsByAuthors({
      userIds: [userId],
      collections: [FEED],
      limit: 1,
    });
    expect(first.records).toHaveLength(1);
    expect(first.nextCursor).not.toBeNull();

    const second = await oxyRecordStore.listRecordsByAuthors({
      userIds: [userId],
      collections: [FEED],
      after: first.nextCursor,
    });

    // SORTED on both sides: the property under test is "each record exactly
    // once, none skipped and none repeated", and the traversal ORDER between two
    // records sharing a timestamp is not something this API promises. The
    // tiebreaker is `id`, a uuid v7 whose random bits decide the order of two
    // rows generated inside the same millisecond — so asserting the sequence
    // made the case depend on which uuid happened to sort first.
    const seen = [...first.records, ...second.records].map((r) => r.recordId);
    expect([...seen].sort()).toEqual([`${userId}-0`, `${userId}-1`].sort());
    expect(new Set(seen).size).toBe(2);
  });

  it('reports no cursor once the stream is exhausted', async () => {
    const userId = await account();
    await seedRows(userId, [{ seq: 0, collection: FEED, issuedAt: T0, createdAt: new Date(T0 + 1000) }]);

    const page = await oxyRecordStore.listRecordsByAuthors({ userIds: [userId], collections: [FEED] });

    expect(page.records).toHaveLength(1);
    expect(page.nextCursor).toBeNull();
  });

  /**
   * An empty filter must mean NOTHING, never everything. Both cases seed a row
   * that a dropped `WHERE` clause would happily return, so the assertion cannot
   * pass vacuously.
   */
  it('answers an empty author or collection list with an empty page', async () => {
    const userId = await account();
    await seedRows(userId, [{ seq: 0, collection: FEED, issuedAt: T0, createdAt: new Date(T0 + 1000) }]);

    expect(await oxyRecordStore.listRecordsByAuthors({ userIds: [], collections: [FEED] })).toEqual({
      records: [],
      nextCursor: null,
    });
    expect(await oxyRecordStore.listRecordsByAuthors({ userIds: [userId], collections: [] })).toEqual({
      records: [],
      nextCursor: null,
    });
  });

  it('refuses an oversized author or collection list instead of truncating it', async () => {
    const userId = await account();

    await expect(
      oxyRecordStore.listRecordsByAuthors({
        userIds: Array.from({ length: MAX_RECORD_AUTHORS + 1 }, (_, i) => `u${i}`),
        collections: [FEED],
      }),
    ).rejects.toThrow(/exceeds the 300 cap/);

    await expect(
      oxyRecordStore.listRecordsByAuthors({
        userIds: [userId],
        collections: Array.from({ length: MAX_RECORD_COLLECTIONS + 1 }, (_, i) => `app.c${i}`),
      }),
    ).rejects.toThrow(/exceeds the 32 cap/);
  });

  it('counts a repeated author once against the cap', async () => {
    const userId = await account();
    await seedRows(userId, [{ seq: 0, collection: FEED, issuedAt: T0, createdAt: new Date(T0 + 1000) }]);

    // 400 entries, one distinct id: deduping happens BEFORE the cap, so a
    // caller that repeats an author is not punished for it.
    const page = await oxyRecordStore.listRecordsByAuthors({
      userIds: Array.from({ length: 400 }, () => userId),
      collections: [FEED, FEED],
    });

    expect(page.records.map((r) => r.recordId)).toEqual([`${userId}-0`]);
  });
});
