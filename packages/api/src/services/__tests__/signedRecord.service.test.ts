/**
 * The signed-record Oxy ADAPTER, against a REAL Postgres.
 *
 * The suite this replaces asserted against `jest.mock('../../models/SignedRecord')`
 * and `jest.mock('../../models/User')` — models the service no longer imports, so
 * the mocks were INERT and every "stored" assertion read a `mockSrCreate.mock.calls`
 * entry rather than a row. What survives the rewrite is the set of guarantees, each
 * now checked against data written in the same test:
 *
 *  - **the signature is the gate.** A tampered record is refused AND leaves the
 *    ledger empty; the signing input covers exactly the fields it claims to and
 *    is independent of key order on the wire.
 *  - **the resolver is a real read.** A key is authorized because it is one of the
 *    account's CURRENT verification methods — its `users.public_key` or a linked
 *    `user_auth_methods` row of type `identity` — not because a mock said so. The
 *    custodial branch is exercised against a real `OXY_PUBLIC_KEY`, including the
 *    case where none is configured.
 *  - **`verifyEnvelope` writes nothing**, which a spy-based suite cannot show.
 *  - **every rejection is a no-op on the ledger.**
 *
 * The chain itself (`seq`/`prev` continuity, the head advance and its atomicity)
 * is `signedRecord.chain.test.ts` and `reputationCivic.postgres.test.ts`; the
 * dual-anchor DID binding is `signedRecord.didDomain.test.ts`. This suite does
 * not restate them.
 *
 * The whole run shares one database, so every account is created per test and
 * every assertion is scoped to ids the test wrote — no count depends on a table
 * being empty.
 */

import { randomUUID } from 'node:crypto';
import { ec as EC } from 'elliptic';
import { eq } from 'drizzle-orm';
import { signedRecordSigningInput, verifyEnvelopeSignature } from '@oxyhq/protocol';
import type { SignedRecordEnvelope } from '@oxyhq/contracts';
import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { signedRecords } from '../../db/schema/signedRecords';
import { userAuthMethods } from '../../db/schema/userAuthMethods';
import { users } from '../../db/schema/users';
import { OXY_DID, buildUserDid } from '../did.service';
import {
  getLatestRecord,
  signRecordEnvelope,
  verifyAndStoreRecord,
  verifyEnvelope,
} from '../signedRecord.service';

const ec = new EC('secp256k1');

/** A keypair plus the DID it signs for. */
interface SigningIdentity {
  did: string;
  publicKey: string;
  privateKey: string;
}

/** A signing identity backed by a real `users` row. */
interface Signer extends SigningIdentity {
  userId: string;
}

beforeAll(async () => {
  await connectPostgres();
});

afterAll(async () => {
  await closePostgres();
});

/** A fresh secp256k1 keypair. Random per call, so no two tests share a key. */
function keyPair(): { publicKey: string; privateKey: string } {
  const pair = ec.genKeyPair();
  return { publicKey: pair.getPublic('hex'), privateKey: pair.getPrivate('hex') };
}

/** An account whose PRIMARY `users.public_key` is the returned signing key. */
async function signer(): Promise<Signer> {
  const { publicKey, privateKey } = keyPair();
  const [row] = await getDb().insert(users).values({ publicKey }).returning({ id: users.id });
  return { userId: row.id, did: buildUserDid(row.id), publicKey, privateKey };
}

/** An account with NO signing key at all — the custodial shape. */
async function keylessAccount(): Promise<{ userId: string; did: string }> {
  const [row] = await getDb().insert(users).values({}).returning({ id: users.id });
  return { userId: row.id, did: buildUserDid(row.id) };
}

/** Build + sign a v1 `identity` envelope (a legacy singleton the chain gate allows). */
function v1Envelope(
  identity: SigningIdentity,
  overrides: Partial<Omit<SignedRecordEnvelope, 'signature'>> = {}
): SignedRecordEnvelope {
  return signRecordEnvelope(
    {
      version: 1,
      type: 'identity',
      subject: identity.did,
      issuer: identity.did,
      record: { displayName: 'Nate' },
      issuedAt: Date.now(),
      publicKey: identity.publicKey,
      alg: 'ES256K-DER-SHA256',
      ...overrides,
    },
    identity.privateKey
  );
}

/** Rows on an account's chain. Exact, so a silent empty read never reads as a pass. */
async function countRecords(userId: string): Promise<number> {
  const rows = await getDb()
    .select({ id: signedRecords.id })
    .from(signedRecords)
    .where(eq(signedRecords.userId, userId));
  return rows.length;
}

describe('the signature covers the record, and the signing input is canonical', () => {
  it('round-trips: a record signed with the private key verifies', async () => {
    const subject = await signer();
    expect(await verifyEnvelopeSignature(v1Envelope(subject))).toBe(true);
  });

  it('refuses a TAMPERED record and stores nothing', async () => {
    const subject = await signer();
    const envelope = v1Envelope(subject);
    const tampered: SignedRecordEnvelope = { ...envelope, record: { displayName: 'Mallory' } };

    // The signature check itself, and then the same verdict through the adapter.
    expect(await verifyEnvelopeSignature(tampered)).toBe(false);
    expect(await verifyEnvelope(tampered, subject.userId)).toEqual({
      ok: false,
      reason: 'bad_signature',
    });
    expect(await verifyAndStoreRecord(tampered, subject.userId)).toEqual({
      ok: false,
      reason: 'bad_signature',
    });
    expect(await countRecords(subject.userId)).toBe(0);

    // A control, so "nothing was stored" cannot pass vacuously: the UNTAMPERED
    // record does land for the same account.
    expect((await verifyAndStoreRecord(envelope, subject.userId)).ok).toBe(true);
    expect(await countRecords(subject.userId)).toBe(1);
  });

  it('signs exactly {version,type,subject,issuer,record,issuedAt} — never alg/publicKey/signature', () => {
    const fields: Omit<SignedRecordEnvelope, 'signature'> = {
      version: 1,
      type: 'identity',
      subject: 'did:web:oxy.so:u:probe',
      issuer: 'did:web:oxy.so:u:probe',
      record: { b: 2, a: 1 },
      issuedAt: 1_700_000_000_000,
      publicKey: 'cafe',
      alg: 'ES256K-DER-SHA256',
    };

    // The exact key set, not merely "does not contain the substring" — a
    // `publicKey` nested inside `record` would satisfy a substring assertion.
    expect(Object.keys(JSON.parse(signedRecordSigningInput(fields)))).toEqual([
      'issuedAt',
      'issuer',
      'record',
      'subject',
      'type',
      'version',
    ]);
  });

  it('is independent of key ORDER but not of key VALUES', () => {
    const base: Omit<SignedRecordEnvelope, 'signature'> = {
      version: 1,
      type: 'identity',
      subject: 'did:web:oxy.so:u:probe',
      issuer: 'did:web:oxy.so:u:probe',
      record: { a: 1, b: 2 },
      issuedAt: 1_700_000_000_000,
      publicKey: 'cafe',
      alg: 'ES256K-DER-SHA256',
    };

    // Same content, both the envelope's own fields and the nested record
    // re-ordered — this is what makes the `jsonb` round trip representation-only.
    const reordered: Omit<SignedRecordEnvelope, 'signature'> = {
      alg: 'ES256K-DER-SHA256',
      publicKey: 'cafe',
      issuedAt: base.issuedAt,
      record: { b: 2, a: 1 },
      issuer: base.issuer,
      subject: base.subject,
      type: base.type,
      version: base.version,
    };
    expect(signedRecordSigningInput(reordered)).toBe(signedRecordSigningInput(base));

    // ...and the equality above is not vacuous: a changed VALUE changes the input.
    expect(signedRecordSigningInput({ ...base, record: { a: 1, b: 3 } })).not.toBe(
      signedRecordSigningInput(base)
    );
  });
});

describe('verifyEnvelope answers a verdict and writes nothing', () => {
  it('accepts a fresh, self-issued record signed by the account’s primary key', async () => {
    const subject = await signer();

    expect(await verifyEnvelope(v1Envelope(subject), subject.userId)).toEqual({ ok: true });
    // The verify endpoint is a READ. A store here would double-append every
    // re-verification, and no spy-based suite could tell.
    expect(await countRecords(subject.userId)).toBe(0);
  });

  it('accepts a key linked as an `identity` auth method, not just the primary key', async () => {
    // The resolver's second source is a real table now. An account that added a
    // second Commons key must still be able to publish with it.
    const account = await keylessAccount();
    const linked = keyPair();
    await getDb().insert(userAuthMethods).values({
      userId: account.userId,
      type: 'identity',
      methodPublicKey: linked.publicKey,
    });

    const envelope = v1Envelope({
      did: account.did,
      publicKey: linked.publicKey,
      privateKey: linked.privateKey,
    });
    expect(await verifyEnvelope(envelope, account.userId)).toEqual({ ok: true });
  });

  it('rejects a key that is no current verification method of the subject', async () => {
    const subject = await signer();
    const stranger = keyPair();

    // Signed correctly — the signature verifies against its OWN embedded key —
    // so this reaches the authorization step rather than failing as a bad
    // signature, which is what makes it a test of the resolver.
    const envelope = v1Envelope({
      did: subject.did,
      publicKey: stranger.publicKey,
      privateKey: stranger.privateKey,
    });
    expect(await verifyEnvelopeSignature(envelope)).toBe(true);
    expect(await verifyEnvelope(envelope, subject.userId)).toEqual({
      ok: false,
      reason: 'public_key_not_a_current_verification_method',
    });
  });

  it('rejects an identity key registered to ANOTHER account', async () => {
    // The discriminating fixture for the resolver's account scope. The case
    // above signs with a key that is registered NOWHERE, so it is rejected even
    // by a resolver that reads every `identity` row in the table. Here the key
    // is a genuine, current verification method — of somebody else. Dropping
    // the `user_id` predicate from the auth-method lookup would authorize it,
    // and every account's Commons key would then be able to sign records onto
    // every other account's chain.
    const attacker = await keylessAccount();
    const attackerKey = keyPair();
    await getDb().insert(userAuthMethods).values({
      userId: attacker.userId,
      type: 'identity',
      methodPublicKey: attackerKey.publicKey,
    });

    const victim = await keylessAccount();
    const envelope = v1Envelope({
      did: victim.did,
      publicKey: attackerKey.publicKey,
      privateKey: attackerKey.privateKey,
    });

    // The signature itself is valid, so this reaches the AUTHORIZATION step.
    expect(await verifyEnvelopeSignature(envelope)).toBe(true);
    expect(await verifyEnvelope(envelope, victim.userId)).toEqual({
      ok: false,
      reason: 'public_key_not_a_current_verification_method',
    });

    // And the same key is genuinely usable on its OWN account, so the rejection
    // above is about the account scope and not about the key being unusable.
    const ownEnvelope = v1Envelope({
      did: attacker.did,
      publicKey: attackerKey.publicKey,
      privateKey: attackerKey.privateKey,
    });
    expect(await verifyEnvelope(ownEnvelope, attacker.userId)).toEqual({ ok: true });
  });

  it('refuses to STORE a record signed by another account’s identity key', async () => {
    // The verdict above is a read; this is the write path, which is what would
    // actually corrupt a victim's chain.
    const attacker = await keylessAccount();
    const attackerKey = keyPair();
    await getDb().insert(userAuthMethods).values({
      userId: attacker.userId,
      type: 'identity',
      methodPublicKey: attackerKey.publicKey,
    });

    const victim = await keylessAccount();
    const envelope = v1Envelope({
      did: victim.did,
      publicKey: attackerKey.publicKey,
      privateKey: attackerKey.privateKey,
    });

    const result = await verifyAndStoreRecord(envelope, victim.userId);
    expect(result).toEqual({
      ok: false,
      reason: 'public_key_not_a_current_verification_method',
    });
    expect(await countRecords(victim.userId)).toBe(0);
  });

  it('rejects a record whose subject is a DIFFERENT account', async () => {
    const caller = await signer();
    const other = await signer();

    expect(await verifyEnvelope(v1Envelope(other), caller.userId)).toEqual({
      ok: false,
      reason: 'subject_mismatch',
    });
  });

  it('rejects a record type outside the closed Oxy store set', async () => {
    const subject = await signer();
    // A PER-APP type. `app_record` is inside the set now, and a v1 one would
    // still be refused — by the CHAIN gate, not this one — so using it here
    // would leave the type gate untested while the case stayed green.
    expect(
      await verifyEnvelope(v1Envelope(subject, { type: 'app.syra.listen' }), subject.userId)
    ).toEqual({ ok: false, reason: 'invalid_envelope' });
  });

  it('rejects an UNCHAINED app record — the chain gate, not the type gate', async () => {
    const subject = await signer();
    // `app_record` passes the type gate and is not a v1 legacy singleton, so it
    // must arrive chained. This is the case that tells the two gates apart.
    expect(
      await verifyEnvelope(v1Envelope(subject, { type: 'app_record' }), subject.userId)
    ).toEqual({ ok: false, reason: 'invalid_envelope' });
  });

  it('rejects a third-party issuer that is neither the subject nor Oxy', async () => {
    const subject = await signer();
    const foreign = await signer();
    expect(
      await verifyEnvelope(v1Envelope(subject, { issuer: foreign.did }), subject.userId)
    ).toEqual({ ok: false, reason: 'untrusted_issuer' });
  });

  it('rejects a subject DID that names no account', async () => {
    // Well-formed DID, correct binding, valid signature — and no row to resolve
    // verification methods from, so no key is authorized.
    const ghostId = randomUUID().replace(/-/g, '');
    const { publicKey, privateKey } = keyPair();
    const envelope = v1Envelope({ did: buildUserDid(ghostId), publicKey, privateKey });
    expect(await verifyEnvelope(envelope, ghostId)).toEqual({
      ok: false,
      reason: 'untrusted_issuer',
    });
  });

  it('rejects an issuedAt beyond the tolerated clock skew', async () => {
    const subject = await signer();
    expect(
      await verifyEnvelope(v1Envelope(subject, { issuedAt: Date.now() + 60 * 60 * 1000 }), subject.userId)
    ).toEqual({ ok: false, reason: 'issued_in_future' });
  });

  it('rejects an issuedAt that is not newer than the STORED record for the key', async () => {
    const subject = await signer();
    const issuedAt = Date.now();
    expect((await verifyAndStoreRecord(v1Envelope(subject, { issuedAt }), subject.userId)).ok).toBe(
      true
    );

    // The frontier is read from the row just written, not from a stub.
    const replay = v1Envelope(subject, { issuedAt, record: { displayName: 'Rolled back' } });
    expect(await verifyEnvelope(replay, subject.userId)).toEqual({
      ok: false,
      reason: 'stale_issued_at',
    });
    // ...and one millisecond later is accepted, so the comparison is against the
    // stored value rather than a blanket refusal of a second record.
    expect(
      await verifyEnvelope(v1Envelope(subject, { issuedAt: issuedAt + 1 }), subject.userId)
    ).toEqual({ ok: true });
  });
});

describe('the custodial issuer branch', () => {
  const ORIGINAL_OXY_PUBLIC_KEY = process.env.OXY_PUBLIC_KEY;
  const oxyKey = keyPair();

  afterAll(() => {
    if (ORIGINAL_OXY_PUBLIC_KEY === undefined) {
      delete process.env.OXY_PUBLIC_KEY;
    } else {
      process.env.OXY_PUBLIC_KEY = ORIGINAL_OXY_PUBLIC_KEY;
    }
  });

  it('accepts an Oxy-signed provenance record ABOUT a keyless account', async () => {
    process.env.OXY_PUBLIC_KEY = oxyKey.publicKey;
    const account = await keylessAccount();

    const envelope = v1Envelope(
      { did: account.did, publicKey: oxyKey.publicKey, privateKey: oxyKey.privateKey },
      { issuer: OXY_DID }
    );
    expect(await verifyEnvelope(envelope, account.userId)).toEqual({ ok: true });
  });

  it('refuses a record that CLAIMS the Oxy issuer but is signed by another key', async () => {
    // The issuer field is caller-controlled; the KEY is what decides. Without
    // this the case above would pass against a check that trusted the string.
    process.env.OXY_PUBLIC_KEY = oxyKey.publicKey;
    const account = await keylessAccount();
    const impostor = keyPair();

    const envelope = v1Envelope(
      { did: account.did, publicKey: impostor.publicKey, privateKey: impostor.privateKey },
      { issuer: OXY_DID }
    );
    expect(await verifyEnvelope(envelope, account.userId)).toEqual({
      ok: false,
      reason: 'public_key_not_a_current_verification_method',
    });
  });

  it('authorizes NO custodial record when the Oxy key is unconfigured', async () => {
    delete process.env.OXY_PUBLIC_KEY;
    const account = await keylessAccount();

    const envelope = v1Envelope(
      { did: account.did, publicKey: oxyKey.publicKey, privateKey: oxyKey.privateKey },
      { issuer: OXY_DID }
    );
    expect(await verifyEnvelope(envelope, account.userId)).toEqual({
      ok: false,
      reason: 'public_key_not_a_current_verification_method',
    });
  });
});

describe('verifyAndStoreRecord — what lands in the ledger', () => {
  it('stores the envelope VERBATIM, marked verified, with no chain fields', async () => {
    const subject = await signer();
    const envelope = v1Envelope(subject);

    const result = await verifyAndStoreRecord(envelope, subject.userId);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.record.verified).toBe(true);

    const [row] = await getDb()
      .select()
      .from(signedRecords)
      .where(eq(signedRecords.userId, subject.userId));
    expect(row.subjectDid).toBe(subject.did);
    expect(row.type).toBe('identity');
    expect(row.publicKey).toBe(subject.publicKey);
    expect(row.verified).toBe(true);
    // The stored envelope is the one that was signed — re-verifiable straight
    // out of the column, which is the whole point of storing it verbatim.
    expect(row.envelope).toEqual(envelope);
    expect(await verifyEnvelopeSignature(row.envelope)).toBe(true);
    // v1 is UNCHAINED: all four chain fields absent together.
    expect(row.seq).toBeNull();
    expect(row.recordId).toBeNull();
    expect(row.nsid).toBeNull();
    expect(row.rkey).toBeNull();
  });

  const rejections: Array<[string, string, (subject: Signer) => Promise<SignedRecordEnvelope>]> = [
    ['a subject that is another account', 'subject_mismatch', async () => v1Envelope(await signer())],
    [
      // A PER-APP type: `app_record` is inside the set, so it would exercise the
      // chain gate here rather than the type gate this row names.
      'a record type outside the Oxy set',
      'invalid_envelope',
      async (subject) => v1Envelope(subject, { type: 'app.syra.listen' }),
    ],
    [
      'a tampered record',
      'bad_signature',
      async (subject) => ({ ...v1Envelope(subject), record: { tampered: true } }),
    ],
    [
      'a third-party issuer',
      'untrusted_issuer',
      async (subject) => v1Envelope(subject, { issuer: (await signer()).did }),
    ],
    [
      'a key that is not a current verification method',
      'public_key_not_a_current_verification_method',
      async (subject) => v1Envelope({ did: subject.did, ...keyPair() }),
    ],
  ];

  it.each(rejections)('refuses %s (%s) and appends nothing', async (_label, reason, build) => {
    const subject = await signer();

    expect(await verifyAndStoreRecord(await build(subject), subject.userId)).toEqual({
      ok: false,
      reason,
    });
    expect(await countRecords(subject.userId)).toBe(0);
  });

  it('getLatestRecord answers per TYPE, and null when the account has none of it', async () => {
    const subject = await signer();
    expect(await getLatestRecord(subject.userId, 'identity')).toBeNull();

    const identity = v1Envelope(subject);
    expect((await verifyAndStoreRecord(identity, subject.userId)).ok).toBe(true);

    expect(await getLatestRecord(subject.userId, 'identity')).toEqual({ envelope: identity });
    // The `profile` singleton is a different key — an unscoped read would hand
    // back the identity record here.
    expect(await getLatestRecord(subject.userId, 'profile')).toBeNull();
  });
});
