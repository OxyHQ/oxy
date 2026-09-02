/**
 * `submitRealLifeAttestation` — the HIGH-weight anti-gaming signal, against a
 * REAL Postgres.
 *
 * B physically meets A, scans A's QR and signs a `real_life_attestation` with
 * B's OWN key; the server awards A +25 and records B as the counterparty who can
 * later be slashed for it. The suite this replaces mocked the signature check,
 * the chain store, the nonce model, the graph-exclusion predicate, the user
 * model AND the reputation service — so the ONLY thing left running was the
 * ordering of the `if`s, and every assertion was about the arguments handed to a
 * mock. It could not see a single row: not the award, not the burned nonce, not
 * the stored envelope, and above all not whether a rejected attempt left the
 * subject's QR spendable.
 *
 * Rewritten end to end. The three properties that carry the weight, and which
 * a mocked version structurally could not test:
 *
 *  - **A rejection must not burn the nonce.** The nonce claim sits AFTER the
 *    eligibility gates precisely so a refused scan does not cost the subject
 *    their QR. Asserted by having a second, eligible counterparty succeed with
 *    the SAME nonce after the first was refused.
 *  - **The (attestor → subject) pair earns at most once.** `realLifeCount`
 *    feeds personhood, so a second +25 for a re-scan is a personhood exploit.
 *    Asserted by counting ledger rows, not by observing a mock go uncalled.
 *  - **The proof chain really exists.** B's envelope is stored, its content
 *    address is the award's `source_action_id`, and the Oxy attestation on A's
 *    chain names that same address.
 */

import { generateSecp256k1KeyPair } from '@oxyhq/protocol/secp256k1';
import { createHash, randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import type { SignedRecordEnvelope } from '@oxyhq/contracts';
import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { civicNonces } from '../../db/schema/civicNonces';
import { reputationTransactions } from '../../db/schema/reputationTransactions';
import { sessions } from '../../db/schema/sessions';
import { signedRecords } from '../../db/schema/signedRecords';
import { userFollows } from '../../db/schema/userFollows';
import { users } from '../../db/schema/users';
import { REPUTATION_ATTESTATION_COLLECTION } from '../civic/attestation.service';
import { submitRealLifeAttestation } from '../civic/realLife.service';
import { buildUserDid } from '../did.service';
import { getHead } from '../repoLog.service';
import { reputationService } from '../reputation.service';
import { signRecordEnvelope } from '../signedRecord.service';
import {
  REAL_LIFE_ATTESTED_ACTION,
  REAL_LIFE_ATTESTED_POINTS,
} from '../../utils/reputation.constants';
import { REAL_LIFE_NONCE_MAX_AGE_MS } from '../../utils/civic.constants';

const oxyKey = generateSecp256k1KeyPair();
const OXY_PUBLIC = oxyKey.publicKey;
const OXY_PRIVATE = oxyKey.privateKey;

const unique = () => randomUUID();

/** The attestation collection B's own envelope lands in. */
const ATTESTATION_COLLECTION = 'app.oxy.attestation';

interface Signer {
  id: string;
  privateKey: string;
  publicKey: string;
}

/** A counterparty: an account whose signing key the resolver will authorize. */
async function signer(): Promise<Signer> {
  const keyPair = generateSecp256k1KeyPair();
  const publicKey = keyPair.publicKey;
  const [row] = await getDb()
    .insert(users)
    .values({ username: `u-${unique().slice(0, 18)}`, publicKey })
    .returning({ id: users.id });
  return { id: row.id, privateKey: keyPair.privateKey, publicKey };
}

/** A subject: a plain account, which is all the QR owner needs to be. */
async function account(): Promise<string> {
  const [row] = await getDb()
    .insert(users)
    .values({ username: `u-${unique().slice(0, 18)}` })
    .returning({ id: users.id });
  return row.id;
}

async function session(userId: string, deviceId: string): Promise<void> {
  const token = unique();
  await getDb().insert(sessions).values({
    sessionId: `s-${token}`,
    userId,
    deviceId,
    deviceType: 'mobile',
    platform: 'ios',
    accessToken: `at-${token}`,
    refreshToken: `rt-${token}`,
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
  });
}

/**
 * The envelope B signs after scanning A's QR: self-issued on B's chain, with A
 * referenced by `about`. Genuinely signed, so the service's own signature check
 * and the store's verification both run for real.
 */
async function attestation(
  attestor: Signer,
  overrides: {
    about?: string;
    nonce?: string;
    exp?: number;
    context?: string;
    subject?: string;
    issuer?: string;
    type?: SignedRecordEnvelope['type'];
    record?: Record<string, unknown>;
    /** Sign with a key OTHER than the attestor's — a forgery. */
    signingKey?: string;
  } = {}
): Promise<SignedRecordEnvelope> {
  const head = await getHead(attestor.id);
  const subject = overrides.subject ?? buildUserDid(attestor.id);
  const nonce = overrides.nonce ?? `nonce-${unique()}`;
  return signRecordEnvelope(
    {
      version: 2,
      type: overrides.type ?? 'real_life_attestation',
      subject,
      issuer: overrides.issuer ?? subject,
      record: overrides.record ?? {
        about: overrides.about ?? '',
        context: overrides.context ?? 'ctx-1',
        nonce,
        exp: overrides.exp ?? Date.now() + 5 * 60 * 1000,
        biometricOk: true,
      },
      issuedAt: Date.now(),
      seq: head ? head.seq + 1 : 0,
      prev: head ? head.headRecordId : null,
      collection: ATTESTATION_COLLECTION,
      rkey: nonce,
      publicKey: attestor.publicKey,
      alg: 'ES256K-DER-SHA256',
    },
    overrides.signingKey ?? attestor.privateKey
  );
}

/** The subject's `real_life_attested` ledger rows. */
async function awards(subjectUserId: string) {
  return getDb()
    .select({
      id: reputationTransactions.id,
      points: reputationTransactions.points,
      createdByUserId: reputationTransactions.createdByUserId,
      sourceActionId: reputationTransactions.sourceActionId,
      metadata: reputationTransactions.metadata,
    })
    .from(reputationTransactions)
    .where(
      and(
        eq(reputationTransactions.userId, subjectUserId),
        eq(reputationTransactions.actionType, REAL_LIFE_ATTESTED_ACTION)
      )
    );
}

/** The attestation envelopes stored on a counterparty's own chain. */
async function storedAttestations(attestorUserId: string) {
  return getDb()
    .select({ recordId: signedRecords.recordId, rkey: signedRecords.rkey, envelope: signedRecords.envelope })
    .from(signedRecords)
    .where(
      and(eq(signedRecords.userId, attestorUserId), eq(signedRecords.nsid, ATTESTATION_COLLECTION))
    );
}

/** The nonces burned for a subject. */
async function burnedNonces(subjectUserId: string) {
  return getDb()
    .select({ nonceHash: civicNonces.nonceHash, purpose: civicNonces.purpose })
    .from(civicNonces)
    .where(eq(civicNonces.subjectUserId, subjectUserId));
}

/** The nonce hash the service stores — purpose-salted sha256, never the raw value. */
function nonceHash(nonce: string): string {
  return createHash('sha256').update(`real_life_attestation:${nonce}`).digest('hex');
}

beforeAll(async () => {
  await connectPostgres();
  process.env.OXY_PRIVATE_KEY = OXY_PRIVATE;
  process.env.OXY_PUBLIC_KEY = OXY_PUBLIC;
  await reputationService.seedDefaultRules();
});

afterAll(async () => {
  delete process.env.OXY_PRIVATE_KEY;
  delete process.env.OXY_PUBLIC_KEY;
  await closePostgres();
});

describe('an accepted attestation', () => {
  it('awards the subject, records the counterparty, and stores the whole proof chain', async () => {
    const subject = await account();
    const attestor = await signer();
    const nonce = `nonce-${unique()}`;
    const envelope = await attestation(attestor, {
      about: buildUserDid(subject),
      nonce,
      context: 'ctx-cafe',
    });

    const result = await submitRealLifeAttestation(envelope, attestor.id);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result).toMatchObject({
      subjectUserId: subject,
      attestorUserId: attestor.id,
      points: REAL_LIFE_ATTESTED_POINTS,
    });

    // 1. The ledger: exactly one award, to the SUBJECT, crediting the attestor.
    const ledger = await awards(subject);
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({
      points: REAL_LIFE_ATTESTED_POINTS,
      createdByUserId: attestor.id,
      sourceActionId: result.recordId,
      metadata: { attestorUserId: attestor.id, context: 'ctx-cafe', biometricOk: true },
    });
    // The attestor earns nothing for attesting — only the subject does.
    expect(await awards(attestor.id)).toEqual([]);

    // 2. B's signed statement is on B's OWN chain, at the address the award cites.
    const stored = await storedAttestations(attestor.id);
    expect(stored).toHaveLength(1);
    expect(stored[0].recordId).toBe(result.recordId);
    expect(stored[0].rkey).toBe(nonce);
    expect(stored[0].envelope.record).toMatchObject({ about: buildUserDid(subject) });
    expect(await storedAttestations(subject)).toEqual([]);

    // 3. The nonce is burned — hashed, never stored in the clear.
    expect(await burnedNonces(subject)).toEqual([
      { nonceHash: nonceHash(nonce), purpose: 'real_life_attestation' },
    ]);

    // 4. The Oxy provenance attestation on the SUBJECT's chain names B's
    //    envelope, closing the loop `user signature → Oxy attestation → ledger`.
    const [provenance] = await getDb()
      .select({ envelope: signedRecords.envelope })
      .from(signedRecords)
      .where(
        and(
          eq(signedRecords.userId, subject),
          eq(signedRecords.nsid, REPUTATION_ATTESTATION_COLLECTION)
        )
      );
    expect(provenance).toBeDefined();
    expect(provenance.envelope.record).toMatchObject({
      txnId: ledger[0].id,
      subjectUserId: subject,
      actionType: REAL_LIFE_ATTESTED_ACTION,
      weightClass: 'HIGH',
      sourceEnvelopeIds: [result.recordId],
    });
  });

  it('awards independently for a DIFFERENT counterparty', async () => {
    const subject = await account();
    const first = await signer();
    const second = await signer();

    await submitRealLifeAttestation(
      await attestation(first, { about: buildUserDid(subject) }),
      first.id
    );
    await submitRealLifeAttestation(
      await attestation(second, { about: buildUserDid(subject) }),
      second.id
    );

    const ledger = await awards(subject);
    expect(ledger).toHaveLength(2);
    expect(new Set(ledger.map((row) => row.createdByUserId))).toEqual(
      new Set([first.id, second.id])
    );
  });
});

describe('the pair earns at most once', () => {
  it('answers a re-scan with the ORIGINAL award and burns no second nonce', async () => {
    // `realLifeCount` feeds personhood, so a second +25 for re-scanning the same
    // person is a personhood exploit. The repeat carries a FRESH nonce, which
    // must survive: a no-op must not cost the subject their current QR.
    const subject = await account();
    const attestor = await signer();

    const firstResult = await submitRealLifeAttestation(
      await attestation(attestor, { about: buildUserDid(subject) }),
      attestor.id
    );
    expect(firstResult.ok).toBe(true);
    if (!firstResult.ok) return;

    const repeat = await submitRealLifeAttestation(
      await attestation(attestor, { about: buildUserDid(subject) }),
      attestor.id
    );

    expect(repeat).toEqual({
      ok: true,
      recordId: firstResult.recordId,
      subjectUserId: subject,
      attestorUserId: attestor.id,
      points: REAL_LIFE_ATTESTED_POINTS,
    });
    // One award, one stored envelope, one burned nonce.
    expect(await awards(subject)).toHaveLength(1);
    expect(await storedAttestations(attestor.id)).toHaveLength(1);
    expect(await burnedNonces(subject)).toHaveLength(1);
  });
});

describe('the envelope gates', () => {
  it('rejects a record that is not a real-life attestation', async () => {
    const subject = await account();
    const attestor = await signer();
    const envelope = await attestation(attestor, {
      about: buildUserDid(subject),
      type: 'identity',
    });

    expect(await submitRealLifeAttestation(envelope, attestor.id)).toEqual({
      ok: false,
      reason: 'invalid_type',
    });
    expect(await awards(subject)).toEqual([]);
  });

  it('rejects an envelope self-issued as a DIFFERENT account', async () => {
    const subject = await account();
    const attestor = await signer();
    const envelope = await attestation(attestor, {
      about: buildUserDid(subject),
      subject: buildUserDid(subject),
    });

    expect(await submitRealLifeAttestation(envelope, attestor.id)).toEqual({
      ok: false,
      reason: 'not_self_issued',
    });
  });

  it('rejects an envelope whose issuer and subject disagree', async () => {
    const subject = await account();
    const attestor = await signer();
    const envelope = await attestation(attestor, {
      about: buildUserDid(subject),
      issuer: buildUserDid(subject),
    });

    expect(await submitRealLifeAttestation(envelope, attestor.id)).toEqual({
      ok: false,
      reason: 'not_self_issued',
    });
  });

  it('rejects a malformed record payload', async () => {
    const attestor = await signer();
    const subject = await account();
    const envelope = await attestation(attestor, {
      // No `nonce`, so there is no replay guard to claim at all.
      record: { about: buildUserDid(subject), context: 'ctx', exp: Date.now() + 60_000 },
    });

    expect(await submitRealLifeAttestation(envelope, attestor.id)).toEqual({
      ok: false,
      reason: 'invalid_record',
    });
  });

  it('rejects an `about` that is not a user DID of this issuer', async () => {
    const attestor = await signer();
    const envelope = await attestation(attestor, { about: `did:web:evil.com:u:${unique()}` });

    expect(await submitRealLifeAttestation(envelope, attestor.id)).toEqual({
      ok: false,
      reason: 'invalid_subject',
    });
  });

  it('rejects an attestation about an account that does not exist', async () => {
    const attestor = await signer();
    const envelope = await attestation(attestor, { about: buildUserDid(unique()) });

    expect(await submitRealLifeAttestation(envelope, attestor.id)).toEqual({
      ok: false,
      reason: 'subject_not_found',
    });
  });

  it('rejects attesting yourself', async () => {
    const attestor = await signer();
    const envelope = await attestation(attestor, { about: buildUserDid(attestor.id) });

    expect(await submitRealLifeAttestation(envelope, attestor.id)).toEqual({
      ok: false,
      reason: 'self_attestation',
    });
    expect(await awards(attestor.id)).toEqual([]);
  });

  it('rejects a QR that has expired', async () => {
    const subject = await account();
    const attestor = await signer();
    const envelope = await attestation(attestor, {
      about: buildUserDid(subject),
      exp: Date.now() - 1000,
    });

    expect(await submitRealLifeAttestation(envelope, attestor.id)).toEqual({
      ok: false,
      reason: 'expired',
    });
  });

  it('rejects a QR whose expiry is further out than the freshness window', async () => {
    // The upper bound matters as much as the lower one: an `exp` years away is a
    // permanently reusable scan handle, which is what the window exists to deny.
    const subject = await account();
    const attestor = await signer();
    const envelope = await attestation(attestor, {
      about: buildUserDid(subject),
      exp: Date.now() + REAL_LIFE_NONCE_MAX_AGE_MS + 60_000,
    });

    expect(await submitRealLifeAttestation(envelope, attestor.id)).toEqual({
      ok: false,
      reason: 'expired',
    });
  });

  it('rejects a forged signature before any award, nonce or storage', async () => {
    const subject = await account();
    const attestor = await signer();
    // Someone else's signature over the same bytes: the envelope still claims
    // the attestor's `publicKey`, so only a real verification catches it.
    const forged = await attestation(attestor, {
      about: buildUserDid(subject),
      signingKey: generateSecp256k1KeyPair().privateKey,
    });

    expect(await submitRealLifeAttestation(forged, attestor.id)).toEqual({
      ok: false,
      reason: 'bad_signature',
    });
    expect(await awards(subject)).toEqual([]);
    expect(await burnedNonces(subject)).toEqual([]);
    expect(await storedAttestations(attestor.id)).toEqual([]);
  });
});

describe('the anti-sybil gates', () => {
  it('refuses a counterparty who is a social-graph neighbour', async () => {
    const subject = await account();
    const attestor = await signer();
    await getDb().insert(userFollows).values({ followerId: subject, followedId: attestor.id });

    expect(
      await submitRealLifeAttestation(
        await attestation(attestor, { about: buildUserDid(subject) }),
        attestor.id
      )
    ).toEqual({ ok: false, reason: 'excluded_graph_neighbor' });

    expect(await awards(subject)).toEqual([]);
    expect(await burnedNonces(subject)).toEqual([]);
    expect(await storedAttestations(attestor.id)).toEqual([]);
  });

  it('refuses a counterparty signed in on the same device', async () => {
    const subject = await account();
    const attestor = await signer();
    const device = `dev-${unique()}`;
    await session(subject, device);
    await session(attestor.id, device);

    expect(
      await submitRealLifeAttestation(
        await attestation(attestor, { about: buildUserDid(subject) }),
        attestor.id
      )
    ).toEqual({ ok: false, reason: 'excluded_shared_device' });
    expect(await awards(subject)).toEqual([]);
  });
});

describe('the single-use nonce', () => {
  it('refuses a second counterparty replaying a nonce that was already spent', async () => {
    // The nonce is salted by PURPOSE only, deliberately: one QR is one scan,
    // regardless of who submits it.
    const subject = await account();
    const first = await signer();
    const replayer = await signer();
    const nonce = `nonce-${unique()}`;

    const accepted = await submitRealLifeAttestation(
      await attestation(first, { about: buildUserDid(subject), nonce }),
      first.id
    );
    expect(accepted.ok).toBe(true);

    expect(
      await submitRealLifeAttestation(
        await attestation(replayer, { about: buildUserDid(subject), nonce }),
        replayer.id
      )
    ).toEqual({ ok: false, reason: 'nonce_used' });

    // The replayer earned the subject nothing and stored nothing.
    expect(await awards(subject)).toHaveLength(1);
    expect(await storedAttestations(replayer.id)).toEqual([]);
  });

  it('leaves the nonce spendable when the scan was REFUSED', async () => {
    // The claim sits after the eligibility gates on purpose. If it did not, a
    // sock puppet could burn a stranger's QR just by scanning it — a denial of
    // service against the subject with no cost to the attacker.
    const subject = await account();
    const excluded = await signer();
    const eligible = await signer();
    const nonce = `nonce-${unique()}`;
    await getDb().insert(userFollows).values({ followerId: subject, followedId: excluded.id });

    expect(
      await submitRealLifeAttestation(
        await attestation(excluded, { about: buildUserDid(subject), nonce }),
        excluded.id
      )
    ).toEqual({ ok: false, reason: 'excluded_graph_neighbor' });

    const second = await submitRealLifeAttestation(
      await attestation(eligible, { about: buildUserDid(subject), nonce }),
      eligible.id
    );

    expect(second.ok).toBe(true);
    expect(await awards(subject)).toHaveLength(1);
    expect(await burnedNonces(subject)).toEqual([
      { nonceHash: nonceHash(nonce), purpose: 'real_life_attestation' },
    ]);
  });
});
