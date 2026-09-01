/**
 * Node → Oxy ingest (F5b), against a REAL Postgres and a REAL hash chain.
 *
 * The suite this replaces mocked `models/UserNode`, `models/SignedRecord`,
 * `models/NodeIngestWitness`, `signedRecord.service` and `@oxyhq/protocol`, then
 * asserted on the arguments handed to `SignedRecord.create`. Nothing was ever
 * signed, verified or stored, so the assertions described a Mongoose call shape:
 * `mockVerifyAndStore` returned `{ ok: true }` for a forged envelope as readily
 * as for a genuine one, and `expect(created.seq).toBeUndefined()` passed against
 * a service that wrote nothing at all. None of those models is imported by the
 * service any more, so the mocks are inert too.
 *
 * Everything here is real except the NETWORK: `safeFetch` is replaced by a fake
 * node that serves `/oxy/head` and `/oxy/log` from envelopes signed with a real
 * secp256k1 key. The verification, the chain, the constraints, the witness
 * ledger and the cursor are the actual system.
 *
 * ## The guarantees this file exists for
 *
 *  - **`seq` is a gapless, unique, monotone sequence per account.** A chain that
 *    lets `seq` skip or repeat is broken permanently, so it is asserted against
 *    the stored rows AND against `repo_heads`, not against a returned value.
 *  - **`prev` really is the previous envelope's content address.** Every link is
 *    re-derived with `computeRecordId` from the stored envelope, so a store that
 *    wrote a plausible-looking hash of something else fails.
 *  - **A witness is recorded for every ingested record**, and its signature is
 *    re-verified against the Oxy public key over the signing input rebuilt from
 *    the STORED row — which is also what proves the `ingested_at` `timestamptz`
 *    round-trips the millisecond value the signature covers.
 *  - **An envelope that fails verification is never stored.** Forged key,
 *    tampered record and foreign subject each leave the ledger, the witness
 *    ledger and the head exactly as they were.
 *  - **A fork preserves BOTH branches.** The authentic linear chain is untouched
 *    and the conflicting envelope is archived off-chain (`seq is null`), which
 *    `signed_records_chain_completeness_check` admits only since migration 0009.
 *
 * The whole run shares one database, so every account is created per test and
 * every assertion is scoped to rows the test wrote.
 */

import { Readable } from 'node:stream';
import { ec as EC } from 'elliptic';
import { asc, eq } from 'drizzle-orm';

const mockSafeFetch = jest.fn();
jest.mock('@oxyhq/core/server', () => ({
  ...jest.requireActual('@oxyhq/core/server'),
  safeFetch: (...args: unknown[]) => mockSafeFetch(...args),
}));

import { canonicalize, computeRecordId } from '@oxyhq/protocol';
import { NODE_HEAD_PATH, NODE_LOG_PATH } from '@oxyhq/protocol/node';
import type { SignedRecordEnvelope } from '@oxyhq/contracts';
import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { nodeIngestWitnesses } from '../../db/schema/nodeIngestWitnesses';
import { repoHeads } from '../../db/schema/repoHeads';
import { signedRecords } from '../../db/schema/signedRecords';
import { userNodes } from '../../db/schema/userNodes';
import { users } from '../../db/schema/users';
import userCache from '../../utils/userCache';
import { buildUserDid } from '../did.service';
import SignatureService from '../signature.service';
import { signRecordEnvelope } from '../signedRecord.service';
import { ingestFromNode } from '../nodeSync.service';

const ec = new EC('secp256k1');

/** A wall-clock base every `issuedAt` is offset from, so ordering is explicit. */
const T0 = 1_700_000_000_000;
/** The one collection/key these tests publish under. */
const NSID = 'app.oxy.identity';
const RKEY = 'self';

/** Oxy's custodial keypair for the run — the witness ledger's signer. */
const oxyKey = ec.genKeyPair();
const OXY_PUBLIC_KEY = oxyKey.getPublic('hex');
const OXY_PRIVATE_KEY = oxyKey.getPrivate('hex');

interface Signer {
  userId: string;
  did: string;
  publicKey: string;
  privateKey: string;
}

/** The fake node's state: what it will serve on `/oxy/head` and `/oxy/log`. */
interface FakeNode {
  endpoint: string;
  records: SignedRecordEnvelope[];
  headSeq: number;
  headRecordId: string | null;
}

let invalidateSpy: jest.SpyInstance<void, [string]>;

beforeAll(async () => {
  await connectPostgres();
});

afterAll(async () => {
  await closePostgres();
});

beforeEach(() => {
  jest.clearAllMocks();
  invalidateSpy = jest.spyOn(userCache, 'invalidate');
  process.env.OXY_PRIVATE_KEY = OXY_PRIVATE_KEY;
  process.env.OXY_PUBLIC_KEY = OXY_PUBLIC_KEY;
});

afterEach(() => {
  invalidateSpy.mockRestore();
  delete process.env.OXY_PRIVATE_KEY;
  delete process.env.OXY_PUBLIC_KEY;
});

/** An account whose primary `users.public_key` authorizes the returned signer. */
async function signer(): Promise<Signer> {
  const pair = ec.genKeyPair();
  const publicKey = pair.getPublic('hex');
  const [row] = await getDb().insert(users).values({ publicKey }).returning({ id: users.id });
  return { userId: row.id, did: buildUserDid(row.id), publicKey, privateKey: pair.getPrivate('hex') };
}

/** Register a node for an account. Seeded directly: registration is F5a's job. */
async function registerNode(userId: string, endpoint: string): Promise<void> {
  await getDb().insert(userNodes).values({
    userId,
    endpoint,
    nodePublicKey: 'ab'.repeat(33),
    mode: 'pull',
    status: 'active',
  });
}

/** Build + sign one v2 envelope for a subject. */
function envelope(
  subject: Signer,
  overrides: Partial<Omit<SignedRecordEnvelope, 'signature'>> = {},
  signWith: string = subject.privateKey,
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
      collection: NSID,
      rkey: RKEY,
      publicKey: subject.publicKey,
      alg: 'ES256K-DER-SHA256',
      ...overrides,
    },
    signWith,
  );
}

/**
 * `count` correctly-chained envelopes: each `prev` is the real content address of
 * the one before it, and each `issuedAt` is strictly newer (the monotonicity the
 * store enforces per record key).
 */
async function chain(subject: Signer, count: number): Promise<SignedRecordEnvelope[]> {
  const built: SignedRecordEnvelope[] = [];
  let prev: string | null = null;
  for (let seq = 0; seq < count; seq += 1) {
    const env = envelope(subject, { seq, prev, issuedAt: T0 + seq * 1_000, record: { v: seq } });
    built.push(env);
    prev = await computeRecordId(env);
  }
  return built;
}

/** A `safeFetch` result whose body streams `obj` as JSON. */
function jsonResult(obj: unknown, status = 200) {
  return {
    status,
    response: Readable.from([Buffer.from(JSON.stringify(obj))]),
    headers: {},
    finalUrl: '',
  };
}

/** Point the mocked network at a fake node serving `node`'s records. */
function serve(node: FakeNode): void {
  mockSafeFetch.mockImplementation(async (rawUrl: string) => {
    const url = new URL(rawUrl);
    if (url.pathname === NODE_HEAD_PATH) {
      return jsonResult({
        seq: node.headSeq,
        headRecordId: node.headRecordId,
        recordCount: node.records.length,
      });
    }
    if (url.pathname === NODE_LOG_PATH) {
      const sinceParam = url.searchParams.get('since');
      const since = sinceParam === null ? -1 : Number(sinceParam);
      const limit = Number(url.searchParams.get('limit') ?? '100');
      const page = node.records.filter((env) => (env.seq ?? -1) > since).slice(0, limit);
      return jsonResult({
        records: page,
        count: page.length,
        head: node.headRecordId === null ? null : { seq: node.headSeq, headRecordId: node.headRecordId },
      });
    }
    throw new Error(`unexpected node fetch: ${rawUrl}`);
  });
}

/** A registered account plus the fake node it points at, primed with `records`. */
async function nodeFor(subject: Signer, records: SignedRecordEnvelope[]): Promise<FakeNode> {
  const endpoint = `https://node-${subject.userId}.example.com`;
  await registerNode(subject.userId, endpoint);
  const last = records.at(-1);
  const node: FakeNode = {
    endpoint,
    records,
    headSeq: last?.seq ?? -1,
    headRecordId: last ? await computeRecordId(last) : null,
  };
  serve(node);
  return node;
}

/** The account's stored records in `seq` order (fork mirrors, with no seq, last). */
async function storedRecords(userId: string) {
  return getDb()
    .select({
      seq: signedRecords.seq,
      prev: signedRecords.prev,
      recordId: signedRecords.recordId,
      nsid: signedRecords.nsid,
      rkey: signedRecords.rkey,
      verified: signedRecords.verified,
      envelope: signedRecords.envelope,
    })
    .from(signedRecords)
    .where(eq(signedRecords.userId, userId))
    .orderBy(asc(signedRecords.seq));
}

/** The account's head row, or `undefined` when it has no chain. */
async function headRow(userId: string) {
  const [row] = await getDb()
    .select({ seq: repoHeads.seq, headRecordId: repoHeads.headRecordId, recordCount: repoHeads.recordCount })
    .from(repoHeads)
    .where(eq(repoHeads.userId, userId))
    .limit(1);
  return row;
}

/** Every witness Oxy counter-signed for an account. */
async function witnesses(userId: string) {
  return getDb()
    .select({
      recordId: nodeIngestWitnesses.recordId,
      witnessSignature: nodeIngestWitnesses.witnessSignature,
      ingestedAt: nodeIngestWitnesses.ingestedAt,
    })
    .from(nodeIngestWitnesses)
    .where(eq(nodeIngestWitnesses.userId, userId));
}

/** The node row as ingest left it. */
async function nodeRow(userId: string) {
  const [row] = await getDb().select().from(userNodes).where(eq(userNodes.userId, userId)).limit(1);
  return row;
}

describe('the linear chain: seq is gapless and unique, prev is the previous address', () => {
  it('mirrors a three-record chain and advances the cursor to the node head', async () => {
    const subject = await signer();
    const records = await chain(subject, 3);
    await nodeFor(subject, records);

    await ingestFromNode(subject.userId);

    const stored = await storedRecords(subject.userId);
    expect(stored.map((row) => row.seq)).toEqual([0, 1, 2]);
    expect(new Set(stored.map((row) => row.seq)).size).toBe(3);

    // Every link re-derived from the STORED envelope, genesis included.
    expect(stored[0].prev).toBeNull();
    for (let i = 1; i < stored.length; i += 1) {
      expect(stored[i].prev).toBe(await computeRecordId(stored[i - 1].envelope));
      expect(stored[i].recordId).toBe(await computeRecordId(stored[i].envelope));
    }

    expect(await headRow(subject.userId)).toEqual({
      seq: 2,
      headRecordId: await computeRecordId(records[2]),
      recordCount: 3,
    });

    const row = await nodeRow(subject.userId);
    expect(row.cursor).toBe(2);
    expect(row.lastSyncedAt).toBeInstanceOf(Date);
    expect(row.lastError).toBeNull();
    expect(invalidateSpy).toHaveBeenCalledWith(subject.userId);
  });

  it('re-pulling the same chain is idempotent — no duplicate rows, no duplicate witnesses', async () => {
    const subject = await signer();
    const node = await nodeFor(subject, await chain(subject, 2));
    await ingestFromNode(subject.userId);
    jest.clearAllMocks();
    serve(node);

    await ingestFromNode(subject.userId);

    expect((await storedRecords(subject.userId)).map((row) => row.seq)).toEqual([0, 1]);
    expect(await witnesses(subject.userId)).toHaveLength(2);
    expect(await headRow(subject.userId)).toMatchObject({ seq: 1, recordCount: 2 });
    // Nothing changed, so nothing is re-verified and no cache is swept.
    expect(invalidateSpy).not.toHaveBeenCalled();
  });

  it('is a caught-up no-op (head only, no log fetch) when the node is not ahead', async () => {
    const subject = await signer();
    const node = await nodeFor(subject, await chain(subject, 2));
    await ingestFromNode(subject.userId);
    jest.clearAllMocks();
    serve(node);

    await ingestFromNode(subject.userId);

    const paths = mockSafeFetch.mock.calls.map((call) => new URL(String(call[0])).pathname);
    expect(paths).toEqual([NODE_HEAD_PATH]);
    expect(await nodeRow(subject.userId)).toMatchObject({ cursor: 1, lastError: null });
  });

  it('resumes from the cursor across runs and leaves no gap', async () => {
    const subject = await signer();
    const records = await chain(subject, 4);
    const node = await nodeFor(subject, records.slice(0, 2));
    await ingestFromNode(subject.userId);
    expect((await storedRecords(subject.userId)).map((row) => row.seq)).toEqual([0, 1]);

    node.records = records;
    node.headSeq = 3;
    node.headRecordId = await computeRecordId(records[3]);
    serve(node);
    await ingestFromNode(subject.userId);

    expect((await storedRecords(subject.userId)).map((row) => row.seq)).toEqual([0, 1, 2, 3]);
    expect(await headRow(subject.userId)).toMatchObject({ seq: 3, recordCount: 4 });
    expect(await nodeRow(subject.userId)).toMatchObject({ cursor: 3 });
  });

  it('stops at a chain gap rather than appending out of order', async () => {
    // Oxy holds nothing; the node's first record builds on a seq Oxy never saw.
    const subject = await signer();
    const records = await chain(subject, 3);
    await nodeFor(subject, records.slice(2)); // only seq 2

    await ingestFromNode(subject.userId);

    expect(await storedRecords(subject.userId)).toHaveLength(0);
    expect(await headRow(subject.userId)).toBeUndefined();
    expect(await witnesses(subject.userId)).toHaveLength(0);
    expect(await nodeRow(subject.userId)).toMatchObject({ lastError: 'chain_gap' });
    expect(invalidateSpy).not.toHaveBeenCalled();
  });
});

describe('the anti-rewrite witness', () => {
  it('counter-signs every ingested record with the Oxy key over the stored value', async () => {
    const subject = await signer();
    const records = await chain(subject, 2);
    await nodeFor(subject, records);

    await ingestFromNode(subject.userId);

    const stored = await witnesses(subject.userId);
    expect(stored.map((row) => row.recordId).sort()).toEqual(
      (await Promise.all(records.map((env) => computeRecordId(env)))).sort(),
    );

    for (const witness of stored) {
      // Rebuilt from the ROW, so this also proves the `timestamptz` column
      // round-trips the millisecond value the signature actually covers.
      const signingInput = canonicalize({
        recordId: witness.recordId,
        userId: subject.userId,
        ingestedAt: witness.ingestedAt.getTime(),
      });
      expect(
        SignatureService.verifySignature(signingInput, witness.witnessSignature, OXY_PUBLIC_KEY),
      ).toBe(true);
      // …and it is the OXY key, not the subject's.
      expect(
        SignatureService.verifySignature(signingInput, witness.witnessSignature, subject.publicKey),
      ).toBe(false);
    }
  });

  it('skips witnessing cleanly when the Oxy key is unset, but still ingests', async () => {
    delete process.env.OXY_PRIVATE_KEY;
    delete process.env.OXY_PUBLIC_KEY;
    const subject = await signer();
    await nodeFor(subject, await chain(subject, 1));

    await ingestFromNode(subject.userId);

    expect(await witnesses(subject.userId)).toHaveLength(0);
    expect((await storedRecords(subject.userId)).map((row) => row.seq)).toEqual([0]);
    expect(await nodeRow(subject.userId)).toMatchObject({ cursor: 0, lastError: null });
    expect(invalidateSpy).toHaveBeenCalledWith(subject.userId);
  });
});

describe('an envelope that fails verification is never stored', () => {
  /** Assert the ledger, the head and the witness ledger are all untouched. */
  async function expectNothingIngested(subject: Signer, reason: string): Promise<void> {
    expect(await storedRecords(subject.userId)).toHaveLength(0);
    expect(await headRow(subject.userId)).toBeUndefined();
    expect(await witnesses(subject.userId)).toHaveLength(0);
    expect(await nodeRow(subject.userId)).toMatchObject({ lastError: `rejected:${reason}` });
    expect(invalidateSpy).not.toHaveBeenCalled();
  }

  it('rejects a record signed by a key that is not a current verification method', async () => {
    // The node holds the user's key, so a stolen-key forger is exactly the
    // threat: a key the DID does not authorize can never inject a record.
    const subject = await signer();
    const forger = ec.genKeyPair();
    const forged = envelope(
      subject,
      { publicKey: forger.getPublic('hex') },
      forger.getPrivate('hex'),
    );
    await nodeFor(subject, [forged]);

    await ingestFromNode(subject.userId);

    await expectNothingIngested(subject, 'public_key_not_a_current_verification_method');
  });

  it('rejects a record whose payload was altered after signing', async () => {
    const subject = await signer();
    const genuine = (await chain(subject, 1))[0];
    const tampered: SignedRecordEnvelope = { ...genuine, record: { displayName: 'Mallory' } };
    await nodeFor(subject, [tampered]);

    await ingestFromNode(subject.userId);

    await expectNothingIngested(subject, 'bad_signature');
  });

  it("rejects a record about somebody else's subject", async () => {
    const subject = await signer();
    const other = await signer();
    const foreign = envelope({ ...subject, did: other.did });
    await nodeFor(subject, [foreign]);

    await ingestFromNode(subject.userId);

    await expectNothingIngested(subject, 'subject_mismatch');
    // …and the record was not smuggled onto the OTHER account's chain either.
    expect(await storedRecords(other.userId)).toHaveLength(0);
  });

  it('rejects a malformed envelope without advancing anything', async () => {
    const subject = await signer();
    await registerNode(subject.userId, `https://node-${subject.userId}.example.com`);
    serve({
      endpoint: `https://node-${subject.userId}.example.com`,
      // Carries a `seq` so the node really serves it, but nothing else a v2
      // envelope requires — the schema is what has to reject it.
      records: [{ version: 2, type: 'identity', seq: 0 } as unknown as SignedRecordEnvelope],
      headSeq: 0,
      headRecordId: 'x'.repeat(64),
    });

    await ingestFromNode(subject.userId);

    await expectNothingIngested(subject, 'invalid_envelope');
  });

  it('stops at the first rejection — a poisoned entry cannot advance the mirror', async () => {
    const subject = await signer();
    const records = await chain(subject, 3);
    const forger = ec.genKeyPair();
    const poisoned = envelope(
      subject,
      { seq: 1, prev: await computeRecordId(records[0]), issuedAt: T0 + 1_000, publicKey: forger.getPublic('hex') },
      forger.getPrivate('hex'),
    );
    await nodeFor(subject, [records[0], poisoned, records[2]]);

    await ingestFromNode(subject.userId);

    // Only the genuine genesis record landed; nothing beyond the poison did.
    expect((await storedRecords(subject.userId)).map((row) => row.seq)).toEqual([0]);
    expect(await headRow(subject.userId)).toMatchObject({ seq: 0, recordCount: 1 });
    expect(await witnesses(subject.userId)).toHaveLength(1);
    expect(await nodeRow(subject.userId)).toMatchObject({
      cursor: 0,
      lastError: 'rejected:public_key_not_a_current_verification_method',
    });
  });
});

describe('conflict resolution', () => {
  it('preserves BOTH branches on a genuine fork and leaves the linear chain intact', async () => {
    const subject = await signer();
    const records = await chain(subject, 2);
    const node = await nodeFor(subject, [records[0]]);
    await ingestFromNode(subject.userId);
    const genesisId = await computeRecordId(records[0]);

    // Authentically signed by the owner, at the next seq, but chaining from a
    // record Oxy's head is not — the definition of a fork.
    const forked = envelope(subject, {
      seq: 1,
      prev: 'f'.repeat(64),
      issuedAt: T0 + 5_000,
      record: { v: 'other-branch' },
    });
    const forkedId = await computeRecordId(forked);
    node.records = [records[0], forked];
    node.headSeq = 1;
    node.headRecordId = forkedId;
    serve(node);
    jest.clearAllMocks();

    await ingestFromNode(subject.userId);

    const stored = await storedRecords(subject.userId);
    expect(stored).toHaveLength(2);
    // The authentic linear chain is untouched…
    const onChain = stored.find((row) => row.seq !== null);
    expect(onChain).toMatchObject({ seq: 0, recordId: genesisId, prev: null });
    // …and the fork is archived append-only, OFF the chain (`seq is null`), so
    // the unique `(user_id, seq)` index is never violated and nothing is lost.
    const mirror = stored.find((row) => row.seq === null);
    expect(mirror).toMatchObject({
      seq: null,
      prev: null,
      recordId: forkedId,
      nsid: NSID,
      rkey: RKEY,
      verified: true,
    });
    // The head still names the linear branch.
    expect(await headRow(subject.userId)).toEqual({ seq: 0, headRecordId: genesisId, recordCount: 1 });
    // Both branches are witnessed.
    expect((await witnesses(subject.userId)).map((row) => row.recordId).sort()).toEqual(
      [genesisId, forkedId].sort(),
    );
    expect(await nodeRow(subject.userId)).toMatchObject({ lastError: 'chain_fork' });
    expect(invalidateSpy).toHaveBeenCalledWith(subject.userId);
  });

  it('re-ingesting the same fork is idempotent', async () => {
    const subject = await signer();
    const records = await chain(subject, 1);
    const node = await nodeFor(subject, records);
    await ingestFromNode(subject.userId);

    const forked = envelope(subject, { seq: 1, prev: 'f'.repeat(64), issuedAt: T0 + 5_000, record: { v: 'fork' } });
    node.records = [records[0], forked];
    node.headSeq = 1;
    node.headRecordId = await computeRecordId(forked);
    serve(node);
    await ingestFromNode(subject.userId);
    serve(node);
    await ingestFromNode(subject.userId);

    expect(await storedRecords(subject.userId)).toHaveLength(2);
    expect(await witnesses(subject.userId)).toHaveLength(2);
  });

  it('keeps the existing record and skips an incoming LWW loser', async () => {
    const subject = await signer();
    const records = await chain(subject, 1);
    const node = await nodeFor(subject, records);
    await ingestFromNode(subject.userId);

    // Same record key, strictly OLDER than what Oxy already materialized.
    const older = envelope(subject, { seq: 1, prev: await computeRecordId(records[0]), issuedAt: T0 - 1_000 });
    node.records = [records[0], older];
    node.headSeq = 1;
    node.headRecordId = await computeRecordId(older);
    serve(node);
    jest.clearAllMocks();

    await ingestFromNode(subject.userId);

    // The loser is not stored, not witnessed, and nothing was invalidated.
    expect((await storedRecords(subject.userId)).map((row) => row.seq)).toEqual([0]);
    expect(await witnesses(subject.userId)).toHaveLength(1);
    expect(invalidateSpy).not.toHaveBeenCalled();
    // A clean skip: the cursor is stamped and the error cleared.
    expect(await nodeRow(subject.userId)).toMatchObject({ cursor: 0, lastError: null });
  });
});

describe('resilience — a down node leaves the mirror stale, never wrong', () => {
  it('records lastError WITHOUT throwing when the head fetch fails', async () => {
    const subject = await signer();
    await registerNode(subject.userId, 'https://down.example.com');
    mockSafeFetch.mockRejectedValue(new Error('ECONNREFUSED'));

    await expect(ingestFromNode(subject.userId)).resolves.toBeUndefined();

    expect(await storedRecords(subject.userId)).toHaveLength(0);
    expect(invalidateSpy).not.toHaveBeenCalled();
    const row = await nodeRow(subject.userId);
    expect(row.lastError).toContain('ECONNREFUSED');
    expect(row.lastSyncedAt).toBeInstanceOf(Date);
  });

  it('records lastError WITHOUT throwing when the log fetch fails mid-run', async () => {
    const subject = await signer();
    const records = await chain(subject, 1);
    const node = await nodeFor(subject, records);
    mockSafeFetch.mockImplementation(async (rawUrl: string) => {
      if (new URL(String(rawUrl)).pathname === NODE_HEAD_PATH) {
        return jsonResult({ seq: node.headSeq, headRecordId: node.headRecordId, recordCount: 1 });
      }
      throw new Error('log unavailable');
    });

    await expect(ingestFromNode(subject.userId)).resolves.toBeUndefined();

    expect(await storedRecords(subject.userId)).toHaveLength(0);
    expect(await nodeRow(subject.userId)).toMatchObject({ lastError: 'log unavailable' });
  });

  it('no-ops for an account with no registered node', async () => {
    const subject = await signer();

    await ingestFromNode(subject.userId);

    expect(mockSafeFetch).not.toHaveBeenCalled();
    expect(await storedRecords(subject.userId)).toHaveLength(0);
  });

  it('no-ops for a REVOKED node and never writes to its row', async () => {
    const subject = await signer();
    await nodeFor(subject, await chain(subject, 1));
    await getDb().update(userNodes).set({ status: 'revoked' }).where(eq(userNodes.userId, subject.userId));
    jest.clearAllMocks();

    await ingestFromNode(subject.userId);

    expect(mockSafeFetch).not.toHaveBeenCalled();
    expect(await storedRecords(subject.userId)).toHaveLength(0);
    expect(await nodeRow(subject.userId)).toMatchObject({ cursor: null, lastSyncedAt: null });
  });

  it('cannot be reached for a deleted account — the node row cascades away', async () => {
    // This is why the Mongo-era "does the user still exist?" guard is deleted
    // rather than translated: `user_nodes.user_id` is NOT NULL and CASCADEs, so
    // a node row cannot outlive its account.
    const subject = await signer();
    await nodeFor(subject, await chain(subject, 1));
    await getDb().delete(users).where(eq(users.id, subject.userId));
    jest.clearAllMocks();

    await ingestFromNode(subject.userId);

    expect(await nodeRow(subject.userId)).toBeUndefined();
    expect(mockSafeFetch).not.toHaveBeenCalled();
  });
});
