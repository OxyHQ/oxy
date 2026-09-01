/**
 * THE INVARIANT of `scripts/register-commons-clients.ts`, pinned: the dry run
 * reports EXACTLY what the real run does.
 *
 * The bug this suite exists to prevent, reproduced from production: a
 * `DRY_RUN=1` run reported `appsUpdated: 0` / `updatedApplication: false` for
 * Commons, and the real run seconds later reported `appsUpdated: 2` /
 * `updatedApplication: true` because it granted the `identity:approval`
 * capability. The dry run had simply not computed the capability union — the
 * whole reconcile block lived inside `if (!dryRun)`. A dry run that says
 * "nothing" and then changes something is worse than none: the next operator
 * trusts it.
 *
 * So the parity asserted here is structural, not a coincidence of two code paths
 * agreeing today:
 *
 *   - `computeApplicationPlan` is the ONLY place a change is decided, and the
 *     script calls it unconditionally (DRY_RUN gates the WRITE, nothing else).
 *   - `applyApplicationPlan` is the ONLY writer, and it writes strictly the
 *     fields the plan reported — proven below by comparing the plan against the
 *     mutation it actually produces, field for field.
 *
 * No database: the plan module is pure, and the writer is generic over the
 * owner-id type precisely so a plain object can stand in for the Mongoose
 * document here.
 */

import {
  applyApplicationPlan,
  computeApplicationPlan,
  readApplicationState,
  PENDING_OWNER_ACCOUNT,
  type ApplicationRegistrationField,
  type ApplicationRegistrationState,
  type ApplicationRegistrationTarget,
  type MutableApplicationFields,
} from '../registerCommonsClientsPlan';

const OWNER = '6a2f9d8989b795cfdfac350f';

/** The registered target for Commons, verbatim from the script's CLIENTS spec. */
const COMMONS_TARGET: ApplicationRegistrationTarget = {
  type: 'first_party',
  redirectUris: ['commons://', 'oxycommons://'],
  scopes: ['user:read'],
  capabilities: ['identity:approval'],
  ownerAccountId: OWNER,
};

/** A stored Commons record that is fully reconciled EXCEPT the capability. */
function commonsMissingCapability(): ApplicationRegistrationState {
  return {
    status: 'active',
    type: 'first_party',
    isOfficial: true,
    isInternal: false,
    ownerAccountId: OWNER,
    redirectUris: ['commons://', 'oxycommons://'],
    scopes: ['user:read'],
    capabilities: [],
  };
}

/** The same record, already carrying the capability — nothing left to do. */
function commonsFullyReconciled(): ApplicationRegistrationState {
  return { ...commonsMissingCapability(), capabilities: ['identity:approval'] };
}

/**
 * Stand-in for the Mongoose document. Structurally identical to the fields the
 * real writer touches, with `string` in place of `ObjectId` — the SAME
 * `applyApplicationPlan` runs against it.
 */
function mutableRecord(state: ApplicationRegistrationState): MutableApplicationFields<string> {
  return {
    status: state.status,
    type: state.type,
    isOfficial: state.isOfficial,
    isInternal: state.isInternal,
    ownerAccountId: state.ownerAccountId ?? '',
    redirectUris: [...state.redirectUris],
    scopes: [...state.scopes],
    capabilities: [...state.capabilities],
  };
}

/** The fields whose value actually differs between two records. */
function mutatedFields(
  before: MutableApplicationFields<string>,
  after: MutableApplicationFields<string>
): ApplicationRegistrationField[] {
  const fields: ApplicationRegistrationField[] = [
    'status',
    'type',
    'isOfficial',
    'isInternal',
    'ownerAccountId',
    'redirectUris',
    'scopes',
    'capabilities',
  ];
  return fields.filter(
    (field) => JSON.stringify(before[field]) !== JSON.stringify(after[field])
  );
}

describe('register-commons-clients — the dry-run plan IS the real-run effect', () => {
  it('reports the capability union the real run performs (the production miss)', () => {
    const stored = commonsMissingCapability();

    // What DRY_RUN=1 prints…
    const plan = computeApplicationPlan(stored, COMMONS_TARGET);

    expect(plan.creates).toBe(false);
    expect(plan.changes).toEqual([
      { field: 'capabilities', from: '(none)', to: 'identity:approval' },
    ]);

    // …and what the real run actually writes.
    const before = mutableRecord(stored);
    const record = mutableRecord(stored);
    const written = applyApplicationPlan(record, plan, OWNER);

    expect(written).toEqual(['capabilities']);
    expect(mutatedFields(before, record)).toEqual(['capabilities']);
    expect(record.capabilities).toEqual(['identity:approval']);
  });

  it('reports nothing for an already-reconciled record, and writes nothing', () => {
    const stored = commonsFullyReconciled();

    const plan = computeApplicationPlan(stored, COMMONS_TARGET);
    expect(plan.changes).toEqual([]);

    const before = mutableRecord(stored);
    const record = mutableRecord(stored);
    const written = applyApplicationPlan(record, plan, OWNER);

    expect(written).toEqual([]);
    expect(mutatedFields(before, record)).toEqual([]);
  });

  it('is idempotent: applying the plan leaves a record the next plan reports as clean', () => {
    const record = mutableRecord(commonsMissingCapability());
    applyApplicationPlan(record, computeApplicationPlan(readApplicationState(record), COMMONS_TARGET), OWNER);

    const second = computeApplicationPlan(readApplicationState(record), COMMONS_TARGET);
    expect(second.changes).toEqual([]);
  });

  it('never reports a field the writer does not write, on a record needing every change', () => {
    const stale: ApplicationRegistrationState = {
      status: 'suspended',
      type: 'third_party',
      isOfficial: false,
      isInternal: true,
      ownerAccountId: '000000000000000000000001',
      redirectUris: ['https://legacy.example'],
      scopes: [],
      capabilities: [],
    };

    const plan = computeApplicationPlan(stale, COMMONS_TARGET);
    const before = mutableRecord(stale);
    const record = mutableRecord(stale);
    const written = applyApplicationPlan(record, plan, OWNER);

    expect(written).toEqual(plan.changes.map((change) => change.field));
    expect(mutatedFields(before, record)).toEqual(written);
    expect(computeApplicationPlan(readApplicationState(record), COMMONS_TARGET).changes).toEqual([]);
  });
});

describe('register-commons-clients — the plan is non-destructive', () => {
  it('UNIONs redirect URIs, scopes and capabilities instead of replacing them', () => {
    const stored: ApplicationRegistrationState = {
      ...commonsMissingCapability(),
      redirectUris: ['https://extra.example', 'commons://'],
      scopes: ['files:read'],
      capabilities: ['some:other'],
    };

    const plan = computeApplicationPlan(stored, COMMONS_TARGET);

    expect(plan.desired.redirectUris).toEqual([
      'https://extra.example',
      'commons://',
      'oxycommons://',
    ]);
    expect(plan.desired.scopes).toEqual(['files:read', 'user:read']);
    expect(plan.desired.capabilities).toEqual(['some:other', 'identity:approval']);
    expect(plan.changes.map((change) => change.field).sort()).toEqual([
      'capabilities',
      'redirectUris',
      'scopes',
    ]);
  });

  it('reports a de-duplication as the change it is', () => {
    const stored: ApplicationRegistrationState = {
      ...commonsFullyReconciled(),
      redirectUris: ['commons://', 'commons://', 'oxycommons://'],
    };

    const plan = computeApplicationPlan(stored, COMMONS_TARGET);

    expect(plan.changes).toEqual([
      {
        field: 'redirectUris',
        from: 'commons://, commons://, oxycommons://',
        to: 'commons://, oxycommons://',
      },
    ]);
  });
});

describe('register-commons-clients — a record that does not exist yet', () => {
  it('reports every field it would write, and the create payload matches', () => {
    const plan = computeApplicationPlan(null, COMMONS_TARGET);

    expect(plan.creates).toBe(true);
    expect(plan.changes.map((change) => change.field)).toEqual([
      'status',
      'type',
      'isOfficial',
      'isInternal',
      'ownerAccountId',
      'redirectUris',
      'scopes',
      'capabilities',
    ]);
    expect(plan.changes.every((change) => change.from === '(absent)')).toBe(true);
    expect(plan.desired).toEqual({
      status: 'active',
      type: 'first_party',
      isOfficial: true,
      isInternal: false,
      ownerAccountId: OWNER,
      redirectUris: ['commons://', 'oxycommons://'],
      scopes: ['user:read'],
      capabilities: ['identity:approval'],
    });
  });

  it('marks an internal application as internal', () => {
    const plan = computeApplicationPlan(null, { ...COMMONS_TARGET, type: 'internal' });
    expect(plan.desired.isInternal).toBe(true);
  });
});

describe('register-commons-clients — an owning account that does not exist yet', () => {
  it('still reports the ownerAccountId change, without inventing an id', () => {
    const stored = commonsFullyReconciled();

    // DRY_RUN with no Oxy organization account: the real run would mint one and
    // repoint the app at it. The change is real; only the id is unknowable.
    const plan = computeApplicationPlan(stored, { ...COMMONS_TARGET, ownerAccountId: null });

    expect(plan.changes).toEqual([
      { field: 'ownerAccountId', from: OWNER, to: PENDING_OWNER_ACCOUNT },
    ]);
  });

  it('writes the caller-resolved id, not the placeholder', () => {
    const stored = commonsFullyReconciled();
    const plan = computeApplicationPlan(stored, { ...COMMONS_TARGET, ownerAccountId: null });

    const record = mutableRecord(stored);
    applyApplicationPlan(record, plan, 'freshly-minted-account-id');

    expect(record.ownerAccountId).toBe('freshly-minted-account-id');
  });
});

describe('readApplicationState — legacy records', () => {
  it('reads a record with missing array fields as empty, not undefined', () => {
    const state = readApplicationState({
      status: 'active',
      type: 'first_party',
      isOfficial: true,
      isInternal: false,
      ownerAccountId: null,
    });

    expect(state).toEqual({
      status: 'active',
      type: 'first_party',
      isOfficial: true,
      isInternal: false,
      ownerAccountId: null,
      redirectUris: [],
      scopes: [],
      capabilities: [],
    });
  });

  it('stringifies an ObjectId-like owner id', () => {
    const state = readApplicationState({
      status: 'active',
      type: 'first_party',
      isOfficial: true,
      isInternal: false,
      ownerAccountId: { toString: () => OWNER },
    });

    expect(state.ownerAccountId).toBe(OWNER);
  });

  it('copies arrays instead of aliasing the document', () => {
    const redirectUris = ['commons://'];
    const state = readApplicationState({
      status: 'active',
      type: 'first_party',
      isOfficial: true,
      isInternal: false,
      ownerAccountId: null,
      redirectUris,
    });

    state.redirectUris.push('oxycommons://');
    expect(redirectUris).toEqual(['commons://']);
  });
});
