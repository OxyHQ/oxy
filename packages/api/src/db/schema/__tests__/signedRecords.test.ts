/**
 * The signed-record chain, against a REAL Postgres.
 *
 * This is the correctness-critical table of the migration: the whole civic
 * layer's guarantees reduce to "the stored envelope still verifies" and "the
 * chain cannot fork". Everything here runs through the application's own pool
 * against the throwaway database `jest.globalSetup.ts` migrated, so what passes
 * is what the shipped DDL actually does.
 *
 * The headline case is the `jsonb` round-trip. `CONVENTIONS.md` and the
 * migration contract chose `jsonb` for `envelope` on the grounds that
 * verification never reads the stored bytes — `canonicalize()` re-serializes
 * from the PARSED value — so `jsonb`'s key reordering, number re-formatting and
 * unicode unescaping are representation-only. That is an argument; the test
 * below is the evidence. It signs a real envelope with a real secp256k1 key,
 * stores it, reads it back, recomputes the canonical signing input from what
 * came out, and re-verifies the signature.
 *
 * Every row carries a per-test random owner, so no assertion depends on a table
 * being empty.
 */

import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import {
  canonicalize,
  computeRecordId,
  signEnvelope,
  signedRecordSigningInput,
  verifyEnvelopeSignature,
} from '@oxyhq/protocol';
import type { SignedRecordEnvelope } from '@oxyhq/contracts';
import { closePostgres, connectPostgres, getDb } from '../../../config/postgres';
import { repoHeads } from '../repoHeads';
import { signedRecords } from '../signedRecords';
import { users } from '../users';

/** Postgres `unique_violation`. */
const UNIQUE_VIOLATION = '23505';
/** Postgres `check_violation`. */
const CHECK_VIOLATION = '23514';
/** Postgres `foreign_key_violation`. */
const FOREIGN_KEY_VIOLATION = '23503';

/**
 * A fixed, valid secp256k1 scalar. Fixed rather than random so a failure is
 * reproducible; it signs test envelopes only and authenticates nothing.
 */
const TEST_PRIVATE_KEY = '4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318';

beforeAll(async () => {
  await connectPostgres();
});

afterAll(async () => {
  await closePostgres();
});

/** A real `users` row — every `user_id` here carries a foreign key. */
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

/** Await a query expecting rejection, and return the error. Runs it exactly once. */
async function rejection(query: Promise<unknown>): Promise<unknown> {
  try {
    await query;
  } catch (error) {
    return error;
  }
  throw new Error('Expected the query to be rejected by a constraint, but it succeeded.');
}

/**
 * A well-formed but UNSIGNED envelope, for the constraint cases below — none of
 * them verifies a signature, and a real one would only obscure what is being
 * asserted. The round-trip suite above signs for real.
 */
function stubEnvelope(subject: string, record: Record<string, unknown> = {}): SignedRecordEnvelope {
  return {
    version: 1,
    type: 'identity',
    subject,
    issuer: subject,
    record,
    issuedAt: 1_700_000_000_000,
    publicKey: 'pk',
    alg: 'ES256K-DER-SHA256',
    signature: 'unsigned-fixture',
  };
}

describe('envelope jsonb round-trip — the whole justification for the column type', () => {
  /**
   * A record body built to exercise every normalisation `jsonb` performs and
   * `canonicalize` is claimed to undo:
   *
   * - keys in DESCENDING order, so jsonb's own ordering must differ from ours;
   * - a nested object, likewise mis-ordered;
   * - a number in exponent form (`1e21`), which jsonb re-formats;
   * - a non-ASCII character, which jsonb stores unescaped;
   * - an EMPTY object, which `minimize: false` exists to preserve;
   * - an empty array and an explicit `null`.
   */
  function trickyRecord(): Record<string, unknown> {
    return {
      zeta: 'last-by-key',
      nested: { z: 1, a: { deep: 'value' }, m: [3, 2, 1] },
      huge: 1e21,
      unicode: 'café — naïve 😀 ünïcødé',
      preserved: {},
      emptyList: [],
      explicitNull: null,
      alpha: 'first-by-key',
    };
  }

  async function signTestEnvelope(subject: string): Promise<SignedRecordEnvelope> {
    return signEnvelope(
      {
        version: 2,
        type: 'identity',
        subject,
        issuer: subject,
        record: trickyRecord(),
        issuedAt: 1_700_000_000_000,
        seq: 0,
        prev: null,
        collection: 'app.oxy.identity',
        rkey: 'self',
      },
      TEST_PRIVATE_KEY
    );
  }

  it('still verifies after a store and a read — signature, signing input and content address', async () => {
    const userId = await owner();
    const subject = `did:web:oxy.so:u:${userId}`;
    const envelope = await signTestEnvelope(subject);
    const recordId = await computeRecordId(envelope);

    // Sanity: it verified BEFORE the database ever saw it. Without this, a test
    // that passes because verification is vacuously true would look identical.
    expect(await verifyEnvelopeSignature(envelope)).toBe(true);

    await getDb().insert(signedRecords).values({
      subjectDid: subject,
      userId,
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

    const [row] = await getDb()
      .select()
      .from(signedRecords)
      .where(eq(signedRecords.recordId, recordId));

    // The signature verifies against what POSTGRES returned, not against the
    // object we still hold in memory.
    expect(await verifyEnvelopeSignature(row.envelope)).toBe(true);
    // ...and the canonical signing input is byte-identical, which is the
    // property the signature check depends on.
    expect(signedRecordSigningInput(row.envelope)).toBe(signedRecordSigningInput(envelope));
    // ...so the content address is unchanged too, and every `prev` pointing at
    // it still resolves.
    expect(await computeRecordId(row.envelope)).toBe(recordId);
  });

  it('normalises the REPRESENTATION, which is exactly why re-canonicalizing is required', async () => {
    const userId = await owner();
    const subject = `did:web:oxy.so:u:${userId}`;
    const envelope = await signTestEnvelope(subject);
    const recordId = await computeRecordId(envelope);

    await getDb().insert(signedRecords).values({
      subjectDid: subject,
      userId,
      type: 'identity',
      envelope,
      publicKey: envelope.publicKey,
      seq: 0,
      prev: null,
      recordId,
      nsid: 'app.oxy.identity',
      rkey: 'self',
    });

    // The raw text Postgres holds is NOT the text we sent: keys are reordered
    // and `1e21` is re-formatted. If this ever stops being true the test above
    // would still pass while proving much less, so the difference is asserted
    // rather than assumed.
    const [raw] = await getDb().execute<{ stored: string }>(sql`
      select envelope::text as stored from signed_records where record_id = ${recordId}
    `);
    expect(raw.stored).not.toBe(JSON.stringify(envelope));
    expect(raw.stored).toContain('1000000000000000000000');

    // And the canonical form of both is identical, which is the invariant.
    const [row] = await getDb()
      .select()
      .from(signedRecords)
      .where(eq(signedRecords.recordId, recordId));
    expect(canonicalize(row.envelope)).toBe(canonicalize(envelope));
  });

  it('preserves an empty object — `minimize: false`, carried over', async () => {
    const userId = await owner();
    const subject = `did:web:oxy.so:u:${userId}`;
    const envelope = await signTestEnvelope(subject);
    const recordId = await computeRecordId(envelope);

    await getDb().insert(signedRecords).values({
      subjectDid: subject,
      userId,
      type: 'identity',
      envelope,
      publicKey: envelope.publicKey,
      seq: 0,
      prev: null,
      recordId,
      nsid: 'app.oxy.identity',
      rkey: 'self',
    });

    const [row] = await getDb()
      .select()
      .from(signedRecords)
      .where(eq(signedRecords.recordId, recordId));
    const record = row.envelope.record;

    expect(record.preserved).toEqual({});
    expect(record.emptyList).toEqual([]);
    expect(record.explicitNull).toBeNull();
  });

  it('refuses a NUL escape loudly rather than corrupting the record', async () => {
    // The one documented hazard of `jsonb`. It is the CORRECT failure mode: an
    // insert that raises beats a column that silently stores something else.
    const userId = await owner();
    const error = await rejection(
      getDb().execute(sql`
        insert into signed_records (id, subject_did, user_id, type, envelope, public_key)
        values (${randomUUID()}, 'did:web:oxy.so:u:x', ${userId}, 'identity',
                ${'{"record":{"nul":"a\\u0000b"}}'}::jsonb, 'pk')
      `)
    );

    expect(pgMessage(error)).toMatch(/unsupported Unicode escape sequence/i);
  });
});

describe('signed_records — the chain constraints', () => {
  it('rejects a second record at the same seq: the multi-device write-race backstop', async () => {
    const userId = await owner();
    const subject = `did:web:oxy.so:u:${userId}`;

    await getDb().insert(signedRecords).values({
      subjectDid: subject,
      userId,
      type: 'identity',
      envelope: stubEnvelope(subject, { device: 'a' }),
      publicKey: 'pk',
      seq: 0,
      prev: null,
      recordId: `rec-a-${randomUUID()}`,
      nsid: 'app.oxy.identity',
      rkey: 'self',
    });

    // The loser of the race. `oxyRecordStore.append` turns this into
    // `chain_conflict`, and the caller re-reads the head and re-signs.
    const error = await rejection(
      getDb().insert(signedRecords).values({
        subjectDid: subject,
        userId,
        type: 'identity',
        envelope: stubEnvelope(subject, { device: 'b' }),
        publicKey: 'pk',
        seq: 0,
        prev: null,
        recordId: `rec-b-${randomUUID()}`,
        nsid: 'app.oxy.identity',
        rkey: 'self',
      })
    );

    expect(pgErrorCode(error)).toBe(UNIQUE_VIOLATION);
    expect(pgConstraint(error)).toBe('signed_records_user_id_seq_key');
  });

  it('lets two SIMULTANEOUS inserts race for one seq, and exactly one wins', async () => {
    const userId = await owner();
    const subject = `did:web:oxy.so:u:${userId}`;
    const append = (device: string) =>
      getDb().insert(signedRecords).values({
        subjectDid: subject,
        userId,
        type: 'identity',
        envelope: stubEnvelope(subject, { device }),
        publicKey: 'pk',
        seq: 7,
        prev: null,
        recordId: `rec-${device}-${randomUUID()}`,
        nsid: 'app.oxy.identity',
        rkey: 'self',
      });

    const settled = await Promise.allSettled([append('a'), append('b')]);

    expect(settled.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = settled.find((r) => r.status === 'rejected');
    expect(rejected && pgErrorCode(rejected.reason)).toBe(UNIQUE_VIOLATION);
  });

  it('still admits every v1 row, which has no seq at all', async () => {
    // The Mongo index was PARTIAL only to dodge "missing field reads as null".
    // Postgres treats NULLs as distinct, so the plain UNIQUE keeps that
    // behaviour — and this is the case that would break if someone "tidied" the
    // column to NOT NULL DEFAULT 0.
    const userId = await owner();
    const subject = `did:web:oxy.so:u:${userId}`;

    await expect(
      getDb().insert(signedRecords).values([
        { subjectDid: subject, userId, type: 'identity', envelope: stubEnvelope(subject), publicKey: 'pk' },
        { subjectDid: subject, userId, type: 'profile', envelope: stubEnvelope(subject), publicKey: 'pk' },
      ])
    ).resolves.toBeDefined();
  });

  it('rejects a half-chained row — v2 needs all four chain fields, v1 none', async () => {
    const userId = await owner();
    const error = await rejection(
      getDb().insert(signedRecords).values({
        subjectDid: `did:web:oxy.so:u:${userId}`,
        userId,
        type: 'identity',
        envelope: stubEnvelope(`did:web:oxy.so:u:${userId}`),
        publicKey: 'pk',
        seq: 3,
      })
    );

    expect(pgErrorCode(error)).toBe(CHECK_VIOLATION);
    expect(pgConstraint(error)).toBe('signed_records_chain_completeness_check');
  });

  it('rejects a `prev` that names no stored record', async () => {
    const userId = await owner();
    const error = await rejection(
      getDb().insert(signedRecords).values({
        subjectDid: `did:web:oxy.so:u:${userId}`,
        userId,
        type: 'identity',
        envelope: stubEnvelope(`did:web:oxy.so:u:${userId}`),
        publicKey: 'pk',
        seq: 1,
        prev: `never-stored-${randomUUID()}`,
        recordId: `rec-${randomUUID()}`,
        nsid: 'app.oxy.identity',
        rkey: 'self',
      })
    );

    expect(pgErrorCode(error)).toBe(FOREIGN_KEY_VIOLATION);
  });

  it('rejects a record type outside the contract set, from a raw write', async () => {
    // Raw SQL on purpose: the typed column refuses this at compile time, so only
    // a hand-written statement can reach the constraint — which is who it is for.
    //
    // A PER-APP type, not `app_record`: the set admits the one shared app
    // category, so using that here would assert the opposite of what holds. An
    // app distinguishes its records by `nsid`, never by inventing a type.
    const error = await rejection(
      getDb().execute(sql`
        insert into signed_records (id, subject_did, user_id, type, envelope, public_key)
        values (${randomUUID()}, 'did:web:oxy.so:u:x', ${await owner()}, 'app.syra.listen', '{}'::jsonb, 'pk')
      `)
    );

    expect(pgErrorCode(error)).toBe(CHECK_VIOLATION);
    expect(pgConstraint(error)).toBe('signed_records_type_check');
  });
});

describe('repo_heads — the O(1) head pointer', () => {
  it('refuses a head that names no stored record', async () => {
    const userId = await owner();
    const error = await rejection(
      getDb().insert(repoHeads).values({
        userId,
        subjectDid: `did:web:oxy.so:u:${userId}`,
        seq: 0,
        headRecordId: `ghost-${randomUUID()}`,
        recordCount: 1,
      })
    );

    expect(pgErrorCode(error)).toBe(FOREIGN_KEY_VIOLATION);
  });

  it('holds exactly one head per account', async () => {
    const userId = await owner();
    const subject = `did:web:oxy.so:u:${userId}`;
    const first = `rec-${randomUUID()}`;
    const second = `rec-${randomUUID()}`;

    await getDb().insert(signedRecords).values([
      { subjectDid: subject, userId, type: 'identity', envelope: stubEnvelope(subject), publicKey: 'pk', seq: 0, prev: null, recordId: first, nsid: 'app.oxy.identity', rkey: 'self' },
      { subjectDid: subject, userId, type: 'identity', envelope: stubEnvelope(subject), publicKey: 'pk', seq: 1, prev: first, recordId: second, nsid: 'app.oxy.identity', rkey: 'self' },
    ]);
    await getDb().insert(repoHeads).values({ userId, subjectDid: subject, seq: 0, headRecordId: first, recordCount: 1 });

    const error = await rejection(
      getDb().insert(repoHeads).values({ userId, subjectDid: subject, seq: 1, headRecordId: second, recordCount: 2 })
    );

    expect(pgErrorCode(error)).toBe(UNIQUE_VIOLATION);
  });

  it('advances in the same transaction as the append, and rolls both back together', async () => {
    // The fork the Mongo `withTransaction` session-less fallback could produce:
    // a head advanced past a record that was never stored. Here the pair is
    // atomic for real, so a failure anywhere leaves the head where it was.
    const userId = await owner();
    const subject = `did:web:oxy.so:u:${userId}`;
    const genesis = `rec-${randomUUID()}`;

    await getDb().transaction(async (tx) => {
      await tx.insert(signedRecords).values({
        subjectDid: subject, userId, type: 'identity', envelope: stubEnvelope(subject), publicKey: 'pk',
        seq: 0, prev: null, recordId: genesis, nsid: 'app.oxy.identity', rkey: 'self',
      });
      await tx.insert(repoHeads).values({ userId, subjectDid: subject, seq: 0, headRecordId: genesis, recordCount: 1 });
    });

    const next = `rec-${randomUUID()}`;
    await expect(
      getDb().transaction(async (tx) => {
        await tx.insert(signedRecords).values({
          subjectDid: subject, userId, type: 'identity', envelope: stubEnvelope(subject), publicKey: 'pk',
          seq: 1, prev: genesis, recordId: next, nsid: 'app.oxy.identity', rkey: 'self',
        });
        await tx
          .update(repoHeads)
          .set({ seq: 1, headRecordId: next })
          .where(eq(repoHeads.userId, userId));
        throw new Error('simulated failure after both writes');
      })
    ).rejects.toThrow('simulated failure');

    const [head] = await getDb().select().from(repoHeads).where(eq(repoHeads.userId, userId));
    const stored = await getDb()
      .select()
      .from(signedRecords)
      .where(eq(signedRecords.recordId, next));

    expect(head.seq).toBe(0);
    expect(head.headRecordId).toBe(genesis);
    expect(stored).toHaveLength(0);
  });
});

describe('account erasure', () => {
  it('takes the whole chain and its head with it', async () => {
    const userId = await owner();
    const subject = `did:web:oxy.so:u:${userId}`;
    const genesis = `rec-${randomUUID()}`;

    await getDb().insert(signedRecords).values({
      subjectDid: subject, userId, type: 'identity', envelope: stubEnvelope(subject), publicKey: 'pk',
      seq: 0, prev: null, recordId: genesis, nsid: 'app.oxy.identity', rkey: 'self',
    });
    await getDb().insert(repoHeads).values({ userId, subjectDid: subject, seq: 0, headRecordId: genesis, recordCount: 1 });

    await getDb().delete(users).where(eq(users.id, userId));

    expect(await getDb().select().from(signedRecords).where(eq(signedRecords.userId, userId))).toHaveLength(0);
    expect(await getDb().select().from(repoHeads).where(eq(repoHeads.userId, userId))).toHaveLength(0);
  });
});
