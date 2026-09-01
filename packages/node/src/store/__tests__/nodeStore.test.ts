/**
 * NodeStore unit tests — the SQLite store as a `@oxyhq/protocol`
 * `RecordStore`/`BlobStore`: append/continuity (via the shared `checkContinuity`),
 * log cursor + cap, head, record materialization, the freshness frontier, and
 * content-addressed blob storage. Same behaviour as before the protocol reshape;
 * the internals now delegate continuity to the shared engine and the methods are
 * async + subject-keyed.
 */

import { createHash } from 'node:crypto';
import { BlobHashMismatchError } from '@oxyhq/protocol/node';
import { NodeStore } from '../nodeStore';
import { buildSignedEnvelope, generateTestKeyPair, recordIdOf, type TestKeyPair } from '../../__tests__/helpers/signEnvelope';
import type { SignedRecordEnvelope } from '@oxyhq/contracts';

// A node holds one subject's repo; the store keys a single global chain and
// ignores the subject argument, so any value works here.
const SUBJECT = 'did:web:api.oxy.so:u:test-owner';

describe('NodeStore', () => {
  let store: NodeStore;
  let owner: TestKeyPair;

  beforeEach(() => {
    store = new NodeStore(':memory:');
    owner = generateTestKeyPair();
  });

  afterEach(() => {
    store.close();
  });

  /** Append the genesis record and return [envelope, recordId]. */
  async function appendGenesis(over: Partial<Parameters<typeof buildSignedEnvelope>[0]> = {}): Promise<{
    envelope: SignedRecordEnvelope;
    recordId: string;
  }> {
    const envelope = await buildSignedEnvelope({
      privateKey: owner.privateKey,
      publicKey: owner.publicKey,
      seq: 0,
      prev: null,
      ...over,
    });
    const recordId = await recordIdOf(envelope);
    const outcome = await store.append(SUBJECT, envelope, recordId);
    expect(outcome.ok).toBe(true);
    return { envelope, recordId };
  }

  it('appends a genesis record and advances the head', async () => {
    expect(await store.getHead(SUBJECT)).toBeNull();

    const { recordId } = await appendGenesis();

    const head = await store.getHead(SUBJECT);
    expect(head).toEqual({ headRecordId: recordId, seq: 0, recordCount: 1 });
  });

  it('appends a chain of records with correct prev/seq linkage', async () => {
    const { recordId: genesisId } = await appendGenesis();

    const second = await buildSignedEnvelope({
      privateKey: owner.privateKey,
      publicKey: owner.publicKey,
      seq: 1,
      prev: genesisId,
      record: { step: 2 },
    });
    const secondId = await recordIdOf(second);
    const outcome = await store.append(SUBJECT, second, secondId);

    expect(outcome).toEqual({ ok: true, recordId: secondId, seq: 1 });
    expect(await store.getHead(SUBJECT)).toEqual({ headRecordId: secondId, seq: 1, recordCount: 2 });
  });

  it('rejects a chain GAP (first record is not genesis)', async () => {
    const envelope = await buildSignedEnvelope({
      privateKey: owner.privateKey,
      publicKey: owner.publicKey,
      seq: 5,
      prev: null,
    });
    const recordId = await recordIdOf(envelope);

    expect(await store.append(SUBJECT, envelope, recordId)).toEqual({ ok: false, reason: 'chain_gap' });
    expect(await store.getHead(SUBJECT)).toBeNull();
  });

  it('rejects a chain FORK (prev does not match the head)', async () => {
    await appendGenesis();

    const fork = await buildSignedEnvelope({
      privateKey: owner.privateKey,
      publicKey: owner.publicKey,
      seq: 1,
      prev: 'f'.repeat(64),
    });
    const forkId = await recordIdOf(fork);

    expect(await store.append(SUBJECT, fork, forkId)).toEqual({ ok: false, reason: 'chain_fork' });
    expect((await store.getHead(SUBJECT))?.seq).toBe(0);
  });

  it('rejects a bad seq (does not extend the head by exactly one)', async () => {
    const { recordId: genesisId } = await appendGenesis();

    const skip = await buildSignedEnvelope({
      privateKey: owner.privateKey,
      publicKey: owner.publicKey,
      seq: 2,
      prev: genesisId,
    });
    const skipId = await recordIdOf(skip);

    expect(await store.append(SUBJECT, skip, skipId)).toEqual({ ok: false, reason: 'bad_seq' });
  });

  it('returns the ordered log from a cursor and caps the limit', async () => {
    let prev: string | null = null;
    const ids: string[] = [];
    for (let seq = 0; seq < 5; seq += 1) {
      const envelope = await buildSignedEnvelope({
        privateKey: owner.privateKey,
        publicKey: owner.publicKey,
        seq,
        prev,
        record: { seq },
      });
      const id = await recordIdOf(envelope);
      expect((await store.append(SUBJECT, envelope, id)).ok).toBe(true);
      ids.push(id);
      prev = id;
    }

    const all = await store.getLogSince(SUBJECT, -1, 100);
    expect(all.map((env) => env.seq)).toEqual([0, 1, 2, 3, 4]);

    const afterSeq1 = await store.getLogSince(SUBJECT, 1, 100);
    expect(afterSeq1.map((env) => env.seq)).toEqual([2, 3, 4]);

    // A recordId cursor resolves to its seq, then the numeric log slice follows.
    const afterRecordSeq = await store.resolveCursorSeq(SUBJECT, ids[2]);
    expect(afterRecordSeq).toBe(2);
    const afterRecordId = await store.getLogSince(SUBJECT, afterRecordSeq as number, 100);
    expect(afterRecordId.map((env) => env.seq)).toEqual([3, 4]);

    const capped = await store.getLogSince(SUBJECT, -1, 2);
    expect(capped.map((env) => env.seq)).toEqual([0, 1]);

    // An unknown recordId cursor resolves to null (the app then serves an empty page).
    expect(await store.resolveCursorSeq(SUBJECT, 'f'.repeat(64))).toBeNull();
  });

  it('materializes the latest version of a record key + its freshness frontier', async () => {
    const { recordId: v0 } = await appendGenesis({ collection: 'app.oxy.profile', rkey: 'self', record: { bio: 'v0' } });

    const v1 = await buildSignedEnvelope({
      privateKey: owner.privateKey,
      publicKey: owner.publicKey,
      seq: 1,
      prev: v0,
      collection: 'app.oxy.profile',
      rkey: 'self',
      record: { bio: 'v1' },
      issuedAt: 1_700_000_001_000,
    });
    const v1Id = await recordIdOf(v1);
    expect((await store.append(SUBJECT, v1, v1Id)).ok).toBe(true);

    const latest = await store.materializeCurrent(SUBJECT, 'app.oxy.profile', 'self');
    expect(latest?.seq).toBe(1);
    expect(latest?.record).toEqual({ bio: 'v1' });
    expect(await store.materializeCurrent(SUBJECT, 'app.oxy.profile', 'missing')).toBeNull();

    // The freshness frontier is the latest record's issuedAt for that key.
    expect(await store.latestIssuedAtForKey(SUBJECT, v1)).toBe(1_700_000_001_000);
  });

  it('stores and serves a content-addressed blob', async () => {
    const bytes = Buffer.from('hello blob world');
    const hash = createHash('sha256').update(bytes).digest('hex');

    expect(await store.getBlob(hash)).toBeNull();
    await store.putBlob(hash, bytes);
    expect(Buffer.from((await store.getBlob(hash)) as Uint8Array).equals(bytes)).toBe(true);

    // Idempotent re-pin is a no-op.
    await expect(store.putBlob(hash, bytes)).resolves.toBeUndefined();
  });

  it('rejects a blob whose bytes do not hash to the address', async () => {
    const bytes = Buffer.from('the real bytes');
    const wrongHash = createHash('sha256').update(Buffer.from('different bytes')).digest('hex');

    await expect(store.putBlob(wrongHash, bytes)).rejects.toThrow(BlobHashMismatchError);
    expect(await store.getBlob(wrongHash)).toBeNull();
  });

  it('putBlob rejects a non-byte-array payload before it reaches the size column', async () => {
    // `size: buf.length` at the SQL sink is only meaningful because `bytes` was
    // proven to be a byte array first — on a string or an object `.length` is
    // either the character count or `undefined`, and the row would record a
    // size that does not describe the stored blob. CodeQL flags that `.length`
    // (js/type-confusion-through-parameter-tampering, alert #472) because it
    // does not model `Buffer.isBuffer` as a narrowing guard; this pins the
    // guard that makes the flag a false positive, so removing it goes red here
    // rather than quietly re-arming the alert.
    const bytes = Buffer.from('hello blob world');
    const hash = createHash('sha256').update(bytes).digest('hex');

    for (const notBytes of ['hello blob world', 42, null, undefined, { length: 16 }, ['a', 'b']]) {
      await expect(store.putBlob(hash, notBytes as unknown as Uint8Array)).rejects.toThrow(
        'invalid_blob_bytes'
      );
    }
    // Nothing was written under that address by any of them.
    expect(await store.getBlob(hash)).toBeNull();

    // The vacuity floor: the same address DOES accept the real bytes.
    await store.putBlob(hash, bytes);
    expect(Buffer.from((await store.getBlob(hash)) as Uint8Array).equals(bytes)).toBe(true);
  });

  it('putBlob rejects a non-string address before it reaches the SQL parameter', async () => {
    const bytes = Buffer.from('hello blob world');

    for (const notAHash of [42, null, undefined, ['a'], { toLowerCase: () => 'x' }]) {
      await expect(store.putBlob(notAHash as unknown as string, bytes)).rejects.toThrow(
        'invalid_blob_hash'
      );
    }
  });

  it('getBlob rejects a malformed (non-SHA-256-hex) address as absent before any DB query', async () => {
    // A blob address that is not a well-formed 64-char SHA-256 hex digest can
    // never name a stored blob (every address is validated at pin time), so it
    // must short-circuit to `null` without reaching the DB. Cover the malformed
    // shapes: too short, too long, non-hex chars, empty, and whitespace.
    for (const malformed of [
      '',
      ' ',
      'abc123',
      'g'.repeat(64), // 64 chars but 'g' is out of hex range
      'a'.repeat(63), // one short
      'a'.repeat(65), // one long
      `${'a'.repeat(63)} `, // trailing whitespace breaks the anchored match
      'not-a-hash',
    ]) {
      expect(await store.getBlob(malformed)).toBeNull();
    }
  });

  it('getBlob resolves a valid address case-insensitively', async () => {
    const bytes = Buffer.from('case insensitive lookup');
    const hash = createHash('sha256').update(bytes).digest('hex'); // lowercase hex
    await store.putBlob(hash, bytes);

    // Uppercased input is a valid SHA-256 hex shape and must resolve the same
    // stored blob (the store lowercases before lookup).
    const upper = hash.toUpperCase();
    expect(Buffer.from((await store.getBlob(upper)) as Uint8Array).equals(bytes)).toBe(true);
  });
});
