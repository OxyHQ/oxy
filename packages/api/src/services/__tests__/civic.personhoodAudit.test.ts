/**
 * Random personhood audits (civic / Fase 3), against a REAL Postgres.
 *
 * The suite this replaces mocked `PersonhoodStatus.aggregate`, the jury, the
 * personhood service and the reputation award, then asserted that
 * `openValidationRequest` had been CALLED with a particular object. That says
 * nothing about the three properties the audit sweep actually has to hold:
 *
 *  - **An audit is only ever opened about a REAL PERSON.** The sample is drawn
 *    `where is_real_person`, so the discriminating fixture is a cohort of
 *    accounts that are NOT real persons: they can never be sampled, whatever the
 *    random draw does, so asserting they never acquire an audit is deterministic
 *    even though the sample is not.
 *  - **At most ONE open audit per subject.** The stable `personhood_audit:<id>`
 *    source key rides the `unique (source_action_id) where status in
 *    ('pending','quorum_met')` index, so re-running the sweep can never fork a
 *    subject's audit across two juries that could each only expire.
 *  - **A `rejected` audit is a STAKING event.** The jury saying "fake" slashes
 *    every active voucher of the subject and recomputes them; a `validated` one
 *    must not. Both are asserted against the vouch rows, not against a spy.
 *
 * The sweep samples RANDOMLY over a table the whole run shares, so nothing here
 * asserts a sample size or a global count — every assertion is scoped to the
 * accounts this file seeded.
 */

import { randomUUID } from 'node:crypto';
import { generateSecp256k1KeyPair } from '@oxyhq/protocol/secp256k1';
import { and, eq, inArray } from 'drizzle-orm';
import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { personhoodStatuses } from '../../db/schema/personhoodStatuses';
import { personhoodVouches } from '../../db/schema/personhoodVouches';
import { reputationTransactions } from '../../db/schema/reputationTransactions';
import { validationRequests } from '../../db/schema/validationRequests';
import { users } from '../../db/schema/users';
import { buildUserDid } from '../did.service';
import { signRecordEnvelope, verifyAndStoreRecord } from '../signedRecord.service';
import { reputationService } from '../reputation.service';
import {
  openPersonhoodAudit,
  resolvePersonhoodAuditOutcome,
  sweepPersonhoodAudits,
} from '../civic/personhoodAudit.service';
import {
  PERSONHOOD_AUDIT_ACTION,
  PERSONHOOD_VOUCH_DEFAULT_STAKE,
} from '../../utils/civic.constants';
import {
  VALIDATION_CORRECT_ACTION,
  VALIDATION_CORRECT_POINTS,
  VOUCH_SLASHED_ACTION,
} from '../../utils/reputation.constants';

const uniqueId = () => randomUUID().replace(/-/g, '');

/** How many real persons this file seeds before exercising the random sweep. */
const REAL_PERSON_COHORT = 60;
/** …and how many accounts it seeds that are explicitly NOT real persons. */
const IMPOSTOR_COHORT = 5;
/** A bounded retry so one unlucky random draw cannot flake the sweep case. */
const SWEEP_ATTEMPTS = 3;

async function makeAccount(): Promise<string> {
  const id = uniqueId();
  await getDb().insert(users).values({ id, username: `au${id.slice(0, 12)}` });
  return id;
}

/** An account with a personhood verdict already recorded. */
async function makeJudged(isRealPerson: boolean): Promise<string> {
  const userId = await makeAccount();
  await getDb()
    .insert(personhoodStatuses)
    .values({ userId, isRealPerson, score: isRealPerson ? 0.9 : 0.1 });
  return userId;
}

/** An ACTIVE vouch backed by a real signed record on the voucher's own chain. */
async function seedActiveVouch(subjectUserId: string): Promise<string> {
  const keyPair = generateSecp256k1KeyPair();
  const publicKey = keyPair.publicKey;
  const voucherId = uniqueId();
  await getDb()
    .insert(users)
    .values({ id: voucherId, username: `vo${voucherId.slice(0, 12)}`, publicKey });
  const envelope = signRecordEnvelope(
    {
      version: 2,
      type: 'personhood_vouch',
      subject: buildUserDid(voucherId),
      issuer: buildUserDid(voucherId),
      record: { about: buildUserDid(subjectUserId), context: 'met-in-person' },
      issuedAt: Date.now(),
      seq: 0,
      prev: null,
      collection: 'app.oxy.personhood',
      rkey: `vouch-${uniqueId().slice(0, 8)}`,
      publicKey,
      alg: 'ES256K-DER-SHA256',
    },
    keyPair.privateKey,
  );
  const stored = await verifyAndStoreRecord(envelope, voucherId);
  if (!stored.ok) {
    throw new Error(`vouch fixture could not be stored: ${stored.reason}`);
  }
  await getDb().insert(personhoodVouches).values({
    voucherUserId: voucherId,
    subjectUserId,
    stakeAmount: PERSONHOOD_VOUCH_DEFAULT_STAKE,
    recordId: stored.record.recordId,
  });
  return voucherId;
}

/** The audit requests (of any status) opened for a set of subjects. */
async function auditsFor(subjectIds: string[]) {
  if (subjectIds.length === 0) {
    return [];
  }
  return getDb()
    .select({
      id: validationRequests.id,
      subjectUserId: validationRequests.subjectUserId,
      sourceActionId: validationRequests.sourceActionId,
      status: validationRequests.status,
      payload: validationRequests.payload,
    })
    .from(validationRequests)
    .where(
      and(
        eq(validationRequests.actionType, PERSONHOOD_AUDIT_ACTION),
        inArray(validationRequests.subjectUserId, subjectIds),
      ),
    );
}

async function vouchStatus(voucherUserId: string, subjectUserId: string): Promise<string> {
  const [row] = await getDb()
    .select({ status: personhoodVouches.status })
    .from(personhoodVouches)
    .where(
      and(
        eq(personhoodVouches.voucherUserId, voucherUserId),
        eq(personhoodVouches.subjectUserId, subjectUserId),
      ),
    );
  return row.status;
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

beforeAll(async () => {
  await connectPostgres();
  await reputationService.seedDefaultRules();
});

afterAll(async () => {
  await closePostgres();
});

describe('openPersonhoodAudit', () => {
  it('opens a jury request carrying the subject DID under a stable source key', async () => {
    const subjectUserId = await makeJudged(true);

    const request = await openPersonhoodAudit(subjectUserId);

    const [stored] = await auditsFor([subjectUserId]);
    expect(stored.id).toBe(request.id);
    expect(stored.status).toBe('pending');
    expect(stored.sourceActionId).toBe(`personhood_audit:${subjectUserId}`);
    // The jurors inspect the payload; the DID is what identifies the subject to
    // them, and it is what the payload hash the verdicts bind to is computed on.
    expect(stored.payload).toEqual({
      kind: 'personhood_audit',
      subjectDid: buildUserDid(subjectUserId),
    });
  });

  it('is idempotent while an audit for the subject is still open', async () => {
    const subjectUserId = await makeJudged(true);

    const first = await openPersonhoodAudit(subjectUserId);
    const second = await openPersonhoodAudit(subjectUserId);

    expect(second.id).toBe(first.id);
    expect(await auditsFor([subjectUserId])).toHaveLength(1);
  });
});

describe('sweepPersonhoodAudits', () => {
  it(
    'audits real persons, never an account that is not one, and never twice at once',
    async () => {
      const realPersons: string[] = [];
      for (let i = 0; i < REAL_PERSON_COHORT; i += 1) {
        realPersons.push(await makeJudged(true));
      }
      const impostors: string[] = [];
      for (let i = 0; i < IMPOSTOR_COHORT; i += 1) {
        impostors.push(await makeJudged(false));
      }

      // The sample is random over a shared table, so the ONE probabilistic step
      // is bounded rather than assumed: retry until the draw touches this
      // cohort. Everything asserted afterwards is deterministic.
      let opened = 0;
      let audited: Awaited<ReturnType<typeof auditsFor>> = [];
      for (let attempt = 0; attempt < SWEEP_ATTEMPTS && audited.length === 0; attempt += 1) {
        opened += await sweepPersonhoodAudits();
        audited = await auditsFor(realPersons);
      }

      expect(audited.length).toBeGreaterThan(0);
      // The counter never under-reports what it opened.
      expect(opened).toBeGreaterThanOrEqual(audited.length);

      for (const audit of audited) {
        expect(audit.sourceActionId).toBe(`personhood_audit:${audit.subjectUserId}`);
        expect(audit.payload).toEqual({
          kind: 'personhood_audit',
          subjectDid: buildUserDid(audit.subjectUserId),
        });
      }

      // Deterministic, whatever the draw did: the sample is taken `where
      // is_real_person`, so an account with a sub-θ verdict can never appear.
      expect(await auditsFor(impostors)).toEqual([]);

      // Re-running must not fork any subject's audit across two open juries.
      await sweepPersonhoodAudits();
      const afterSecondSweep = await auditsFor(realPersons);
      const openPerSubject = new Map<string, number>();
      for (const audit of afterSecondSweep) {
        if (audit.status === 'pending' || audit.status === 'quorum_met') {
          openPerSubject.set(audit.subjectUserId, (openPerSubject.get(audit.subjectUserId) ?? 0) + 1);
        }
      }
      expect([...openPerSubject.values()].every((count) => count === 1)).toBe(true);
      expect(openPerSubject.size).toBeGreaterThan(0);
    },
    120_000,
  );
});

describe('resolvePersonhoodAuditOutcome', () => {
  it('rewards the majority and runs the STAKING SLASH cascade on a rejected audit', async () => {
    const subjectUserId = await makeJudged(true);
    const voucher = await seedActiveVouch(subjectUserId);
    const request = await openPersonhoodAudit(subjectUserId);
    const jurors = [await makeAccount(), await makeAccount()];

    await resolvePersonhoodAuditOutcome(request, 'rejected', jurors);

    for (const juror of jurors) {
      expect(await ledgerRows(juror)).toEqual([
        {
          actionType: VALIDATION_CORRECT_ACTION,
          points: VALIDATION_CORRECT_POINTS,
          // The audit's own source key — distinct from the peer-validation one,
          // so a juror can be rewarded for both without either being deduped away.
          sourceActionId: `${request.id}:${juror}:audit`,
        },
      ]);
    }

    // The staking consequence: the voucher loses their stake and the edge.
    expect(await vouchStatus(voucher, subjectUserId)).toBe('slashed');
    expect(await ledgerRows(voucher)).toEqual([
      {
        actionType: VOUCH_SLASHED_ACTION,
        points: -20,
        sourceActionId: expect.stringContaining('vouch_slash:'),
      },
    ]);

    // …and the subject was recomputed without their vouch.
    const [status] = await getDb()
      .select({ vouchCount: personhoodStatuses.vouchCount })
      .from(personhoodStatuses)
      .where(eq(personhoodStatuses.userId, subjectUserId));
    expect(status.vouchCount).toBe(0);
  });

  it('re-affirms the subject on a validated audit WITHOUT slashing anyone', async () => {
    // The discriminating pair for the case above: the same inputs, the other
    // outcome. A resolver that slashed unconditionally passes that one.
    const subjectUserId = await makeJudged(true);
    const voucher = await seedActiveVouch(subjectUserId);
    const request = await openPersonhoodAudit(subjectUserId);
    const juror = await makeAccount();

    await resolvePersonhoodAuditOutcome(request, 'validated', [juror]);

    expect(await vouchStatus(voucher, subjectUserId)).toBe('active');
    expect(await ledgerRows(voucher)).toEqual([]);
    expect(await ledgerRows(juror)).toHaveLength(1);

    // The re-affirm recomputes the subject, so the status row reflects the
    // surviving vouch rather than a stale count.
    const [status] = await getDb()
      .select({ vouchCount: personhoodStatuses.vouchCount })
      .from(personhoodStatuses)
      .where(eq(personhoodStatuses.userId, subjectUserId));
    expect(status.vouchCount).toBe(1);
  });

  it('rewards nobody when the jury had no winning side to reward', async () => {
    const subjectUserId = await makeJudged(true);
    const voucher = await seedActiveVouch(subjectUserId);
    const request = await openPersonhoodAudit(subjectUserId);

    await resolvePersonhoodAuditOutcome(request, 'validated', []);

    expect(await vouchStatus(voucher, subjectUserId)).toBe('active');
  });
});
