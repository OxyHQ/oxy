/**
 * Regression: the signed-record Oxy adapter under the PRODUCTION did:web anchor,
 * against a REAL Postgres.
 *
 * Production sets `DID_WEB_DOMAIN=api.oxy.so` (server-emitted DIDs) while the
 * shipped SDK signs envelopes at the canonical identity apex
 * (`did:web:oxy.so:u:<accountId>`). The `oxyStorePolicy` subject binding used to
 * string-compare `env.subject !== buildUserDid(subjectUserId)`, so every
 * client-signed identity/civic record was rejected `subject_mismatch` in prod —
 * and only in prod, since dev collapses both anchors to `oxy.so`. The binding is
 * account-based now (`parseUserDid(env.subject) !== subjectUserId`, dual-anchor),
 * and the resolver + store key by the PARSED account id.
 *
 * The version this replaces mocked `SignedRecord`/`RepoHead`/`User` and asserted
 * that `SignedRecord.create` was called with `{ userId }` — inert mocks of models
 * the service no longer imports. The property that actually matters is stronger
 * than the call shape and needs a database to state: **both spellings land on the
 * SAME chain**, so a record signed at the SDK apex and one signed at the server
 * anchor extend one `seq` sequence behind one head.
 *
 * `DID_WEB_DOMAIN` is read at MODULE LOAD, so the service is loaded fresh inside
 * `jest.isolateModulesAsync`. That registry gets its own `config/postgres`, so it
 * opens (and closes) its own pool onto the same throwaway database; seeding and
 * assertions run on this file's own pool.
 */

import { randomUUID } from 'node:crypto';
import { ec as EC } from 'elliptic';
import { asc, eq } from 'drizzle-orm';
import { computeRecordId } from '@oxyhq/protocol';
import type { SignedRecordEnvelope } from '@oxyhq/contracts';
import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { repoHeads } from '../../db/schema/repoHeads';
import { signedRecords } from '../../db/schema/signedRecords';
import { users } from '../../db/schema/users';

const ec = new EC('secp256k1');

/** A wall-clock base every envelope's `issuedAt` is offset from. */
const T0 = 1_700_000_000_000;

interface Signer {
  userId: string;
  publicKey: string;
  privateKey: string;
}

/** The spelling the shipped SDK signs with (`@oxyhq/core` OXY_IDENTITY_APEX). */
function sdkDid(userId: string): string {
  return `did:web:oxy.so:u:${userId}`;
}

/** The spelling the server emits under the production anchor. */
function serverDid(userId: string): string {
  return `did:web:api.oxy.so:u:${userId}`;
}

describe('the signed-record adapter under DID_WEB_DOMAIN=api.oxy.so', () => {
  const ORIGINAL_DID_WEB_DOMAIN = process.env.DID_WEB_DOMAIN;
  let service: typeof import('../signedRecord.service');
  let closeIsolatedPostgres: () => Promise<void>;

  beforeAll(async () => {
    await connectPostgres();
    process.env.DID_WEB_DOMAIN = 'api.oxy.so';
    await jest.isolateModulesAsync(async () => {
      const isolatedPostgres: typeof import('../../config/postgres') = await import(
        '../../config/postgres'
      );
      await isolatedPostgres.connectPostgres();
      closeIsolatedPostgres = isolatedPostgres.closePostgres;
      service = await import('../signedRecord.service');
    });
  });

  afterAll(async () => {
    await closeIsolatedPostgres();
    await closePostgres();
    if (ORIGINAL_DID_WEB_DOMAIN === undefined) {
      delete process.env.DID_WEB_DOMAIN;
    } else {
      process.env.DID_WEB_DOMAIN = ORIGINAL_DID_WEB_DOMAIN;
    }
    jest.resetModules();
  });

  async function signer(): Promise<Signer> {
    const pair = ec.genKeyPair();
    const publicKey = pair.getPublic('hex');
    const [row] = await getDb().insert(users).values({ publicKey }).returning({ id: users.id });
    return { userId: row.id, publicKey, privateKey: pair.getPrivate('hex') };
  }

  /** Build + sign a v2 envelope for an explicit subject DID spelling. */
  function envelopeFor(
    subject: Signer,
    did: string,
    overrides: Partial<Omit<SignedRecordEnvelope, 'signature'>> = {}
  ): SignedRecordEnvelope {
    return service.signRecordEnvelope(
      {
        version: 2,
        type: 'identity',
        subject: did,
        issuer: did,
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

  async function countRecords(userId: string): Promise<number> {
    const rows = await getDb()
      .select({ id: signedRecords.id })
      .from(signedRecords)
      .where(eq(signedRecords.userId, userId));
    return rows.length;
  }

  it('accepts an SDK-spelled record and keys the row by the PARSED account id', async () => {
    const subject = await signer();
    const envelope = envelopeFor(subject, sdkDid(subject.userId));

    expect(await service.verifyEnvelope(envelope, subject.userId)).toEqual({ ok: true });
    const stored = await service.verifyAndStoreRecord(envelope, subject.userId);
    expect(stored.ok).toBe(true);

    const [row] = await getDb()
      .select({ subjectDid: signedRecords.subjectDid, userId: signedRecords.userId })
      .from(signedRecords)
      .where(eq(signedRecords.userId, subject.userId));
    expect(row.userId).toBe(subject.userId);
    // The DID is stored exactly as it was SIGNED — rewriting it to the server
    // anchor would invalidate the signature it is part of.
    expect(row.subjectDid).toBe(sdkDid(subject.userId));
  });

  it('lands BOTH spellings on one chain, behind one head', async () => {
    // The property the string comparison could never have: an SDK-signed genesis
    // and a server-signed extension are the same subject, so the second must
    // extend the first rather than open a second chain or be refused.
    const subject = await signer();

    const genesis = envelopeFor(subject, sdkDid(subject.userId));
    const genesisOutcome = await service.verifyAndStoreRecord(genesis, subject.userId);
    expect(genesisOutcome.ok).toBe(true);
    if (!genesisOutcome.ok) return;
    const genesisId = genesisOutcome.record.recordId;
    expect(genesisId).toBe(await computeRecordId(genesis));

    const extension = envelopeFor(subject, serverDid(subject.userId), {
      seq: 1,
      prev: genesisId,
      issuedAt: T0 + 1_000,
      record: { displayName: 'Nate II' },
    });
    expect(await service.verifyEnvelope(extension, subject.userId)).toEqual({ ok: true });
    const extensionOutcome = await service.verifyAndStoreRecord(extension, subject.userId);
    expect(extensionOutcome.ok).toBe(true);
    if (!extensionOutcome.ok) return;

    const rows = await getDb()
      .select({ seq: signedRecords.seq, prev: signedRecords.prev, subjectDid: signedRecords.subjectDid })
      .from(signedRecords)
      .where(eq(signedRecords.userId, subject.userId))
      .orderBy(asc(signedRecords.seq));
    expect(rows).toEqual([
      { seq: 0, prev: null, subjectDid: sdkDid(subject.userId) },
      { seq: 1, prev: genesisId, subjectDid: serverDid(subject.userId) },
    ]);

    // ONE head, at the second record — two chains would have shown up as two
    // rows here, and the unique `user_id` would have refused the second write.
    const heads = await getDb()
      .select({ seq: repoHeads.seq, headRecordId: repoHeads.headRecordId, recordCount: repoHeads.recordCount })
      .from(repoHeads)
      .where(eq(repoHeads.userId, subject.userId));
    expect(heads).toEqual([
      { seq: 1, headRecordId: extensionOutcome.record.recordId, recordCount: 2 },
    ]);
  });

  it.each([
    ['another account, SDK-spelled', (otherId: string) => sdkDid(otherId)],
    ['another account, server-spelled', (otherId: string) => serverDid(otherId)],
  ])('still rejects a subject naming %s', async (_label, spell) => {
    const caller = await signer();
    const otherId = randomUUID().replace(/-/g, '');
    const envelope = envelopeFor(caller, spell(otherId));

    expect(await service.verifyEnvelope(envelope, caller.userId)).toEqual({
      ok: false,
      reason: 'subject_mismatch',
    });
    expect(await service.verifyAndStoreRecord(envelope, caller.userId)).toEqual({
      ok: false,
      reason: 'subject_mismatch',
    });
    expect(await countRecords(caller.userId)).toBe(0);
  });

  it('still rejects a foreign domain carrying the caller’s own account id', async () => {
    // The account id matches, so ONLY the domain check can refuse this. A parse
    // that accepted any `did:web:*:u:<id>` would let another issuer's namespace
    // write to an Oxy chain.
    const caller = await signer();
    const envelope = envelopeFor(caller, `did:web:evil.com:u:${caller.userId}`);

    expect(await service.verifyEnvelope(envelope, caller.userId)).toEqual({
      ok: false,
      reason: 'subject_mismatch',
    });
    expect(await service.verifyAndStoreRecord(envelope, caller.userId)).toEqual({
      ok: false,
      reason: 'subject_mismatch',
    });
    expect(await countRecords(caller.userId)).toBe(0);

    // The control: the SAME account, spelled at an accepted anchor, does store —
    // so the refusals above are about the domain and not about the fixture.
    const accepted = await service.verifyAndStoreRecord(
      envelopeFor(caller, sdkDid(caller.userId)),
      caller.userId
    );
    expect(accepted.ok).toBe(true);
    expect(await countRecords(caller.userId)).toBe(1);
  });
});
