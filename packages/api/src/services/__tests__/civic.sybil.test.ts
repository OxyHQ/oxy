/**
 * `computeSybilPenalty` — the personhood anti-gaming heuristic, against a REAL
 * Postgres.
 *
 * The penalty is subtracted (multiplicatively) from a subject's personhood
 * evidence, so it is the one thing standing between "a farm of accounts vouched
 * for each other" and `User.verified = true`. The suite it replaces mocked
 * `PersonhoodVouch.find` and branched on the SHAPE of the query object
 * (`q.subjectUserId && q.status === 'active' && q.voucherUserId === undefined`),
 * which means it asserted that a particular filter was constructed — it could
 * not have caught a `status` predicate that was dropped, or one scoped to the
 * wrong column, because the fixture answered whatever the branch decided.
 *
 * Rewritten: real vouch rows (each backed by a real signed record, since
 * `personhood_vouches.record_id` is a genuine foreign key now), real sessions,
 * and every fixture DISCRIMINATING —
 *
 *  - the "no vouchers" case seeds a WITHDRAWN vouch from an account that shares
 *    the subject's device, so a status-blind read would answer `0.6` instead of
 *    the zero signal;
 *  - the clustering cases seed clustered AND independent vouchers together, so a
 *    rule that counts every voucher lands on the wrong fraction rather than on
 *    a plausible one;
 *  - the cap case drives both sub-signals to 1 and states `SYBIL_PENALTY_CAP`,
 *    which an uncapped sum (1.2) fails.
 */

import { randomUUID } from 'node:crypto';
import { ec as EC } from 'elliptic';
import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { personhoodVouches } from '../../db/schema/personhoodVouches';
import { sessions } from '../../db/schema/sessions';
import { users } from '../../db/schema/users';
import { buildUserDid } from '../did.service';
import { getHead } from '../repoLog.service';
import { signRecordEnvelope, verifyAndStoreRecord } from '../signedRecord.service';
import { computeSybilPenalty } from '../civic/sybil.service';
import {
  SYBIL_PENALTY_CAP,
  SYBIL_SHARED_FINGERPRINT_WEIGHT,
  SYBIL_VOUCH_RING_WEIGHT,
} from '../../utils/civic.constants';

const ec = new EC('secp256k1');
const unique = () => randomUUID();

/** An account holding a signing key, so its vouch envelopes really verify. */
interface Signer {
  id: string;
  privateKey: string;
  publicKey: string;
}

async function signer(): Promise<Signer> {
  const keyPair = ec.genKeyPair();
  const publicKey = keyPair.getPublic('hex');
  const [row] = await getDb()
    .insert(users)
    .values({ username: `u-${unique().slice(0, 18)}`, publicKey })
    .returning({ id: users.id });
  return { id: row.id, privateKey: keyPair.getPrivate('hex'), publicKey };
}

/** An active session for `userId` on `deviceId`. */
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
 * A real vouch: the voucher signs a v2 `personhood_vouch` onto their OWN chain
 * and the projection row references that record. `record_id` is a foreign key,
 * so there is no shortcut here — the proof has to exist.
 */
async function vouch(
  voucher: Signer,
  subjectUserId: string,
  status: 'active' | 'withdrawn' | 'slashed' = 'active'
): Promise<void> {
  const head = await getHead(voucher.id);
  const envelope = signRecordEnvelope(
    {
      version: 2,
      type: 'personhood_vouch',
      subject: buildUserDid(voucher.id),
      issuer: buildUserDid(voucher.id),
      record: { about: buildUserDid(subjectUserId), stake: 10 },
      issuedAt: Date.now(),
      seq: head ? head.seq + 1 : 0,
      prev: head ? head.headRecordId : null,
      collection: 'app.oxy.personhood',
      rkey: subjectUserId,
      publicKey: voucher.publicKey,
      alg: 'ES256K-DER-SHA256',
    },
    voucher.privateKey
  );
  const stored = await verifyAndStoreRecord(envelope, voucher.id);
  if (!stored.ok) {
    throw new Error(`vouch fixture failed to store: ${stored.reason}`);
  }
  // The insert below is itself the check that the address names a stored row —
  // `record_id` is a foreign key, so a v1/unstored address fails loudly here
  // rather than becoming a dangling reference.
  await getDb().insert(personhoodVouches).values({
    voucherUserId: voucher.id,
    subjectUserId,
    stakeAmount: 10,
    recordId: stored.record.recordId,
    status,
  });
}

beforeAll(async () => {
  await connectPostgres();
});

afterAll(async () => {
  await closePostgres();
});

describe('which vouches count at all', () => {
  it('answers the zero signal when every vouch for the subject is NOT active', async () => {
    const subject = await signer();
    const withdrawn = await signer();
    const slashed = await signer();
    // Both would be a full shared-device cluster if `status` were ignored, so
    // this fixture separates "no active vouchers" from "no vouchers".
    const device = `dev-${unique()}`;
    await session(subject.id, device);
    await session(withdrawn.id, device);
    await session(slashed.id, device);
    await vouch(withdrawn, subject.id, 'withdrawn');
    await vouch(slashed, subject.id, 'slashed');

    expect(await computeSybilPenalty(subject.id)).toEqual({
      penalty: 0,
      sharedFingerprintFraction: 0,
      ringDensity: 0,
    });
  });

  it('does not read another subject’s vouchers or rings', async () => {
    const subject = await signer();
    const stranger = await signer();
    const theirVoucher = await signer();
    // The stranger has a fully reciprocal, fully co-located vouch graph.
    const device = `dev-${unique()}`;
    await session(stranger.id, device);
    await session(theirVoucher.id, device);
    await vouch(theirVoucher, stranger.id);
    await vouch(stranger, theirVoucher.id);

    expect(await computeSybilPenalty(subject.id)).toEqual({
      penalty: 0,
      sharedFingerprintFraction: 0,
      ringDensity: 0,
    });
    // …and the stranger's own signal is non-zero, so the empty read above is
    // not vacuous.
    const theirs = await computeSybilPenalty(stranger.id);
    expect(theirs.sharedFingerprintFraction).toBe(1);
    expect(theirs.ringDensity).toBe(1);
  });
});

describe('the shared-device cluster signal', () => {
  it('counts vouchers that share a device with EACH OTHER', async () => {
    const subject = await signer();
    const a = await signer();
    const b = await signer();
    const shared = `dev-${unique()}`;
    await session(subject.id, `dev-${unique()}`);
    await session(a.id, shared);
    await session(b.id, shared);
    await vouch(a, subject.id);
    await vouch(b, subject.id);

    const signal = await computeSybilPenalty(subject.id);

    expect(signal.sharedFingerprintFraction).toBe(1);
    expect(signal.ringDensity).toBe(0);
    expect(signal.penalty).toBeCloseTo(SYBIL_SHARED_FINGERPRINT_WEIGHT, 5);
  });

  it('counts a voucher that shares a device with the SUBJECT, and only that one', async () => {
    // Two vouchers, exactly one co-located with the subject. A rule that
    // counted every voucher would answer 1; one that ignored the subject's own
    // devices would answer 0. The fixture separates all three.
    const subject = await signer();
    const colocated = await signer();
    const independent = await signer();
    const device = `dev-${unique()}`;
    await session(subject.id, device);
    await session(colocated.id, device);
    await session(independent.id, `dev-${unique()}`);
    await vouch(colocated, subject.id);
    await vouch(independent, subject.id);

    const signal = await computeSybilPenalty(subject.id);

    expect(signal.sharedFingerprintFraction).toBe(0.5);
    expect(signal.penalty).toBeCloseTo(SYBIL_SHARED_FINGERPRINT_WEIGHT * 0.5, 5);
  });

  it('reports no cluster for independent vouchers on their own devices', async () => {
    const subject = await signer();
    const a = await signer();
    const b = await signer();
    await session(subject.id, `dev-${unique()}`);
    await session(a.id, `dev-${unique()}`);
    await session(b.id, `dev-${unique()}`);
    await vouch(a, subject.id);
    await vouch(b, subject.id);

    expect(await computeSybilPenalty(subject.id)).toEqual({
      penalty: 0,
      sharedFingerprintFraction: 0,
      ringDensity: 0,
    });
  });
});

describe('the vouch-ring density signal', () => {
  it('counts a reciprocal edge (the subject vouches a voucher back)', async () => {
    const subject = await signer();
    const a = await signer();
    await vouch(a, subject.id);
    await vouch(subject, a.id);

    const signal = await computeSybilPenalty(subject.id);

    expect(signal.ringDensity).toBe(1);
    expect(signal.sharedFingerprintFraction).toBe(0);
    expect(signal.penalty).toBeCloseTo(SYBIL_VOUCH_RING_WEIGHT, 5);
  });

  it('counts a 3-cycle (S→X, X→Y, Y→S) with no reciprocal edge anywhere', async () => {
    // The triad branch is the one a purely reciprocal fixture never reaches.
    // `x` is only OUTGOING and `y` is only INCOMING, so nothing here is a
    // 2-cycle and the density can come from the bridge edge alone.
    const subject = await signer();
    const x = await signer();
    const y = await signer();
    await vouch(subject, x.id);
    await vouch(x, y.id);
    await vouch(y, subject.id);

    const signal = await computeSybilPenalty(subject.id);

    expect(signal.ringDensity).toBe(1);
    expect(signal.penalty).toBeCloseTo(SYBIL_VOUCH_RING_WEIGHT, 5);
  });

  it('reports no ring for a one-directional vouch', async () => {
    const subject = await signer();
    const a = await signer();
    const unrelated = await signer();
    // The subject DOES vouch — just not for anyone in their own incoming set,
    // so an outgoing-vouch count that forgot to intersect would answer 1.
    await vouch(a, subject.id);
    await vouch(subject, unrelated.id);

    expect((await computeSybilPenalty(subject.id)).ringDensity).toBe(0);
  });
});

describe('the combined penalty', () => {
  it('caps the sum of both signals at SYBIL_PENALTY_CAP', async () => {
    // Both weights are 0.6, so an uncapped sum is 1.2 — a penalty above 1 would
    // drive a subject's evidence score negative.
    const subject = await signer();
    const a = await signer();
    const device = `dev-${unique()}`;
    await session(subject.id, device);
    await session(a.id, device);
    await vouch(a, subject.id);
    await vouch(subject, a.id);

    const signal = await computeSybilPenalty(subject.id);

    expect(signal.sharedFingerprintFraction).toBe(1);
    expect(signal.ringDensity).toBe(1);
    expect(SYBIL_SHARED_FINGERPRINT_WEIGHT + SYBIL_VOUCH_RING_WEIGHT).toBeGreaterThan(
      SYBIL_PENALTY_CAP
    );
    expect(signal.penalty).toBe(SYBIL_PENALTY_CAP);
  });

  it('adds the two signals when their sum is below the cap', async () => {
    // One of two vouchers clustered (0.5) plus one of two reciprocal (0.5) —
    // 0.6 total, so the arithmetic is visible rather than hidden by the clamp.
    const subject = await signer();
    const a = await signer();
    const b = await signer();
    const device = `dev-${unique()}`;
    await session(subject.id, device);
    await session(a.id, device);
    await session(b.id, `dev-${unique()}`);
    await vouch(a, subject.id);
    await vouch(b, subject.id);
    await vouch(subject, a.id);

    const signal = await computeSybilPenalty(subject.id);

    expect(signal.sharedFingerprintFraction).toBe(0.5);
    expect(signal.ringDensity).toBe(0.5);
    expect(signal.penalty).toBeCloseTo(
      SYBIL_SHARED_FINGERPRINT_WEIGHT * 0.5 + SYBIL_VOUCH_RING_WEIGHT * 0.5,
      5
    );
  });
});
