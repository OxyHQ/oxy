/**
 * Transparency checkpoint service, against a REAL Postgres.
 *
 * The Merkle math itself is covered in `@oxyhq/protocol`; this suite locks the
 * SERVICE behaviour that makes the log trustworthy in production:
 *  - a checkpoint is signed, gapless, and hash-linked to its predecessor;
 *  - the concurrent-writer loser ADOPTS the persisted root instead of publishing
 *    a second root for the same index (two signed roots for one period is the
 *    exact equivocation this system exists to detect);
 *  - an inclusion proof is served from the snapshot the checkpoint COMMITTED to,
 *    not from whatever the heads happen to be now, and it verifies against the
 *    published root with the protocol's own verifier;
 *  - `period_end` survives becoming a `timestamptz` — it is part of the SIGNED
 *    body, so the round trip is proved by signing, storing, reading back, and
 *    re-verifying the signature against what came out of the database.
 *
 * ## Why this suite no longer mocks the models
 *
 * It used to hand-write a `TransparencyCheckpoint` stand-in that pushed into an
 * array, and SIMULATED the concurrent-write collision by rejecting with a fake
 * `code: 11000` on a flag the test set. The adoption path — the single most
 * safety-critical branch in this file — was therefore tested against the test's
 * own idea of a duplicate key rather than against a unique index, and it would
 * have stayed green against a port that reacted to the wrong SQLSTATE, the wrong
 * constraint, or nothing at all. Here two `buildCheckpoint` calls really race,
 * the loser really collides with `transparency_checkpoints_index_unique`, and
 * "the loser adopted the winner's root" is read back out of the database.
 *
 * ## Why this suite owns its OWN database
 *
 * `buildCheckpoint` commits EVERY head on the platform and derives its index
 * from the newest stored checkpoint: its unit of work is global, so `treeSize`
 * and `index` are only assertable against a database nobody else is writing to.
 * Eleven other suites write `repo_heads`, and jest runs suites in parallel
 * against the ONE throwaway database the global setup creates — so this file
 * creates a second one, points `DATABASE_URL` at it for the duration, and drops
 * it afterwards. That is also what lets the ceiling case seed 50 001 real chains
 * without leaving them behind for anyone else.
 *
 * The protocol crypto is real throughout.
 */

import { generateSecp256k1KeyPair } from '@oxyhq/protocol/secp256k1';
import { asc, eq, sql } from 'drizzle-orm';
import {
  checkpointHash,
  verifyCheckpointSignature,
  verifyInclusionProof,
} from '@oxyhq/protocol';

const oxyKey = generateSecp256k1KeyPair();
const OXY_PRIVATE_KEY = oxyKey.privateKey;
const OXY_PUBLIC_KEY = oxyKey.publicKey;

jest.mock('../../utils/logger', () => ({
  logger: { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { createTestDatabase, dropTestDatabase } from '../../db/testDatabase';
import { repoHeads } from '../../db/schema/repoHeads';
import { signedRecords } from '../../db/schema/signedRecords';
import {
  transparencyCheckpointSignatures,
  transparencyCheckpointSnapshotEntries,
  transparencyCheckpoints,
} from '../../db/schema/transparencyCheckpoints';
import { users } from '../../db/schema/users';
import { logger } from '../../utils/logger';
import {
  buildCheckpoint,
  checkpointSignedFields,
  getInclusionProof,
  getLatestCheckpoint,
  listCheckpoints,
  MAX_CHECKPOINT_SUBJECTS,
} from '../transparency.service';

/** One subject's head, as `buildCheckpoint` reads it out of `repo_heads`. */
interface HeadFixture {
  subjectDid: string;
  seq: number;
  headRecordId: string;
}

/** Creating + migrating a database and seeding 50 001 chains both outlast 10s. */
const SLOW_STEP_TIMEOUT_MS = 120_000;

let ownDatabaseUrl = '';
let sharedDatabaseUrl: string | undefined;

beforeAll(async () => {
  sharedDatabaseUrl = process.env.DATABASE_URL;
  ownDatabaseUrl = await createTestDatabase();
  await connectPostgres();
}, SLOW_STEP_TIMEOUT_MS);

afterAll(async () => {
  await closePostgres();
  await dropTestDatabase(ownDatabaseUrl);
  // Restore the run-wide database for whatever jest schedules next in this
  // worker; leaving `DATABASE_URL` pointed at a dropped database would fail the
  // next suite for a reason that has nothing to do with it.
  process.env.DATABASE_URL = sharedDatabaseUrl;
}, SLOW_STEP_TIMEOUT_MS);

beforeEach(async () => {
  process.env.OXY_PRIVATE_KEY = OXY_PRIVATE_KEY;
  jest.clearAllMocks();
  // `TRUNCATE … CASCADE` rather than four `DELETE`s: the ceiling case leaves
  // 150 003 rows behind, and cascading DELETEs across them cost more than every
  // other case in this file put together. Truncate is O(1) in the row count and
  // safe only because this suite owns the database — see the header.
  await getDb().execute(sql`truncate table users, transparency_checkpoints cascade`);
});

/**
 * Publish `count` heads, numbered from `from`.
 *
 * `repo_heads.head_record_id` is a real foreign key onto `signed_records`, so a
 * head cannot be invented without the record it points at — the schema enforcing
 * "a head can only ever point at a record that exists". Each head needs its own
 * account: `repo_heads.user_id` is unique, one chain per account.
 */
async function seedHeads(count: number, from = 1): Promise<HeadFixture[]> {
  const db = getDb();
  const fixtures: HeadFixture[] = [];

  for (let n = from; n < from + count; n += 1) {
    const [user] = await db.insert(users).values({ color: 'teal' }).returning({ id: users.id });
    const subjectDid = `did:web:oxy.so:u:${String(n).padStart(3, '0')}`;
    const headRecordId = String(n).padStart(64, '0');

    await db.insert(signedRecords).values({
      subjectDid,
      userId: user.id,
      type: 'identity',
      envelope: { version: 2, subject: subjectDid, seq: n },
      publicKey: OXY_PUBLIC_KEY,
      seq: n,
      prev: null,
      recordId: headRecordId,
      nsid: 'app.oxy.identity',
      rkey: 'self',
    });

    await db.insert(repoHeads).values({
      userId: user.id,
      subjectDid,
      seq: n,
      headRecordId,
      recordCount: 1,
    });

    fixtures.push({ subjectDid, seq: n, headRecordId });
  }

  return fixtures;
}

/** Advance one subject's head to a new record, as a later chain write would. */
async function advanceHead(subjectDid: string, seq: number, headRecordId: string): Promise<void> {
  const db = getDb();
  const [head] = await db
    .select({ userId: repoHeads.userId })
    .from(repoHeads)
    .where(eq(repoHeads.subjectDid, subjectDid));

  await db.insert(signedRecords).values({
    subjectDid,
    userId: head.userId,
    type: 'identity',
    envelope: { version: 2, subject: subjectDid, seq },
    publicKey: OXY_PUBLIC_KEY,
    seq,
    prev: null,
    recordId: headRecordId,
    nsid: 'app.oxy.identity',
    rkey: String(seq),
  });

  await db.update(repoHeads).set({ seq, headRecordId }).where(eq(repoHeads.subjectDid, subjectDid));
}

describe('buildCheckpoint', () => {
  it('publishes a signed genesis checkpoint with no previous link', async () => {
    await seedHeads(3);
    const checkpoint = await buildCheckpoint(1_800_000_000_000);

    expect(checkpoint.index).toBe(0);
    expect(checkpoint.prevCheckpointHash).toBeNull();
    expect(checkpoint.treeSize).toBe(3);
    expect(checkpoint.anchors).toEqual([]);
    expect(checkpoint.signatures).toHaveLength(1);
    expect(checkpoint.signatures[0].publicKey).toBe(OXY_PUBLIC_KEY);
    await expect(
      verifyCheckpointSignature(checkpointSignedFields(checkpoint), checkpoint.signatures[0]),
    ).resolves.toBe(true);
  });

  it('stores the signed body, the signature and the ordered snapshot', async () => {
    const heads = await seedHeads(3);
    const checkpoint = await buildCheckpoint(1_800_000_000_000);

    const db = getDb();
    const [row] = await db
      .select()
      .from(transparencyCheckpoints)
      .where(eq(transparencyCheckpoints.index, checkpoint.index));
    expect(row.root).toBe(checkpoint.root);
    expect(row.treeSize).toBe(3);
    // `period_end` is a `timestamptz` at rest and ms epoch on the wire.
    expect(row.periodEnd.getTime()).toBe(1_800_000_000_000);

    const signatures = await db
      .select()
      .from(transparencyCheckpointSignatures)
      .where(eq(transparencyCheckpointSignatures.checkpointId, row.id));
    expect(signatures).toHaveLength(1);
    expect(signatures[0].position).toBe(0);
    expect(signatures[0].publicKey).toBe(OXY_PUBLIC_KEY);

    const snapshot = await db
      .select()
      .from(transparencyCheckpointSnapshotEntries)
      .where(eq(transparencyCheckpointSnapshotEntries.checkpointId, row.id))
      .orderBy(asc(transparencyCheckpointSnapshotEntries.leafIndex));
    expect(snapshot.map((entry) => entry.leafIndex)).toEqual([0, 1, 2]);
    // Committed in ascending `subjectDid` order — the protocol's leaf order, and
    // the order `getInclusionProof` indexes by.
    expect(snapshot.map((entry) => entry.subjectDid)).toEqual(
      heads.map((head) => head.subjectDid).sort(),
    );
  });

  it('round-trips `periodEnd` through timestamptz without breaking the signature', async () => {
    await seedHeads(2);
    const periodEnd = 1_800_000_123_456;
    const published = await buildCheckpoint(periodEnd);
    expect(published.periodEnd).toBe(periodEnd);

    // Re-read from Postgres, rebuild the signing input from the STORED value,
    // and re-verify. A timestamp that lost or shifted a millisecond fails here.
    const reread = await getLatestCheckpoint();
    expect(reread).not.toBeNull();
    if (!reread) return;
    expect(reread.periodEnd).toBe(periodEnd);
    await expect(
      verifyCheckpointSignature(checkpointSignedFields(reread), reread.signatures[0]),
    ).resolves.toBe(true);
  });

  it('hash-links each checkpoint to its predecessor so history cannot be rewritten', async () => {
    await seedHeads(3);
    const first = await buildCheckpoint(1_800_000_000_000);
    await seedHeads(1, 4);
    const second = await buildCheckpoint(1_800_000_600_000);

    expect(second.index).toBe(1);
    expect(second.prevCheckpointHash).toBe(await checkpointHash(checkpointSignedFields(first)));
    expect(second.treeSize).toBe(4);
  });

  it('commits an empty tree when no subject has a chain yet', async () => {
    const checkpoint = await buildCheckpoint(1_800_000_000_000);
    expect(checkpoint.treeSize).toBe(0);
  });

  it('refuses to publish an unsigned checkpoint when the Oxy key is not configured', async () => {
    process.env.OXY_PRIVATE_KEY = '';
    await expect(buildCheckpoint(1_800_000_000_000)).rejects.toThrow(/OXY_PRIVATE_KEY/);
    expect(await getLatestCheckpoint()).toBeNull();
  });

  it(
    'refuses to publish a checkpoint whose proofs it could not serve',
    async () => {
      // 50 001 REAL chains, bulk-inserted: the ceiling is a property of the head
      // COUNT, so a stubbed head list would only prove the service can count an
      // array it was handed. Three `insert … select generate_series` statements
      // keep it to three round trips, and this suite's own database means the
      // rows bother nobody.
      const db = getDb();
      const oversized = MAX_CHECKPOINT_SUBJECTS + 1;
      await db.execute(sql`
        insert into users (id, color)
        select 'bulk-user-' || g, 'teal' from generate_series(1, ${oversized}) g
      `);
      await db.execute(sql`
        insert into signed_records
          (id, subject_did, user_id, type, envelope, public_key, seq, record_id, nsid, rkey)
        select 'bulk-rec-' || g, 'did:web:oxy.so:u:bulk' || g, 'bulk-user-' || g, 'identity',
               '{}'::jsonb, ${OXY_PUBLIC_KEY}, 0, lpad(g::text, 64, '0'), 'app.oxy.identity', 'self'
        from generate_series(1, ${oversized}) g
      `);
      await db.execute(sql`
        insert into repo_heads (id, user_id, subject_did, seq, head_record_id, record_count)
        select 'bulk-head-' || g, 'bulk-user-' || g, 'did:web:oxy.so:u:bulk' || g, 0,
               lpad(g::text, 64, '0'), 1
        from generate_series(1, ${oversized}) g
      `);

      await expect(buildCheckpoint(1_800_000_000_000)).rejects.toThrow(
        new RegExp(`${oversized} subjects exceeds the ${MAX_CHECKPOINT_SUBJECTS} ceiling`),
      );
      expect(await getLatestCheckpoint()).toBeNull();
    },
    SLOW_STEP_TIMEOUT_MS,
  );

  it('adopts the persisted checkpoint when another task won the same index', async () => {
    const heads = await seedHeads(3);

    // A REAL race: both tasks read the (empty) log and the same heads, both
    // compute index 0, and exactly one insert survives
    // `transparency_checkpoints_index_unique`. No simulated driver error, no
    // stubbed read — the loser's transaction really is rejected by the index.
    const [first, second] = await Promise.all([
      buildCheckpoint(1_800_000_000_000),
      buildCheckpoint(1_800_000_000_000),
    ]);

    // If the two calls had serialized instead of racing, the second would carry
    // index 1 and this fails LOUDLY — a race that did not reproduce must not
    // read as a pass.
    expect(first.index).toBe(0);
    expect(second.index).toBe(0);
    expect(second.root).toBe(first.root);
    expect(logger.warn).toHaveBeenCalledWith(
      'Transparency checkpoint index already published; adopting the persisted root',
      { index: 0 },
    );

    // Exactly ONE checkpoint row, one signature, one snapshot — the loser's
    // whole transaction rolled back rather than leaving half of it behind.
    const db = getDb();
    const stored = await db.select().from(transparencyCheckpoints);
    expect(stored).toHaveLength(1);
    expect(stored[0].root).toBe(first.root);
    expect(await db.select().from(transparencyCheckpointSignatures)).toHaveLength(1);
    expect(await db.select().from(transparencyCheckpointSnapshotEntries)).toHaveLength(
      heads.length,
    );
  });
});

describe('getInclusionProof', () => {
  it('serves a proof that verifies against the published root', async () => {
    const heads = await seedHeads(3);
    const checkpoint = await buildCheckpoint(1_800_000_000_000);
    const subject = heads[1];
    const proof = await getInclusionProof(subject.subjectDid);

    expect(proof).not.toBeNull();
    if (!proof) return;
    expect(proof.seq).toBe(subject.seq);
    expect(proof.headRecordId).toBe(subject.headRecordId);
    await expect(
      verifyInclusionProof({
        leaf: proof.leaf,
        index: proof.leafIndex,
        treeSize: checkpoint.treeSize,
        proof: proof.proof,
        root: checkpoint.root,
      }),
    ).resolves.toBe(true);
  });

  it('proves against the snapshot the checkpoint committed to, not the current heads', async () => {
    const heads = await seedHeads(3);
    const first = await buildCheckpoint(1_800_000_000_000);

    // The subject's chain advances AFTER the checkpoint was published, and a
    // second checkpoint commits the moved head.
    const subject = heads[1];
    await advanceHead(subject.subjectDid, 99, 'f'.repeat(64));
    const second = await buildCheckpoint(1_800_000_600_000);
    expect(second.root).not.toBe(first.root);

    const proof = await getInclusionProof(subject.subjectDid, 0);
    expect(proof).not.toBeNull();
    if (!proof) return;
    expect(proof.seq).toBe(subject.seq);
    expect(proof.headRecordId).toBe(subject.headRecordId);
    await expect(
      verifyInclusionProof({
        leaf: proof.leaf,
        index: proof.leafIndex,
        treeSize: first.treeSize,
        proof: proof.proof,
        root: first.root,
      }),
    ).resolves.toBe(true);
  });

  it('returns null for a subject that is not in the checkpoint', async () => {
    await seedHeads(3);
    await buildCheckpoint(1_800_000_000_000);
    await expect(getInclusionProof('did:web:oxy.so:u:nobody')).resolves.toBeNull();
  });

  it('returns null when no checkpoint has been published yet', async () => {
    const heads = await seedHeads(1);
    await expect(getInclusionProof(heads[0].subjectDid)).resolves.toBeNull();
  });

  it('returns null for a checkpoint index that does not exist', async () => {
    const heads = await seedHeads(1);
    await buildCheckpoint(1_800_000_000_000);
    await expect(getInclusionProof(heads[0].subjectDid, 42)).resolves.toBeNull();
  });

  it('serves a proof for every committed subject, and only for the one asked for', async () => {
    const heads = await seedHeads(4);
    const checkpoint = await buildCheckpoint(1_800_000_000_000);

    for (const head of heads) {
      const proof = await getInclusionProof(head.subjectDid);
      expect(proof?.subjectDid).toBe(head.subjectDid);
      expect(proof?.headRecordId).toBe(head.headRecordId);
      if (!proof) continue;
      await expect(
        verifyInclusionProof({
          leaf: proof.leaf,
          index: proof.leafIndex,
          treeSize: checkpoint.treeSize,
          proof: proof.proof,
          root: checkpoint.root,
        }),
      ).resolves.toBe(true);
    }
  });
});

describe('reads', () => {
  it('reports the newest checkpoint', async () => {
    await seedHeads(1);
    await buildCheckpoint(1_800_000_000_000);
    const second = await buildCheckpoint(1_800_000_600_000);
    await expect(getLatestCheckpoint()).resolves.toMatchObject({ index: second.index });
  });

  it('lists the checkpoint chain oldest first so a verifier can walk the links', async () => {
    await seedHeads(1);
    await buildCheckpoint(1_800_000_000_000);
    await buildCheckpoint(1_800_000_600_000);
    const list = await listCheckpoints(0, 10);
    expect(list.map((c) => c.index)).toEqual([0, 1]);
    // Each entry carries its own signature — the page loads the children for the
    // whole page in one query, so a mis-grouped join would silently empty them.
    expect(list.map((c) => c.signatures.map((s) => s.publicKey))).toEqual([
      [OXY_PUBLIC_KEY],
      [OXY_PUBLIC_KEY],
    ]);
  });

  it('honours `sinceIndex` and `limit`', async () => {
    await seedHeads(1);
    for (let i = 0; i < 4; i += 1) {
      await buildCheckpoint(1_800_000_000_000 + i);
    }
    expect((await listCheckpoints(2, 10)).map((c) => c.index)).toEqual([2, 3]);
    expect((await listCheckpoints(0, 2)).map((c) => c.index)).toEqual([0, 1]);
  });

  it('never exposes the committed snapshot, which would enumerate every subject', async () => {
    await seedHeads(3);
    await buildCheckpoint(1_800_000_000_000);
    const latest = await getLatestCheckpoint();
    expect(latest).not.toBeNull();
    // The whole DTO, key by key: a `snapshot` (or the row `id`) that started
    // riding along fails here rather than needing its own case.
    expect(Object.keys(latest ?? {}).sort()).toEqual([
      'anchors',
      'index',
      'periodEnd',
      'prevCheckpointHash',
      'root',
      'signatures',
      'treeSize',
    ]);
  });

  it('returns null / empty before the first checkpoint', async () => {
    await expect(getLatestCheckpoint()).resolves.toBeNull();
    await expect(listCheckpoints(0, 10)).resolves.toEqual([]);
  });
});
