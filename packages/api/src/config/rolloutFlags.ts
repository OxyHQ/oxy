/**
 * The inference platform's rollout flags (issue #972 workstream 16, "Rollout").
 *
 * SIX switches, declared here and nowhere else: the new authentication lane,
 * the public API edge, the Kaana execution hop, the ledger, the catalogue, and the privacy/security
 * review a public launch is gated on. {@link describeRolloutFlags} renders all
 * six at once, so "what is on in production" is one call rather than a grep —
 * and `GET /inference/admin/rollout` is that call over HTTP.
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
 * An unset variable also never asserts that a review HAPPENED — see
 * {@link resolveInferencePrivacyReview}, whose absence closes the public
 * audience rather than being read as "nothing to review".
 *
 * ## An unreadable value resolves to the SAFE state, loudly
 *
 * A prior high-risk failover switch in this ecosystem established the precedent
 * that a dangerous control must never interpret an arbitrary truthy value as
 * authorization. Its malformed values caused a hard boot failure. That is proportionate for a data
 * plane whose entire job is the thing being gated. It is not proportionate here:
 * `oxy-api` also serves authentication, email, storage and federation, so a typo
 * in an inference rollout flag must not take those down. So a value this module
 * cannot read resolves to the safe state and is reported — at `error` level, and
 * in {@link describeRolloutFlags}, which is what closes the gap between "off"
 * and "off because somebody mistyped it".
 *
 * ## Read per call, never cached
 *
 * A test can set the variable, and a task-definition change takes effect on restart without a
 * second mechanism deciding it did not. The work is an environment read and a
 * small parse; nothing here touches the database.
 *
 * ## What these flags are NOT
 *
 * They are not authorization. A flag decides whether a surface is open at all in
 * this deployment; scopes, commercial permission, routing policy and the ledger's
 * own refusals all still apply behind every one of them. Opening a flag can only
 * ever expose a gate that was already there.
 *
 * The two dated ones — {@link resolveInferenceCharging} and
 * {@link resolveInferencePrivacyReview} — are DOCUMENTED SELF-ATTESTATIONS and
 * nothing more. Nobody checks that the reason names a real commercial decision
 * or that the reviewer read anything: the mechanism is that the state cannot be
 * reached by forgetting a variable, and that the readout says who claimed it and
 * how long ago. An operator who types a name they did not earn has defeated
 * both, and no amount of parsing in this module changes that.
 */

import { isLiveEntityId } from '@oxyhq/db';
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
 * internal              internal/system applications      — tier canary
 * first_party           internal + first-party apps       — broader tier canary
 * allowlist:<id>,<id>   exactly the named applications    — exact-app canary/beta
 * public                every application                 — prepaid public launch
 * ```
 *
 * The tier audiences are cumulative. `allowlist` is deliberately not: it is the
 * escape hatch for naming one or more exact application principals without
 * implicitly admitting every `internal` or `first_party` application. Moving
 * from a tier audience to an allowlist is therefore a narrowing operation unless
 * each prior caller is named explicitly.
 *
 * It is an AUDIENCE rather than a phase number, and it names the applications it
 * admits, because "what does `stage 3` mean" is a question a task definition
 * cannot answer and `allowlist:<exact application ID>` answers by itself.
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
 * Why the edge is closed, when it is. Five arms rather than a boolean, because
 * an operator's next action differs in each: set the variable, nothing at all,
 * fix a typo, authorize charging, or record the privacy and security review
 * before opening to the world.
 */
export type EdgeClosedReason =
  | 'not_configured'
  | 'closed'
  | 'unreadable'
  | 'public_requires_charging'
  | 'public_requires_privacy_review';

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
 *
 * The privacy and security review is the epic's OTHER named prerequisite for
 * that same step (#972 section 12), and it is checked here for the same reason
 * and in the same place: the two are separate decisions, taken by different
 * people, and a launch that has one and not the other is exactly the state a
 * single combined flag could not express. Both are checked here rather than at
 * each endpoint, so a fourth endpoint cannot be added without them.
 *
 * Charging is checked FIRST, deliberately: an operator arming a public launch
 * needs one next action at a time, and the charging flag is the one whose
 * absence also silently changes what every served request DOES (shadow
 * metering). Neither refusal is more severe than the other; the order only
 * decides which one an operator is told about first.
 */
export function resolveEdgeAudience(): EdgeAudienceResolution {
  const configured = process.env[EDGE_AUDIENCE_VARIABLE];
  if (configured === undefined || configured.length === 0) {
    return { status: 'closed', reason: 'not_configured' };
  }
  if (configured === 'closed') {
    return { status: 'closed', reason: 'closed' };
  }

  if (configured.startsWith(ALLOWLIST_PREFIX)) {
    const allowedApplicationIds = configured.slice(ALLOWLIST_PREFIX.length).split(',');
    const uniqueApplicationIds = new Set(allowedApplicationIds);
    // IDs are exact database primary keys: never trim, normalize, discard an
    // empty segment, or silently deduplicate them. A malformed list closes the
    // whole edge, making an operator correct the intended principal set instead
    // of running with a different set than the task definition spells.
    if (
      allowedApplicationIds.length === 0 ||
      allowedApplicationIds.some((id) => !isLiveEntityId(id)) ||
      uniqueApplicationIds.size !== allowedApplicationIds.length
    ) {
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
    if (resolveInferencePrivacyReview().status !== 'reviewed') {
      return { status: 'closed', reason: 'public_requires_privacy_review' };
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

/** The tiers admitted by tier audiences. `allowlist` admits by exact ID only. */
const AUDIENCE_TIERS: Record<EdgeAudienceName, readonly ApplicationTier[]> = {
  internal: ['internal'],
  first_party: ['internal', 'first_party'],
  allowlist: [],
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
  if (audience.name === 'allowlist') {
    return audience.allowedApplicationIds.includes(principal.applicationId)
      ? { status: 'admitted', audience: audience.name }
      : { status: 'refused', reason: 'outside_audience', tier };
  }
  if (AUDIENCE_TIERS[audience.name].includes(tier)) {
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
/*  3. The Kaana execution hop                                                */
/* -------------------------------------------------------------------------- */

/**
 * `INFERENCE_KAANA_EXECUTION` is an independent kill switch for constructing
 * the production Kaana client. Explicitly injected clients remain available to
 * tests; ambient production wiring is inert unless this says `enabled`.
 */
export const KAANA_EXECUTION_VARIABLE = 'INFERENCE_KAANA_EXECUTION';

export type KaanaExecutionState =
  | { readonly status: 'enabled' }
  | { readonly status: 'disabled'; readonly reason: 'not_configured' | 'disabled' | 'unreadable' };

export function resolveKaanaExecution(): KaanaExecutionState {
  const configured = process.env[KAANA_EXECUTION_VARIABLE]?.trim();
  if (configured === undefined || configured.length === 0) {
    return { status: 'disabled', reason: 'not_configured' };
  }
  if (configured === 'enabled') return { status: 'enabled' };
  if (configured === 'disabled') return { status: 'disabled', reason: 'disabled' };

  reportUnreadable(KAANA_EXECUTION_VARIABLE, configured, 'enabled | disabled');
  return { status: 'disabled', reason: 'unreadable' };
}

export function isKaanaExecutionEnabled(): boolean {
  return resolveKaanaExecution().status === 'enabled';
}

/* -------------------------------------------------------------------------- */
/*  4. The ledger — charging, and the shadow metering that precedes it        */
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
 * The dated-attestation shape follows that established failover precedent and
 * refuses a bare `true`: that is the value that arrives by accident. It is what a
 * copied task definition carries, what a `.env` picks up, and what somebody
 * types to see whether a flag does anything. `commercial-launch:2026-08-16` is
 * not typed by accident, and it records the two things an auditor asks about a
 * charge — who accepted it, and when.
 *
 * ## It does not expire, and that is argued rather than inherited
 *
 * That precedent did not expire automatically either. Expiry would be wrong here in both directions: at
 * public scale an expired authorization either serves the world for free or
 * refuses every request, and both are expensive. What the date buys instead is
 * an age reported beside the flag in {@link describeRolloutFlags}, which is the
 * question ("who armed this, and how long ago") a self-disarming timer was only
 * ever a proxy for.
 */
export const CHARGING_AUTHORIZED_VARIABLE = 'INFERENCE_CHARGING_AUTHORIZED';

/** `<label>:<YYYY-MM-DD>`. The label carries no colon, so the split is exact. */
const DATED_ATTESTATION_PATTERN = /^([^:]{1,120}):(\d{4})-(\d{2})-(\d{2})$/;

const CHARGING_AUTHORIZATION_SHAPE =
  '<reason>:<YYYY-MM-DD>, e.g. commercial-launch:2026-08-16 — it states who accepted charging customers, and when';

/**
 * How a `<label>:<YYYY-MM-DD>` attestation can be refused.
 *
 * ONE union for both dated flags rather than one each: the refusals are the same
 * four facts about the same grammar, and two copies would let a tightening of
 * one drift away from the other while both still read as "the same shape".
 */
export type DatedAttestationRefusal =
  | 'not_configured'
  /** A bare `true`/`1`/`yes`: the value that arrives by accident. */
  | 'bare_boolean'
  | 'unreadable'
  /** A date that has not happened. An attestation cannot be pre-dated. */
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
  | { readonly status: 'shadow'; readonly refusal: DatedAttestationRefusal };

/** The values a boolean-shaped flag would have accepted, refused by name. */
const BARE_BOOLEANS = ['true', '1', 'yes', 'on', 'enabled'] as const;

const MILLISECONDS_PER_DAY = 86_400_000;

type ParsedAttestation =
  | {
      readonly status: 'attested';
      /** Whatever stood before the colon: a reason, or a reviewer. */
      readonly label: string;
      /** `YYYY-MM-DD`, exactly as configured. */
      readonly on: string;
      readonly ageInDays: number;
    }
  | { readonly status: 'refused'; readonly refusal: DatedAttestationRefusal };

/**
 * Read a `<label>:<YYYY-MM-DD>` attestation out of the environment.
 *
 * Shared by {@link resolveInferenceCharging} and
 * {@link resolveInferencePrivacyReview}, which differ only in what the two
 * halves MEAN — a commercial decision and its date, or a reviewer and the date
 * they signed off. Every refusal, including the bare-boolean one and the
 * rolled-date one, is therefore identical by construction rather than by
 * somebody keeping two copies in step.
 */
function parseDatedAttestation(variable: string, shape: string): ParsedAttestation {
  const configured = process.env[variable]?.trim();
  if (configured === undefined || configured.length === 0) {
    return { status: 'refused', refusal: 'not_configured' };
  }

  if ((BARE_BOOLEANS as readonly string[]).includes(configured.toLowerCase())) {
    reportUnreadable(variable, configured, shape);
    return { status: 'refused', refusal: 'bare_boolean' };
  }

  const match = DATED_ATTESTATION_PATTERN.exec(configured);
  if (match === null) {
    reportUnreadable(variable, configured, shape);
    return { status: 'refused', refusal: 'unreadable' };
  }

  const [, label, year, month, day] = match;
  const on = `${year}-${month}-${day}`;
  const parsed = Date.parse(`${on}T00:00:00.000Z`);
  // `Date.parse` accepts `2026-02-31` and rolls it into March, so the round trip
  // is what rejects a date that does not exist. A silently-moved date would put
  // a wrong day on a financial authorization, or on a review.
  if (Number.isNaN(parsed) || new Date(parsed).toISOString().slice(0, 10) !== on) {
    reportUnreadable(variable, configured, shape);
    return { status: 'refused', refusal: 'unreadable' };
  }

  const ageInDays = Math.floor((Date.now() - parsed) / MILLISECONDS_PER_DAY);
  if (ageInDays < 0) {
    reportUnreadable(variable, configured, shape);
    return { status: 'refused', refusal: 'future_date' };
  }

  return { status: 'attested', label, on, ageInDays };
}

export function resolveInferenceCharging(): ChargingAuthorization {
  const parsed = parseDatedAttestation(CHARGING_AUTHORIZED_VARIABLE, CHARGING_AUTHORIZATION_SHAPE);
  if (parsed.status === 'refused') {
    return { status: 'shadow', refusal: parsed.refusal };
  }
  return {
    status: 'authorized',
    reason: parsed.label,
    authorizedOn: parsed.on,
    ageInDays: parsed.ageInDays,
  };
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
/*  5. The privacy and security review a public launch is gated on            */
/* -------------------------------------------------------------------------- */

/**
 * `INFERENCE_PRIVACY_REVIEW=<reviewer>:<YYYY-MM-DD>` — whether the privacy and
 * security review #972 section 12 requires before a public launch has been
 * recorded for this deployment.
 *
 * ## Why it is a flag and not a document
 *
 * The review itself is human work and this module cannot do any of it. What it
 * can do is make the review's ABSENCE stop a public launch, which is the half
 * that was missing: every item section 12 asks for could be outstanding and
 * `INFERENCE_EDGE_AUDIENCE=public` would still serve the world, because nothing
 * anywhere read a privacy decision. Now the launch does not start until somebody
 * has put their name and a date against it.
 *
 * `INFERENCE_CHARGING_AUTHORIZED` is the precedent and NOT a substitute: it
 * records a COMMERCIAL acceptance — that Oxy may take money — which is a
 * different decision, usually taken by a different person, and a deployment can
 * legitimately be in either state without the other.
 *
 * ## The same shape, and the same refusal of a bare `true`
 *
 * `<reviewer>:<YYYY-MM-DD>`, parsed by {@link parseDatedAttestation}, so
 * `true`, `1`, `yes`, `on` and `enabled` are refused by name and a future date is
 * refused as well. The reasoning is the charging flag's, unchanged: `true` is
 * what a copied task definition carries and what somebody types to see whether a
 * flag does anything, whereas `security-privacy-review:2026-08-16` is not typed
 * by accident and records the two things an auditor asks — who reviewed it, and
 * when.
 *
 * ## It does not expire either
 *
 * For the reason argued above {@link resolveInferenceCharging}: at public scale a
 * lapsed attestation either refuses every request or serves the world anyway, and
 * both are worse than an age reported beside the flag. A review whose findings
 * have gone stale is re-run and the variable re-stamped; the readout's
 * `ageInDays` is what makes "when was this last looked at" answerable without
 * asking anybody.
 *
 * ## What this is NOT
 *
 * Not an authorization control, and not evidence that any item in section 12 was
 * fixed. It is a self-attested gate — the module header says the same about the
 * other four — whose whole mechanism is that the state cannot be reached by
 * forgetting a variable, and that the readout names who claimed it.
 */
export const PRIVACY_REVIEW_VARIABLE = 'INFERENCE_PRIVACY_REVIEW';

const PRIVACY_REVIEW_SHAPE =
  '<reviewer>:<YYYY-MM-DD>, e.g. security-privacy-review:2026-08-16 — it states who signed off the privacy and security review, and when';

export type PrivacyReviewResolution =
  | {
      readonly status: 'reviewed';
      /** Who signed the review off. Never a secret — it names a person or a team. */
      readonly reviewer: string;
      /** `YYYY-MM-DD`, exactly as configured. */
      readonly reviewedOn: string;
      /** Whole days since `reviewedOn`, so a stale review is visible. */
      readonly ageInDays: number;
    }
  | { readonly status: 'unreviewed'; readonly refusal: DatedAttestationRefusal };

export function resolveInferencePrivacyReview(): PrivacyReviewResolution {
  const parsed = parseDatedAttestation(PRIVACY_REVIEW_VARIABLE, PRIVACY_REVIEW_SHAPE);
  if (parsed.status === 'refused') {
    return { status: 'unreviewed', refusal: parsed.refusal };
  }
  return {
    status: 'reviewed',
    reviewer: parsed.label,
    reviewedOn: parsed.on,
    ageInDays: parsed.ageInDays,
  };
}

/** Whether this deployment has recorded the review a public launch is gated on. */
export function isPrivacyReviewRecorded(): boolean {
  return resolveInferencePrivacyReview().status === 'reviewed';
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
  readonly kaanaExecution: {
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
    readonly refusal: DatedAttestationRefusal | null;
  };
  readonly catalogue: {
    readonly variable: string;
    readonly audience: CatalogueAudienceName;
    readonly reason: CatalogueAudienceResolution['reason'];
  };
  readonly privacyReview: {
    readonly variable: string;
    readonly authorized: boolean;
    /** Present only when recorded. Never a secret — it names a reviewer. */
    readonly reviewer: string | null;
    readonly reviewedOn: string | null;
    /** How long ago the review was signed off. A stale review is still armed. */
    readonly ageInDays: number | null;
    readonly refusal: DatedAttestationRefusal | null;
  };
}

/**
 * Every rollout flag, resolved, in one object.
 *
 * The point of the module: "what is on in production" is answerable without
 * knowing which six variables to grep for, and every arm carries WHY, so a flag
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
  const kaanaExecution = resolveKaanaExecution();
  const charging = resolveInferenceCharging();
  const catalogue = resolveCatalogueAudience();
  const privacyReview = resolveInferencePrivacyReview();

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
    kaanaExecution: {
      variable: KAANA_EXECUTION_VARIABLE,
      enabled: kaanaExecution.status === 'enabled',
      disabledReason: kaanaExecution.status === 'disabled' ? kaanaExecution.reason : null,
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
    privacyReview: {
      variable: PRIVACY_REVIEW_VARIABLE,
      authorized: privacyReview.status === 'reviewed',
      reviewer: privacyReview.status === 'reviewed' ? privacyReview.reviewer : null,
      reviewedOn: privacyReview.status === 'reviewed' ? privacyReview.reviewedOn : null,
      ageInDays: privacyReview.status === 'reviewed' ? privacyReview.ageInDays : null,
      refusal: privacyReview.status === 'unreviewed' ? privacyReview.refusal : null,
    },
  };
}
