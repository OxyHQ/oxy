/**
 * Proof-of-personhood (civic / Fase 3), against a REAL Postgres.
 *
 * The suite this replaces mocked eleven Mongoose models the service no longer
 * imports, so every gate it "checked" was checked against a `jest.fn()` and
 * every stake, award and score it "asserted" was read back out of a mock's
 * argument list. Personhood is the one civic surface where that is worst,
 * because its whole design is a claim about ARITHMETIC over stored rows:
 *
 *  - **No single evidence class reaches θ.** `evidence = 0.50·vouch +
 *    0.35·realLife + 0.15·biometric`, θ = 0.60 — so a saturated vouch signal
 *    alone (0.50) and a saturated real-life + biometric pair (0.50) are BOTH
 *    below it. That is the anti-single-point-of-trust property, and a fixture
 *    that only ever exercises "enough evidence, verdict true" passes against a
 *    formula that ignores the weights entirely. Both sub-θ cases are asserted
 *    here alongside the crossing one.
 *  - **A refusal must write NOTHING.** Each rejection case asserts the reason
 *    AND that no vouch row, no signed record on the voucher's chain, and no
 *    ledger row for the subject appeared — a vouch that is refused after the
 *    award, or after the chain append, is a much worse bug than one that is not
 *    refused at all.
 *  - **`personhood_vouches.record_id` is a real foreign key onto
 *    `signed_records.record_id` now.** A v1 (unchained) envelope stores no
 *    content address, which is exactly why the store policy refuses one for this
 *    type; under Mongo it produced a dangling reference in silence.
 *  - **The verified mirror is guarded.** `recomputePersonhood` only writes
 *    `users.verified`, recalculates the balance and invalidates the cache when
 *    the verdict actually CHANGES. The observable for "the recompute did not
 *    run" is that no `reputation_balances` row exists for the account —
 *    `recalculateBalance` upserts one unconditionally.
 *
 * The whole run shares one database, so every account carries a per-test random
 * id and no assertion depends on a table being empty.
 */

import { generateSecp256k1KeyPair } from '@oxyhq/protocol/secp256k1';
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import type { SignedRecordEnvelope } from '@oxyhq/contracts';
import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { personhoodStatuses } from '../../db/schema/personhoodStatuses';
import { personhoodVouches } from '../../db/schema/personhoodVouches';
import { reputationBalances } from '../../db/schema/reputationBalances';
import { reputationTransactions } from '../../db/schema/reputationTransactions';
import { sessions } from '../../db/schema/sessions';
import { signedRecords } from '../../db/schema/signedRecords';
import { userFollows } from '../../db/schema/userFollows';
import { users } from '../../db/schema/users';
import { buildUserDid } from '../did.service';
import { signRecordEnvelope, verifyAndStoreRecord } from '../signedRecord.service';
import { reputationService } from '../reputation.service';
import {
  recomputePersonhood,
  slashVouchersForFakeSubject,
  vouchForPerson,
  withdrawVouch,
} from '../civic/personhood.service';
import {
  PERSONHOOD_THRESHOLD,
  PERSONHOOD_VOUCH_MAX_STAKE,
  PERSONHOOD_VOUCH_MIN_STAKE,
  PERSONHOOD_VOUCH_DEFAULT_STAKE,
  PERSONHOOD_VOUCH_TARGET,
  VOUCH_TIER_WEIGHT,
} from '../../utils/civic.constants';
import {
  PERSONHOOD_VOUCHED_ACTION,
  PERSONHOOD_VOUCHED_POINTS,
  REAL_LIFE_ATTESTED_ACTION,
  VOUCH_SLASHED_ACTION,
  VOUCH_SLASHED_POINTS,
} from '../../utils/reputation.constants';

const uniqueId = () => randomUUID().replace(/-/g, '');

/** An account that can sign: its `publicKey` is a current verification method. */
interface Signer {
  userId: string;
  did: string;
  publicKey: string;
  privateKey: string;
}

async function makeSigner(overrides: Partial<typeof users.$inferInsert> = {}): Promise<Signer> {
  const keyPair = generateSecp256k1KeyPair();
  const publicKey = keyPair.publicKey;
  const id = uniqueId();
  await getDb()
    .insert(users)
    .values({ id, username: `p${id.slice(0, 12)}`, publicKey, ...overrides });
  return { userId: id, did: buildUserDid(id), publicKey, privateKey: keyPair.privateKey };
}

/** A plain account with no signing key. */
async function makeAccount(overrides: Partial<typeof users.$inferInsert> = {}): Promise<string> {
  const id = uniqueId();
  await getDb()
    .insert(users)
    .values({ id, username: `a${id.slice(0, 12)}`, ...overrides });
  return id;
}

/** A voucher that clears τ outright — the genesis of the web of trust. */
const makeSeedVoucher = () => makeSigner({ isSeedVerifier: true });

/** Build + REAL-sign a v2 `personhood_vouch` envelope from `voucher`. */
function vouchEnvelope(
  voucher: Signer,
  overrides: {
    about?: string;
    subject?: string;
    issuer?: string;
    stake?: number;
    type?: SignedRecordEnvelope['type'];
    version?: 1 | 2;
    rkey?: string;
    seq?: number;
    prev?: string | null;
  } = {},
): SignedRecordEnvelope {
  const record: Record<string, unknown> = {
    about: overrides.about ?? buildUserDid(uniqueId()),
    context: 'met-in-person',
    ...(overrides.stake === undefined ? {} : { stake: overrides.stake }),
  };
  const chained =
    overrides.version === 1
      ? {}
      : {
          seq: overrides.seq ?? 0,
          prev: overrides.prev ?? null,
          collection: 'app.oxy.personhood',
          rkey: overrides.rkey ?? `vouch-${uniqueId().slice(0, 8)}`,
        };
  return signRecordEnvelope(
    {
      version: overrides.version ?? 2,
      type: overrides.type ?? 'personhood_vouch',
      subject: overrides.subject ?? voucher.did,
      issuer: overrides.issuer ?? voucher.did,
      record,
      issuedAt: Date.now(),
      ...chained,
      publicKey: voucher.publicKey,
      alg: 'ES256K-DER-SHA256',
    } as Omit<SignedRecordEnvelope, 'signature'>,
    voucher.privateKey,
  );
}

/** The vouch rows one subject has, whatever their status. */
async function vouchRows(subjectUserId: string) {
  return getDb()
    .select({
      voucherUserId: personhoodVouches.voucherUserId,
      subjectUserId: personhoodVouches.subjectUserId,
      stakeAmount: personhoodVouches.stakeAmount,
      recordId: personhoodVouches.recordId,
      status: personhoodVouches.status,
    })
    .from(personhoodVouches)
    .where(eq(personhoodVouches.subjectUserId, subjectUserId));
}

/** The chain rows a voucher owns. */
async function chainRows(userId: string) {
  return getDb()
    .select({ recordId: signedRecords.recordId, type: signedRecords.type })
    .from(signedRecords)
    .where(eq(signedRecords.userId, userId));
}

/** The ledger rows one account has. */
async function ledgerRows(userId: string) {
  return getDb()
    .select({ actionType: reputationTransactions.actionType, points: reputationTransactions.points })
    .from(reputationTransactions)
    .where(eq(reputationTransactions.userId, userId));
}

async function personhoodRow(userId: string) {
  const [row] = await getDb()
    .select()
    .from(personhoodStatuses)
    .where(eq(personhoodStatuses.userId, userId))
    .limit(1);
  return row;
}

async function balanceRows(userId: string) {
  return getDb()
    .select({ total: reputationBalances.total })
    .from(reputationBalances)
    .where(eq(reputationBalances.userId, userId));
}

async function isUserVerified(userId: string): Promise<boolean> {
  const [row] = await getDb()
    .select({ verified: users.verified })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  return row.verified;
}

/**
 * An ACTIVE vouch fixture for a recompute test: a real signed vouch record on
 * the voucher's own chain (so `personhood_vouches.record_id`'s foreign key has a
 * genuine target) plus the projection row, without going through the eligibility
 * gates the vouch tests own. `tier` seeds the voucher's balance so the weighted
 * sum can be predicted; omit it to leave the voucher with no balance row at all.
 */
async function seedActiveVouch(
  subjectUserId: string,
  tier?: typeof reputationBalances.$inferInsert['trustTier'],
): Promise<string> {
  const voucher = await makeSigner();
  if (tier) {
    await getDb().insert(reputationBalances).values({ userId: voucher.userId, trustTier: tier });
  }
  const envelope = vouchEnvelope(voucher, { about: buildUserDid(subjectUserId) });
  const stored = await verifyAndStoreRecord(envelope, voucher.userId);
  if (!stored.ok) {
    throw new Error(`vouch fixture could not be stored: ${stored.reason}`);
  }
  await getDb().insert(personhoodVouches).values({
    voucherUserId: voucher.userId,
    subjectUserId,
    stakeAmount: PERSONHOOD_VOUCH_DEFAULT_STAKE,
    recordId: stored.record.recordId,
  });
  return voucher.userId;
}

/** An active session binding `userId` to `deviceId`. */
async function seedSession(userId: string, deviceId: string): Promise<void> {
  const token = uniqueId();
  await getDb().insert(sessions).values({
    sessionId: `s-${token}`,
    userId,
    deviceId,
    deviceType: 'mobile',
    platform: 'ios',
    accessToken: `at-${token}`,
    refreshToken: `rt-${token}`,
    expiresAt: new Date(Date.now() + 86_400_000),
  });
}

beforeAll(async () => {
  await connectPostgres();
  // The civic award rules (`personhood_vouched`, `vouch_slashed`,
  // `real_life_attested`) — `award` refuses an action with no enabled rule.
  await reputationService.seedDefaultRules();
});

afterAll(async () => {
  await closePostgres();
});

describe('vouchForPerson — what an accepted vouch actually writes', () => {
  it('stores the staked vouch against a real signed record, awards the subject, and recomputes them', async () => {
    const voucher = await makeSeedVoucher();
    const subjectUserId = await makeAccount();

    const result = await vouchForPerson(
      vouchEnvelope(voucher, { about: buildUserDid(subjectUserId) }),
      voucher.userId,
    );

    expect(result).toMatchObject({
      ok: true,
      subjectUserId,
      voucherUserId: voucher.userId,
      stakeAmount: PERSONHOOD_VOUCH_DEFAULT_STAKE,
      points: PERSONHOOD_VOUCHED_POINTS,
    });
    if (!result.ok) return;

    const vouches = await vouchRows(subjectUserId);
    expect(vouches).toEqual([
      {
        voucherUserId: voucher.userId,
        subjectUserId,
        stakeAmount: PERSONHOOD_VOUCH_DEFAULT_STAKE,
        recordId: result.recordId,
        status: 'active',
      },
    ]);

    // The stored content address names a record on the VOUCHER's chain — the
    // vouch is their signed statement, not the subject's.
    const chain = await chainRows(voucher.userId);
    expect(chain).toEqual([{ recordId: result.recordId, type: 'personhood_vouch' }]);

    // The subject was awarded by the SERVICE; the voucher awarded nobody.
    expect(await ledgerRows(subjectUserId)).toEqual([
      { actionType: PERSONHOOD_VOUCHED_ACTION, points: PERSONHOOD_VOUCHED_POINTS },
    ]);
    expect(await ledgerRows(voucher.userId)).toEqual([]);

    const [txn] = await getDb()
      .select({
        createdByUserId: reputationTransactions.createdByUserId,
        sourceActionId: reputationTransactions.sourceActionId,
        metadata: reputationTransactions.metadata,
      })
      .from(reputationTransactions)
      .where(eq(reputationTransactions.userId, subjectUserId));
    expect(txn.createdByUserId).toBe(voucher.userId);
    expect(txn.sourceActionId).toBe(result.recordId);
    expect(txn.metadata).toMatchObject({
      voucherUserId: voucher.userId,
      stakeAmount: PERSONHOOD_VOUCH_DEFAULT_STAKE,
    });

    const status = await personhoodRow(subjectUserId);
    expect(status.vouchCount).toBe(1);
  });

  it('clamps a caller-chosen stake into the configured bounds, in the STORED row', async () => {
    const high = await makeSeedVoucher();
    const richSubject = await makeAccount();
    await vouchForPerson(
      vouchEnvelope(high, { about: buildUserDid(richSubject), stake: 10_000 }),
      high.userId,
    );
    expect((await vouchRows(richSubject))[0].stakeAmount).toBe(PERSONHOOD_VOUCH_MAX_STAKE);

    const low = await makeSeedVoucher();
    const poorSubject = await makeAccount();
    await vouchForPerson(
      vouchEnvelope(low, { about: buildUserDid(poorSubject), stake: 0 }),
      low.userId,
    );
    expect((await vouchRows(poorSubject))[0].stakeAmount).toBe(PERSONHOOD_VOUCH_MIN_STAKE);
  });
});

describe('vouchForPerson — a refusal writes nothing at all', () => {
  /**
   * Every rejection below asserts the reason AND the absence of all three side
   * effects. Asserting only the reason cannot tell a gate that fires FIRST from
   * one that fires after the chain append or after the award — which is the
   * difference between a rejected vouch and a half-applied one.
   */
  async function expectNothingWritten(voucherUserId: string, subjectUserId: string): Promise<void> {
    expect(await vouchRows(subjectUserId)).toEqual([]);
    expect(await chainRows(voucherUserId)).toEqual([]);
    expect(await ledgerRows(subjectUserId)).toEqual([]);
  }

  it('refuses an envelope of the wrong type', async () => {
    const voucher = await makeSeedVoucher();
    const subjectUserId = await makeAccount();
    const envelope = vouchEnvelope(voucher, {
      about: buildUserDid(subjectUserId),
      type: 'identity',
    });

    expect(await vouchForPerson(envelope, voucher.userId)).toEqual({
      ok: false,
      reason: 'invalid_type',
    });
    await expectNothingWritten(voucher.userId, subjectUserId);
  });

  it('refuses an envelope the caller did not self-issue', async () => {
    const voucher = await makeSeedVoucher();
    const subjectUserId = await makeAccount();
    // Signed by the voucher but claiming the SUBJECT as its chain subject.
    const envelope = vouchEnvelope(voucher, {
      about: buildUserDid(subjectUserId),
      subject: buildUserDid(subjectUserId),
      issuer: buildUserDid(subjectUserId),
    });

    expect(await vouchForPerson(envelope, voucher.userId)).toEqual({
      ok: false,
      reason: 'not_self_issued',
    });
    await expectNothingWritten(voucher.userId, subjectUserId);
  });

  it('refuses a self-vouch', async () => {
    const voucher = await makeSeedVoucher();
    const envelope = vouchEnvelope(voucher, { about: voucher.did });

    expect(await vouchForPerson(envelope, voucher.userId)).toEqual({
      ok: false,
      reason: 'self_vouch',
    });
    await expectNothingWritten(voucher.userId, voucher.userId);
  });

  it('refuses a subject reference that is not a user DID', async () => {
    const voucher = await makeSeedVoucher();
    const envelope = vouchEnvelope(voucher, { about: 'not-a-did' });

    expect(await vouchForPerson(envelope, voucher.userId)).toEqual({
      ok: false,
      reason: 'invalid_subject',
    });
    expect(await chainRows(voucher.userId)).toEqual([]);
  });

  it('refuses a record payload missing `about`', async () => {
    const voucher = await makeSeedVoucher();
    const envelope = signRecordEnvelope(
      {
        version: 2,
        type: 'personhood_vouch',
        subject: voucher.did,
        issuer: voucher.did,
        record: { context: 'no subject here' },
        issuedAt: Date.now(),
        seq: 0,
        prev: null,
        collection: 'app.oxy.personhood',
        rkey: 'vouch-1',
        publicKey: voucher.publicKey,
        alg: 'ES256K-DER-SHA256',
      },
      voucher.privateKey,
    );

    expect(await vouchForPerson(envelope, voucher.userId)).toEqual({
      ok: false,
      reason: 'invalid_record',
    });
    expect(await chainRows(voucher.userId)).toEqual([]);
  });

  it('refuses a TAMPERED envelope before any graph or chain work', async () => {
    const voucher = await makeSeedVoucher();
    const subjectUserId = await makeAccount();
    const signed = vouchEnvelope(voucher, { about: buildUserDid(subjectUserId) });
    // The signature covers the record; swapping the stake after signing breaks it.
    const tampered: SignedRecordEnvelope = {
      ...signed,
      record: { ...(signed.record as Record<string, unknown>), stake: 99 },
    };

    expect(await vouchForPerson(tampered, voucher.userId)).toEqual({
      ok: false,
      reason: 'bad_signature',
    });
    await expectNothingWritten(voucher.userId, subjectUserId);
  });

  it('refuses a signature made by a key that is not a current verification method', async () => {
    const voucher = await makeSeedVoucher();
    const subjectUserId = await makeAccount();
    const stranger = generateSecp256k1KeyPair();
    // A well-formed, correctly-signed envelope — signed by the WRONG key. The
    // signature check passes; the resolver's current-VM check is what refuses it.
    const envelope = vouchEnvelope(
      {
        ...voucher,
        publicKey: stranger.publicKey,
        privateKey: stranger.privateKey,
      },
      { about: buildUserDid(subjectUserId) },
    );

    const result = await vouchForPerson(envelope, voucher.userId);
    expect(result.ok).toBe(false);
    await expectNothingWritten(voucher.userId, subjectUserId);
  });

  it('refuses a v1 (UNCHAINED) envelope — its address would name no stored row', async () => {
    // The root cause the foreign key now makes unrepresentable: a v1 append
    // stores no `record_id`, so `personhood_vouches.record_id` would dangle.
    const voucher = await makeSeedVoucher();
    const subjectUserId = await makeAccount();
    const envelope = vouchEnvelope(voucher, {
      about: buildUserDid(subjectUserId),
      version: 1,
    });

    expect(await vouchForPerson(envelope, voucher.userId)).toEqual({
      ok: false,
      reason: 'invalid_envelope',
    });
    await expectNothingWritten(voucher.userId, subjectUserId);
  });

  it('refuses a vouch about an account that does not exist', async () => {
    const voucher = await makeSeedVoucher();
    const envelope = vouchEnvelope(voucher, { about: buildUserDid(uniqueId()) });

    expect(await vouchForPerson(envelope, voucher.userId)).toEqual({
      ok: false,
      reason: 'subject_not_found',
    });
    expect(await chainRows(voucher.userId)).toEqual([]);
  });

  it('refuses a voucher who is not themselves a real person', async () => {
    // Not a seed verifier and with no evidence of their own, so their recomputed
    // score is 0 — below τ. The control is every accepted case above, whose
    // voucher differs from this one ONLY in `isSeedVerifier`.
    const voucher = await makeSigner();
    const subjectUserId = await makeAccount();

    expect(
      await vouchForPerson(
        vouchEnvelope(voucher, { about: buildUserDid(subjectUserId) }),
        voucher.userId,
      ),
    ).toEqual({ ok: false, reason: 'voucher_below_threshold' });
    await expectNothingWritten(voucher.userId, subjectUserId);
  });

  it('refuses a voucher who is a graph neighbour of the subject', async () => {
    const voucher = await makeSeedVoucher();
    const subjectUserId = await makeAccount();
    await getDb()
      .insert(userFollows)
      .values({ followerId: subjectUserId, followedId: voucher.userId });

    expect(
      await vouchForPerson(
        vouchEnvelope(voucher, { about: buildUserDid(subjectUserId) }),
        voucher.userId,
      ),
    ).toEqual({ ok: false, reason: 'excluded_graph_neighbor' });
    await expectNothingWritten(voucher.userId, subjectUserId);
  });

  it('refuses a voucher who shares an active-session device with the subject', async () => {
    const voucher = await makeSeedVoucher();
    const subjectUserId = await makeAccount();
    const deviceId = `dev-${uniqueId()}`;
    await seedSession(voucher.userId, deviceId);
    await seedSession(subjectUserId, deviceId);

    expect(
      await vouchForPerson(
        vouchEnvelope(voucher, { about: buildUserDid(subjectUserId) }),
        voucher.userId,
      ),
    ).toEqual({ ok: false, reason: 'excluded_shared_device' });
    await expectNothingWritten(voucher.userId, subjectUserId);
  });

  it('refuses a re-vouch after the pair’s earlier vouch was WITHDRAWN', async () => {
    // The discriminating fixture: the partial unique index only covers `active`
    // rows, so a withdrawn one does not collide. Only the service's deliberately
    // BROADER historical lookup stops the withdraw/re-vouch reputation farm.
    const voucher = await makeSeedVoucher();
    const subjectUserId = await makeAccount();
    const first = await vouchForPerson(
      vouchEnvelope(voucher, { about: buildUserDid(subjectUserId) }),
      voucher.userId,
    );
    expect(first.ok).toBe(true);
    expect(await withdrawVouch(voucher.userId, subjectUserId)).toEqual({ ok: true });

    const second = await vouchForPerson(
      vouchEnvelope(voucher, {
        about: buildUserDid(subjectUserId),
        seq: 1,
        prev: first.ok ? first.recordId : null,
        rkey: 'vouch-again',
      }),
      voucher.userId,
    );
    expect(second).toEqual({ ok: false, reason: 'already_vouched' });

    // The refusal banked no second award and appended no second record.
    expect(await ledgerRows(subjectUserId)).toHaveLength(1);
    expect(await chainRows(voucher.userId)).toHaveLength(1);
    expect(await vouchRows(subjectUserId)).toHaveLength(1);
  });
});

describe('recomputePersonhood — the evidence formula over stored rows', () => {
  it('keeps a SATURATED vouch signal below θ on its own', async () => {
    // Three `verified` vouchers = weight 3.0 = `PERSONHOOD_VOUCH_TARGET`, so the
    // vouch axis is fully saturated. Evidence is still only 0.50 < 0.60. This is
    // the anti-single-point-of-trust property; a formula that ignored the
    // component weights would promote this account.
    const subjectUserId = await makeAccount();
    await seedActiveVouch(subjectUserId, 'verified');
    await seedActiveVouch(subjectUserId, 'verified');
    await seedActiveVouch(subjectUserId, 'verified');

    const status = await recomputePersonhood(subjectUserId);

    expect(status.breakdownVouchSignal).toBeCloseTo(1, 10);
    expect(status.breakdownEvidence).toBeCloseTo(0.5, 10);
    expect(status.score).toBeCloseTo(0.5, 10);
    expect(status.score).toBeLessThan(PERSONHOOD_THRESHOLD);
    expect(status.isRealPerson).toBe(false);
    expect(await isUserVerified(subjectUserId)).toBe(false);
  });

  it('keeps a SATURATED real-life + biometric pair below θ too', async () => {
    // The other worked point: 0.35 + 0.15 = 0.50 < θ. Two independent signal
    // classes are required, and these two are not enough by themselves.
    const subjectUserId = await makeAccount();
    await reputationService.award({
      userId: subjectUserId,
      actionType: REAL_LIFE_ATTESTED_ACTION,
      sourceActionId: `rl-${uniqueId()}`,
      metadata: { biometricOk: true },
    });
    await reputationService.award({
      userId: subjectUserId,
      actionType: REAL_LIFE_ATTESTED_ACTION,
      sourceActionId: `rl-${uniqueId()}`,
      metadata: { biometricOk: true },
    });

    const status = await recomputePersonhood(subjectUserId);

    expect(status.realLifeCount).toBe(2);
    expect(status.biometricBound).toBe(true);
    expect(status.breakdownRealLifeSignal).toBeCloseTo(1, 10);
    expect(status.breakdownVouchSignal).toBe(0);
    expect(status.score).toBeCloseTo(0.5, 10);
    expect(status.isRealPerson).toBe(false);
  });

  it('crosses θ once TWO signal classes are present, and mirrors onto users.verified', async () => {
    const subjectUserId = await makeAccount();
    await seedActiveVouch(subjectUserId, 'verified');
    await seedActiveVouch(subjectUserId, 'verified');
    await seedActiveVouch(subjectUserId, 'verified');
    await reputationService.award({
      userId: subjectUserId,
      actionType: REAL_LIFE_ATTESTED_ACTION,
      sourceActionId: `rl-${uniqueId()}`,
      metadata: { biometricOk: true },
    });

    const status = await recomputePersonhood(subjectUserId);

    // 0.50·1 + 0.35·0.5 + 0.15·1
    expect(status.score).toBeCloseTo(0.825, 10);
    expect(status.isRealPerson).toBe(true);
    expect(await isUserVerified(subjectUserId)).toBe(true);
  });

  it('does NOT read a non-biometric attestation as a biometric signal', async () => {
    // The metadata gate is jsonb CONTAINMENT, not a text compare: a real-life
    // attestation with no biometric flag must contribute the real-life axis and
    // nothing else.
    const subjectUserId = await makeAccount();
    await reputationService.award({
      userId: subjectUserId,
      actionType: REAL_LIFE_ATTESTED_ACTION,
      sourceActionId: `rl-${uniqueId()}`,
      metadata: { biometricOk: false },
    });

    const status = await recomputePersonhood(subjectUserId);
    expect(status.realLifeCount).toBe(1);
    expect(status.biometricBound).toBe(false);
    expect(status.breakdownBiometricSignal).toBe(0);
  });

  it('weights a voucher by their trust tier', async () => {
    const verifiedSubject = await makeAccount();
    await seedActiveVouch(verifiedSubject, 'verified');
    const trustedSubject = await makeAccount();
    await seedActiveVouch(trustedSubject, 'trusted');
    const unrankedSubject = await makeAccount();
    await seedActiveVouch(unrankedSubject);

    expect((await recomputePersonhood(verifiedSubject)).breakdownVouchSignal).toBeCloseTo(
      VOUCH_TIER_WEIGHT.verified / PERSONHOOD_VOUCH_TARGET,
      10,
    );
    expect((await recomputePersonhood(trustedSubject)).breakdownVouchSignal).toBeCloseTo(
      VOUCH_TIER_WEIGHT.trusted / PERSONHOOD_VOUCH_TARGET,
      10,
    );
    // A voucher with no balance snapshot yet counts as the `new` tier.
    expect((await recomputePersonhood(unrankedSubject)).breakdownVouchSignal).toBeCloseTo(
      VOUCH_TIER_WEIGHT.new / PERSONHOOD_VOUCH_TARGET,
      10,
    );
  });

  it('counts ACTIVE vouches only', async () => {
    const subjectUserId = await makeAccount();
    const staying = await seedActiveVouch(subjectUserId, 'verified');
    const leaving = await seedActiveVouch(subjectUserId, 'verified');
    await getDb()
      .update(personhoodVouches)
      .set({ status: 'withdrawn' })
      .where(
        and(
          eq(personhoodVouches.voucherUserId, leaving),
          eq(personhoodVouches.subjectUserId, subjectUserId),
        ),
      );

    const status = await recomputePersonhood(subjectUserId);
    expect(status.vouchCount).toBe(1);
    expect(status.breakdownVouchSignal).toBeCloseTo(
      VOUCH_TIER_WEIGHT.verified / PERSONHOOD_VOUCH_TARGET,
      10,
    );
    // …and the row that stopped counting is still there as history.
    expect((await vouchRows(subjectUserId)).map((row) => row.voucherUserId).sort()).toEqual(
      [staying, leaving].sort(),
    );
  });

  it('attenuates the score MULTIPLICATIVELY when the vouchers cluster on one device', async () => {
    // Two vouchers sharing an active-session device id — a farm signature. The
    // penalty scales the evidence rather than being subtracted from it, so the
    // vouch axis being saturated cannot buy it off.
    const subjectUserId = await makeAccount();
    const first = await seedActiveVouch(subjectUserId, 'verified');
    const second = await seedActiveVouch(subjectUserId, 'verified');
    const deviceId = `dev-${uniqueId()}`;
    await seedSession(first, deviceId);
    await seedSession(second, deviceId);

    const status = await recomputePersonhood(subjectUserId);

    expect(status.sybilPenalty).toBeGreaterThan(0);
    expect(status.breakdownSybilPenalty).toBe(status.sybilPenalty);
    expect(status.score).toBeCloseTo(
      status.breakdownEvidence * (1 - status.sybilPenalty),
      10,
    );
    expect(status.score).toBeLessThan(status.breakdownEvidence);
  });

  it('short-circuits a seed verifier to 1 without aggregating any evidence', async () => {
    const seed = await makeSigner({ isSeedVerifier: true });
    // Evidence that would be aggregated if the short-circuit did not fire.
    await seedActiveVouch(seed.userId, 'verified');

    const status = await recomputePersonhood(seed.userId);

    expect(status.score).toBe(1);
    expect(status.isRealPerson).toBe(true);
    expect(status.breakdownSeed).toBe(true);
    // The aggregation was skipped entirely, so the counters stay at zero even
    // though a real vouch row exists.
    expect(status.vouchCount).toBe(0);
    expect(status.realLifeCount).toBe(0);
    expect(await isUserVerified(seed.userId)).toBe(true);
  });

  it('is idempotent — a second recompute with the same inputs upserts the same row', async () => {
    const subjectUserId = await makeAccount();
    await seedActiveVouch(subjectUserId, 'verified');

    const first = await recomputePersonhood(subjectUserId);
    const second = await recomputePersonhood(subjectUserId);

    expect(second.id).toBe(first.id);
    expect(second.score).toBe(first.score);
    const rows = await getDb()
      .select({ id: personhoodStatuses.id })
      .from(personhoodStatuses)
      .where(eq(personhoodStatuses.userId, subjectUserId));
    expect(rows).toHaveLength(1);
  });
});

describe('recomputePersonhood — the verified mirror only fires on a CHANGE', () => {
  it('leaves the account untouched when the verdict is unchanged', async () => {
    // No evidence, `users.verified` already false. The observable for "the
    // downstream recompute did not run" is that no balance row exists:
    // `recalculateBalance` upserts one unconditionally.
    const subjectUserId = await makeAccount();

    const status = await recomputePersonhood(subjectUserId);

    expect(status.isRealPerson).toBe(false);
    expect(await isUserVerified(subjectUserId)).toBe(false);
    expect(await balanceRows(subjectUserId)).toEqual([]);
  });

  it('flips the flag and recalculates the balance when the verdict changes', async () => {
    // The control for the case above, differing only in the verdict: the SAME
    // assertions now expect the write to have happened.
    const seed = await makeSigner({ isSeedVerifier: true });

    const status = await recomputePersonhood(seed.userId);

    expect(status.isRealPerson).toBe(true);
    expect(await isUserVerified(seed.userId)).toBe(true);
    expect(await balanceRows(seed.userId)).toHaveLength(1);
  });

  it('demotes an account whose evidence no longer clears θ', async () => {
    const subjectUserId = await makeAccount({ verified: true });
    // Nothing supports the flag, so the mirror must take it away.
    const status = await recomputePersonhood(subjectUserId);

    expect(status.isRealPerson).toBe(false);
    expect(await isUserVerified(subjectUserId)).toBe(false);
  });
});

describe('withdrawVouch', () => {
  it('flips the vouch to withdrawn and drops it from the subject’s signal', async () => {
    const voucher = await makeSeedVoucher();
    const subjectUserId = await makeAccount();
    await vouchForPerson(
      vouchEnvelope(voucher, { about: buildUserDid(subjectUserId) }),
      voucher.userId,
    );
    expect((await personhoodRow(subjectUserId)).vouchCount).toBe(1);

    expect(await withdrawVouch(voucher.userId, subjectUserId)).toEqual({ ok: true });

    const rows = await vouchRows(subjectUserId);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('withdrawn');
    // The subject was recomputed, so the withdrawn vouch stopped counting.
    expect((await personhoodRow(subjectUserId)).vouchCount).toBe(0);
  });

  it('reports not_found when there is no ACTIVE vouch for the pair', async () => {
    const voucher = await makeSeedVoucher();
    const subjectUserId = await makeAccount();
    expect(await withdrawVouch(voucher.userId, subjectUserId)).toEqual({
      ok: false,
      reason: 'not_found',
    });
  });
});

describe('slashVouchersForFakeSubject', () => {
  it('penalises every ACTIVE voucher, flips their vouch, and leaves history alone', async () => {
    const subjectUserId = await makeAccount();
    const slashed = await seedActiveVouch(subjectUserId, 'verified');
    const alreadyGone = await seedActiveVouch(subjectUserId, 'verified');
    await getDb()
      .update(personhoodVouches)
      .set({ status: 'withdrawn' })
      .where(
        and(
          eq(personhoodVouches.voucherUserId, alreadyGone),
          eq(personhoodVouches.subjectUserId, subjectUserId),
        ),
      );

    const count = await slashVouchersForFakeSubject(subjectUserId, 'Failed an audit');

    expect(count).toBe(1);
    expect(await ledgerRows(slashed)).toEqual([
      { actionType: VOUCH_SLASHED_ACTION, points: VOUCH_SLASHED_POINTS },
    ]);
    // The withdrawn voucher was NOT slashed — they had already pulled the stake.
    expect(await ledgerRows(alreadyGone)).toEqual([]);

    const byVoucher = new Map(
      (await vouchRows(subjectUserId)).map((row) => [row.voucherUserId, row.status]),
    );
    expect(byVoucher.get(slashed)).toBe('slashed');
    expect(byVoucher.get(alreadyGone)).toBe('withdrawn');

    // The subject lost their vouch signal in the same pass.
    expect((await personhoodRow(subjectUserId)).vouchCount).toBe(0);
  });

  it('is a no-op for a subject nobody vouched for', async () => {
    const subjectUserId = await makeAccount();
    expect(await slashVouchersForFakeSubject(subjectUserId, 'Failed an audit')).toBe(0);
    // …but the subject is still recomputed, so a status row exists.
    expect(await personhoodRow(subjectUserId)).toBeDefined();
  });
});
