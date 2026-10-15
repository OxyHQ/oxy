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
 * ## Which keys fund a deployment
 *
 * Kaana owns provider keys and chooses among them (ADR 0038, Kaana ADR 0001):
 * a deployment without an operator pin executes on its provider's whole key
 * pool, cheapest stated funding first — free, then credits (promotional or
 * trial grants, then prepaid), then paid. So the funding a route can count on
 * is the BEST tier that is available among its provider's enabled keys right
 * now: a provider with one promotional key whose grant is available funds its
 * routes as `promotional_credit`, whatever else it holds, because Kaana spends
 * that grant first. When no promotional key is available the provider's routes
 * are `standard_payg` if any other key can still serve them (Kaana walks on to
 * it), or the promotional keys' own spent/throttled state if they are all it
 * has. A failed read is unknown and keeps the synced default, `standard_payg` —
 * never a cheaper class nobody proved.
 *
 * Where a route must NOT fall through to a dearer key, Oxy says so on the
 * signed route (`maxFundingTier`, ADR 0038) and Kaana refuses the route rather
 * than spend past it. ADR 0037's Pro/Ultra lane is the one such route today.
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
 * made at `now`: the best available tier among each provider's enabled keys
 * (see "Which keys fund a deployment"). Only a provider holding at least one
 * key described `promotional` gets an entry; every other provider is left
 * unknown, which the sync writes as `standard_payg`.
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
    const promotional = keys
      .filter((key) => key.description?.capacityCategory === 'promotional')
      .sort((a, b) => a.keyId.localeCompare(b.keyId));
    if (promotional.length === 0) continue;
    const judged = promotional.map((key) => ({
      key,
      state: capacityState(key.capacityEvidence ?? [], at),
      validUntil: grantValidUntil(key, at),
    }));
    const available = judged.filter((entry) => entry.state === 'available');
    if (available.length === 0 && promotional.length < keys.length) {
      // Every grant is spent or throttled, and the provider still holds a key
      // Kaana walks on to: its routes are ordinary paid usage now.
      continue;
    }
    const [funding] = available.length > 0 ? available : judged;
    if (funding === undefined) continue;
    const state: ProviderFundingEvidence['fundingState'] =
      available.length > 0
        ? 'available'
        : judged.some((entry) => entry.state === 'rate_limited')
          ? 'rate_limited'
          : 'exhausted';
    // Any available grant funds the route, so the class holds until the last
    // of them lapses (each already bounded by the evidence window).
    const validUntil = Math.max(
      ...(available.length > 0 ? available : judged).map((entry) => entry.validUntil),
    );
    const revision = funding.key.description?.revision ?? 0;
    index.set(provider, {
      fundingClass: 'promotional_credit',
      fundingState: state,
      fundingEvidenceRef:
        `kaana-credential-economics:${provider}:${funding.key.keyId}:description-revision-${revision}${
          promotional.length > 1
            ? `:promotional-keys-${available.length}-of-${promotional.length}-available`
            : ''
        }`.slice(0, 500),
      fundingObservedAt: now,
      fundingValidUntil: new Date(validUntil),
    });
  }
  return index;
}

/** The end of one grant's evidence window: the TTL, or an earlier stated expiry. */
function grantValidUntil(
  key: CredentialEconomicsResponse['credentials'][number],
  at: number,
): number {
  let validUntil = at + FUNDING_EVIDENCE_TTL_MS;
  for (const observation of key.capacityEvidence ?? []) {
    const expiresAt = observation.kind === 'expiry' ? instant(observation.expiresAt) : undefined;
    if (expiresAt !== undefined && expiresAt > at && expiresAt < validUntil) {
      validUntil = expiresAt;
    }
  }
  return validUntil;
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
