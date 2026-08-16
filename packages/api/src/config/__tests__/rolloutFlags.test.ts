/**
 * The inference platform's rollout flags (issue #972 workstream 16, "Rollout").
 *
 * ## The test this file exists for
 *
 * **Every flag is off when nothing is set.** That assertion is the whole
 * mechanism: a flag you can arm by forgetting a variable is worse than no flag,
 * because it reads as a control while defaulting to the dangerous side. It is
 * mutation-tested — flipping any default in `rolloutFlags.ts` turns
 * `the safe default` red — and each default is paired with a case that OPENS the
 * same flag, so "off" is never what a test that reads nothing would also report.
 *
 * ## The environment is cleared, not assumed
 *
 * `beforeEach` deletes all four variables rather than trusting them to be
 * absent. A sibling suite in the same worker sets three of them
 * (`routes/__tests__/inferenceEdge.test.ts`), and `process.env` is shared across
 * every file a worker runs — so an assumed-empty environment is exactly how a
 * default test would silently start measuring somebody else's fixture.
 */

jest.mock('../../utils/logger', () => ({
  logger: { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

import {
  admitToInferenceEdge,
  CATALOGUE_AUDIENCE_VARIABLE,
  CHARGING_AUTHORIZED_VARIABLE,
  describeRolloutFlags,
  EDGE_AUDIENCE_VARIABLE,
  forgetReportedMisconfigurations,
  isCataloguePublished,
  isChargingAuthorized,
  isMachineCredentialLaneEnabled,
  MACHINE_CREDENTIAL_AUTH_VARIABLE,
  resolveCatalogueAudience,
  resolveEdgeAudience,
  resolveInferenceCharging,
  resolveMachineCredentialLane,
  type EdgeAdmissionPrincipal,
} from '../rolloutFlags';
import { logger } from '../../utils/logger';

const mockedLogger = logger as jest.Mocked<typeof logger>;

const FLAG_VARIABLES = [
  EDGE_AUDIENCE_VARIABLE,
  MACHINE_CREDENTIAL_AUTH_VARIABLE,
  CHARGING_AUTHORIZED_VARIABLE,
  CATALOGUE_AUDIENCE_VARIABLE,
] as const;

const ORIGINAL = Object.fromEntries(FLAG_VARIABLES.map((key) => [key, process.env[key]]));

/** A charging authorization that is valid and comfortably in the past. */
const ARMED_CHARGING = 'commercial-launch:2026-08-01';

beforeEach(() => {
  for (const key of FLAG_VARIABLES) delete process.env[key];
  forgetReportedMisconfigurations();
  jest.clearAllMocks();
});

afterAll(() => {
  for (const [key, value] of Object.entries(ORIGINAL)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

/** The three tiers, as an admission decision reads them off an Application row. */
const THIRD_PARTY: EdgeAdmissionPrincipal = {
  applicationId: 'app_third_party',
  applicationType: 'third_party',
  applicationIsInternal: false,
};
const FIRST_PARTY: EdgeAdmissionPrincipal = {
  applicationId: 'app_first_party',
  applicationType: 'first_party',
  applicationIsInternal: false,
};
const INTERNAL: EdgeAdmissionPrincipal = {
  applicationId: 'app_internal',
  applicationType: 'internal',
  applicationIsInternal: false,
};

/* -------------------------------------------------------------------------- */
/*  1. The safe default — the assertion the whole module exists for           */
/* -------------------------------------------------------------------------- */

describe('the safe default', () => {
  it('serves nobody, authenticates no machine key, charges nobody and publishes nothing', () => {
    expect(resolveEdgeAudience()).toEqual({ status: 'closed', reason: 'not_configured' });
    expect(isMachineCredentialLaneEnabled()).toBe(false);
    expect(isChargingAuthorized()).toBe(false);
    expect(isCataloguePublished()).toBe(false);
  });

  it('refuses every tier at the edge, the internal one included', () => {
    for (const principal of [THIRD_PARTY, FIRST_PARTY, INTERNAL]) {
      expect(admitToInferenceEdge(principal)).toMatchObject({
        status: 'refused',
        reason: 'not_configured',
      });
    }
  });

  /**
   * The control for all four assertions above.
   *
   * Without it, "everything is off" is also what a suite whose imports resolved
   * to a stub would report. This proves each flag CAN be opened by the very
   * mechanism the defaults are being measured through.
   */
  it('and every one of them opens when the deployment says so — the positive control', () => {
    process.env[EDGE_AUDIENCE_VARIABLE] = 'public';
    process.env[MACHINE_CREDENTIAL_AUTH_VARIABLE] = 'enabled';
    process.env[CHARGING_AUTHORIZED_VARIABLE] = ARMED_CHARGING;
    process.env[CATALOGUE_AUDIENCE_VARIABLE] = 'public';

    expect(resolveEdgeAudience()).toEqual({
      status: 'open',
      audience: { name: 'public', allowedApplicationIds: [] },
    });
    expect(isMachineCredentialLaneEnabled()).toBe(true);
    expect(isChargingAuthorized()).toBe(true);
    expect(isCataloguePublished()).toBe(true);
    expect(admitToInferenceEdge(THIRD_PARTY)).toEqual({ status: 'admitted', audience: 'public' });
  });
});

/* -------------------------------------------------------------------------- */
/*  2. The edge audience — the four rollout states, expressible               */
/* -------------------------------------------------------------------------- */

describe('the edge audience makes each rollout state expressible', () => {
  it('admits only internal applications during the internal canary', () => {
    process.env[EDGE_AUDIENCE_VARIABLE] = 'internal';

    expect(admitToInferenceEdge(INTERNAL)).toEqual({ status: 'admitted', audience: 'internal' });
    expect(admitToInferenceEdge(FIRST_PARTY)).toMatchObject({
      status: 'refused',
      reason: 'outside_audience',
      tier: 'first_party',
    });
    expect(admitToInferenceEdge(THIRD_PARTY)).toMatchObject({
      status: 'refused',
      reason: 'outside_audience',
      tier: 'third_party',
    });
  });

  it('adds first-party applications during the first-party canary, and keeps internal ones', () => {
    process.env[EDGE_AUDIENCE_VARIABLE] = 'first_party';

    expect(admitToInferenceEdge(INTERNAL).status).toBe('admitted');
    expect(admitToInferenceEdge(FIRST_PARTY).status).toBe('admitted');
    expect(admitToInferenceEdge(THIRD_PARTY)).toMatchObject({ status: 'refused' });
  });

  it('admits exactly the named applications during a closed beta', () => {
    process.env[EDGE_AUDIENCE_VARIABLE] = `allowlist:${THIRD_PARTY.applicationId},app_other`;

    expect(admitToInferenceEdge(THIRD_PARTY)).toEqual({
      status: 'admitted',
      audience: 'allowlist',
    });
    // Cumulative: a stage does not lock out the previous stage's callers.
    expect(admitToInferenceEdge(FIRST_PARTY).status).toBe('admitted');
    expect(admitToInferenceEdge(INTERNAL).status).toBe('admitted');
    // The control: a third-party application that is NOT named stays out, so
    // the case above is not passing because `allowlist` admits everyone.
    expect(
      admitToInferenceEdge({ ...THIRD_PARTY, applicationId: 'app_not_in_the_beta' })
    ).toMatchObject({ status: 'refused', reason: 'outside_audience' });
  });

  it('is closed by an allowlist with nobody in it, rather than silently serving the previous stage', () => {
    process.env[EDGE_AUDIENCE_VARIABLE] = 'allowlist:';

    expect(resolveEdgeAudience()).toEqual({ status: 'closed', reason: 'unreadable' });
    expect(admitToInferenceEdge(FIRST_PARTY)).toMatchObject({ status: 'refused' });
  });

  it('is closed by an unreadable value, and says so once rather than on every request', () => {
    process.env[EDGE_AUDIENCE_VARIABLE] = 'stage-3';

    expect(resolveEdgeAudience()).toEqual({ status: 'closed', reason: 'unreadable' });
    resolveEdgeAudience();
    resolveEdgeAudience();

    expect(mockedLogger.error).toHaveBeenCalledTimes(1);
    expect(mockedLogger.error.mock.calls[0][0]).toBe('rollout.flag.unreadable');
  });

  it('distinguishes a deployment that said `closed` from one that said nothing', () => {
    process.env[EDGE_AUDIENCE_VARIABLE] = 'closed';
    expect(resolveEdgeAudience()).toEqual({ status: 'closed', reason: 'closed' });
    expect(mockedLogger.error).not.toHaveBeenCalled();
  });
});

/* -------------------------------------------------------------------------- */
/*  3. Public launch is gated on charging                                     */
/* -------------------------------------------------------------------------- */

describe('a public audience requires an armed charging authorization', () => {
  it('stays closed, and names which of the two to fix', () => {
    process.env[EDGE_AUDIENCE_VARIABLE] = 'public';

    expect(resolveEdgeAudience()).toEqual({
      status: 'closed',
      reason: 'public_requires_charging',
    });
    expect(admitToInferenceEdge(THIRD_PARTY)).toMatchObject({
      status: 'refused',
      reason: 'public_requires_charging',
    });
  });

  it('opens the moment charging is authorized — the same value, one variable apart', () => {
    process.env[EDGE_AUDIENCE_VARIABLE] = 'public';
    process.env[CHARGING_AUTHORIZED_VARIABLE] = ARMED_CHARGING;

    expect(resolveEdgeAudience().status).toBe('open');
  });

  it('does not gate a closed beta on it — a bounded, named audience may run unpriced', () => {
    process.env[EDGE_AUDIENCE_VARIABLE] = `allowlist:${THIRD_PARTY.applicationId}`;

    expect(resolveEdgeAudience().status).toBe('open');
    expect(isChargingAuthorized()).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/*  4. The machine-credential lane                                            */
/* -------------------------------------------------------------------------- */

describe('the machine-credential lane', () => {
  it('is disabled unset, disabled when said so, and enabled only when named', () => {
    expect(resolveMachineCredentialLane()).toEqual({
      status: 'disabled',
      reason: 'not_configured',
    });

    process.env[MACHINE_CREDENTIAL_AUTH_VARIABLE] = 'disabled';
    expect(resolveMachineCredentialLane()).toEqual({ status: 'disabled', reason: 'disabled' });

    process.env[MACHINE_CREDENTIAL_AUTH_VARIABLE] = 'enabled';
    expect(resolveMachineCredentialLane()).toEqual({ status: 'enabled' });
  });

  it('refuses a value outside its vocabulary rather than reading it as false in silence', () => {
    // `true` is what a boolean parse would have accepted and what a copied task
    // definition carries. Read as `false` silently, it leaves an operator
    // debugging a flag that appears not to work.
    process.env[MACHINE_CREDENTIAL_AUTH_VARIABLE] = 'true';

    expect(resolveMachineCredentialLane()).toEqual({ status: 'disabled', reason: 'unreadable' });
    expect(mockedLogger.error).toHaveBeenCalledTimes(1);
  });
});

/* -------------------------------------------------------------------------- */
/*  5. Charging — the shape that refuses an accident                          */
/* -------------------------------------------------------------------------- */

describe('the charging authorization', () => {
  it('shadow meters when unset', () => {
    expect(resolveInferenceCharging()).toEqual({ status: 'shadow', refusal: 'not_configured' });
  });

  it.each([['true'], ['1'], ['yes'], ['on'], ['enabled'], ['TRUE']])(
    'refuses the bare boolean %s — the value that arrives by accident',
    (value) => {
      process.env[CHARGING_AUTHORIZED_VARIABLE] = value;
      expect(resolveInferenceCharging()).toEqual({ status: 'shadow', refusal: 'bare_boolean' });
    }
  );

  it('accepts a reason and a date, and reports both', () => {
    process.env[CHARGING_AUTHORIZED_VARIABLE] = ARMED_CHARGING;

    const resolution = resolveInferenceCharging();
    expect(resolution).toMatchObject({
      status: 'authorized',
      reason: 'commercial-launch',
      authorizedOn: '2026-08-01',
    });
    if (resolution.status !== 'authorized') throw new Error('unreachable');
    expect(resolution.ageInDays).toBeGreaterThanOrEqual(0);
  });

  it('refuses a date that has not happened — an authorization cannot be pre-dated', () => {
    const tomorrow = new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 10);
    process.env[CHARGING_AUTHORIZED_VARIABLE] = `pre-approved:${tomorrow}`;

    expect(resolveInferenceCharging()).toEqual({ status: 'shadow', refusal: 'future_date' });
  });

  it('refuses a date that does not exist, which Date.parse would have rolled forward', () => {
    process.env[CHARGING_AUTHORIZED_VARIABLE] = 'launch:2026-02-31';

    expect(resolveInferenceCharging()).toEqual({ status: 'shadow', refusal: 'unreadable' });
  });

  it.each([['launch'], ['launch:yesterday'], ['launch:2026-8-1'], [':2026-08-01']])(
    'refuses %s, which carries no reason-and-date pair',
    (value) => {
      process.env[CHARGING_AUTHORIZED_VARIABLE] = value;
      expect(resolveInferenceCharging().status).toBe('shadow');
    }
  );
});

/* -------------------------------------------------------------------------- */
/*  6. The catalogue audience                                                 */
/* -------------------------------------------------------------------------- */

describe('the catalogue audience', () => {
  it('is internal unset, and public only when a deployment publishes it', () => {
    expect(resolveCatalogueAudience()).toEqual({ name: 'internal', reason: 'not_configured' });

    process.env[CATALOGUE_AUDIENCE_VARIABLE] = 'public';
    expect(resolveCatalogueAudience()).toEqual({ name: 'public', reason: 'configured' });
  });

  it('falls back to internal on an unreadable value, and reports it', () => {
    process.env[CATALOGUE_AUDIENCE_VARIABLE] = 'everyone';

    expect(resolveCatalogueAudience()).toEqual({ name: 'internal', reason: 'unreadable' });
    expect(isCataloguePublished()).toBe(false);
    expect(mockedLogger.error).toHaveBeenCalledTimes(1);
  });
});

/* -------------------------------------------------------------------------- */
/*  7. The readout                                                            */
/* -------------------------------------------------------------------------- */

describe('describeRolloutFlags answers "what is on here"', () => {
  it('reports every flag closed, with the reason for each, when nothing is set', () => {
    expect(describeRolloutFlags()).toEqual({
      edge: {
        variable: EDGE_AUDIENCE_VARIABLE,
        open: false,
        audience: null,
        closedReason: 'not_configured',
        allowedApplicationIds: [],
      },
      machineCredentialAuth: {
        variable: MACHINE_CREDENTIAL_AUTH_VARIABLE,
        enabled: false,
        disabledReason: 'not_configured',
      },
      charging: {
        variable: CHARGING_AUTHORIZED_VARIABLE,
        authorized: false,
        reason: null,
        authorizedOn: null,
        ageInDays: null,
        shadowMetering: true,
        refusal: 'not_configured',
      },
      catalogue: {
        variable: CATALOGUE_AUDIENCE_VARIABLE,
        audience: 'internal',
        reason: 'not_configured',
      },
    });
  });

  it('names a closed beta’s applications, and the decision behind an armed charge', () => {
    process.env[EDGE_AUDIENCE_VARIABLE] = 'allowlist:app_alpha,app_beta';
    process.env[CHARGING_AUTHORIZED_VARIABLE] = ARMED_CHARGING;

    const report = describeRolloutFlags();
    expect(report.edge).toMatchObject({
      open: true,
      audience: 'allowlist',
      allowedApplicationIds: ['app_alpha', 'app_beta'],
    });
    expect(report.charging).toMatchObject({
      authorized: true,
      reason: 'commercial-launch',
      authorizedOn: '2026-08-01',
      shadowMetering: false,
    });
  });

  it('never echoes an unreadable value back, since it is served over HTTP', () => {
    process.env[EDGE_AUDIENCE_VARIABLE] = 'stage-3-do-not-echo-me';
    process.env[CATALOGUE_AUDIENCE_VARIABLE] = 'everyone-do-not-echo-me';

    const serialized = JSON.stringify(describeRolloutFlags());
    expect(serialized).not.toContain('do-not-echo-me');
    // The control: the report DID see both variables and said why each is off.
    expect(serialized).toContain('unreadable');
  });
});
