/**
 * Transparency checkpoints, against a REAL Postgres.
 *
 * Three things have to be true for the log to mean anything, and none of them
 * is visible in the schema file alone:
 *
 *   1. The signed body cannot be mutated. Nothing re-verifies a stored
 *      checkpoint on read, so a silent edit would break every signature over it
 *      AND the next checkpoint's `prev_checkpoint_hash` link with no symptom.
 *      Enforced by a TRIGGER, which drizzle-kit cannot emit — so this suite also
 *      asserts the trigger EXISTS, and a regeneration that dropped it goes red.
 *   2. One index, one root. The unique constraint IS the checkpoint job's mutex;
 *      two signed roots for one index is the equivocation the log detects.
 *   3. `period_end` survives becoming a `timestamptz`. It is part of the SIGNED
 *      body, so the round-trip is proved by signing, storing, reading back,
 *      rebuilding the fields with `.getTime()`, and re-verifying — not argued.
 */

import { randomUUID } from 'node:crypto';
import { asc, eq, sql } from 'drizzle-orm';
import {
  buildTransparencyTreeFromHeads,
  checkpointHash,
  inclusionProof,
  signCheckpoint,
  transparencyLeafHash,
  verifyCheckpointSignature,
  verifyInclusionProof,
  type TransparencyCheckpointFields,
} from '@oxyhq/protocol';
import { closePostgres, connectPostgres, getDb } from '../../../config/postgres';
import {
  TRANSPARENCY_IMMUTABILITY_TRIGGERS,
  transparencyCheckpointAnchors,
  transparencyCheckpointSignatures,
  transparencyCheckpointSnapshotEntries,
  transparencyCheckpoints,
} from '../transparencyCheckpoints';

/** Postgres `unique_violation`. */
const UNIQUE_VIOLATION = '23505';
/** Postgres `check_violation` — what the immutability triggers raise. */
const CHECK_VIOLATION = '23514';

/** A fixed, valid secp256k1 scalar. Signs test checkpoints only. */
const TEST_PRIVATE_KEY = '4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318';

beforeAll(async () => {
  await connectPostgres();
});

afterAll(async () => {
  await closePostgres();
});

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
  throw new Error('Expected the query to be rejected, but it succeeded.');
}

/**
 * `index` is globally unique, so every case mints its own from a shared counter
 * rather than depending on the table being empty.
 */
let nextIndex = 1_000_000;
function freshIndex(): number {
  nextIndex += 1;
  return nextIndex;
}

/** Insert a minimal checkpoint and return its row id. */
async function insertCheckpoint(overrides: {
  index?: number;
  periodEnd?: Date;
  treeSize?: number;
  root?: string;
} = {}): Promise<string> {
  const [row] = await getDb()
    .insert(transparencyCheckpoints)
    .values({
      index: overrides.index ?? freshIndex(),
      periodEnd: overrides.periodEnd ?? new Date(),
      treeSize: overrides.treeSize ?? 1,
      root: overrides.root ?? `root-${randomUUID()}`,
      prevCheckpointHash: null,
    })
    .returning({ id: transparencyCheckpoints.id });
  return row.id;
}

describe('the signed body is immutable', () => {
  it('installs both triggers — the DDL drizzle-kit cannot emit', async () => {
    // Without this, every case below would pass just as happily against a
    // database where the migration silently lost the trigger and the UPDATE
    // simply did nothing observable in that test's assertions.
    const rows = await getDb().execute<{ tgname: string }>(sql`
      select tgname from pg_trigger where not tgisinternal order by tgname
    `);
    const installed = rows.map((row) => row.tgname);

    for (const trigger of TRANSPARENCY_IMMUTABILITY_TRIGGERS) {
      expect(installed).toContain(trigger);
    }
  });

  it.each([
    ['index', (id: string) => getDb().update(transparencyCheckpoints).set({ index: freshIndex() }).where(eq(transparencyCheckpoints.id, id))],
    ['period_end', (id: string) => getDb().update(transparencyCheckpoints).set({ periodEnd: new Date(0) }).where(eq(transparencyCheckpoints.id, id))],
    ['tree_size', (id: string) => getDb().update(transparencyCheckpoints).set({ treeSize: 99 }).where(eq(transparencyCheckpoints.id, id))],
    ['root', (id: string) => getDb().update(transparencyCheckpoints).set({ root: 'tampered' }).where(eq(transparencyCheckpoints.id, id))],
    ['prev_checkpoint_hash', (id: string) => getDb().update(transparencyCheckpoints).set({ prevCheckpointHash: 'tampered' }).where(eq(transparencyCheckpoints.id, id))],
  ])('refuses to change %s, and names it', async (column, mutate) => {
    const id = await insertCheckpoint();

    const error = await rejection(mutate(id));

    expect(pgErrorCode(error)).toBe(CHECK_VIOLATION);
    // The message names the offending column, so a failure in production says
    // WHICH signed field something tried to rewrite.
    expect(pgMessage(error)).toContain(`transparency_checkpoints.${column} is immutable`);
  });

  it('still allows the two fields that legitimately grow after insert', async () => {
    const id = await insertCheckpoint();
    const signature = await signCheckpoint(
      { index: 0, periodEnd: 0, treeSize: 0, root: 'r', prevCheckpointHash: null },
      TEST_PRIVATE_KEY
    );

    // A witness co-signs later; an anchor is broadcast later and then reconciled.
    await expect(
      getDb().insert(transparencyCheckpointSignatures).values({
        checkpointId: id,
        position: 1,
        publicKey: signature.publicKey,
        alg: 'ES256K-DER-SHA256',
        signature: signature.signature,
      })
    ).resolves.toBeDefined();

    const [anchor] = await getDb()
      .insert(transparencyCheckpointAnchors)
      .values({
        checkpointId: id,
        network: 'faircoin',
        txid: `tx-${randomUUID()}`,
        confirmations: 0,
        anchoredAt: new Date(),
      })
      .returning({ id: transparencyCheckpointAnchors.id });

    await expect(
      getDb()
        .update(transparencyCheckpointAnchors)
        .set({ confirmations: 6 })
        .where(eq(transparencyCheckpointAnchors.id, anchor.id))
    ).resolves.toBeDefined();
  });

  it('refuses to rewrite a committed snapshot leaf', async () => {
    const id = await insertCheckpoint();
    await getDb().insert(transparencyCheckpointSnapshotEntries).values({
      checkpointId: id,
      leafIndex: 0,
      subjectDid: 'did:web:oxy.so:u:a',
      seq: 0,
      headRecordId: 'rec-a',
    });

    const error = await rejection(
      getDb()
        .update(transparencyCheckpointSnapshotEntries)
        .set({ headRecordId: 'rewritten' })
        .where(eq(transparencyCheckpointSnapshotEntries.checkpointId, id))
    );

    expect(pgErrorCode(error)).toBe(CHECK_VIOLATION);
    expect(pgMessage(error)).toContain('append-only');
  });
});

describe('index uniqueness — the checkpoint job mutex', () => {
  it('lets exactly one of two concurrent builders publish a root for an index', async () => {
    const index = freshIndex();
    const build = (root: string) =>
      getDb().insert(transparencyCheckpoints).values({
        index,
        periodEnd: new Date(),
        treeSize: 1,
        root,
        prevCheckpointHash: null,
      });

    // Two tasks computing the same period read heads at slightly different
    // moments, so their roots differ. Publishing both would be equivocation.
    const settled = await Promise.allSettled([build('root-from-task-a'), build('root-from-task-b')]);

    expect(settled.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = settled.find((r) => r.status === 'rejected');
    expect(rejected && pgErrorCode(rejected.reason)).toBe(UNIQUE_VIOLATION);

    // The loser must ADOPT the persisted root, which is only possible because
    // exactly one row survives.
    const rows = await getDb()
      .select()
      .from(transparencyCheckpoints)
      .where(eq(transparencyCheckpoints.index, index));
    expect(rows).toHaveLength(1);
  });

  it('accepts one endorsement per signer and refuses a duplicate', async () => {
    const id = await insertCheckpoint();
    const fields: TransparencyCheckpointFields = {
      index: 1,
      periodEnd: 0,
      treeSize: 0,
      root: 'r',
      prevCheckpointHash: null,
    };
    const signature = await signCheckpoint(fields, TEST_PRIVATE_KEY);

    await getDb().insert(transparencyCheckpointSignatures).values({
      checkpointId: id,
      position: 0,
      publicKey: signature.publicKey,
      alg: 'ES256K-DER-SHA256',
      signature: signature.signature,
    });

    const error = await rejection(
      getDb().insert(transparencyCheckpointSignatures).values({
        checkpointId: id,
        position: 1,
        publicKey: signature.publicKey,
        alg: 'ES256K-DER-SHA256',
        signature: signature.signature,
      })
    );

    expect(pgErrorCode(error)).toBe(UNIQUE_VIOLATION);
  });
});

describe('the signed body survives the storage round-trip', () => {
  it('re-verifies after `period_end` becomes a timestamptz and comes back', async () => {
    // The one risk in porting a SIGNED ms-epoch number to a date column. A
    // whole-millisecond value round-trips through `timestamptz` exactly, so
    // rebuilding the fields with `.getTime()` must reproduce the signed bytes.
    const periodEnd = 1_700_000_123_456;
    const index = freshIndex();
    const fields: TransparencyCheckpointFields = {
      index,
      periodEnd,
      treeSize: 3,
      root: 'a'.repeat(64),
      prevCheckpointHash: null,
    };
    const signature = await signCheckpoint(fields, TEST_PRIVATE_KEY);
    expect(await verifyCheckpointSignature(fields, signature)).toBe(true);

    const [inserted] = await getDb()
      .insert(transparencyCheckpoints)
      .values({
        index,
        periodEnd: new Date(periodEnd),
        treeSize: fields.treeSize,
        root: fields.root,
        prevCheckpointHash: fields.prevCheckpointHash,
      })
      .returning({ id: transparencyCheckpoints.id });
    await getDb().insert(transparencyCheckpointSignatures).values({
      checkpointId: inserted.id,
      position: 0,
      publicKey: signature.publicKey,
      alg: 'ES256K-DER-SHA256',
      signature: signature.signature,
    });

    const [row] = await getDb()
      .select()
      .from(transparencyCheckpoints)
      .where(eq(transparencyCheckpoints.id, inserted.id));
    const [storedSignature] = await getDb()
      .select()
      .from(transparencyCheckpointSignatures)
      .where(eq(transparencyCheckpointSignatures.checkpointId, inserted.id));

    const rebuilt: TransparencyCheckpointFields = {
      index: row.index,
      periodEnd: row.periodEnd.getTime(),
      treeSize: row.treeSize,
      root: row.root,
      prevCheckpointHash: row.prevCheckpointHash,
    };

    expect(rebuilt.periodEnd).toBe(periodEnd);
    expect(
      await verifyCheckpointSignature(rebuilt, {
        publicKey: storedSignature.publicKey,
        alg: storedSignature.alg,
        signature: storedSignature.signature,
      })
    ).toBe(true);
    // The hash the NEXT checkpoint links to is unchanged, so the chain holds.
    expect(await checkpointHash(rebuilt)).toBe(await checkpointHash(fields));
  });
});

describe('the committed snapshot serves inclusion proofs', () => {
  it('keeps the leaf ORDER the Merkle tree committed to', async () => {
    // `getInclusionProof` uses the array position as the leaf index, so the
    // ordinal is the whole reason `snapshot[]` is a child table with a
    // composite primary key rather than an unordered set of rows.
    const heads = [
      { subjectDid: 'did:web:oxy.so:u:c', seq: 2, headRecordId: 'rec-c' },
      { subjectDid: 'did:web:oxy.so:u:a', seq: 0, headRecordId: 'rec-a' },
      { subjectDid: 'did:web:oxy.so:u:b', seq: 1, headRecordId: 'rec-b' },
    ];
    const tree = await buildTransparencyTreeFromHeads(heads);
    const ordered = [...heads].sort(
      (a, b) => tree.indexBySubject[a.subjectDid] - tree.indexBySubject[b.subjectDid]
    );

    const id = await insertCheckpoint({ treeSize: tree.treeSize, root: tree.root });
    await getDb()
      .insert(transparencyCheckpointSnapshotEntries)
      .values(
        ordered.map((entry, leafIndex) => ({
          checkpointId: id,
          leafIndex,
          subjectDid: entry.subjectDid,
          seq: entry.seq,
          headRecordId: entry.headRecordId,
        }))
      );

    const stored = await getDb()
      .select()
      .from(transparencyCheckpointSnapshotEntries)
      .where(eq(transparencyCheckpointSnapshotEntries.checkpointId, id))
      .orderBy(asc(transparencyCheckpointSnapshotEntries.leafIndex));

    expect(stored.map((row) => row.subjectDid)).toEqual(ordered.map((entry) => entry.subjectDid));

    // And a proof built from what came OUT of the database verifies against the
    // stored root — the end-to-end property the ordering exists for.
    const leafIndex = stored.findIndex((row) => row.subjectDid === 'did:web:oxy.so:u:b');
    const leaf = await transparencyLeafHash({
      subjectDid: stored[leafIndex].subjectDid,
      seq: stored[leafIndex].seq,
      headRecordId: stored[leafIndex].headRecordId,
    });
    const [checkpoint] = await getDb()
      .select()
      .from(transparencyCheckpoints)
      .where(eq(transparencyCheckpoints.id, id));

    const valid = await verifyInclusionProof({
      leaf,
      index: leafIndex,
      proof: inclusionProof(tree, leafIndex),
      root: checkpoint.root,
      treeSize: checkpoint.treeSize,
    });
    expect(valid).toBe(true);
  });

  it('holds one head per subject per checkpoint', async () => {
    const id = await insertCheckpoint();
    await getDb().insert(transparencyCheckpointSnapshotEntries).values({
      checkpointId: id,
      leafIndex: 0,
      subjectDid: 'did:web:oxy.so:u:dup',
      seq: 0,
      headRecordId: 'rec-1',
    });

    const error = await rejection(
      getDb().insert(transparencyCheckpointSnapshotEntries).values({
        checkpointId: id,
        leafIndex: 1,
        subjectDid: 'did:web:oxy.so:u:dup',
        seq: 1,
        headRecordId: 'rec-2',
      })
    );

    expect(pgErrorCode(error)).toBe(UNIQUE_VIOLATION);
  });

  it('is deliberately NOT tied to the records it committed to', async () => {
    // `head_record_id` carries no foreign key on purpose: the snapshot is frozen
    // evidence under a signed root, so no ON DELETE action may ever rewrite it.
    // An account erasure removing the record must leave the leaf standing.
    const id = await insertCheckpoint();
    await expect(
      getDb().insert(transparencyCheckpointSnapshotEntries).values({
        checkpointId: id,
        leafIndex: 0,
        subjectDid: 'did:web:oxy.so:u:erased',
        seq: 4,
        headRecordId: `never-stored-${randomUUID()}`,
      })
    ).resolves.toBeDefined();
  });
});
