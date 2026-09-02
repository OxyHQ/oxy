/**
 * The validator jury (civic / Fase 2 Part B), against a REAL Postgres.
 *
 * The suite this replaces mocked seven Mongoose models the service no longer
 * imports, handed `tallyAndResolve` a hand-built document with a `save()` spy,
 * and then asserted on the arguments a mocked `award` was called with. None of
 * that could observe the three things the port actually moved into the database:
 *
 *  1. **"One open jury per source action" is a CONSTRAINT again.**
 *     `unique (source_action_id) where status in ('pending','quorum_met')`.
 *     Mongo could not express it, so `openValidationRequest` paid with a
 *     check-then-act window in which two callers each opened a jury for one
 *     action and both could only expire. The race is driven concurrently below,
 *     and the partial-ness is checked too: a CLOSED request must free the slot.
 *  2. **The jury is a junction table with real foreign keys**, and the draw
 *     ORDER is stored. A seat can no longer name an account that does not exist.
 *  3. **A vote's `record_id` is a foreign key onto a stored signed record**, so
 *     the verdict a tally counts is always one whose proof can be re-verified.
 *
 * Two shapes recur deliberately. Every rejection asserts the reason AND that no
 * vote row and no chain record appeared — a vote refused after it was stored is
 * a different bug from one refused before. And the resolution cases assert the
 * LEDGER: `rejected` awards nothing at all, which is what tells a real tally
 * from one that awards on every terminal outcome.
 *
 * `selectValidators` reads a GLOBAL pool (every balance in a jury-eligible
 * tier), so its cases assert membership of `candidateSnapshot` — which contains
 * every surviving candidate — rather than counts, and never depend on the pool
 * containing only this test's accounts.
 */

import { generateSecp256k1KeyPair } from '@oxyhq/protocol/secp256k1';
import { createHash, randomUUID } from 'node:crypto';
import { and, eq, inArray } from 'drizzle-orm';
import { canonicalize } from '@oxyhq/protocol';
import type { SignedRecordEnvelope, ValidationVerdict } from '@oxyhq/contracts';
import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { personhoodVouches } from '../../db/schema/personhoodVouches';
import { reputationBalances } from '../../db/schema/reputationBalances';
import { reputationTransactions } from '../../db/schema/reputationTransactions';
import { sessions } from '../../db/schema/sessions';
import { signedRecords } from '../../db/schema/signedRecords';
import {
  validationRequestValidators,
  validationRequests,
} from '../../db/schema/validationRequests';
import { validationVotes } from '../../db/schema/validationVotes';
import { validatorAffinities } from '../../db/schema/validatorAffinities';
import { userFollows } from '../../db/schema/userFollows';
import { users } from '../../db/schema/users';
import { buildUserDid } from '../did.service';
import { signRecordEnvelope, verifyAndStoreRecord } from '../signedRecord.service';
import { reputationService } from '../reputation.service';
import {
  denyValidation,
  getValidationRequest,
  getValidatorInbox,
  openValidationRequest,
  selectValidators,
  submitVote,
  sweepValidations,
  tallyAndResolve,
} from '../civic/validator.service';
import {
  AFFINITY_MAX_COVOTES,
  PERSONHOOD_AUDIT_ACTION,
  PERSONHOOD_VOUCH_DEFAULT_STAKE,
  VALIDATOR_COUNT,
  VALIDATOR_QUORUM,
  VALIDATOR_SUPERMAJORITY,
} from '../../utils/civic.constants';
import {
  PEER_VALIDATED_ACTION,
  PEER_VALIDATED_POINTS,
  VALIDATION_CORRECT_ACTION,
} from '../../utils/reputation.constants';

const uniqueId = () => randomUUID().replace(/-/g, '');

/**
 * How many consecutive draws the determinism case may take while waiting for
 * two of them to observe the same (globally shared) candidate pool.
 */
const POOL_STABILITY_ATTEMPTS = 8;

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
    .values({ id, username: `v${id.slice(0, 12)}`, publicKey, ...overrides });
  return { userId: id, did: buildUserDid(id), publicKey, privateKey: keyPair.privateKey };
}

async function makeAccount(): Promise<string> {
  const id = uniqueId();
  await getDb().insert(users).values({ id, username: `s${id.slice(0, 12)}` });
  return id;
}

/** A signer who is ALSO in the jury-eligible pool at the given tier. */
async function makeEligible(
  trustTier: typeof reputationBalances.$inferInsert['trustTier'] = 'verified',
): Promise<Signer> {
  const signer = await makeSigner();
  await getDb().insert(reputationBalances).values({ userId: signer.userId, trustTier });
  return signer;
}

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

interface OpenedRequest {
  id: string;
  payloadHash: string;
}

/** Open a jury request for a subject with a per-test-unique source action. */
async function openRequest(
  subjectUserId: string,
  options: { actionType?: string; sourceActionId?: string; highValue?: boolean } = {},
): Promise<OpenedRequest> {
  const request = await openValidationRequest({
    subjectUserId,
    actionType: options.actionType ?? 'real_life_attested',
    sourceActionId: options.sourceActionId ?? `src-${uniqueId()}`,
    payload: { kind: 'probe', nonce: uniqueId() },
    highValue: options.highValue,
  });
  return { id: request.id, payloadHash: request.payloadHash };
}

/**
 * Replace a request's drawn jury with a known panel.
 *
 * `selectValidators` draws from a pool every suite in the run contributes to, so
 * the vote and tally cases seat their OWN jurors rather than trying to predict
 * the draw. The draw itself is what the `selectValidators` block asserts.
 */
async function setJury(requestId: string, jurorIds: string[]): Promise<void> {
  await getDb()
    .delete(validationRequestValidators)
    .where(eq(validationRequestValidators.requestId, requestId));
  await getDb()
    .insert(validationRequestValidators)
    .values(jurorIds.map((userId, position) => ({ requestId, userId, position })));
}

/** Build + REAL-sign a juror's v2 `validation_verdict` envelope. */
function verdictEnvelope(
  juror: Signer,
  requestId: string,
  payloadHash: string,
  verdict: ValidationVerdict,
  overrides: {
    type?: SignedRecordEnvelope['type'];
    subject?: string;
    issuer?: string;
    recordRequestId?: string;
    recordPayloadHash?: string;
    seq?: number;
    prev?: string | null;
  } = {},
): SignedRecordEnvelope {
  return signRecordEnvelope(
    {
      version: 2,
      type: overrides.type ?? 'validation_verdict',
      subject: overrides.subject ?? juror.did,
      issuer: overrides.issuer ?? juror.did,
      record: {
        requestId: overrides.recordRequestId ?? requestId,
        payloadHash: overrides.recordPayloadHash ?? payloadHash,
        verdict,
      },
      issuedAt: Date.now(),
      seq: overrides.seq ?? 0,
      prev: overrides.prev ?? null,
      collection: 'app.oxy.validation',
      rkey: requestId,
      publicKey: juror.publicKey,
      alg: 'ES256K-DER-SHA256',
    },
    juror.privateKey,
  );
}

async function voteRows(requestId: string) {
  return getDb()
    .select({
      validatorUserId: validationVotes.validatorUserId,
      verdict: validationVotes.verdict,
      recordId: validationVotes.recordId,
    })
    .from(validationVotes)
    .where(eq(validationVotes.requestId, requestId));
}

async function chainRows(userId: string) {
  return getDb()
    .select({ recordId: signedRecords.recordId })
    .from(signedRecords)
    .where(eq(signedRecords.userId, userId));
}

async function ledgerRows(userId: string) {
  return getDb()
    .select({
      actionType: reputationTransactions.actionType,
      points: reputationTransactions.points,
      sourceActionId: reputationTransactions.sourceActionId,
    })
    .from(reputationTransactions)
    .where(eq(reputationTransactions.userId, userId));
}

async function requestRow(requestId: string) {
  const [row] = await getDb()
    .select()
    .from(validationRequests)
    .where(eq(validationRequests.id, requestId))
    .limit(1);
  return row;
}

/** Force a request past its deadline without waiting 48 hours. */
async function expireRequest(requestId: string): Promise<void> {
  await getDb()
    .update(validationRequests)
    .set({ expiresAt: new Date(Date.now() - 1_000) })
    .where(eq(validationRequests.id, requestId));
}

/** An active vouch backed by a real signed record, for the slash-cascade case. */
async function seedActiveVouch(subjectUserId: string): Promise<string> {
  const voucher = await makeSigner();
  const envelope = signRecordEnvelope(
    {
      version: 2,
      type: 'personhood_vouch',
      subject: voucher.did,
      issuer: voucher.did,
      record: { about: buildUserDid(subjectUserId), context: 'met-in-person' },
      issuedAt: Date.now(),
      seq: 0,
      prev: null,
      collection: 'app.oxy.personhood',
      rkey: `vouch-${uniqueId().slice(0, 8)}`,
      publicKey: voucher.publicKey,
      alg: 'ES256K-DER-SHA256',
    },
    voucher.privateKey,
  );
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

beforeAll(async () => {
  await connectPostgres();
  await reputationService.seedDefaultRules();
});

afterAll(async () => {
  await closePostgres();
});

describe('selectValidators — who is even allowed in the pool', () => {
  it('never places the subject on their own jury, even when they are jury-eligible', async () => {
    const subject = await makeEligible();
    const peer = await makeEligible();

    const selection = await selectValidators(subject.userId, { rngSeed: `seed-${uniqueId()}` });

    // `candidateSnapshot` is every surviving candidate, so this is a statement
    // about the POOL rather than about who happened to win the draw.
    const candidateIds = selection.candidateSnapshot.map((candidate) => candidate.userId);
    expect(candidateIds).not.toContain(subject.userId);
    expect(candidateIds).toContain(peer.userId);
    expect(selection.validatorIds).not.toContain(subject.userId);
    expect(selection.validatorIds.length).toBeLessThanOrEqual(VALIDATOR_COUNT);
  });

  it('drops a graph-related candidate while keeping an unrelated one', async () => {
    const subject = await makeAccount();
    const neighbour = await makeEligible();
    const stranger = await makeEligible();
    await getDb()
      .insert(userFollows)
      .values({ followerId: neighbour.userId, followedId: subject });

    const { candidateSnapshot } = await selectValidators(subject, { rngSeed: `seed-${uniqueId()}` });

    const candidateIds = candidateSnapshot.map((candidate) => candidate.userId);
    // The PAIR is the assertion: an exclusion rule that dropped everyone, or
    // nobody, fails one half of it.
    expect(candidateIds).not.toContain(neighbour.userId);
    expect(candidateIds).toContain(stranger.userId);
  });

  it('drops a candidate who shares an active-session device with the subject', async () => {
    const subject = await makeAccount();
    const roommate = await makeEligible();
    const stranger = await makeEligible();
    const deviceId = `dev-${uniqueId()}`;
    await seedSession(subject, deviceId);
    await seedSession(roommate.userId, deviceId);

    const { candidateSnapshot } = await selectValidators(subject, { rngSeed: `seed-${uniqueId()}` });

    const candidateIds = candidateSnapshot.map((candidate) => candidate.userId);
    expect(candidateIds).not.toContain(roommate.userId);
    expect(candidateIds).toContain(stranger.userId);
  });

  it('weights a candidate by their trust tier', async () => {
    const subject = await makeAccount();
    const verified = await makeEligible('verified');
    const high = await makeEligible('high_trust');
    const trusted = await makeEligible('trusted');

    const { candidateSnapshot } = await selectValidators(subject, { rngSeed: `seed-${uniqueId()}` });
    const weightOf = (userId: string) =>
      candidateSnapshot.find((candidate) => candidate.userId === userId)?.weight;

    expect(weightOf(verified.userId)).toBe(2);
    expect(weightOf(high.userId)).toBe(1.5);
    expect(weightOf(trusted.userId)).toBe(1);
  });

  it('reproduces the SAME draw from the stored rng seed — the audit guarantee', async () => {
    const subject = await makeAccount();
    for (let i = 0; i < 8; i += 1) {
      await makeEligible();
    }
    const rngSeed = `fixed-${uniqueId()}`;
    const poolOf = (selection: Awaited<ReturnType<typeof selectValidators>>) =>
      JSON.stringify(selection.candidateSnapshot);

    // The eligible pool is GLOBAL and every suite in the run adds to it, so a
    // pair of draws that straddles another suite's insert is a stale
    // MEASUREMENT, not a non-deterministic selection. Consecutive draws are
    // chained until two of them saw the SAME pool; only then is the draw held to
    // being identical — which is what the stored `rng_seed` promises an auditor.
    let first = await selectValidators(subject, { rngSeed });
    let second = await selectValidators(subject, { rngSeed });
    for (let attempt = 0; attempt < POOL_STABILITY_ATTEMPTS && poolOf(first) !== poolOf(second); attempt += 1) {
      first = second;
      second = await selectValidators(subject, { rngSeed });
    }

    expect(poolOf(second)).toBe(poolOf(first));
    expect(second.validatorIds).toEqual(first.validatorIds);
    expect(first.rngSeed).toBe(rngSeed);
    expect(first.validatorIds).toHaveLength(VALIDATOR_COUNT);
  });

  it('skips a candidate who has co-voted too often with an already-drawn juror', async () => {
    const subject = await makeAccount();
    for (let i = 0; i < 8; i += 1) {
      await makeEligible();
    }
    const rngSeed = `affinity-${uniqueId()}`;

    // The draw is over a shared pool, so the throttled pair is taken FROM the
    // baseline draw rather than assumed: whoever came first and second are, by
    // construction, both selected without an affinity edge between them.
    const baseline = await selectValidators(subject, { rngSeed });
    const [first, second] = baseline.validatorIds;
    expect(second).toBeDefined();

    const pair =
      first < second
        ? { validatorA: first, validatorB: second }
        : { validatorA: second, validatorB: first };
    await getDb()
      .insert(validatorAffinities)
      .values({ ...pair, coVoteCount: AFFINITY_MAX_COVOTES, lastCoVoteAt: new Date() });
    try {
      const throttled = await selectValidators(subject, { rngSeed });
      expect(throttled.validatorIds).toContain(first);
      expect(throttled.validatorIds).not.toContain(second);
      // …and it was SKIPPED, not excluded: it is still an eligible candidate,
      // and the panel filled up behind it. Without both, a candidate that simply
      // fell out of the draw would read as a throttled one.
      expect(throttled.candidateSnapshot.map((candidate) => candidate.userId)).toContain(second);
      expect(throttled.validatorIds).toHaveLength(VALIDATOR_COUNT);
    } finally {
      // The pool is shared; leave no edge behind that would skew another draw.
      await getDb()
        .delete(validatorAffinities)
        .where(
          and(
            eq(validatorAffinities.validatorA, pair.validatorA),
            eq(validatorAffinities.validatorB, pair.validatorB),
          ),
        );
    }
  });
});

describe('openValidationRequest — one open jury per source action', () => {
  it('stores the request, its jury seats in draw order, and the audit trail', async () => {
    const subject = await makeAccount();
    for (let i = 0; i < 6; i += 1) {
      await makeEligible();
    }
    const sourceActionId = `src-${uniqueId()}`;
    const payload = { kind: 'probe', nonce: uniqueId() };

    const request = await openValidationRequest({
      subjectUserId: subject,
      actionType: 'real_life_attested',
      sourceActionId,
      payload,
    });

    const stored = await requestRow(request.id);
    expect(stored).toMatchObject({
      subjectUserId: subject,
      actionType: 'real_life_attested',
      sourceActionId,
      status: 'pending',
      quorum: VALIDATOR_QUORUM,
      threshold: VALIDATOR_QUORUM,
      highValue: false,
      outcome: null,
      resolvedTxnId: null,
    });
    expect(stored.payload).toEqual(payload);
    // The signed verdict binds to THIS hash, so it must be the canonical digest
    // of the payload rather than of whatever the caller happened to send.
    expect(stored.payloadHash).toBe(
      createHash('sha256').update(canonicalize(payload)).digest('hex'),
    );
    expect(stored.rngSeed).toHaveLength(64);
    expect(stored.expiresAt.getTime()).toBeGreaterThan(Date.now());
    expect(stored.candidateSnapshot.length).toBeGreaterThan(0);

    const seats = await getDb()
      .select({
        userId: validationRequestValidators.userId,
        position: validationRequestValidators.position,
      })
      .from(validationRequestValidators)
      .where(eq(validationRequestValidators.requestId, request.id));
    expect(seats).toHaveLength(request.selectedValidatorIds.length);
    expect(request.selectedValidatorIds).toHaveLength(VALIDATOR_COUNT);
    // The draw ORDER is preserved — it is part of what `rng_seed` +
    // `candidate_snapshot` let an auditor reproduce.
    expect(
      seats.sort((a, b) => a.position - b.position).map((seat) => seat.userId),
    ).toEqual(request.selectedValidatorIds);
  });

  it('returns the existing jury rather than opening a second one', async () => {
    const subject = await makeAccount();
    await makeEligible();
    const sourceActionId = `src-${uniqueId()}`;

    const first = await openRequest(subject, { sourceActionId });
    const second = await openRequest(subject, { sourceActionId });

    expect(second.id).toBe(first.id);
    const rows = await getDb()
      .select({ id: validationRequests.id })
      .from(validationRequests)
      .where(eq(validationRequests.sourceActionId, sourceActionId));
    expect(rows).toHaveLength(1);
  });

  it('answers a CONCURRENT caller with the winner’s request — the index, not the lookup', async () => {
    // Both callers pass the friendly `findOne` (neither sees the other's row
    // yet) and race into the insert. Under Mongo this split one action's jury
    // across two requests that could each only expire.
    const subject = await makeAccount();
    await makeEligible();
    const sourceActionId = `src-${uniqueId()}`;

    const [a, b] = await Promise.all([
      openRequest(subject, { sourceActionId }),
      openRequest(subject, { sourceActionId }),
    ]);

    expect(a.id).toBe(b.id);
    const rows = await getDb()
      .select({ id: validationRequests.id })
      .from(validationRequests)
      .where(eq(validationRequests.sourceActionId, sourceActionId));
    expect(rows).toHaveLength(1);
  });

  it('frees the dedup slot once the request CLOSES', async () => {
    // The index is partial on the two OPEN statuses. A plain unique would make
    // an action unreviewable for ever after its first jury lapsed.
    const subject = await makeAccount();
    await makeEligible();
    const sourceActionId = `src-${uniqueId()}`;

    const first = await openRequest(subject, { sourceActionId });
    await expireRequest(first.id);
    expect(await tallyAndResolve(first.id)).toBe('expired');

    const second = await openRequest(subject, { sourceActionId });
    expect(second.id).not.toBe(first.id);
  });

  it('raises the winning threshold to a supermajority for a high-value claim', async () => {
    const subject = await makeAccount();
    await makeEligible();

    const request = await openRequest(subject, { highValue: true });

    const stored = await requestRow(request.id);
    expect(stored.highValue).toBe(true);
    expect(stored.threshold).toBe(VALIDATOR_SUPERMAJORITY);
    expect(stored.quorum).toBe(VALIDATOR_QUORUM);
  });
});

describe('submitVote — a verdict is a signed record before it is a row', () => {
  it('stores the verdict on the juror’s own chain and counts it', async () => {
    const subject = await makeAccount();
    const juror = await makeEligible();
    const request = await openRequest(subject);
    await setJury(request.id, [juror.userId]);

    const result = await submitVote(
      request.id,
      juror.userId,
      verdictEnvelope(juror, request.id, request.payloadHash, 'valid'),
    );

    expect(result).toMatchObject({ ok: true, verdict: 'valid' });
    const votes = await voteRows(request.id);
    expect(votes).toHaveLength(1);
    expect(votes[0].validatorUserId).toBe(juror.userId);
    expect(votes[0].verdict).toBe('valid');
    // The vote's proof lives on the JUROR's chain, and the row's foreign key
    // names it.
    expect(await chainRows(juror.userId)).toEqual([{ recordId: votes[0].recordId }]);
  });

  it('refuses a juror who was not selected', async () => {
    const subject = await makeAccount();
    const juror = await makeEligible();
    const intruder = await makeEligible();
    const request = await openRequest(subject);
    await setJury(request.id, [juror.userId]);

    expect(
      await submitVote(
        request.id,
        intruder.userId,
        verdictEnvelope(intruder, request.id, request.payloadHash, 'valid'),
      ),
    ).toEqual({ ok: false, reason: 'not_selected' });
    expect(await voteRows(request.id)).toEqual([]);
    expect(await chainRows(intruder.userId)).toEqual([]);
  });

  it('refuses a verdict bound to a DIFFERENT request', async () => {
    const subject = await makeAccount();
    const juror = await makeEligible();
    const request = await openRequest(subject);
    const other = await openRequest(await makeAccount());
    await setJury(request.id, [juror.userId]);

    expect(
      await submitVote(
        request.id,
        juror.userId,
        verdictEnvelope(juror, request.id, request.payloadHash, 'valid', {
          recordRequestId: other.id,
        }),
      ),
    ).toEqual({ ok: false, reason: 'request_mismatch' });
    expect(await voteRows(request.id)).toEqual([]);
    expect(await chainRows(juror.userId)).toEqual([]);
  });

  it('refuses a verdict bound to a different PAYLOAD', async () => {
    const subject = await makeAccount();
    const juror = await makeEligible();
    const request = await openRequest(subject);
    await setJury(request.id, [juror.userId]);

    expect(
      await submitVote(
        request.id,
        juror.userId,
        verdictEnvelope(juror, request.id, request.payloadHash, 'valid', {
          recordPayloadHash: createHash('sha256').update('something else').digest('hex'),
        }),
      ),
    ).toEqual({ ok: false, reason: 'payload_mismatch' });
    expect(await voteRows(request.id)).toEqual([]);
  });

  it('refuses a TAMPERED verdict envelope', async () => {
    const subject = await makeAccount();
    const juror = await makeEligible();
    const request = await openRequest(subject);
    await setJury(request.id, [juror.userId]);

    const signed = verdictEnvelope(juror, request.id, request.payloadHash, 'invalid');
    // The verdict itself is inside the signed bytes — flipping it must not stand.
    const tampered: SignedRecordEnvelope = {
      ...signed,
      record: { ...(signed.record as Record<string, unknown>), verdict: 'valid' },
    };

    expect(await submitVote(request.id, juror.userId, tampered)).toEqual({
      ok: false,
      reason: 'bad_signature',
    });
    expect(await voteRows(request.id)).toEqual([]);
    expect(await chainRows(juror.userId)).toEqual([]);
  });

  it('refuses a verdict the juror did not self-issue', async () => {
    const subject = await makeAccount();
    const juror = await makeEligible();
    const request = await openRequest(subject);
    await setJury(request.id, [juror.userId]);

    expect(
      await submitVote(
        request.id,
        juror.userId,
        verdictEnvelope(juror, request.id, request.payloadHash, 'valid', {
          subject: buildUserDid(subject),
          issuer: buildUserDid(subject),
        }),
      ),
    ).toEqual({ ok: false, reason: 'not_self_issued' });
    expect(await voteRows(request.id)).toEqual([]);
  });

  it('lets a juror vote exactly once', async () => {
    const subject = await makeAccount();
    const juror = await makeEligible();
    const request = await openRequest(subject);
    await setJury(request.id, [juror.userId, (await makeEligible()).userId]);

    await submitVote(
      request.id,
      juror.userId,
      verdictEnvelope(juror, request.id, request.payloadHash, 'valid'),
    );
    const second = await submitVote(
      request.id,
      juror.userId,
      verdictEnvelope(juror, request.id, request.payloadHash, 'invalid', {
        seq: 1,
        prev: (await chainRows(juror.userId))[0].recordId,
      }),
    );

    expect(second).toEqual({ ok: false, reason: 'already_voted' });
    const votes = await voteRows(request.id);
    expect(votes).toHaveLength(1);
    expect(votes[0].verdict).toBe('valid');
  });

  it('refuses a vote on an expired request', async () => {
    const subject = await makeAccount();
    const juror = await makeEligible();
    const request = await openRequest(subject);
    await setJury(request.id, [juror.userId]);
    await expireRequest(request.id);

    expect(
      await submitVote(
        request.id,
        juror.userId,
        verdictEnvelope(juror, request.id, request.payloadHash, 'valid'),
      ),
    ).toEqual({ ok: false, reason: 'request_closed' });
    expect(await voteRows(request.id)).toEqual([]);
  });

  it('reports request_not_found for an id no request holds', async () => {
    const juror = await makeEligible();
    expect(
      await submitVote(
        uniqueId(),
        juror.userId,
        verdictEnvelope(juror, uniqueId(), 'hash', 'valid'),
      ),
    ).toEqual({ ok: false, reason: 'request_not_found' });
  });
});

describe('tallyAndResolve — the ledger is the verdict', () => {
  /** Seat `panel` on a fresh request and have the first `verdicts.length` vote. */
  async function jury(
    verdicts: ValidationVerdict[],
    options: { actionType?: string; subjectUserId?: string } = {},
  ): Promise<{ requestId: string; subjectUserId: string; jurors: Signer[] }> {
    const subjectUserId = options.subjectUserId ?? (await makeAccount());
    const jurors: Signer[] = [];
    for (let i = 0; i < VALIDATOR_COUNT; i += 1) {
      jurors.push(await makeEligible());
    }
    const request = await openRequest(subjectUserId, { actionType: options.actionType });
    await setJury(
      request.id,
      jurors.map((juror) => juror.userId),
    );
    for (const [index, verdict] of verdicts.entries()) {
      const outcome = await submitVote(
        request.id,
        jurors[index].userId,
        verdictEnvelope(jurors[index], request.id, request.payloadHash, verdict),
      );
      expect(outcome.ok).toBe(true);
    }
    return { requestId: request.id, subjectUserId, jurors };
  }

  it('stays pending below quorum and awards nobody', async () => {
    const { requestId, subjectUserId } = await jury(['valid', 'valid']);

    expect(await tallyAndResolve(requestId)).toBe('pending');
    expect((await requestRow(requestId)).status).toBe('pending');
    expect(await ledgerRows(subjectUserId)).toEqual([]);
  });

  it('awards the subject and the majority jurors on a valid majority', async () => {
    const { requestId, subjectUserId, jurors } = await jury(['valid', 'valid', 'valid']);

    // The third vote already resolved it through `submitVote`.
    const stored = await requestRow(requestId);
    expect(stored.status).toBe('validated');
    expect(stored.outcome).toBe('validated');
    expect(stored.resolvedTxnId).not.toBeNull();

    const subjectLedger = await ledgerRows(subjectUserId);
    expect(subjectLedger).toEqual([
      {
        actionType: PEER_VALIDATED_ACTION,
        points: PEER_VALIDATED_POINTS,
        sourceActionId: requestId,
      },
    ]);
    // …and the ledger row the request points at is that award.
    const [award] = await getDb()
      .select({ id: reputationTransactions.id })
      .from(reputationTransactions)
      .where(eq(reputationTransactions.userId, subjectUserId));
    expect(stored.resolvedTxnId).toBe(award.id);

    for (const juror of jurors.slice(0, 3)) {
      expect(await ledgerRows(juror.userId)).toEqual([
        {
          actionType: VALIDATION_CORRECT_ACTION,
          points: 3,
          sourceActionId: `${requestId}:${juror.userId}`,
        },
      ]);
    }
    // The two jurors who never voted are rewarded nothing.
    expect(await ledgerRows(jurors[3].userId)).toEqual([]);
    expect(await ledgerRows(jurors[4].userId)).toEqual([]);
  });

  it('bumps the co-vote affinity for every pair on the winning side', async () => {
    const { requestId, jurors } = await jury(['valid', 'valid', 'valid']);
    expect((await requestRow(requestId)).status).toBe('validated');

    const winners = jurors.slice(0, 3).map((juror) => juror.userId);
    const edges = await getDb()
      .select({
        validatorA: validatorAffinities.validatorA,
        validatorB: validatorAffinities.validatorB,
        coVoteCount: validatorAffinities.coVoteCount,
      })
      .from(validatorAffinities)
      .where(inArray(validatorAffinities.validatorA, winners));

    // Three winners ⇒ exactly the three unordered pairs, each counted once, and
    // each stored in the canonical `validator_a < validator_b` order.
    expect(edges).toHaveLength(3);
    for (const edge of edges) {
      expect(edge.coVoteCount).toBe(1);
      expect(edge.validatorA < edge.validatorB).toBe(true);
      expect(winners).toContain(edge.validatorB);
    }
  });

  it('rejects on an invalid majority and awards NOBODY', async () => {
    // The discriminating half of the pair above: a tally that awarded on every
    // terminal outcome would pass the `validated` case and fail here.
    const { requestId, subjectUserId, jurors } = await jury(['invalid', 'invalid', 'invalid']);

    const stored = await requestRow(requestId);
    expect(stored.status).toBe('rejected');
    expect(stored.outcome).toBe('rejected');
    expect(stored.resolvedTxnId).toBeNull();
    expect(await ledgerRows(subjectUserId)).toEqual([]);
    for (const juror of jurors) {
      expect(await ledgerRows(juror.userId)).toEqual([]);
    }
  });

  it('resolves at most once, however often it is re-tallied', async () => {
    const { requestId, subjectUserId } = await jury(['valid', 'valid', 'valid']);

    expect(await tallyAndResolve(requestId)).toBe('validated');
    expect(await tallyAndResolve(requestId)).toBe('validated');

    // A second pass through the award path would double the subject's points.
    expect(await ledgerRows(subjectUserId)).toHaveLength(1);
  });

  it('marks a request that lapsed below quorum as expired', async () => {
    const { requestId, subjectUserId } = await jury(['valid']);
    await expireRequest(requestId);

    expect(await tallyAndResolve(requestId)).toBe('expired');
    expect((await requestRow(requestId)).status).toBe('expired');
    expect((await requestRow(requestId)).outcome).toBeNull();
    expect(await ledgerRows(subjectUserId)).toEqual([]);
  });

  it('resolves an expired request that DID reach quorum, on the majority', async () => {
    const { requestId, subjectUserId } = await jury(['valid', 'valid', 'invalid']);
    // Two valid vs one invalid: neither side reached the threshold of 3, so the
    // request sat at `quorum_met` until the deadline decided it.
    expect((await requestRow(requestId)).status).toBe('quorum_met');
    await expireRequest(requestId);

    expect(await tallyAndResolve(requestId)).toBe('validated');
    expect(await ledgerRows(subjectUserId)).toHaveLength(1);
  });

  it('routes a personhood_audit to the audit resolver instead of the peer award', async () => {
    const subjectUserId = await makeAccount();
    const voucher = await seedActiveVouch(subjectUserId);
    const { requestId, jurors } = await jury(['invalid', 'invalid', 'invalid'], {
      actionType: PERSONHOOD_AUDIT_ACTION,
      subjectUserId,
    });

    expect((await requestRow(requestId)).status).toBe('rejected');
    // A plain `rejected` request awards nothing at all (asserted above); the
    // audit path instead rewards the majority under its OWN source key…
    for (const juror of jurors.slice(0, 3)) {
      expect(await ledgerRows(juror.userId)).toEqual([
        {
          actionType: VALIDATION_CORRECT_ACTION,
          points: 3,
          sourceActionId: `${requestId}:${juror.userId}:audit`,
        },
      ]);
    }
    // …and never awards the subject the peer-validation points.
    expect(
      (await ledgerRows(subjectUserId)).some((row) => row.actionType === PEER_VALIDATED_ACTION),
    ).toBe(false);

    // …and runs the staking slash cascade over the subject's vouchers.
    const [vouch] = await getDb()
      .select({ status: personhoodVouches.status })
      .from(personhoodVouches)
      .where(
        and(
          eq(personhoodVouches.voucherUserId, voucher),
          eq(personhoodVouches.subjectUserId, subjectUserId),
        ),
      );
    expect(vouch.status).toBe('slashed');
  });
});

describe('denyValidation — a juror recuses', () => {
  it('removes the seat and re-tallies the request', async () => {
    const subject = await makeAccount();
    const jurors = [await makeEligible(), await makeEligible(), await makeEligible()];
    const request = await openRequest(subject);
    await setJury(
      request.id,
      jurors.map((juror) => juror.userId),
    );

    expect(await denyValidation(request.id, jurors[0].userId)).toEqual({ ok: true });

    const view = await getValidationRequest(request.id);
    expect(view?.selectedValidatorIds).toEqual([jurors[1].userId, jurors[2].userId]);
  });

  it('refuses a recusal from an account that was never seated', async () => {
    const subject = await makeAccount();
    const juror = await makeEligible();
    const outsider = await makeAccount();
    const request = await openRequest(subject);
    await setJury(request.id, [juror.userId]);

    expect(await denyValidation(request.id, outsider)).toEqual({
      ok: false,
      reason: 'not_selected',
    });
    const view = await getValidationRequest(request.id);
    expect(view?.selectedValidatorIds).toEqual([juror.userId]);
  });

  it('reports request_not_found for an id no request holds', async () => {
    expect(await denyValidation(uniqueId(), await makeAccount())).toEqual({
      ok: false,
      reason: 'request_not_found',
    });
  });
});

describe('getValidatorInbox', () => {
  it('lists a juror’s open seats and drops the ones they already answered', async () => {
    const juror = await makeEligible();
    const answered = await openRequest(await makeAccount());
    const outstanding = await openRequest(await makeAccount());
    const expired = await openRequest(await makeAccount());
    await setJury(answered.id, [juror.userId]);
    await setJury(outstanding.id, [juror.userId]);
    await setJury(expired.id, [juror.userId]);
    await expireRequest(expired.id);

    await submitVote(
      answered.id,
      juror.userId,
      verdictEnvelope(juror, answered.id, answered.payloadHash, 'valid'),
    );

    const inbox = await getValidatorInbox(juror.userId);

    // Scoped to this juror's seats, so the shared table cannot leak in.
    expect(inbox.map((request) => request.id)).toEqual([outstanding.id]);
  });

  it('is empty for an account with no seats', async () => {
    expect(await getValidatorInbox(await makeAccount())).toEqual([]);
  });
});

describe('sweepValidations', () => {
  it('retires a request that lapsed without quorum', async () => {
    const subject = await makeAccount();
    const request = await openRequest(subject);
    await expireRequest(request.id);

    await sweepValidations();

    expect((await requestRow(request.id)).status).toBe('expired');
  });
});
