/**
 * The funding class of a synced route, from Kaana's credential economics.
 *
 * Oxy owns the economic order of a model's deployments — free allowance,
 * discounted pay-as-you-go, promotional credit, standard paid
 * (`docs/inference/routing.md`, "Funding class") — and Kaana owns the facts
 * about the provider keys that fund them. Kaana serves those facts on the
 * signed operator read `POST /internal/v1/provider-telemetry/credentials`
 * (Kaana `docs/cost.md`, "The operator feed Oxy reads"): every ENABLED platform
 * key with its operator-stated capacity category and its latest capacity
 * evidence per kind, and no label, email or secret.
 *
 * ## Which key funds a deployment
 *
 * Kaana runs each deployment on one exact key: the key an operator bound it to,
 * or, when its provider holds exactly one key, that key by default (Kaana
 * `docs/key-pools.md`). Ordinary deployment descriptors do not name the key, so
 * Oxy applies the one rule it can verify from this read: a provider with exactly
 * one enabled key funds every deployment on that provider with that key. A
 * provider with several keys, a key nobody described, and a failed read are all
 * UNKNOWN, and an unknown funding source keeps the synced default,
 * `standard_payg` — never a cheaper class nobody proved.
 *
 * ## What it maps
 *
 * Only `promotional` is mapped, to `promotional_credit`: granted credit that
 * runs out or expires, ranked after free and discounted capacity and before
 * ordinary paid usage. `paid` and `prepaid` are what the synced default already
 * says. `trial` is not mapped: a trial is evaluation capacity whose commercial
 * terms are stated separately (`commercialUse`), and treating it as a free
 * allowance is a separate decision.
 *
 * A promotional class is evidence with a window. It is observed when this read
 * succeeded and valid for {@link FUNDING_EVIDENCE_TTL_MS}, so a sync that stops
 * running cannot keep a route preferred on a stale grant: past the window the
 * edge treats the class as unavailable and drops the route, and the rest of the
 * line serves. Capacity evidence saying the grant is spent (a zero balance, no
 * quota left for the month, an expiry in the past) records `exhausted` (or
 * `rate_limited` for a minute/hour/day quota), which the edge also refuses to
 * rank. Kaana independently withholds a deployment whose key it retired (an
 * Anthropic `billing_error`, for example) from its serving snapshot, and fails a
 * request over to the next signed route on a quota refusal.
 */

import { z } from 'zod';
import { resolveKaanaDataPlane, type KaanaDataPlaneConfig } from '../config/kaanaDataPlane';
import type { InferenceFundingClass } from '../db/schema';
import { postProviderTelemetry } from './kaanaProviderCostFeed.service';

export const CREDENTIAL_ECONOMICS_PATH = '/internal/v1/provider-telemetry/credentials';

/**
 * How long one observation of a promotional key backs a route's class: twelve
 * 30-minute catalogue-sync intervals. The sync renews the window once less than
 * half of it is left ({@link fundingNeedsRenewal}), so a few missed runs change
 * nothing and a stopped sync withdraws the class within six hours.
 */
export const FUNDING_EVIDENCE_TTL_MS = 6 * 60 * 60 * 1000;

const MAX_CREDENTIAL_ECONOMICS_BYTES = 1024 * 1024;

/* -------------------------------------------------------------------------- */
/*  Wire shape (Kaana `internal/credentialstore/feed.go`, migration 0018)      */
/* -------------------------------------------------------------------------- */

const capacityEvidenceSchema = z
  .object({
    kind: z.string().max(64),
    observedAt: z.string().max(64),
    freshUntil: z.string().max(64).nullish(),
    quotaWindow: z.string().max(64).nullish(),
    quotaRemaining: z.union([z.number(), z.string().max(64)]).nullish(),
    balancePicos: z.string().max(64).nullish(),
    expiresAt: z.string().max(64).nullish(),
  })
  .passthrough();

const credentialEconomicsSchema = z
  .object({
    provider: z.string().min(1).max(128),
    keyId: z.string().min(1).max(256),
    keyClass: z.string().max(64),
    description: z
      .object({
        revision: z.number().int(),
        capacityCategory: z.string().max(64),
      })
      .passthrough()
      .nullable(),
    // Kaana sends `[]` when a key has no evidence; read leniently, never fail.
    capacityEvidence: z.array(capacityEvidenceSchema).nullish(),
  })
  .passthrough();

const credentialEconomicsResponseSchema = z
  .object({
    schemaVersion: z.literal(1),
    credentials: z.array(credentialEconomicsSchema).max(10_000),
  })
  .passthrough();

export type CredentialEconomicsResponse = z.infer<typeof credentialEconomicsResponseSchema>;

export function parseCredentialEconomics(payload: unknown): CredentialEconomicsResponse {
  return credentialEconomicsResponseSchema.parse(payload);
}

/* -------------------------------------------------------------------------- */
/*  Funding evidence                                                           */
/* -------------------------------------------------------------------------- */

/** What a synced scorecard records about the money behind one provider's routes. */
export interface ProviderFundingEvidence {
  readonly fundingClass: InferenceFundingClass;
  readonly fundingState: 'available' | 'exhausted' | 'rate_limited';
  readonly fundingEvidenceRef: string;
  readonly fundingObservedAt: Date;
  readonly fundingValidUntil: Date;
}

/** Provider slug → its funding evidence. A provider absent here is unknown. */
export type ProviderFundingIndex = ReadonlyMap<string, ProviderFundingEvidence>;

const SHORT_QUOTA_WINDOWS: ReadonlySet<string> = new Set(['minute', 'hour', 'day']);

function instant(value: string | null | undefined): number | undefined {
  if (value === null || value === undefined) return undefined;
  const at = Date.parse(value);
  return Number.isFinite(at) ? at : undefined;
}

/**
 * The state a key's latest capacity evidence states, at `now`. Evidence whose
 * `freshUntil` has passed says nothing any more; evidence with no `freshUntil`
 * stands until a newer observation of the same kind replaces it (Kaana returns
 * only the latest per kind).
 */
function capacityState(
  evidence: readonly z.infer<typeof capacityEvidenceSchema>[],
  now: number,
): ProviderFundingEvidence['fundingState'] {
  let state: ProviderFundingEvidence['fundingState'] = 'available';
  for (const observation of evidence) {
    const freshUntil = instant(observation.freshUntil);
    if (freshUntil !== undefined && freshUntil <= now) continue;
    if (observation.kind === 'balance' && /^0+$/.test(observation.balancePicos ?? '')) {
      return 'exhausted';
    }
    if (observation.kind === 'expiry') {
      const expiresAt = instant(observation.expiresAt);
      if (expiresAt !== undefined && expiresAt <= now) return 'exhausted';
    }
    if (observation.kind === 'quota' && Number(observation.quotaRemaining) === 0) {
      if (!SHORT_QUOTA_WINDOWS.has(observation.quotaWindow ?? '')) return 'exhausted';
      state = 'rate_limited';
    }
  }
  return state;
}

/**
 * Derive each provider's funding evidence from one credential-economics read
 * made at `now`. Only a provider with exactly one enabled key, described as
 * `promotional`, gets an entry; every other provider is left unknown.
 */
export function fundingEvidenceByProvider(
  response: CredentialEconomicsResponse,
  now: Date,
): ProviderFundingIndex {
  const keysByProvider = new Map<string, CredentialEconomicsResponse['credentials']>();
  for (const credential of response.credentials) {
    const keys = keysByProvider.get(credential.provider) ?? [];
    keys.push(credential);
    keysByProvider.set(credential.provider, keys);
  }
  const at = now.getTime();
  const index = new Map<string, ProviderFundingEvidence>();
  for (const [provider, keys] of keysByProvider) {
    const [key] = keys;
    if (keys.length !== 1 || key === undefined) continue;
    if (key.description?.capacityCategory !== 'promotional') continue;
    let validUntil = at + FUNDING_EVIDENCE_TTL_MS;
    for (const observation of key.capacityEvidence ?? []) {
      const expiresAt = observation.kind === 'expiry' ? instant(observation.expiresAt) : undefined;
      if (expiresAt !== undefined && expiresAt > at && expiresAt < validUntil) {
        validUntil = expiresAt;
      }
    }
    index.set(provider, {
      fundingClass: 'promotional_credit',
      fundingState: capacityState(key.capacityEvidence ?? [], at),
      fundingEvidenceRef:
        `kaana-credential-economics:${provider}:${key.keyId}:description-revision-${key.description.revision}`.slice(
          0,
          500,
        ),
      fundingObservedAt: now,
      fundingValidUntil: new Date(validUntil),
    });
  }
  return index;
}

/**
 * Whether a stored windowed observation must be renewed now: when less than
 * half of {@link FUNDING_EVIDENCE_TTL_MS} remains, so a scorecard is rewritten
 * a few times a day rather than on every sync.
 */
export function fundingNeedsRenewal(validUntil: Date | null, now: Date): boolean {
  return validUntil === null || validUntil.getTime() - now.getTime() < FUNDING_EVIDENCE_TTL_MS / 2;
}

/* -------------------------------------------------------------------------- */
/*  The signed read                                                           */
/* -------------------------------------------------------------------------- */

export interface CredentialEconomicsReader {
  read(signal: AbortSignal): Promise<CredentialEconomicsResponse>;
}

export class HttpKaanaCredentialEconomicsReader implements CredentialEconomicsReader {
  constructor(private readonly config: KaanaDataPlaneConfig) {}

  async read(signal: AbortSignal): Promise<CredentialEconomicsResponse> {
    return parseCredentialEconomics(
      await postProviderTelemetry(
        this.config,
        CREDENTIAL_ECONOMICS_PATH,
        { schemaVersion: 1 },
        { maxBytes: MAX_CREDENTIAL_ECONOMICS_BYTES, signal },
      ),
    );
  }
}

export function createHttpKaanaCredentialEconomicsReader(): CredentialEconomicsReader | undefined {
  const resolution = resolveKaanaDataPlane();
  return resolution.status === 'configured'
    ? new HttpKaanaCredentialEconomicsReader(resolution.config)
    : undefined;
}
