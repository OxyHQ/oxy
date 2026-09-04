/**
 * The moderation → reputation bridge, against a REAL Postgres.
 *
 * The suite this replaces built a ~300-line in-memory Mongo emulator with
 * hand-written unique-index enforcement, and its own header argued at length
 * that the emulator HAD to enforce those indexes or every idempotency assertion
 * would be vacuous. That argument was correct and it is now moot: the three
 * indexes are real, declared in `conductStrikes.ts`, `moderationEffects.ts` and
 * `reputationTransactions.ts`, and Postgres enforces them. What the emulator
 * could never do — and what every count below now does — is fail when the
 * SCHEMA loses one.
 *
 * THE TWO SCENARIOS THAT DEFINE DONE, asserted against stored rows:
 *   1. A final global infraction produces EXACTLY ONE ledger transaction, ONE
 *      conduct strike and ONE moderation effect, however many times it is
 *      delivered and from however many cases.
 *   2. An accepted appeal appends a COMPENSATING ledger entry and removes the
 *      active risk, without editing or deleting anything.
 *
 * ## The one collaborator that is stubbed, and exactly what that costs
 *
 * `resolveBindingProof` (`services/identityBinding.service.ts`) is the ONE
 * module on this path that has NOT been ported: it still queries the Mongoose
 * `IdentityBinding` model, and it gates on `mongoose.Types.ObjectId.isValid`
 * before doing so — a guard the migration contract deletes on sight. A
 * Postgres-generated `identity_bindings.id` is a uuid v7, which that guard
 * rejects outright, so TODAY every call to `applyModerationDecision` returns
 * `no_binding_proof` and the bridge can apply nothing at all. (Measured, not
 * inferred — see the report accompanying this rewrite.)
 *
 * So it is stubbed, and the stub is deliberately DUMB: it returns whatever
 * resolution the test states outright. It re-implements none of the resolver's
 * predicates, so nothing here can be mistaken for a test of them — those live
 * in `identityBinding.service.test.ts`. What IS tested here, and is entirely a
 * property of the module under test, is that the bridge writes NOTHING when the
 * resolution is a rejection, and derives the consequence when it is not. Every
 * accepted resolution names a REAL `identity_bindings` row, because
 * `moderation_effects.binding_id` is a real foreign key with `ON DELETE
 * RESTRICT` — a fabricated id would fail the insert.
 *
 * ## Scoping
 *
 * The whole run shares one database, so every user, application, incident,
 * decision and policy version below carries a per-test random key and no
 * assertion depends on a table being empty. The one place a GLOBAL query is
 * unavoidable is `expireConductStrikes`, which sweeps every due strike in the
 * database; this file is the only writer of `conduct_strikes.expires_at` in the
 * suite (`db/schema/__tests__/socialGraph.test.ts` writes strikes but never an
 * expiry, and a NULL never matches the sweep's `<= now()`), so its counts are
 * exact. A future suite that starts writing due strikes will fail these loudly,
 * which is the correct outcome.
 */

import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import type {
  ModerationDecisionEvent,
  ModerationEffectSkipReason,
  ModerationFinding,
} from '@oxyhq/contracts';

import type { ResolveBindingParams } from '../identityBinding.service';

/**
 * The stub for the un-ported binding resolver. See the header: it states a
 * resolution, it does not derive one.
 */
type BindingStub =
  | { ok: true; binding: { id: string } }
  | { ok: false; reason: ModerationEffectSkipReason };

const mockResolveBindingProof = jest.fn(
  async (_params: ResolveBindingParams): Promise<BindingStub> => ({
    ok: false,
    reason: 'no_binding_proof',
  })
);

jest.mock('../identityBinding.service', () => ({
  __esModule: true,
  resolveBindingProof: (params: ResolveBindingParams) => mockResolveBindingProof(params),
}));

import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { applicationCredentials } from '../../db/schema/applicationCredentials';
import { applicationModerationTrust } from '../../db/schema/applicationModerationTrust';
import { applications } from '../../db/schema/applications';
import { conductStrikes } from '../../db/schema/conductStrikes';
import { identityBindings } from '../../db/schema/identityBindings';
import { moderationEffects } from '../../db/schema/moderationEffects';
import { moderationPolicies } from '../../db/schema/moderationPolicies';
import { moderationPolicySeverityRules } from '../../db/schema/moderationPolicySeverityRules';
import { moderationPolicyStandingThresholds } from '../../db/schema/moderationPolicyStandingThresholds';
import { reputationBalances } from '../../db/schema/reputationBalances';
import { reputationRules } from '../../db/schema/reputationRules';
import { reputationTransactions } from '../../db/schema/reputationTransactions';
import { users } from '../../db/schema/users';
import moderationReputationService, {
  buildIdempotencyKey,
} from '../moderationReputation.service';
import reputationService from '../reputation.service';
import {
  BASELINE_CONDUCT_FAMILIES,
  BASELINE_MULTI_FINDING_CAP,
  BASELINE_MULTI_FINDING_SECONDARY_SHARE,
  BASELINE_REPETITION_MULTIPLIERS,
  BASELINE_REPETITION_WINDOW_DAYS,
  BASELINE_SEVERITY_RULES,
  BASELINE_STANDING_THRESHOLDS,
  CONTEXTUAL_WEIGHT_MIN,
  MODERATION_VIOLATION_ACTIONS,
  REPORT_ABUSE_CONFIRMED_ACTION,
} from '../../utils/moderation.constants';

const uniqueId = () => randomUUID().replace(/-/g, '');

/** The action happened an hour ago; bindings are dated well before that. */
const OCCURRED_AT = new Date(Date.now() - 60 * 60 * 1000);

// ---------------------------------------------------------------------------
// Fixtures — a whole world per test, keyed so no two tests can collide.
// ---------------------------------------------------------------------------

/** Everything one scenario needs, already wired and stored. */
interface World {
  subjectId: string;
  applicationId: string;
  bindingId: string;
  policyVersion: string;
  emitterApplicationId: string;
  context: { emitterApplicationId: string; emitterCredentialId?: string };
}

/**
 * An account with a GENERATED id. The id is not invented here on purpose:
 * `applyModerationDecision` runs the principal through `resolveUserIdToObjectId`,
 * which only recognises the two sanctioned account-id shapes (a 24-char ObjectId
 * hex or a uuid v7) and treats anything else as a publicKey. A fabricated id in
 * neither shape would make every case in this file answer 404 for a reason that
 * has nothing to do with what it is testing.
 */
async function makeUser(): Promise<string> {
  const [row] = await getDb()
    .insert(users)
    .values({ username: `mr${uniqueId()}` })
    .returning({ id: users.id });
  return row.id;
}

async function makeApplication(): Promise<string> {
  const [row] = await getDb()
    .insert(applications)
    .values({ name: `app-${uniqueId().slice(0, 8)}`, ownerAccountId: await makeUser() })
    .returning({ id: applications.id });
  return row.id;
}

/** The reported application's standing on the global-effects gate. */
async function setGlobalEffects(applicationId: string, allowed: boolean): Promise<void> {
  await getDb()
    .insert(applicationModerationTrust)
    .values({
      applicationId,
      standing: allowed ? 'trusted' : 'sandbox',
      globalReputationEffectsAllowed: allowed,
    });
}

/** A real binding row, so `moderation_effects.binding_id` resolves. */
async function makeBinding(applicationId: string, userId: string): Promise<string> {
  const [row] = await getDb()
    .insert(identityBindings)
    .values({
      applicationId,
      userId,
      localPrincipalId: `local-${uniqueId().slice(0, 10)}`,
      bindingType: 'oauth_grant',
      status: 'active',
      verifiedAt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
    })
    .returning({ id: identityBindings.id });
  return row.id;
}

/**
 * A published policy version carrying the baseline figures, under a key unique
 * to this test — `moderation_policies.policy_version` is globally UNIQUE and
 * every suite in the run shares one database.
 */
async function makePolicy(): Promise<string> {
  const policyVersion = `oxy.test.${uniqueId().slice(0, 16)}`;
  await moderationReputationService.seedBaselinePolicy({
    policyVersion,
    severityRules: BASELINE_SEVERITY_RULES,
    conductFamilies: BASELINE_CONDUCT_FAMILIES,
    repetitionMultipliers: BASELINE_REPETITION_MULTIPLIERS,
    repetitionWindowDays: BASELINE_REPETITION_WINDOW_DAYS,
    multiFindingSecondaryShare: BASELINE_MULTI_FINDING_SECONDARY_SHARE,
    multiFindingCap: BASELINE_MULTI_FINDING_CAP,
    standingThresholds: BASELINE_STANDING_THRESHOLDS,
  });
  return policyVersion;
}

/** A subject, a permitted reporting application, a binding and a policy. */
async function makeWorld(options: { globalEffects?: boolean } = {}): Promise<World> {
  const subjectId = await makeUser();
  const applicationId = await makeApplication();
  await setGlobalEffects(applicationId, options.globalEffects ?? true);
  const bindingId = await makeBinding(applicationId, subjectId);
  const policyVersion = await makePolicy();
  const emitterApplicationId = await makeApplication();
  const [credential] = await getDb()
    .insert(applicationCredentials)
    .values({
      applicationId: emitterApplicationId,
      name: 'emitter credential',
      publicKey: `oxy_dk_${uniqueId()}`,
      type: 'service',
      environment: 'development',
    })
    .returning({ id: applicationCredentials.id });

  mockResolveBindingProof.mockResolvedValue({ ok: true, binding: { id: bindingId } });

  return {
    subjectId,
    applicationId,
    bindingId,
    policyVersion,
    emitterApplicationId,
    context: { emitterApplicationId, emitterCredentialId: credential.id },
  };
}

const HARASSMENT_MEDIUM: ModerationFinding = {
  code: 'harassment.targeted_abuse',
  severity: 'medium',
  scope: 'oxy_network',
  attribution: 'author',
  family: 'harassment',
};

/** A well-formed decision event for a world, with per-call unique identifiers. */
function makeEvent(
  world: World,
  overrides: Partial<ModerationDecisionEvent> = {}
): ModerationDecisionEvent {
  const key = uniqueId().slice(0, 12);
  return {
    eventId: `evt_${key}`,
    reportedApplicationId: world.applicationId,
    type: 'moderation.decision.finalized.v1',
    caseId: `case_${key}`,
    incidentId: `inc_${key}`,
    decisionId: `dec_${key}`,
    decisionRevision: 1,
    subject: {
      principalType: 'oxy_user',
      principalId: world.subjectId,
      bindingProofId: world.bindingId,
    },
    findings: [HARASSMENT_MEDIUM],
    decisionStatus: 'final',
    policyVersions: {
      universal: '2026.1',
      application: 'mention.2026.07',
      oxyConduct: world.policyVersion,
    },
    occurredAt: OCCURRED_AT.toISOString(),
    proofHash: `sha256:${key}`,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Readers — every assertion is scoped to rows this test wrote.
// ---------------------------------------------------------------------------

async function ledgerRows(userId: string) {
  return getDb()
    .select({
      id: reputationTransactions.id,
      points: reputationTransactions.points,
      status: reputationTransactions.status,
      actionType: reputationTransactions.actionType,
      sourceActionId: reputationTransactions.sourceActionId,
      metadata: reputationTransactions.metadata,
      reversedTransactionId: reputationTransactions.reversedTransactionId,
    })
    .from(reputationTransactions)
    .where(eq(reputationTransactions.userId, userId));
}

async function strikeRows(userId: string) {
  return getDb()
    .select()
    .from(conductStrikes)
    .where(eq(conductStrikes.userId, userId));
}

async function effectRows(incidentId: string) {
  return getDb()
    .select()
    .from(moderationEffects)
    .where(eq(moderationEffects.incidentId, incidentId));
}

/** "Nothing at all was written for this subject and this incident." */
async function expectNothingWritten(world: World, incidentId: string): Promise<void> {
  expect(await ledgerRows(world.subjectId)).toEqual([]);
  expect(await strikeRows(world.subjectId)).toEqual([]);
  expect(await effectRows(incidentId)).toEqual([]);
}

beforeAll(async () => {
  await connectPostgres();
});

afterAll(async () => {
  await closePostgres();
});

beforeEach(() => {
  // Call history only: every test that reaches the resolver states its own
  // resolution (`makeWorld` for the accepting cases, the rejection block for
  // the rest), so clearing the implementation as well would only make a
  // forgotten one fail obscurely instead of loudly.
  mockResolveBindingProof.mockClear();
});

// ===========================================================================
// DEFINITION OF DONE — scenario 1
// ===========================================================================

describe('DoD: a final global infraction creates exactly one transaction and one strike', () => {
  it('writes one ledger row, one strike and one effect, with the POLICY VERSION’s figures', async () => {
    const world = await makeWorld();
    const event = makeEvent(world);

    const result = await moderationReputationService.applyModerationDecision(
      event,
      world.context
    );

    expect(result.applied).toBe(true);
    expect(result.idempotent).toBe(false);

    // Exact non-zero counts against real tables — a zero would be
    // indistinguishable from a query that silently matched nothing.
    const ledger = await ledgerRows(world.subjectId);
    const strikes = await strikeRows(world.subjectId);
    const effects = await effectRows(event.incidentId);
    expect(ledger).toHaveLength(1);
    expect(strikes).toHaveLength(1);
    expect(effects).toHaveLength(1);

    // `medium` is −8 points / 3 risk / 90-day expiry in the seeded version.
    expect(ledger[0].points).toBe(-8);
    expect(ledger[0].actionType).toBe(MODERATION_VIOLATION_ACTIONS.medium);
    expect(strikes[0]).toMatchObject({
      riskPoints: 3,
      status: 'active',
      severity: 'medium',
      family: 'harassment',
      effectType: 'conduct_penalty',
      policyVersion: world.policyVersion,
      transactionId: ledger[0].id,
    });
    expect(strikes[0].expiresAt).toBeInstanceOf(Date);
    expect(strikes[0].resolvedAt).toBeNull();
    expect(effects[0]).toMatchObject({
      status: 'applied',
      points: -8,
      activeRisk: 3,
      bindingId: world.bindingId,
      applicationId: world.applicationId,
      transactionId: ledger[0].id,
      strikeId: strikes[0].id,
      policyVersionOxyConduct: world.policyVersion,
    });

    // …and the conduct axis of the snapshot moved with it.
    const balance = await reputationService.getBalance(world.subjectId);
    expect(balance.conduct).toMatchObject({
      activeRisk: 3,
      activeStrikes: 1,
      standing: 'watch',
    });
  });

  it('a hundred deliveries of the same event still produce one of each', async () => {
    const world = await makeWorld();
    const event = makeEvent(world);

    for (let i = 0; i < 100; i += 1) {
      await moderationReputationService.applyModerationDecision(event, world.context);
    }

    expect(await ledgerRows(world.subjectId)).toHaveLength(1);
    expect(await strikeRows(world.subjectId)).toHaveLength(1);
    expect(await effectRows(event.incidentId)).toHaveLength(1);
  });

  it('two DIFFERENT events for the same incident and revision still produce one of each', async () => {
    // A hundred reports collapse into one incident. Two cases, two event ids,
    // one consequence — the SEMANTIC key decides, not the transport key.
    const world = await makeWorld();
    const first = makeEvent(world);
    await moderationReputationService.applyModerationDecision(first, world.context);

    const second = await moderationReputationService.applyModerationDecision(
      makeEvent(world, {
        incidentId: first.incidentId,
        decisionId: first.decisionId,
      }),
      world.context
    );

    expect(second.applied).toBe(true);
    expect(second.idempotent).toBe(true);
    expect(await ledgerRows(world.subjectId)).toHaveLength(1);
    expect(await strikeRows(world.subjectId)).toHaveLength(1);
    expect(await effectRows(first.incidentId)).toHaveLength(1);
  });

  it('the ledger idempotency key is the LAST line of defence, not the pre-check', async () => {
    // The pre-check on the semantic key hides the ledger's own guard in the
    // happy path, so a test that merely replays an event proves nothing about
    // it. Here the effect and its strike are REMOVED — a partially-lost write,
    // or a second code path reaching the same incident — leaving only the
    // ledger row. The pre-check then finds nothing, the service proceeds, and
    // `UNIQUE (application_id, source_action_id)` is the sole thing standing
    // between the subject and a second penalty for one incident.
    const world = await makeWorld();
    const first = makeEvent(world);
    await moderationReputationService.applyModerationDecision(first, world.context);
    const [original] = await ledgerRows(world.subjectId);
    expect(original.points).toBe(-8);

    // `moderation_effects.strike_id` cascades, so the effect must lose its
    // pointer before the strike can go without taking the effect with it.
    await getDb()
      .update(moderationEffects)
      .set({ strikeId: null })
      .where(eq(moderationEffects.incidentId, first.incidentId));
    await getDb().delete(moderationEffects).where(eq(moderationEffects.incidentId, first.incidentId));
    await getDb().delete(conductStrikes).where(eq(conductStrikes.userId, world.subjectId));

    await moderationReputationService.applyModerationDecision(
      makeEvent(world, { incidentId: first.incidentId, decisionId: first.decisionId }),
      world.context
    );

    const ledger = await ledgerRows(world.subjectId);
    expect(ledger).toHaveLength(1);
    expect(ledger[0].id).toBe(original.id);
    expect(ledger[0].points).toBe(-8);
  });

  it('an appeal revision is its own consequence, not a duplicate of the first', async () => {
    // The revision is part of the semantic key: a revision-2 decision may
    // legitimately impose a different consequence and must not be swallowed.
    const world = await makeWorld();
    const first = makeEvent(world);
    await moderationReputationService.applyModerationDecision(first, world.context);

    const revision2 = await moderationReputationService.applyModerationDecision(
      makeEvent(world, {
        incidentId: first.incidentId,
        decisionId: first.decisionId,
        decisionRevision: 2,
      }),
      world.context
    );

    expect(revision2.idempotent).toBe(false);
    expect(await effectRows(first.incidentId)).toHaveLength(2);
    expect(await strikeRows(world.subjectId)).toHaveLength(2);
    expect(await ledgerRows(world.subjectId)).toHaveLength(2);
  });

  it('two different people in one incident each get their own consequence', async () => {
    const world = await makeWorld();
    const sharerId = await makeUser();
    const sharerBinding = await makeBinding(world.applicationId, sharerId);
    const first = makeEvent(world);
    await moderationReputationService.applyModerationDecision(first, world.context);

    mockResolveBindingProof.mockResolvedValue({ ok: true, binding: { id: sharerBinding } });
    const second = await moderationReputationService.applyModerationDecision(
      makeEvent(world, {
        incidentId: first.incidentId,
        decisionId: first.decisionId,
        subject: {
          principalType: 'oxy_user',
          principalId: sharerId,
          bindingProofId: sharerBinding,
        },
        findings: [{ ...HARASSMENT_MEDIUM, attribution: 'sharer' }],
      }),
      world.context
    );

    expect(second.applied).toBe(true);
    expect(second.idempotent).toBe(false);
    expect(await effectRows(first.incidentId)).toHaveLength(2);
    expect(await ledgerRows(world.subjectId)).toHaveLength(1);
    expect(await ledgerRows(sharerId)).toHaveLength(1);
  });

  it('one person on two AXES in one incident carries two distinct consequences', async () => {
    // Author and colluding reviewer are different consequences, and dropping
    // the axis from the key would silently swallow the second.
    const world = await makeWorld();
    const first = makeEvent(world);
    await moderationReputationService.applyModerationDecision(first, world.context);

    const second = await moderationReputationService.applyModerationDecision(
      makeEvent(world, {
        incidentId: first.incidentId,
        decisionId: first.decisionId,
        findings: [
          {
            ...HARASSMENT_MEDIUM,
            attribution: 'reporter',
            family: 'report_abuse',
            code: 'report_abuse.mass_false_reporting',
          },
        ],
      }),
      world.context
    );

    expect(second.applied).toBe(true);
    expect(second.idempotent).toBe(false);
    const effects = await effectRows(first.incidentId);
    expect(effects.map((row) => row.effectType).sort()).toEqual([
      'conduct_penalty',
      'report_abuse_penalty',
    ]);
    const ledger = await ledgerRows(world.subjectId);
    expect(ledger).toHaveLength(2);
    expect(ledger.map((row) => row.actionType).sort()).toEqual(
      [MODERATION_VIOLATION_ACTIONS.medium, REPORT_ABUSE_CONFIRMED_ACTION].sort()
    );
  });
});

describe('buildIdempotencyKey carries every dimension a collision would erase', () => {
  it('separates two subjects in one incident, and two axes for one subject', () => {
    const incident = `inc_${uniqueId().slice(0, 8)}`;
    const author = buildIdempotencyKey(incident, 1, 'user-a', 'conduct_penalty');

    expect(buildIdempotencyKey(incident, 1, 'user-b', 'conduct_penalty')).not.toBe(author);
    expect(buildIdempotencyKey(incident, 1, 'user-a', 'review_abuse_penalty')).not.toBe(author);
    expect(buildIdempotencyKey(incident, 2, 'user-a', 'conduct_penalty')).not.toBe(author);
    expect(buildIdempotencyKey(`${incident}x`, 1, 'user-a', 'conduct_penalty')).not.toBe(author);
    // …and it is stable, which is the half that makes it an idempotency key.
    expect(buildIdempotencyKey(incident, 1, 'user-a', 'conduct_penalty')).toBe(author);
  });
});

// ===========================================================================
// DEFINITION OF DONE — scenario 2
// ===========================================================================

describe('DoD: an accepted appeal compensates the points and removes the active risk', () => {
  it('appends a compensating entry, nets the balance to zero and clears the risk', async () => {
    const world = await makeWorld();
    const event = makeEvent(world);
    await moderationReputationService.applyModerationDecision(event, world.context);

    const before = await reputationService.getBalance(world.subjectId);
    expect(before.conduct.activeRisk).toBe(3);
    expect(before.conduct.standing).toBe('watch');

    const result = await moderationReputationService.reverseModerationDecision(
      event.decisionId,
      1,
      'Appeal accepted: the material was quoted criticism, not abuse',
      world.context.emitterCredentialId!
    );

    expect(result.idempotent).toBe(false);
    expect(result.reversed).toHaveLength(1);
    expect(result.reversed[0].status).toBe('reversed');
    expect(result.reversed[0].reversalTransactionId).not.toBeNull();
    expect(result.reversed[0].reversedAt).toBeInstanceOf(Date);

    // COMPENSATING, not edited: the original keeps its points and flips to
    // `reversed`; a new `active` row with negated points is appended.
    const ledger = await ledgerRows(world.subjectId);
    expect(ledger).toHaveLength(2);
    const original = ledger.find((row) => row.points === -8);
    const compensating = ledger.find((row) => row.points === 8);
    expect(original?.status).toBe('reversed');
    expect(compensating?.status).toBe('active');
    expect(compensating?.reversedTransactionId).toBe(original?.id);
    expect(ledger.reduce((sum, row) => sum + row.points, 0)).toBe(0);

    // The strike stops carrying risk; both halves of the resolution move
    // together, which the table's CHECK now requires.
    const [strike] = await strikeRows(world.subjectId);
    expect(strike.status).toBe('reversed');
    expect(strike.resolvedAt).toBeInstanceOf(Date);

    const after = await reputationService.getBalance(world.subjectId);
    expect(after.conduct).toMatchObject({
      activeRisk: 0,
      activeStrikes: 0,
      standing: 'good',
    });
  });

  it('reversing twice appends no second compensating entry', async () => {
    const world = await makeWorld();
    const event = makeEvent(world);
    await moderationReputationService.applyModerationDecision(event, world.context);
    await moderationReputationService.reverseModerationDecision(
      event.decisionId,
      1,
      'Appeal accepted',
      world.context.emitterCredentialId!
    );

    const again = await moderationReputationService.reverseModerationDecision(
      event.decisionId,
      1,
      'Appeal accepted',
      world.context.emitterCredentialId!
    );

    expect(again.idempotent).toBe(true);
    expect(await ledgerRows(world.subjectId)).toHaveLength(2);
    expect((await reputationService.getBalance(world.subjectId)).total).toBe(0);
  });

  it('cannot reverse another service credential\'s colliding decision id', async () => {
    const owner = await makeWorld();
    const other = await makeWorld();
    const decisionId = `dec_shared_${uniqueId().slice(0, 8)}`;
    const ownerEvent = makeEvent(owner, { decisionId });
    const otherEvent = makeEvent(other, { decisionId });
    await moderationReputationService.applyModerationDecision(ownerEvent, owner.context);
    await moderationReputationService.applyModerationDecision(otherEvent, other.context);

    const result = await moderationReputationService.reverseModerationDecision(
      decisionId,
      1,
      'Appeal accepted',
      owner.context.emitterCredentialId!
    );

    expect(result.reversed).toHaveLength(1);
    expect(result.reversed[0].credentialId).toBe(owner.context.emitterCredentialId);
    expect((await effectRows(otherEvent.incidentId))[0].status).toBe('applied');
    expect(await ledgerRows(other.subjectId)).toHaveLength(1);
  });

  it('reversing a decision that produced no effect is an error, not a silent success', async () => {
    await expect(
      moderationReputationService.reverseModerationDecision(
        `dec_never_${uniqueId().slice(0, 8)}`,
        1,
        'Appeal accepted',
        world.context.emitterCredentialId!
      )
    ).rejects.toThrow(/No moderation effect/);
  });
});

// ===========================================================================
// THE PRE-EFFECT VALIDATIONS
// ===========================================================================

describe('validation — the emitting credential', () => {
  it('refuses an event with no emitting credential identity', async () => {
    const world = await makeWorld();
    await expect(
      moderationReputationService.applyModerationDecision(makeEvent(world), {
        emitterApplicationId: '',
      })
    ).rejects.toThrow(/service credential/i);
  });

  it('records the emitting credential on the effect when one is supplied', async () => {
    const world = await makeWorld();
    const [credential] = await getDb()
      .insert(applicationCredentials)
      .values({
        applicationId: world.emitterApplicationId,
        name: 'emitter credential',
        publicKey: `oxy_dk_${uniqueId()}`,
        type: 'service',
        environment: 'development',
      })
      .returning({ id: applicationCredentials.id });

    const event = makeEvent(world);
    await moderationReputationService.applyModerationDecision(event, {
      emitterApplicationId: world.emitterApplicationId,
      emitterCredentialId: credential.id,
    });

    const [effect] = await effectRows(event.incidentId);
    expect(effect.credentialId).toBe(credential.id);
  });
});

describe('validation — the decision must be effective', () => {
  it('an inconclusive decision produces no effect and is NOT read as no-violation', async () => {
    const world = await makeWorld();
    const event = makeEvent(world, { decisionStatus: 'inconclusive' });

    const result = await moderationReputationService.applyModerationDecision(
      event,
      world.context
    );

    expect(result.applied).toBe(false);
    expect(result.skipReason).toBe('decision_not_effective');
    await expectNothingWritten(world, event.incidentId);
  });

  it('a provisional decision produces no effect under the baseline policy', async () => {
    const world = await makeWorld();
    const event = makeEvent(world, { decisionStatus: 'provisional' });

    const result = await moderationReputationService.applyModerationDecision(
      event,
      world.context
    );

    expect(result.applied).toBe(false);
    expect(result.skipReason).toBe('decision_not_effective');
    await expectNothingWritten(world, event.incidentId);
  });

  it('a provisional decision DOES produce an effect when its policy version permits it', async () => {
    const world = await makeWorld();
    await getDb()
      .update(moderationPolicies)
      .set({ provisionalEffectsAllowed: true })
      .where(eq(moderationPolicies.policyVersion, world.policyVersion));
    const event = makeEvent(world, { decisionStatus: 'provisional' });

    const result = await moderationReputationService.applyModerationDecision(
      event,
      world.context
    );

    expect(result.applied).toBe(true);
    expect(await ledgerRows(world.subjectId)).toHaveLength(1);
  });

  it('a superseded revision does not resurrect a consequence an appeal removed', async () => {
    const world = await makeWorld();
    const event = makeEvent(world, { decisionStatus: 'superseded' });

    const result = await moderationReputationService.applyModerationDecision(
      event,
      world.context
    );

    expect(result.applied).toBe(false);
    expect(result.skipReason).toBe('decision_superseded');
    await expectNothingWritten(world, event.incidentId);
  });

  it('a corrected revision likewise produces nothing', async () => {
    const world = await makeWorld();
    const event = makeEvent(world, { decisionStatus: 'corrected' });

    const result = await moderationReputationService.applyModerationDecision(
      event,
      world.context
    );

    expect(result.applied).toBe(false);
    expect(result.skipReason).toBe('decision_superseded');
    await expectNothingWritten(world, event.incidentId);
  });
});

describe('validation — the binding proof', () => {
  /*
   * The hole the whole phase exists to close: before it, `award` accepted a
   * bare `userId` and trusted it. The stub states the rejection (see the file
   * header); what is asserted is that the BRIDGE honours it — deleting the
   * `if (!binding.ok) return …` block in `applyModerationDecision` makes every
   * case here go red on `expect(applied).toBe(false)` and on the empty tables.
   */
  const REJECTIONS: ModerationEffectSkipReason[] = [
    'no_binding_proof',
    'binding_after_action',
    'binding_principal_mismatch',
    'binding_revoked',
  ];

  for (const reason of REJECTIONS) {
    it(`writes nothing when the binding resolution is \`${reason}\``, async () => {
      const world = await makeWorld();
      mockResolveBindingProof.mockResolvedValue({ ok: false, reason });
      const event = makeEvent(world);

      const result = await moderationReputationService.applyModerationDecision(
        event,
        world.context
      );

      expect(result.applied).toBe(false);
      expect(result.skipReason).toBe(reason);
      await expectNothingWritten(world, event.incidentId);
    });
  }

  it('resolves the binding against the REPORTED application and the reported instant', async () => {
    // The bridge must not hand the resolver the emitter's own application or
    // its own clock: the proof has to be scoped to the tenant the action
    // happened in, at the time it happened.
    const world = await makeWorld();
    const event = makeEvent(world);
    await moderationReputationService.applyModerationDecision(event, world.context);

    expect(mockResolveBindingProof).toHaveBeenCalledWith({
      applicationId: world.applicationId,
      bindingProofId: world.bindingId,
      principalId: world.subjectId,
      occurredAt: OCCURRED_AT,
    });
  });
});

describe('validation — the finding must reach the network', () => {
  it('an application-local finding produces no global effect', async () => {
    const world = await makeWorld();
    const event = makeEvent(world, {
      findings: [{ ...HARASSMENT_MEDIUM, scope: 'application_local' }],
    });

    const result = await moderationReputationService.applyModerationDecision(
      event,
      world.context
    );

    expect(result.applied).toBe(false);
    expect(result.skipReason).toBe('finding_scope_local');
    await expectNothingWritten(world, event.incidentId);
  });

  it('an identity-integrity finding does reach the network', async () => {
    const world = await makeWorld();
    const event = makeEvent(world, {
      findings: [
        {
          ...HARASSMENT_MEDIUM,
          scope: 'identity_integrity',
          family: 'impersonation',
          code: 'impersonation.account',
        },
      ],
    });

    const result = await moderationReputationService.applyModerationDecision(
      event,
      world.context
    );

    expect(result.applied).toBe(true);
    expect(await ledgerRows(world.subjectId)).toHaveLength(1);
  });
});

describe('validation — the policy version must recognise the finding', () => {
  it('refuses an unknown policy version rather than falling back to the current one', async () => {
    // A fallback would apply today's tuning to a decision made under another,
    // which is precisely what versioning exists to prevent.
    const world = await makeWorld();
    const event = makeEvent(world, {
      policyVersions: {
        universal: '2026.1',
        application: 'mention.2026.07',
        oxyConduct: `oxy.absent.${uniqueId().slice(0, 8)}`,
      },
    });

    await expect(
      moderationReputationService.applyModerationDecision(event, world.context)
    ).rejects.toThrow(/Unknown Oxy conduct policy version/);
    await expectNothingWritten(world, event.incidentId);
  });

  it('a conduct family the policy version does not recognise produces no effect', async () => {
    const world = await makeWorld();
    const event = makeEvent(world, {
      findings: [{ ...HARASSMENT_MEDIUM, family: 'astrology', code: 'astrology.bad_takes' }],
    });

    const result = await moderationReputationService.applyModerationDecision(
      event,
      world.context
    );

    expect(result.applied).toBe(false);
    expect(result.skipReason).toBe('finding_not_in_policy');
    await expectNothingWritten(world, event.incidentId);
  });

  it('a severity the policy version prices nowhere produces no effect', async () => {
    // The other half of "recognised": the family is known but the version has
    // no row for that band, so there is no figure to derive from.
    const world = await makeWorld();
    const [policy] = await getDb()
      .select({ id: moderationPolicies.id })
      .from(moderationPolicies)
      .where(eq(moderationPolicies.policyVersion, world.policyVersion));
    await getDb()
      .delete(moderationPolicySeverityRules)
      .where(
        and(
          eq(moderationPolicySeverityRules.policyId, policy.id),
          eq(moderationPolicySeverityRules.severity, 'medium')
        )
      );
    const event = makeEvent(world);

    const result = await moderationReputationService.applyModerationDecision(
      event,
      world.context
    );

    expect(result.applied).toBe(false);
    expect(result.skipReason).toBe('finding_not_in_policy');
    await expectNothingWritten(world, event.incidentId);
  });
});

describe('validation — the reported application must be permitted', () => {
  it('a sandboxed application moderates locally and produces no global effect', async () => {
    const world = await makeWorld({ globalEffects: false });
    const event = makeEvent(world);

    const result = await moderationReputationService.applyModerationDecision(
      event,
      world.context
    );

    expect(result.applied).toBe(false);
    expect(result.skipReason).toBe('application_not_permitted');
    await expectNothingWritten(world, event.incidentId);
  });

  it('an application with NO trust row fails safe — local only', async () => {
    // Forgetting to configure an application must mean "it touches nothing
    // global", never "it can penalise arbitrary Oxy users".
    const subjectId = await makeUser();
    const applicationId = await makeApplication();
    const bindingId = await makeBinding(applicationId, subjectId);
    const policyVersion = await makePolicy();
    const emitterApplicationId = await makeApplication();
    const world: World = {
      subjectId,
      applicationId,
      bindingId,
      policyVersion,
      emitterApplicationId,
      context: { emitterApplicationId },
    };
    mockResolveBindingProof.mockResolvedValue({ ok: true, binding: { id: bindingId } });
    const event = makeEvent(world);

    const result = await moderationReputationService.applyModerationDecision(
      event,
      world.context
    );

    expect(result.applied).toBe(false);
    expect(result.skipReason).toBe('application_not_permitted');
    await expectNothingWritten(world, event.incidentId);
  });
});

describe('the service does not trust its caller', () => {
  /*
   * Every method here is EXPORTED: a queue worker, a reconciliation script or a
   * future caller is under no obligation to have passed a body through the
   * route's zod schema. `as never` is how a test reaches a shape the type
   * system exists to forbid — which is the point, since the runtime must hold
   * even when the types were bypassed.
   */

  it('rejects a malformed decisionRevision rather than silently matching nothing', async () => {
    const world = await makeWorld();
    const event = makeEvent(world, { decisionRevision: 'not-a-number' as never });

    await expect(
      moderationReputationService.applyModerationDecision(event, world.context)
    ).rejects.toThrow(/decisionRevision must be a positive integer/);
    await expectNothingWritten(world, event.incidentId);
  });

  it('rejects a malformed occurredAt rather than defeating the binding time check', async () => {
    // An invalid date yields `NaN`, and every comparison against `NaN` is
    // false — so `verifiedAt > occurredAt` would be false and a binding created
    // AFTER the action would sail through the one check that proves presence.
    const world = await makeWorld();
    const event = makeEvent(world, { occurredAt: 'not-a-date' });

    await expect(
      moderationReputationService.applyModerationDecision(event, world.context)
    ).rejects.toThrow(/occurredAt must be a valid ISO 8601 timestamp/);
    await expectNothingWritten(world, event.incidentId);
  });

  it('cannot be made to reverse an unrelated decision by a non-string decisionId', async () => {
    const world = await makeWorld();
    const event = makeEvent(world);
    await moderationReputationService.applyModerationDecision(event, world.context);

    await expect(
      moderationReputationService.reverseModerationDecision(
        { toString: () => 'anything' } as never,
        1,
        'Appeal accepted',
        world.context.emitterCredentialId!
      )
    ).rejects.toThrow(/No moderation effect/);

    // The real consequence is untouched: nothing was compensated.
    const [effect] = await effectRows(event.incidentId);
    expect(effect.status).toBe('applied');
    const [strike] = await strikeRows(world.subjectId);
    expect(strike.status).toBe('active');
    expect(await ledgerRows(world.subjectId)).toHaveLength(1);
  });
});

// ===========================================================================
// REPETITION, CAPS AND THE PRIMARY FINDING
// ===========================================================================

describe('repetition and multi-finding caps', () => {
  it('carries no multiplier for a first similar incident', async () => {
    const world = await makeWorld();
    const result = await moderationReputationService.applyModerationDecision(
      makeEvent(world),
      world.context
    );

    expect(result.effect?.repetitionMultiplier).toBe(1);
    expect(result.effect?.points).toBe(-8);
    expect(result.effect?.multiFindingMultiplier).toBe(1);
  });

  it('escalates a second similar incident by the policy multiplier', async () => {
    const world = await makeWorld();
    await moderationReputationService.applyModerationDecision(makeEvent(world), world.context);

    const second = await moderationReputationService.applyModerationDecision(
      makeEvent(world),
      world.context
    );

    expect(second.effect?.repetitionMultiplier).toBe(1.5);
    expect(second.effect?.points).toBe(-12);
    expect(second.effect?.activeRisk).toBe(5); // round(3 × 1.5)
  });

  it('counts DISTINCT incidents, so two axes in one incident escalate once', async () => {
    // A person who is both the author and a colluding reporter in ONE incident
    // has offended once. Both strikes below carry the SAME family, so they both
    // reach the repetition lookup: an implementation that counted STRIKES
    // rather than distinct incidents would jump the next incident to the third
    // multiplier (2.0) instead of the second (1.5).
    const world = await makeWorld();
    const first = makeEvent(world);
    await moderationReputationService.applyModerationDecision(first, world.context);
    await moderationReputationService.applyModerationDecision(
      makeEvent(world, {
        incidentId: first.incidentId,
        decisionId: first.decisionId,
        findings: [{ ...HARASSMENT_MEDIUM, attribution: 'reporter' }],
      }),
      world.context
    );
    const strikes = await strikeRows(world.subjectId);
    expect(strikes).toHaveLength(2);
    expect(strikes.every((row) => row.family === 'harassment')).toBe(true);

    const next = await moderationReputationService.applyModerationDecision(
      makeEvent(world),
      world.context
    );
    expect(next.effect?.repetitionMultiplier).toBe(1.5);
  });

  it('does not treat a REVERSED prior strike as a prior offence', async () => {
    const world = await makeWorld();
    const first = makeEvent(world);
    await moderationReputationService.applyModerationDecision(first, world.context);
    await moderationReputationService.reverseModerationDecision(
      first.decisionId,
      1,
      'Appeal accepted',
      world.context.emitterCredentialId!
    );

    const next = await moderationReputationService.applyModerationDecision(
      makeEvent(world),
      world.context
    );
    expect(next.effect?.repetitionMultiplier).toBe(1);
  });

  it('does not escalate across conduct FAMILIES', async () => {
    const world = await makeWorld();
    await moderationReputationService.applyModerationDecision(makeEvent(world), world.context);

    const other = await moderationReputationService.applyModerationDecision(
      makeEvent(world, {
        findings: [{ ...HARASSMENT_MEDIUM, family: 'spam', code: 'spam.bulk' }],
      }),
      world.context
    );
    expect(other.effect?.repetitionMultiplier).toBe(1);
  });

  it('bounds escalation at the last multiplier the policy declares', async () => {
    const world = await makeWorld();
    for (let i = 0; i < 6; i += 1) {
      await moderationReputationService.applyModerationDecision(
        makeEvent(world),
        world.context
      );
    }

    const strikes = await strikeRows(world.subjectId);
    expect(strikes).toHaveLength(6);
    const ceiling = BASELINE_REPETITION_MULTIPLIERS[BASELINE_REPETITION_MULTIPLIERS.length - 1];
    const effects = await getDb()
      .select({ multiplier: moderationEffects.repetitionMultiplier })
      .from(moderationEffects)
      .where(eq(moderationEffects.principalId, world.subjectId));
    expect(effects).toHaveLength(6);
    expect(Math.max(...effects.map((row) => row.multiplier))).toBe(ceiling);
  });

  it('caps what secondary findings can add', async () => {
    // Five effective findings would be 1 + 4 × 0.25 = 2.0 uncapped; the policy
    // caps at 1.5, so stacking taxonomy labels cannot manufacture a sanction.
    const world = await makeWorld();
    const result = await moderationReputationService.applyModerationDecision(
      makeEvent(world, {
        findings: [
          HARASSMENT_MEDIUM,
          { ...HARASSMENT_MEDIUM, code: 'harassment.b', severity: 'low' },
          { ...HARASSMENT_MEDIUM, code: 'harassment.c', severity: 'low' },
          { ...HARASSMENT_MEDIUM, code: 'harassment.d', severity: 'low' },
          { ...HARASSMENT_MEDIUM, code: 'harassment.e', severity: 'low' },
        ],
      }),
      world.context
    );

    expect(result.effect?.multiFindingMultiplier).toBe(BASELINE_MULTI_FINDING_CAP);
    expect(result.effect?.points).toBe(-12); // round(−8 × 1.5)
  });

  it('derives from the MOST SEVERE recognised finding', async () => {
    const world = await makeWorld();
    const result = await moderationReputationService.applyModerationDecision(
      makeEvent(world, {
        findings: [
          { ...HARASSMENT_MEDIUM, severity: 'low', code: 'harassment.mild' },
          { ...HARASSMENT_MEDIUM, severity: 'high', code: 'harassment.severe' },
        ],
      }),
      world.context
    );

    expect(result.effect?.severity).toBe('high');
    // `high` is −20 / risk 8, with a 1.25 multiplier for one secondary finding.
    expect(result.effect?.points).toBe(-25);
    const [strike] = await strikeRows(world.subjectId);
    expect(strike.severity).toBe('high');
    expect(strike.riskPoints).toBe(10);
  });

  it('ignores an UNRECOGNISED finding when choosing the primary', async () => {
    // A family the policy does not know must not be able to become the primary
    // and drag the whole consequence up a band.
    const world = await makeWorld();
    const result = await moderationReputationService.applyModerationDecision(
      makeEvent(world, {
        findings: [
          HARASSMENT_MEDIUM,
          { ...HARASSMENT_MEDIUM, severity: 'critical', family: 'astrology', code: 'astrology.x' },
        ],
      }),
      world.context
    );

    expect(result.effect?.severity).toBe('medium');
    expect(result.effect?.multiFindingMultiplier).toBe(1);
    expect(result.effect?.points).toBe(-8);
  });

  it('restricts standing outright on a critical finding, with no expiry on the strike', async () => {
    const world = await makeWorld();
    const result = await moderationReputationService.applyModerationDecision(
      makeEvent(world, {
        findings: [
          {
            ...HARASSMENT_MEDIUM,
            severity: 'critical',
            family: 'child_safety',
            code: 'child_safety.csam',
          },
        ],
      }),
      world.context
    );

    expect(result.effect?.activeRisk).toBe(20);
    const [strike] = await strikeRows(world.subjectId);
    // A critical strike needs a specialised recovery review, not a timer.
    expect(strike.expiresAt).toBeNull();
    expect((await reputationService.getBalance(world.subjectId)).conduct.standing).toBe(
      'restricted'
    );
  });
});

// ===========================================================================
// EXPIRY
// ===========================================================================

describe('expireConductStrikes', () => {
  it('resolves a lapsed strike while its ledger entry survives', async () => {
    const world = await makeWorld();
    const event = makeEvent(world);
    await moderationReputationService.applyModerationDecision(event, world.context);
    await getDb()
      .update(conductStrikes)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(conductStrikes.userId, world.subjectId));

    const result = await moderationReputationService.expireConductStrikes(100);

    expect(result).toEqual({ expired: 1, subjects: 1 });
    const [strike] = await strikeRows(world.subjectId);
    expect(strike.status).toBe('expired');
    expect(strike.resolvedAt).toBeInstanceOf(Date);

    // The consequence decayed; the history did not.
    const ledger = await ledgerRows(world.subjectId);
    expect(ledger).toHaveLength(1);
    expect(ledger[0].points).toBe(-8);
    expect(ledger[0].status).toBe('active');
    const balance = await reputationService.getBalance(world.subjectId);
    expect(balance.conduct).toMatchObject({ activeRisk: 0, standing: 'good' });
    expect(balance.total).toBe(-8);
  });

  it('never sweeps a critical strike, which carries no expiry', async () => {
    const world = await makeWorld();
    await moderationReputationService.applyModerationDecision(
      makeEvent(world, {
        findings: [
          {
            ...HARASSMENT_MEDIUM,
            severity: 'critical',
            family: 'child_safety',
            code: 'child_safety.csam',
          },
        ],
      }),
      world.context
    );

    const result = await moderationReputationService.expireConductStrikes(100);

    expect(result).toEqual({ expired: 0, subjects: 0 });
    const [strike] = await strikeRows(world.subjectId);
    expect(strike.status).toBe('active');
  });

  it('leaves a not-yet-due strike alone', async () => {
    const world = await makeWorld();
    await moderationReputationService.applyModerationDecision(makeEvent(world), world.context);

    const result = await moderationReputationService.expireConductStrikes(100);

    expect(result).toEqual({ expired: 0, subjects: 0 });
    const [strike] = await strikeRows(world.subjectId);
    expect(strike.status).toBe('active');
  });

  it('bounds one pass by the limit, so a backlog cannot stall a tick', async () => {
    const world = await makeWorld();
    for (let i = 0; i < 3; i += 1) {
      await moderationReputationService.applyModerationDecision(
        makeEvent(world),
        world.context
      );
    }
    await getDb()
      .update(conductStrikes)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(conductStrikes.userId, world.subjectId));

    const first = await moderationReputationService.expireConductStrikes(2);
    expect(first).toEqual({ expired: 2, subjects: 1 });
    expect(
      (await strikeRows(world.subjectId)).filter((row) => row.status === 'active')
    ).toHaveLength(1);

    // The remainder is picked up by the next tick rather than lost.
    const second = await moderationReputationService.expireConductStrikes(2);
    expect(second).toEqual({ expired: 1, subjects: 1 });
    expect(
      (await strikeRows(world.subjectId)).filter((row) => row.status === 'expired')
    ).toHaveLength(3);
  });

  it('does not overwrite a strike a concurrent reversal already resolved', async () => {
    // The sweep's update is predicated on `status = 'active'`, so a reversal
    // wins rather than being rewritten into `expired` — which would also
    // violate the resolution CHECK if the two disagreed.
    const world = await makeWorld();
    const event = makeEvent(world);
    await moderationReputationService.applyModerationDecision(event, world.context);
    await moderationReputationService.reverseModerationDecision(
      event.decisionId,
      1,
      'Appeal accepted',
      world.context.emitterCredentialId!
    );
    await getDb()
      .update(conductStrikes)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(conductStrikes.userId, world.subjectId));

    const result = await moderationReputationService.expireConductStrikes(100);

    expect(result).toEqual({ expired: 0, subjects: 0 });
    const [strike] = await strikeRows(world.subjectId);
    expect(strike.status).toBe('reversed');
  });
});

// ===========================================================================
// RECONCILIATION
// ===========================================================================

describe('reconcileModerationIncident', () => {
  /** Detach and remove a strike, leaving the effect that created it behind. */
  async function loseTheStrike(incidentId: string, userId: string): Promise<void> {
    // `moderation_effects.strike_id` cascades, so the pointer must go first or
    // the effect disappears with the strike and there is nothing to repair.
    await getDb()
      .update(moderationEffects)
      .set({ strikeId: null })
      .where(eq(moderationEffects.incidentId, incidentId));
    await getDb().delete(conductStrikes).where(eq(conductStrikes.userId, userId));
  }

  it('examines a healthy incident and writes nothing', async () => {
    const world = await makeWorld();
    const event = makeEvent(world);
    await moderationReputationService.applyModerationDecision(event, world.context);

    const result = await moderationReputationService.reconcileModerationIncident(
      event.incidentId
    );

    expect(result).toEqual({
      incidentId: event.incidentId,
      effectsExamined: 1,
      strikesRepaired: 0,
      supersededReversed: 0,
      balancesRecalculated: 0,
    });
    const [strike] = await strikeRows(world.subjectId);
    expect(strike.status).toBe('active');
    expect(await ledgerRows(world.subjectId)).toHaveLength(1);
  });

  it('repairs an effect whose strike never landed', async () => {
    // Points deducted, standing unmoved — silent, and nothing but a
    // reconciliation pass ever notices.
    const world = await makeWorld();
    const event = makeEvent(world);
    await moderationReputationService.applyModerationDecision(event, world.context);
    await loseTheStrike(event.incidentId, world.subjectId);
    expect((await reputationService.recalculateBalance(world.subjectId)).conduct.activeRisk).toBe(
      0
    );

    const result = await moderationReputationService.reconcileModerationIncident(
      event.incidentId
    );

    expect(result.strikesRepaired).toBe(1);
    expect(result.balancesRecalculated).toBe(1);
    const strikes = await strikeRows(world.subjectId);
    expect(strikes).toHaveLength(1);
    expect(strikes[0].riskPoints).toBe(3);
    expect(strikes[0].status).toBe('active');
    // The effect points at the repaired strike, so the pair cannot disagree
    // again about whether a consequence exists.
    const [effect] = await effectRows(event.incidentId);
    expect(effect.strikeId).toBe(strikes[0].id);
    expect((await reputationService.getBalance(world.subjectId)).conduct.activeRisk).toBe(3);
    // The repair does NOT deduct a second time.
    expect(await ledgerRows(world.subjectId)).toHaveLength(1);
  });

  /*
   * A REPAIR MUST NOT BE HARSHER THAN THE ORIGINAL. The first version of the
   * repair passed `expiresAt: undefined` — and since the sweep only selects
   * strikes that HAVE an `expiresAt`, that silently converted a 90-day medium
   * consequence into a permanent one. Nothing else would have surfaced it: the
   * repaired strike looks correct in every other respect.
   */

  it('gives a repaired strike the ORIGINAL expiry window', async () => {
    const world = await makeWorld();
    const event = makeEvent(world);
    await moderationReputationService.applyModerationDecision(event, world.context);
    const [before] = await strikeRows(world.subjectId);
    const originalExpiry = before.expiresAt;
    expect(originalExpiry).toBeInstanceOf(Date);
    await loseTheStrike(event.incidentId, world.subjectId);

    await moderationReputationService.reconcileModerationIncident(event.incidentId);

    // Measured from the effect's `appliedAt`, not from the repair — otherwise
    // the subject is punished for however long the strike was missing.
    const [repaired] = await strikeRows(world.subjectId);
    expect(repaired.expiresAt).toBeInstanceOf(Date);
    expect(
      Math.abs(Number(repaired.expiresAt?.getTime()) - Number(originalExpiry?.getTime()))
    ).toBeLessThan(2000);
    expect(repaired.status).toBe('active');
  });

  it('creates a repaired strike EXPIRED when its window has already passed', async () => {
    // Otherwise reconciliation resurrects a consequence that had lapsed — and
    // one resurrected as `active` with a past expiry would be swept immediately,
    // while one with no expiry would never lapse again at all.
    const world = await makeWorld();
    const event = makeEvent(world);
    await moderationReputationService.applyModerationDecision(event, world.context);
    await loseTheStrike(event.incidentId, world.subjectId);
    // The effect was applied a year ago; a medium strike lapses after 90 days.
    await getDb()
      .update(moderationEffects)
      .set({ appliedAt: new Date(Date.now() - 365 * 24 * 60 * 60 * 1000) })
      .where(eq(moderationEffects.incidentId, event.incidentId));

    await moderationReputationService.reconcileModerationIncident(event.incidentId);

    const [repaired] = await strikeRows(world.subjectId);
    expect(repaired.status).toBe('expired');
    expect(repaired.resolvedAt).toBeInstanceOf(Date);
    const balance = await reputationService.getBalance(world.subjectId);
    expect(balance.conduct).toMatchObject({ activeRisk: 0, standing: 'good' });
  });

  it('keeps a repaired CRITICAL strike permanent, because that one is correct', async () => {
    const world = await makeWorld();
    const event = makeEvent(world, {
      findings: [
        {
          ...HARASSMENT_MEDIUM,
          severity: 'critical',
          family: 'child_safety',
          code: 'child_safety.csam',
        },
      ],
    });
    await moderationReputationService.applyModerationDecision(event, world.context);
    await loseTheStrike(event.incidentId, world.subjectId);

    await moderationReputationService.reconcileModerationIncident(event.incidentId);

    const [repaired] = await strikeRows(world.subjectId);
    expect(repaired.expiresAt).toBeNull();
    expect(repaired.status).toBe('active');
    expect(repaired.riskPoints).toBe(20);
  });

  it('reverses a consequence a later revision superseded', async () => {
    const world = await makeWorld();
    const first = makeEvent(world);
    await moderationReputationService.applyModerationDecision(first, world.context);
    await moderationReputationService.applyModerationDecision(
      makeEvent(world, {
        incidentId: first.incidentId,
        decisionId: first.decisionId,
        decisionRevision: 2,
      }),
      world.context
    );

    const result = await moderationReputationService.reconcileModerationIncident(
      first.incidentId
    );

    expect(result.supersededReversed).toBe(1);
    const effects = await effectRows(first.incidentId);
    expect(effects.find((row) => row.decisionRevision === 1)?.status).toBe('reversed');
    expect(effects.find((row) => row.decisionRevision === 2)?.status).toBe('applied');
    // Revision 1's points were compensated and its risk removed; revision 2
    // still stands.
    const strikes = await strikeRows(world.subjectId);
    expect(strikes.find((row) => row.decisionRevision === 1)?.status).toBe('reversed');
    expect(strikes.find((row) => row.decisionRevision === 2)?.status).toBe('active');
    expect((await reputationService.getBalance(world.subjectId)).conduct.activeStrikes).toBe(1);
  });

  it('is idempotent — a second pass over a repaired incident changes nothing', async () => {
    const world = await makeWorld();
    const event = makeEvent(world);
    await moderationReputationService.applyModerationDecision(event, world.context);
    await loseTheStrike(event.incidentId, world.subjectId);
    await moderationReputationService.reconcileModerationIncident(event.incidentId);

    const again = await moderationReputationService.reconcileModerationIncident(
      event.incidentId
    );

    expect(again.strikesRepaired).toBe(0);
    expect(again.supersededReversed).toBe(0);
    expect(await strikeRows(world.subjectId)).toHaveLength(1);
    expect(await ledgerRows(world.subjectId)).toHaveLength(1);
  });
});

// ===========================================================================
// FINALIZE
// ===========================================================================

describe('finalizeModerationDecision', () => {
  it('re-derives the snapshot from the durable effect and strike', async () => {
    const world = await makeWorld();
    const event = makeEvent(world);
    await moderationReputationService.applyModerationDecision(event, world.context);
    // A snapshot that disagrees with the durable rows — what a lost dispatch
    // leaves behind.
    await getDb()
      .update(reputationBalances)
      .set({ conductActiveRisk: 0, conductActiveStrikes: 0, conductStanding: 'good' })
      .where(eq(reputationBalances.userId, world.subjectId));

    const effects = await moderationReputationService.finalizeModerationDecision(
      event.decisionId,
      1
    );

    expect(effects).toHaveLength(1);
    const balance = await reputationService.getBalance(world.subjectId);
    expect(balance.conduct).toMatchObject({
      activeRisk: 3,
      activeStrikes: 1,
      standing: 'watch',
    });
    // Re-deriving must never double-count: the ledger is untouched.
    expect(await ledgerRows(world.subjectId)).toHaveLength(1);
  });

  it('cannot conjure a consequence from a decision id alone', async () => {
    await expect(
      moderationReputationService.finalizeModerationDecision(
        `dec_never_${uniqueId().slice(0, 8)}`,
        1
      )
    ).rejects.toThrow(/No moderation effect/);
  });
});

// ===========================================================================
// CONDUCT ACTION TYPES ARE BRIDGE-ONLY
// ===========================================================================

describe('conduct action types are bridge-only', () => {
  /*
   * "No binding proof, no Oxy Trust effect" is one-way, so the question worth
   * asking is not whether the bridge is guarded — it is whether a conduct
   * penalty can be reached WITHOUT the bridge at all. The ordinary award path
   * needs a `reputation_rules` row and none exists for a conduct action; but
   * that is an ABSENCE, not a guard. Both cases below create the rule an
   * operator would have had to create, so the absence cannot stand in for the
   * check.
   */

  it('refuses an award of a conduct action type without a policy-derived override', async () => {
    const userId = await makeUser();
    const applicationId = await makeApplication();
    // Inserted directly, because `upsertRule` refuses to create it (below).
    await getDb()
      .insert(reputationRules)
      .values({
        actionType: MODERATION_VIOLATION_ACTIONS.high,
        points: -20,
        category: 'penalty',
        description: 'smuggled conduct rule',
        cooldownInMinutes: 0,
        isEnabled: true,
      })
      .onConflictDoNothing();

    await expect(
      reputationService.award({
        userId,
        actionType: MODERATION_VIOLATION_ACTIONS.high,
        applicationId,
        sourceActionId: `attacker-chosen-${uniqueId().slice(0, 8)}`,
      })
    ).rejects.toThrow(/produced only by the moderation reputation bridge/);
    expect(await ledgerRows(userId)).toEqual([]);
  });

  it('refuses to create a conduct rule in the first place', async () => {
    await expect(
      reputationService.upsertRule({
        actionType: REPORT_ABUSE_CONFIRMED_ACTION,
        points: -50,
        category: 'penalty',
        description: 'smuggled',
      })
    ).rejects.toThrow(/versioned Oxy conduct policy/);
  });

  it('still lets the bridge through, because it supplies the policy override', async () => {
    const world = await makeWorld();
    const event = makeEvent(world);

    const result = await moderationReputationService.applyModerationDecision(
      event,
      world.context
    );

    expect(result.applied).toBe(true);
    const ledger = await ledgerRows(world.subjectId);
    expect(ledger).toHaveLength(1);
    expect(ledger[0].actionType).toBe(MODERATION_VIOLATION_ACTIONS.medium);
    // No `reputation_rules` row for that action was needed.
    const rules = await getDb()
      .select({ id: reputationRules.id })
      .from(reputationRules)
      .where(eq(reputationRules.actionType, MODERATION_VIOLATION_ACTIONS.medium));
    expect(rules).toEqual([]);
  });
});

// ===========================================================================
// CONTRIBUTION NEVER CANCELS CONDUCT
// ===========================================================================

describe('contribution points never cancel an active strike', () => {
  /** Award legitimate, non-conduct contribution to a subject. */
  async function seedContribution(userId: string, points: number): Promise<void> {
    const actionType = `contribution_${uniqueId().slice(0, 12)}`;
    await reputationService.upsertRule({
      actionType,
      points,
      category: 'physical',
      description: 'contribution fixture',
      cooldownInMinutes: 0,
      isEnabled: true,
    });
    await reputationService.award({ userId, actionType });
  }

  it('lets a high contribution tier and a limited standing coexist', async () => {
    const world = await makeWorld();
    await moderationReputationService.applyModerationDecision(
      makeEvent(world, { findings: [{ ...HARASSMENT_MEDIUM, severity: 'high' }] }),
      world.context
    );
    expect((await reputationService.getBalance(world.subjectId)).conduct.standing).toBe(
      'limited'
    );

    await seedContribution(world.subjectId, 5000);
    const balance = await reputationService.recalculateBalance(world.subjectId);

    // THE PAIR the multidimensional model exists to make representable: a long
    // genuine contribution history AND an active consequence, reported side by
    // side rather than netted into one number.
    expect(balance.contribution).toMatchObject({ tier: 'high_trust', points: 5000 });
    expect(balance.conduct).toMatchObject({
      activeRisk: 8,
      activeStrikes: 1,
      standing: 'limited',
    });
  });

  it('cannot buy off a RESTRICTED standing with any amount of contribution', async () => {
    const world = await makeWorld();
    await moderationReputationService.applyModerationDecision(
      makeEvent(world, {
        findings: [
          {
            ...HARASSMENT_MEDIUM,
            severity: 'critical',
            family: 'child_safety',
            code: 'child_safety.csam',
          },
        ],
      }),
      world.context
    );

    await seedContribution(world.subjectId, 50_000);
    const balance = await reputationService.recalculateBalance(world.subjectId);

    expect(balance.contribution.tier).toBe('high_trust');
    expect(balance.conduct).toMatchObject({ activeRisk: 20, standing: 'restricted' });
    // A consumer that only knows about the legacy `trustTier` must not be told
    // the account is unremarkable.
    expect(balance.trustTier).toBe('restricted');
    // Every contextual weight is floored, so a restricted account is neither
    // drawn for review nor prioritised as a reporter.
    expect(balance.contextualInfluence.reviewSelectionWeight).toBe(CONTEXTUAL_WEIGHT_MIN);
  });

  it('keeps the conduct penalty in the TOTAL, so the ledger stays honest', async () => {
    // Contribution EXCLUDES the penalty; `total` does not. The ledger says what
    // happened; the axes say what it means.
    const world = await makeWorld();
    await moderationReputationService.applyModerationDecision(makeEvent(world), world.context);
    await seedContribution(world.subjectId, 100);

    const balance = await reputationService.recalculateBalance(world.subjectId);

    expect(balance.total).toBe(92); // 100 − 8
    expect(balance.contribution.points).toBe(100);
  });
});

// ===========================================================================
// WHAT A CONDUCT LEDGER ROW IS ALLOWED TO KNOW
// ===========================================================================

describe('the conduct ledger row explains itself without becoming a dossier', () => {
  it('carries the severity, the family and the policy version — never the taxonomy code', async () => {
    const world = await makeWorld();
    const event = makeEvent(world);
    await moderationReputationService.applyModerationDecision(event, world.context);

    const [row] = await ledgerRows(world.subjectId);
    const metadata = row.metadata;
    expect(metadata).toMatchObject({
      incidentId: event.incidentId,
      decisionRevision: 1,
      severity: 'medium',
      family: 'harassment',
      policyVersion: world.policyVersion,
    });
    // The ledger is readable by its subject.
    expect(JSON.stringify(metadata)).not.toContain('targeted_abuse');
    expect(metadata).not.toHaveProperty('reporterId');
    expect(metadata).not.toHaveProperty('victimId');
  });

  it('names the incident as the target entity, and the effect keeps the proof hash', async () => {
    const world = await makeWorld();
    const event = makeEvent(world);
    await moderationReputationService.applyModerationDecision(event, world.context);

    const [transaction] = await getDb()
      .select({
        targetEntityId: reputationTransactions.targetEntityId,
        targetEntityType: reputationTransactions.targetEntityType,
        applicationId: reputationTransactions.applicationId,
        category: reputationTransactions.category,
      })
      .from(reputationTransactions)
      .where(eq(reputationTransactions.userId, world.subjectId));
    expect(transaction).toMatchObject({
      targetEntityId: event.incidentId,
      targetEntityType: 'manual_review',
      applicationId: world.applicationId,
      category: 'penalty',
    });

    const [effect] = await effectRows(event.incidentId);
    // Provenance without contents: a hash of the private decision, and the
    // three policy versions it was decided under.
    expect(effect.proofHash).toBe(event.proofHash);
    expect(effect.policyVersionUniversal).toBe('2026.1');
    expect(effect.policyVersionApplication).toBe('mention.2026.07');
  });

  it('exposes the effect’s ledger row for the owner-facing explanation surface', async () => {
    const world = await makeWorld();
    const event = makeEvent(world);
    const result = await moderationReputationService.applyModerationDecision(
      event,
      world.context
    );
    expect(result.effect).toBeDefined();
    if (!result.effect) return;

    const transaction = await moderationReputationService.getEffectTransaction(result.effect);

    expect(transaction).not.toBeNull();
    expect(transaction?.id).toBe(result.effect.transactionId);
    expect(transaction?.points).toBe(-8);
  });
});

// ===========================================================================
// THE POLICY VERSION ITSELF
// ===========================================================================

describe('seedBaselinePolicy', () => {
  it('lands the version and both child tables together', async () => {
    const policyVersion = await makePolicy();

    const [policy] = await getDb()
      .select()
      .from(moderationPolicies)
      .where(eq(moderationPolicies.policyVersion, policyVersion));
    expect(policy).toBeDefined();
    expect(policy.status).toBe('active');
    expect(policy.provisionalEffectsAllowed).toBe(false);
    expect(policy.conductFamilies).toEqual([...BASELINE_CONDUCT_FAMILIES]);
    expect(policy.repetitionMultipliers).toEqual([...BASELINE_REPETITION_MULTIPLIERS]);

    const severities = await getDb()
      .select()
      .from(moderationPolicySeverityRules)
      .where(eq(moderationPolicySeverityRules.policyId, policy.id));
    expect(severities).toHaveLength(BASELINE_SEVERITY_RULES.length);
    const critical = severities.find((row) => row.severity === 'critical');
    // NULL is MEANINGFUL here: the risk does not lapse on its own.
    expect(critical?.riskExpiryDays).toBeNull();
    expect(severities.find((row) => row.severity === 'medium')?.riskExpiryDays).toBe(90);

    const thresholds = await getDb()
      .select()
      .from(moderationPolicyStandingThresholds)
      .where(eq(moderationPolicyStandingThresholds.policyId, policy.id));
    expect(thresholds).toHaveLength(BASELINE_STANDING_THRESHOLDS.length);
  });

  it('is idempotent and does NOT edit a published version', async () => {
    // A published version is immutable: a new tuning is a NEW version, never an
    // edit of the one past decisions were made under.
    const policyVersion = await makePolicy();
    await moderationReputationService.seedBaselinePolicy({
      policyVersion,
      severityRules: [{ severity: 'medium', points: -999, riskPoints: 999, riskExpiryDays: 1 }],
      conductFamilies: ['nothing_like_the_baseline'],
      repetitionMultipliers: [9],
      repetitionWindowDays: 1,
      multiFindingSecondaryShare: 9,
      multiFindingCap: 9,
      standingThresholds: [{ standing: 'restricted', minRisk: 0 }],
    });

    const [policy] = await getDb()
      .select()
      .from(moderationPolicies)
      .where(eq(moderationPolicies.policyVersion, policyVersion));
    expect(policy.conductFamilies).toEqual([...BASELINE_CONDUCT_FAMILIES]);
    expect(policy.multiFindingCap).toBe(BASELINE_MULTI_FINDING_CAP);

    const severities = await getDb()
      .select({ points: moderationPolicySeverityRules.points })
      .from(moderationPolicySeverityRules)
      .where(eq(moderationPolicySeverityRules.policyId, policy.id));
    expect(severities).toHaveLength(BASELINE_SEVERITY_RULES.length);
    expect(severities.map((row) => row.points)).not.toContain(-999);
  });

  it('derives the consequence from the version the DECISION names, not the newest one', async () => {
    // Two live versions with different figures; the event names the older one,
    // so the older one's figures are what land.
    const world = await makeWorld();
    const laterVersion = `oxy.test.${uniqueId().slice(0, 16)}`;
    await moderationReputationService.seedBaselinePolicy({
      policyVersion: laterVersion,
      severityRules: [{ severity: 'medium', points: -400, riskPoints: 40, riskExpiryDays: 5 }],
      conductFamilies: BASELINE_CONDUCT_FAMILIES,
      repetitionMultipliers: BASELINE_REPETITION_MULTIPLIERS,
      repetitionWindowDays: BASELINE_REPETITION_WINDOW_DAYS,
      multiFindingSecondaryShare: BASELINE_MULTI_FINDING_SECONDARY_SHARE,
      multiFindingCap: BASELINE_MULTI_FINDING_CAP,
      standingThresholds: BASELINE_STANDING_THRESHOLDS,
    });

    const result = await moderationReputationService.applyModerationDecision(
      makeEvent(world),
      world.context
    );

    expect(result.effect?.points).toBe(-8);
    expect(result.effect?.policyVersionOxyConduct).toBe(world.policyVersion);
  });
});
