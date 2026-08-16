/**
 * The inference platform's rollout flags (issue #972 workstream 16, "Rollout").
 *
 * FOUR switches, declared here and nowhere else, one per surface the epic names:
 * the new authentication lane, the public API edge, the ledger and the
 * catalogue. {@link describeRolloutFlags} renders all four at once, so "what is
 * on in production" is one call rather than a grep — and `GET
 * /inference/admin/rollout` is that call over HTTP.
 *
 * ## Every one of them defaults to the state that does nothing
 *
 * An unset variable never opens a surface, never authenticates a customer's API
 * key, never publishes a catalogue and — most of all — never charges anybody.
 * That is not a stylistic preference: a flag you can arm by forgetting a
 * variable is worse than no flag, because it looks like a control while
 * defaulting to the dangerous side. Each default is asserted in
 * `__tests__/rolloutFlags.test.ts` with the environment explicitly cleared, so
 * the assertion fails if a default is ever flipped.
 *
 * ## An unreadable value resolves to the SAFE state, loudly
 *
 * Relay's `RELAY_ASSUME_FAILOVER_AUTHORIZED` — this ecosystem's precedent for a
 * dangerous switch, and the shape {@link resolveInferenceCharging} copies —
 * makes a malformed value a hard boot failure. That is proportionate for a data
 * plane whose entire job is the thing being gated. It is not proportionate here:
 * `oxy-api` also serves authentication, email, storage and federation, so a typo
 * in an inference rollout flag must not take those down. So a value this module
 * cannot read resolves to the safe state and is reported — at `error` level, and
 * in {@link describeRolloutFlags}, which is what closes the gap between "off"
 * and "off because somebody mistyped it".
 *
 * ## Read per call, never cached
 *
 * Same reasoning as `services/providerSecretStore.ts`: a test can set the
 * variable, and a task-definition change takes effect on restart without a
 * second mechanism deciding it did not. The work is an environment read and a
 * small parse; nothing here touches the database.
 *
 * ## What these flags are NOT
 *
 * They are not authorization. A flag decides whether a surface is open at all in
 * this deployment; scopes, commercial permission, routing policy and the ledger's
 * own refusals all still apply behind every one of them. Opening a flag can only
 * ever expose a gate that was already there.
 */

import { classifyApplicationTier, type ApplicationTier } from '../utils/applicationTier';
import { logger } from '../utils/logger';

/* -------------------------------------------------------------------------- */
/*  Reporting a misconfiguration without shouting on every request            */
/* -------------------------------------------------------------------------- */

/**
 * Values already reported as unreadable, so a misconfiguration is logged once
 * rather than once per request.
 *
 * Keyed on `<variable>=<value>`, so correcting a typo to a second typo is
 * reported again. It grows only when an OPERATOR sets an unreadable value — no
 * request input reaches it — so it is bounded by the number of distinct typos in
 * a deployment's environment, which is not a number that grows.
 */
const reportedMisconfigurations = new Set<string>();

function reportUnreadable(variable: string, value: string, expected: string): void {
  const key = `${variable}=${value}`;
  if (reportedMisconfigurations.has(key)) return;
  reportedMisconfigurations.add(key);
  logger.error(
    'rollout.flag.unreadable',
    new Error(`${variable} is set to a value this build cannot read; the safe default applies`),
    { component: 'rollout', variable, expected }
  );
}

/** Test-only reset, so a suite can assert the log fires for its own value. */
export function forgetReportedMisconfigurations(): void {
  reportedMisconfigurations.clear();
}

/* -------------------------------------------------------------------------- */
/*  1. The public inference edge — who may reach it at all                    */
/* -------------------------------------------------------------------------- */

/**
 * `INFERENCE_EDGE_AUDIENCE` — the flag that makes the epic's four rollout STATES
 * expressible and enforceable.
 *
 * ```text
 * (unset)               nobody. The default.
 * closed                nobody, said out loud.
 * internal              internal/system applications      — internal Alia canary
 * first_party           …plus first-party applications    — Oxy first-party canary
 * allowlist:<id>,<id>   …plus the named applications      — closed external beta
 * public                every application                 — prepaid public launch
 * ```
 *
 * The stages are cumulative because an operational rollout is: a stage that
 * locked out the previous stage's callers would make every advance an outage for
 * the people already depending on it.
 *
 * It is an AUDIENCE rather than a phase number, and it names the applications it
 * admits, because "what does `stage 3` mean" is a question a task definition
 * cannot answer and `allowlist:app_x` answers by itself.
 */
export const EDGE_AUDIENCE_VARIABLE = 'INFERENCE_EDGE_AUDIENCE';

/** The open audiences, narrowest first. `closed` is the absence of one. */
export const EDGE_AUDIENCES = ['internal', 'first_party', 'allowlist', 'public'] as const;

export type EdgeAudienceName = (typeof EDGE_AUDIENCES)[number];

export interface EdgeAudience {
  readonly name: EdgeAudienceName;
  /** Non-empty only for `allowlist`; the closed beta's named applications. */
  readonly allowedApplicationIds: readonly string[];
}

/**
 * Why the edge is closed, when it is. Four arms rather than a boolean, because
 * an operator's next action differs in each: set the variable, nothing at all,
 * fix a typo, or authorize charging before opening to the world.
 */
export type EdgeClosedReason =
  | 'not_configured'
  | 'closed'
  | 'unreadable'
  | 'public_requires_charging';

export type EdgeAudienceResolution =
  | { readonly status: 'open'; readonly audience: EdgeAudience }
  | { readonly status: 'closed'; readonly reason: EdgeClosedReason };

/** The prefix that introduces a closed external beta's application list. */
const ALLOWLIST_PREFIX = 'allowlist:';

const EDGE_AUDIENCE_SHAPE =
  'closed | internal | first_party | allowlist:<applicationId>[,<applicationId>…] | public';

/**
 * Which applications this deployment's inference edge admits.
 *
 * `public` is the one value that is not taken at face value: the epic's own gate
 * is "prepaid public launch only after fraud, ledger and commercial-permission
 * gates pass", and serving the whole internet without charging is the expensive
 * half of that sentence. So a `public` audience with no charging authorization
 * resolves CLOSED, and says which of the two to fix. The failure that produces —
 * a launch that visibly does not start — costs an environment variable; the one
 * it prevents is unbounded free inference at internet scale.
 */
export function resolveEdgeAudience(): EdgeAudienceResolution {
  const configured = process.env[EDGE_AUDIENCE_VARIABLE]?.trim();
  if (configured === undefined || configured.length === 0) {
    return { status: 'closed', reason: 'not_configured' };
  }
  if (configured === 'closed') {
    return { status: 'closed', reason: 'closed' };
  }

  if (configured.startsWith(ALLOWLIST_PREFIX)) {
    const allowedApplicationIds = configured
      .slice(ALLOWLIST_PREFIX.length)
      .split(',')
      .map((id) => id.trim())
      .filter((id) => id.length > 0);
    // An empty list is refused rather than read as `first_party`. A closed beta
    // with nobody in it is a misconfiguration, and silently serving the previous
    // stage would hide it for exactly as long as nobody noticed the beta had no
    // testers.
    if (allowedApplicationIds.length === 0) {
      reportUnreadable(EDGE_AUDIENCE_VARIABLE, configured, EDGE_AUDIENCE_SHAPE);
      return { status: 'closed', reason: 'unreadable' };
    }
    return { status: 'open', audience: { name: 'allowlist', allowedApplicationIds } };
  }

  if (configured === 'internal' || configured === 'first_party') {
    return { status: 'open', audience: { name: configured, allowedApplicationIds: [] } };
  }

  if (configured === 'public') {
    if (resolveInferenceCharging().status !== 'authorized') {
      return { status: 'closed', reason: 'public_requires_charging' };
    }
    return { status: 'open', audience: { name: 'public', allowedApplicationIds: [] } };
  }

  reportUnreadable(EDGE_AUDIENCE_VARIABLE, configured, EDGE_AUDIENCE_SHAPE);
  return { status: 'closed', reason: 'unreadable' };
}

/** The application principal an admission decision reads. */
export interface EdgeAdmissionPrincipal {
  readonly applicationId: string;
  readonly applicationType: string | null;
  readonly applicationIsInternal: boolean | null;
}

export type EdgeAdmission =
  | { readonly status: 'admitted'; readonly audience: EdgeAudienceName }
  | {
      readonly status: 'refused';
      /** `outside_audience` when the edge is open but not to this tier. */
      readonly reason: EdgeClosedReason | 'outside_audience';
      readonly tier: ApplicationTier;
    };

/** The tiers each audience admits, before the allowlist is consulted. */
const AUDIENCE_TIERS: Record<EdgeAudienceName, readonly ApplicationTier[]> = {
  internal: ['internal'],
  first_party: ['internal', 'first_party'],
  allowlist: ['internal', 'first_party'],
  public: ['internal', 'first_party', 'third_party'],
};

/**
 * Whether this principal may reach the inference edge in this deployment.
 *
 * Applied once, in the edge's own gate, so all three of its endpoints — both
 * dialects and the receipt read — are covered by one decision that cannot be
 * forgotten on a fourth.
 */
export function admitToInferenceEdge(principal: EdgeAdmissionPrincipal): EdgeAdmission {
  const tier = classifyApplicationTier({
    type: principal.applicationType,
    isInternal: principal.applicationIsInternal,
  });

  const resolution = resolveEdgeAudience();
  if (resolution.status === 'closed') {
    return { status: 'refused', reason: resolution.reason, tier };
  }

  const { audience } = resolution;
  if (AUDIENCE_TIERS[audience.name].includes(tier)) {
    return { status: 'admitted', audience: audience.name };
  }
  if (
    audience.name === 'allowlist' &&
    audience.allowedApplicationIds.includes(principal.applicationId)
  ) {
    return { status: 'admitted', audience: audience.name };
  }

  return { status: 'refused', reason: 'outside_audience', tier };
}

/* -------------------------------------------------------------------------- */
/*  2. The new authentication lane                                            */
/* -------------------------------------------------------------------------- */

/**
 * `INFERENCE_MACHINE_CREDENTIAL_AUTH` — whether an `oxy_sk_…` machine credential
 * authenticates anything in this deployment.
 *
 * `enabled` | `disabled`, and unset is disabled. NOT a boolean parse: a value
 * outside the vocabulary resolves DISABLED and is reported, where
 * `getEnvBoolean` would map `enabled` to `false` in silence and leave an
 * operator reading a flag that appears not to work.
 *
 * Orthogonal to the audience, and worth its own switch: the machine lane is the
 * self-serve, externally-mintable one, so a first-party canary that wants only
 * short-lived service tokens live is a state {@link resolveEdgeAudience} cannot
 * express on its own.
 */
export const MACHINE_CREDENTIAL_AUTH_VARIABLE = 'INFERENCE_MACHINE_CREDENTIAL_AUTH';

export type MachineCredentialLaneState =
  | { readonly status: 'enabled' }
  | { readonly status: 'disabled'; readonly reason: 'not_configured' | 'disabled' | 'unreadable' };

export function resolveMachineCredentialLane(): MachineCredentialLaneState {
  const configured = process.env[MACHINE_CREDENTIAL_AUTH_VARIABLE]?.trim();
  if (configured === undefined || configured.length === 0) {
    return { status: 'disabled', reason: 'not_configured' };
  }
  if (configured === 'enabled') return { status: 'enabled' };
  if (configured === 'disabled') return { status: 'disabled', reason: 'disabled' };

  reportUnreadable(MACHINE_CREDENTIAL_AUTH_VARIABLE, configured, 'enabled | disabled');
  return { status: 'disabled', reason: 'unreadable' };
}

export function isMachineCredentialLaneEnabled(): boolean {
  return resolveMachineCredentialLane().status === 'enabled';
}

/* -------------------------------------------------------------------------- */
/*  3. The ledger — charging, and the shadow metering that precedes it        */
/* -------------------------------------------------------------------------- */

/**
 * `INFERENCE_CHARGING_AUTHORIZED=<reason>:<YYYY-MM-DD>` — whether this
 * deployment may take customers' money.
 *
 * Unset, this deployment SHADOW METERS: the edge prices every request exactly as
 * it would charge for it and records the amount, and no reservation, receipt,
 * refund or balance movement is written. That is workstream 16's "shadow
 * technical metering before charging customers", and the ledger needed no second
 * mechanism for it — `quoteUnits` already computes the exact charge with the same
 * arithmetic `settle` bills with, as a pure read that takes no lock and writes
 * nothing.
 *
 * ## Why a bare `true` is refused
 *
 * The shape is Relay's `RELAY_ASSUME_FAILOVER_AUTHORIZED` and it is refused for
 * the same reason: `true` is the value that arrives by accident. It is what a
 * copied task definition carries, what a `.env` picks up, and what somebody
 * types to see whether a flag does anything. `commercial-launch:2026-08-16` is
 * not typed by accident, and it records the two things an auditor asks about a
 * charge — who accepted it, and when.
 *
 * ## It does not expire, and that is argued rather than inherited
 *
 * Relay's does not either. Expiry would be wrong here in both directions: at
 * public scale an expired authorization either serves the world for free or
 * refuses every request, and both are expensive. What the date buys instead is
 * an age reported beside the flag in {@link describeRolloutFlags}, which is the
 * question ("who armed this, and how long ago") a self-disarming timer was only
 * ever a proxy for.
 */
export const CHARGING_AUTHORIZED_VARIABLE = 'INFERENCE_CHARGING_AUTHORIZED';

/** `<reason>:<YYYY-MM-DD>`. The reason carries no colon, so the split is exact. */
const CHARGING_AUTHORIZATION_PATTERN = /^([^:]{1,120}):(\d{4})-(\d{2})-(\d{2})$/;

const CHARGING_AUTHORIZATION_SHAPE =
  '<reason>:<YYYY-MM-DD>, e.g. commercial-launch:2026-08-16 — it states who accepted charging customers, and when';

export type ChargingRefusal =
  | 'not_configured'
  /** A bare `true`/`1`/`yes`: the value that arrives by accident. */
  | 'bare_boolean'
  | 'unreadable'
  /** A date that has not happened. An authorization cannot be pre-dated. */
  | 'future_date';

export type ChargingAuthorization =
  | {
      readonly status: 'authorized';
      readonly reason: string;
      /** `YYYY-MM-DD`, exactly as configured. */
      readonly authorizedOn: string;
      /** Whole days since `authorizedOn`, for the readout. */
      readonly ageInDays: number;
    }
  | { readonly status: 'shadow'; readonly refusal: ChargingRefusal };

/** The values a boolean-shaped flag would have accepted, refused by name. */
const BARE_BOOLEANS = ['true', '1', 'yes', 'on', 'enabled'] as const;

const MILLISECONDS_PER_DAY = 86_400_000;

export function resolveInferenceCharging(): ChargingAuthorization {
  const configured = process.env[CHARGING_AUTHORIZED_VARIABLE]?.trim();
  if (configured === undefined || configured.length === 0) {
    return { status: 'shadow', refusal: 'not_configured' };
  }

  if ((BARE_BOOLEANS as readonly string[]).includes(configured.toLowerCase())) {
    reportUnreadable(CHARGING_AUTHORIZED_VARIABLE, configured, CHARGING_AUTHORIZATION_SHAPE);
    return { status: 'shadow', refusal: 'bare_boolean' };
  }

  const match = CHARGING_AUTHORIZATION_PATTERN.exec(configured);
  if (match === null) {
    reportUnreadable(CHARGING_AUTHORIZED_VARIABLE, configured, CHARGING_AUTHORIZATION_SHAPE);
    return { status: 'shadow', refusal: 'unreadable' };
  }

  const [, reason, year, month, day] = match;
  const authorizedOn = `${year}-${month}-${day}`;
  const parsed = Date.parse(`${authorizedOn}T00:00:00.000Z`);
  // `Date.parse` accepts `2026-02-31` and rolls it into March, so the round trip
  // is what rejects a date that does not exist. A silently-moved date would put
  // a wrong day on a financial authorization.
  if (Number.isNaN(parsed) || new Date(parsed).toISOString().slice(0, 10) !== authorizedOn) {
    reportUnreadable(CHARGING_AUTHORIZED_VARIABLE, configured, CHARGING_AUTHORIZATION_SHAPE);
    return { status: 'shadow', refusal: 'unreadable' };
  }

  const ageInDays = Math.floor((Date.now() - parsed) / MILLISECONDS_PER_DAY);
  if (ageInDays < 0) {
    reportUnreadable(CHARGING_AUTHORIZED_VARIABLE, configured, CHARGING_AUTHORIZATION_SHAPE);
    return { status: 'shadow', refusal: 'future_date' };
  }

  return { status: 'authorized', reason, authorizedOn, ageInDays };
}

/**
 * Whether the edge may reserve, settle and move money for this request.
 *
 * `false` is SHADOW METERING, not "billing is broken": the request is still
 * served, still metered and still priced — see `inferenceEdge.service.ts`, which
 * records what it would have charged.
 */
export function isChargingAuthorized(): boolean {
  return resolveInferenceCharging().status === 'authorized';
}

/* -------------------------------------------------------------------------- */
/*  4. The catalogue — who is served the published model list                 */
/* -------------------------------------------------------------------------- */

/**
 * `INFERENCE_CATALOGUE_AUDIENCE` — `internal` (the default) or `public`.
 *
 * The catalogue is the customer-facing statement of what Oxy sells, so
 * publishing it is a commercial act with its own timing, separate from whether
 * the edge will serve a request. Under `internal` a public viewer is served an
 * EMPTY catalogue rather than a 404: the endpoint exists and answers; there is
 * simply nothing published to them yet. Internal viewers are unaffected in both
 * positions, which is what lets a canary populate and check the catalogue before
 * anyone can read it.
 *
 * This gates the AUDIENCE only. Commercial permission, legal review and
 * availability scope still decide what any viewer may be offered, and opening
 * this flag cannot publish a route none of those approved.
 */
export const CATALOGUE_AUDIENCE_VARIABLE = 'INFERENCE_CATALOGUE_AUDIENCE';

export const CATALOGUE_AUDIENCES = ['internal', 'public'] as const;

export type CatalogueAudienceName = (typeof CATALOGUE_AUDIENCES)[number];

export interface CatalogueAudienceResolution {
  readonly name: CatalogueAudienceName;
  readonly reason: 'not_configured' | 'configured' | 'unreadable';
}

export function resolveCatalogueAudience(): CatalogueAudienceResolution {
  const configured = process.env[CATALOGUE_AUDIENCE_VARIABLE]?.trim();
  if (configured === undefined || configured.length === 0) {
    return { name: 'internal', reason: 'not_configured' };
  }
  if ((CATALOGUE_AUDIENCES as readonly string[]).includes(configured)) {
    return { name: configured as CatalogueAudienceName, reason: 'configured' };
  }

  reportUnreadable(CATALOGUE_AUDIENCE_VARIABLE, configured, CATALOGUE_AUDIENCES.join(' | '));
  return { name: 'internal', reason: 'unreadable' };
}

/** Whether a viewer outside the internal tier is served catalogue entries. */
export function isCataloguePublished(): boolean {
  return resolveCatalogueAudience().name === 'public';
}

/* -------------------------------------------------------------------------- */
/*  The readout                                                               */
/* -------------------------------------------------------------------------- */

export interface RolloutFlagReport {
  readonly edge: {
    readonly variable: string;
    readonly open: boolean;
    readonly audience: EdgeAudienceName | null;
    readonly closedReason: EdgeClosedReason | null;
    readonly allowedApplicationIds: readonly string[];
  };
  readonly machineCredentialAuth: {
    readonly variable: string;
    readonly enabled: boolean;
    readonly disabledReason: 'not_configured' | 'disabled' | 'unreadable' | null;
  };
  readonly charging: {
    readonly variable: string;
    readonly authorized: boolean;
    /** Present only when armed. Never a secret — it names a decision. */
    readonly reason: string | null;
    readonly authorizedOn: string | null;
    readonly ageInDays: number | null;
    readonly shadowMetering: boolean;
    readonly refusal: ChargingRefusal | null;
  };
  readonly catalogue: {
    readonly variable: string;
    readonly audience: CatalogueAudienceName;
    readonly reason: CatalogueAudienceResolution['reason'];
  };
}

/**
 * Every rollout flag, resolved, in one object.
 *
 * The point of the module: "what is on in production" is answerable without
 * knowing which four variables to grep for, and every arm carries WHY, so a flag
 * that is off because it was mistyped is distinguishable from one that is off
 * because nobody set it.
 *
 * It reports the CONFIGURED reason and never the raw value, so an unreadable
 * setting shows up as `unreadable` rather than being echoed back — the value is
 * an operator's text and this report is served over HTTP.
 */
export function describeRolloutFlags(): RolloutFlagReport {
  const edge = resolveEdgeAudience();
  const lane = resolveMachineCredentialLane();
  const charging = resolveInferenceCharging();
  const catalogue = resolveCatalogueAudience();

  return {
    edge: {
      variable: EDGE_AUDIENCE_VARIABLE,
      open: edge.status === 'open',
      audience: edge.status === 'open' ? edge.audience.name : null,
      closedReason: edge.status === 'closed' ? edge.reason : null,
      allowedApplicationIds: edge.status === 'open' ? edge.audience.allowedApplicationIds : [],
    },
    machineCredentialAuth: {
      variable: MACHINE_CREDENTIAL_AUTH_VARIABLE,
      enabled: lane.status === 'enabled',
      disabledReason: lane.status === 'disabled' ? lane.reason : null,
    },
    charging: {
      variable: CHARGING_AUTHORIZED_VARIABLE,
      authorized: charging.status === 'authorized',
      reason: charging.status === 'authorized' ? charging.reason : null,
      authorizedOn: charging.status === 'authorized' ? charging.authorizedOn : null,
      ageInDays: charging.status === 'authorized' ? charging.ageInDays : null,
      shadowMetering: charging.status !== 'authorized',
      refusal: charging.status === 'shadow' ? charging.refusal : null,
    },
    catalogue: {
      variable: CATALOGUE_AUDIENCE_VARIABLE,
      audience: catalogue.name,
      reason: catalogue.reason,
    },
  };
}
